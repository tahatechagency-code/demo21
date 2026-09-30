import {
  classifyFrontDoor,
  ConversationPhase,
  FrontDoorIntent,
  matchNamedVehicles,
  RequiredAction,
  type ConversationPhaseValue,
  type FrontDoorClassification,
  type FrontDoorEntities,
  type FrontDoorIntentValue,
} from '@ai-concierge/ai';
import { listVehicles } from '@ai-concierge/db';
import {
  EscalationReason,
  EscalationTier,
  type CollectedBookingInfo,
  type EscalationReasonValue,
  type EscalationTierValue,
  type OutboundAttachment,
} from '@ai-concierge/domain';
import type { AppContext } from '../../context.js';
import type { RecentTurn } from '../conversationalReplyService.js';
import type { JourneyProgress } from '../journeyProgress.js';
import { escalateJourney } from '../journeyService.js';
import { buildPhotoReply } from '../vehiclePhotoReplyService.js';
import { interpretWithGemini } from './geminiFallback.js';

/**
 * The concierge front door — the one place that decides how a customer
 * message is handled:
 *
 *   rules + intent (confidence)  ->  Gemini (only if unsure)  ->  a person
 *
 * Confident, low-risk messages continue through the existing booking pipeline
 * untouched (`null`). Money, cancellation, damage and booking changes always go
 * to a person; the database (never the model) stays the source of truth, so a
 * reply here never claims that something was cancelled, refunded or changed.
 */

export interface FrontDoorInput {
  message: string;
  conversationId: string;
  requestId: string;
  progress: JourneyProgress;
  collected: CollectedBookingInfo;
  resolvedVehicleId: string | null;
  turns: RecentTurn[];
}

export interface FrontDoorOverride {
  text: string;
  escalated: boolean;
  /** Car photos staff uploaded, when the customer asked to see a car. */
  attachments?: OutboundAttachment[];
}

const MAX_CARS_LISTED = 6;

export function phaseOf(
  progress: JourneyProgress,
  collected: CollectedBookingInfo,
): ConversationPhaseValue {
  switch (progress.stage) {
    case 'HUMAN_REVIEW':
    case 'ESCALATED_WAITING':
      return ConversationPhase.ESCALATED;
    case 'QUOTE_ISSUED':
    case 'QUOTE_FOLLOWUP':
    case 'LATER_STAGE':
      return ConversationPhase.QUOTED;
    case 'STEP4_PENDING':
      return collected.vehicle ||
        collected.pickupDate ||
        collected.returnDate ||
        collected.pickupLocation
        ? ConversationPhase.COLLECTING
        : ConversationPhase.NO_CONTEXT;
    default:
      return ConversationPhase.COLLECTING;
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "What cars do you have?" — the whole catalogue, answered from the database. */
const FLEET_QUESTION_RE =
  /\b(?:what|which)\b.{0,20}\b(?:cars|vehicles|models|makes|brands)\b|\byour (?:fleet|cars|collection|lineup)\b/i;

async function fleetReply(ctx: AppContext): Promise<string | null> {
  const vehicles = (
    await listVehicles(ctx.prisma, {
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      limit: 100,
      offset: 0,
    })
  ).filter((vehicle) => vehicle.active);
  const byMake = new Map<string, Set<string>>();
  for (const vehicle of vehicles) {
    byMake.set(vehicle.make, (byMake.get(vehicle.make) ?? new Set()).add(vehicle.model));
  }
  if (byMake.size === 0) return null;
  const list = [...byMake.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([make, models]) => `${make} (${[...models].sort().join(', ')})`)
    .join('; ');
  return `We offer: ${list}. Tell me which one catches your eye and I can share photos, prices and availability.`;
}

async function priceReply(
  ctx: AppContext,
  input: FrontDoorInput,
  options: { askWhichCar: boolean },
): Promise<string | null> {
  const vehicles = (
    await listVehicles(ctx.prisma, {
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      limit: 100,
      offset: 0,
    })
  ).filter((vehicle) => vehicle.active);
  const catalog = vehicles.map((vehicle) => ({
    id: vehicle.id,
    make: vehicle.make,
    model: vehicle.model,
    color: vehicle.color,
    name: `${vehicle.make} ${vehicle.model}`,
    photos: [],
  }));

  let matched = matchNamedVehicles(input.message, catalog);
  if (matched.length === 0 && input.resolvedVehicleId) {
    matched = catalog.filter((entry) => entry.id === input.resolvedVehicleId);
  }
  if (matched.length === 0) {
    if (!options.askWhichCar) return null;
    const listed = [...new Set(catalog.slice(0, MAX_CARS_LISTED).map((entry) => entry.name))];
    return `Happy to help with pricing — which car do you have in mind? We offer the ${joinNames(listed)}.`;
  }

  const rateById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle.pricingProfile]));
  const byName = new Map<string, { rates: number[]; colours: string[]; currency: string }>();
  for (const entry of matched) {
    const profile = rateById.get(entry.id);
    if (!profile) continue;
    const group = byName.get(entry.name) ?? { rates: [], colours: [], currency: profile.currency };
    group.rates.push(profile.dailyRate);
    group.colours.push(entry.color);
    byName.set(entry.name, group);
  }
  const lines = [...byName.entries()].slice(0, 3).map(([name, group]) => {
    const rate = Math.min(...group.rates).toLocaleString('en-US');
    return `the ${name} starts from ${group.currency} ${rate} per day (${joinNames(group.colours)})`;
  });
  if (lines.length === 0) return null;
  const sentence = lines.join(', and ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. The final price depends on your dates and pickup, so share those and I'll prepare an exact quote.`;
}

function describeChange(entities: FrontDoorEntities): string {
  if (!entities.pickupTime) return 'the change';
  const [hour, minute] = entities.pickupTime.split(':').map(Number) as [number, number];
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour >= 12 ? 'PM' : 'AM'}`;
  return `the pickup change to ${clock}`;
}

interface HandOff {
  reason: EscalationReasonValue;
  tier: EscalationTierValue;
  /** What the customer is told. Never says the action was done. */
  reply: string;
}

function handOffFor(intent: FrontDoorIntentValue, entities: FrontDoorEntities): HandOff | null {
  switch (intent) {
    case FrontDoorIntent.CANCELLATION:
      return {
        reason: EscalationReason.AI_UNABLE_TO_PROCEED,
        tier: EscalationTier.T2,
        reply:
          "I've passed your cancellation request to our team so they can review it with you. Nothing has been cancelled yet, and they'll follow up here.",
      };
    case FrontDoorIntent.PAYMENT_REFUND:
      return {
        reason: EscalationReason.PAYMENT_EXCEPTION,
        tier: EscalationTier.T3,
        reply:
          "Payments and refunds are handled by our team directly, so I've passed this to them. They'll get back to you here.",
      };
    case FrontDoorIntent.COMPLAINT_DAMAGE:
      return {
        reason: EscalationReason.DAMAGE_OR_DISPUTE,
        tier: EscalationTier.T3,
        reply:
          "I'm sorry to hear that. I've passed this to our team right away and they'll be in touch here.",
      };
    case FrontDoorIntent.MODIFY_BOOKING:
      return {
        reason: EscalationReason.AI_UNABLE_TO_PROCEED,
        tier: EscalationTier.T2,
        reply: `Sure, I've noted ${describeChange(entities)}. Changes to an existing booking need our team's approval, so they'll confirm it with you here.`,
      };
    default:
      return null;
  }
}

async function escalate(
  ctx: AppContext,
  input: FrontDoorInput,
  handOff: Pick<HandOff, 'reason' | 'tier'>,
  detail: string,
): Promise<boolean> {
  const result = await escalateJourney(
    { prisma: ctx.prisma, notificationProvider: ctx.notificationProvider },
    {
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      conversationId: input.conversationId,
      decision: { tier: handOff.tier, reason: handOff.reason, detail },
      requestId: input.requestId,
    },
  );
  return result.escalated;
}

function bookingState(collected: CollectedBookingInfo): Record<string, string | null> {
  return {
    vehicle: collected.vehicle ? `${collected.vehicle.make} ${collected.vehicle.model}` : null,
    pickupDate: collected.pickupDate,
    returnDate: collected.returnDate,
    pickupLocation: collected.pickupLocation?.normalized ?? null,
  };
}

async function routeHighRisk(
  ctx: AppContext,
  input: FrontDoorInput,
  classification: FrontDoorClassification,
  source: string,
): Promise<FrontDoorOverride | null> {
  const { intent, entities, secondaryIntents, conversationPhase } = classification;
  // A change request with no booking behind it is a booking question, not a change to approve.
  if (intent === FrontDoorIntent.MODIFY_BOOKING) {
    if (conversationPhase === ConversationPhase.COLLECTING) return null;
    if (conversationPhase === ConversationPhase.NO_CONTEXT) {
      return {
        text: "I can't see a booking in this chat yet. Tell me which car and dates you'd like, or share your booking details and I'll bring in our team.",
        escalated: false,
      };
    }
  }
  const handOff = handOffFor(intent, entities);
  if (!handOff) return null;

  const detail = `Front door (${source}): ${intent}${entities.pickupTime ? ` pickup ${entities.pickupTime}` : ''}; other intents: ${secondaryIntents.join(', ') || 'none'}`;
  if (!(await escalate(ctx, input, handOff, detail))) return null;

  let text = handOff.reply;
  if (secondaryIntents.includes(FrontDoorIntent.PRICING)) {
    const price = await priceReply(ctx, input, { askWhichCar: false });
    if (price) text = `On pricing: ${price}\n\n${text}`;
  }
  return { text, escalated: true };
}

/**
 * Returns the reply to send instead of the pipeline's, or `null` to let the
 * booking pipeline's own reply stand.
 */
export async function runFrontDoor(
  ctx: AppContext,
  input: FrontDoorInput,
): Promise<FrontDoorOverride | null> {
  const phase = phaseOf(input.progress, input.collected);
  // A person already owns this conversation.
  if (phase === ConversationPhase.ESCALATED) return null;

  let classification = classifyFrontDoor(input.message, { phase });
  let source = 'rules';

  if (classification.requiredAction === RequiredAction.ASK_GEMINI) {
    const { interpretation, note } = await interpretWithGemini(ctx.aiProvider, {
      message: input.message,
      recentTurns: input.turns,
      bookingState: bookingState(input.collected),
    });
    if (!interpretation) {
      // Rules and Gemini both unsure: do not guess, hand over.
      const handedOver = await escalate(
        ctx,
        input,
        { reason: EscalationReason.AI_UNABLE_TO_PROCEED, tier: EscalationTier.T2 },
        `Front door: AI_UNCERTAIN. Rules read ${classification.intent} (${classification.confidence}). ${note}`,
      );
      if (!handedOver) return null;
      return {
        text: "I want to make sure you get the right answer, so I've asked a member of our team to take a look. They'll reply here.",
        escalated: true,
      };
    }
    source = 'gemini';
    const highRisk = handOffFor(interpretation.intent, interpretation.entities) !== null;
    classification = {
      ...classification,
      intent: interpretation.intent,
      confidence: interpretation.confidence,
      entities: { ...classification.entities, ...interpretation.entities },
      requiredAction: highRisk
        ? RequiredAction.ESCALATE_HUMAN
        : interpretation.intent === FrontDoorIntent.PRICING
          ? RequiredAction.ANSWER_PRICE
          : RequiredAction.CONTINUE_PIPELINE,
    };
  }

  ctx.logger.info(
    {
      requestId: input.requestId,
      conversationId: input.conversationId,
      frontDoor: {
        source,
        phase,
        intent: classification.intent,
        confidence: classification.confidence,
        secondary: classification.secondaryIntents,
        action: classification.requiredAction,
      },
    },
    'front door decision',
  );

  if (
    phase !== ConversationPhase.QUOTED &&
    classification.requiredAction === RequiredAction.CONTINUE_PIPELINE &&
    FLEET_QUESTION_RE.test(input.message)
  ) {
    const text = await fleetReply(ctx);
    if (text) return { text, escalated: false };
  }

  switch (classification.requiredAction) {
    case RequiredAction.ESCALATE_HUMAN:
      // An explicit "talk to a person" is escalated by the journey autopilot already.
      if (classification.intent === FrontDoorIntent.HUMAN_REQUEST) return null;
      return routeHighRisk(ctx, input, classification, source);
    case RequiredAction.SEND_PHOTOS: {
      // Mid-booking, the photos are added in front of the normal reply instead.
      if (phase !== ConversationPhase.NO_CONTEXT) return null;
      const photos = await buildPhotoReply(
        { prisma: ctx.prisma },
        {
          tenantId: ctx.config.DEFAULT_TENANT_ID,
          message: input.message,
          resolvedVehicleId: input.resolvedVehicleId,
        },
      );
      if (!photos) return null;
      const next =
        photos.attachments.length > 0 ? "\n\nTell me your dates and I'll check availability." : '';
      return { text: `${photos.text}${next}`, escalated: false, attachments: photos.attachments };
    }
    case RequiredAction.ANSWER_PRICE: {
      if (phase === ConversationPhase.QUOTED) return null;
      const text = await priceReply(ctx, input, { askWhichCar: true });
      return text ? { text, escalated: false } : null;
    }
    default:
      return null;
  }
}
