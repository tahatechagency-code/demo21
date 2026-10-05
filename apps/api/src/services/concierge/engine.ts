import {
  ASK_REPEAT_TEXT,
  ConversationPhase,
  ShortReplyIntent,
  DateExtractionService,
  EMIRATE_LABEL,
  FrontDoorIntent,
  OPTION_REPEAT,
  OPTION_TEAM,
  pickVariant,
  STAGE_ONE_INTRO,
  STAGE_TWO_INTRO,
  UAE_PLACES,
  TEAM_HANDOFF_TEXT,
  answerPolicies,
  answerPolicy,
  brandReply,
  detectPolicyTopic,
  detectPolicyTopics,
  seatFilterReply,
  categoryReply,
  checkDelivery,
  classifyFrontDoor,
  classifyShortReply,
  coloursReply,
  compareReply,
  describeFee,
  detectFleetQuestion,
  detectRecommendNeed,
  expandVehicleAliases,
  extractStatedDuration,
  extremeReply,
  fleetListReply,
  foundModelsReply,
  formatOptions,
  isPhotoRequest,
  joinList,
  matchLocation,
  money,
  notInFleetReply,
  parseNumberedOptions,
  parseOptionPick,
  popularModels,
  priceListReply,
  recommendReply,
  resolveVehicleMention,
  seatsReply,
  stageOneOptions,
  stageTwoOptions,
  wantsTeamByWords,
  wantsToRepeat,
  type ConversationPhaseValue,
  type DeliveryDecision,
  type FleetModel,
  type FrontDoorClassification,
  type FrontDoorIntentValue,
  type MapsProvider,
  type PolicyAnswer,
} from '@ai-concierge/ai';
import {
  EscalationReason,
  EscalationTier,
  type CollectedBookingInfo,
  type EscalationReasonValue,
  type EscalationTierValue,
  type OutboundAttachment,
} from '@ai-concierge/domain';
import type { AppContext } from '../../context.js';
import { createMapsProvider } from '../../lib/mapsFactory.js';
import type { RecentTurn } from '../conversationalReplyService.js';
import type { JourneyProgress } from '../journeyProgress.js';
import { escalateJourney } from '../journeyService.js';
import { buildPhotoReply } from '../vehiclePhotoReplyService.js';
import { availabilityReply, estimateText } from './estimate.js';
import { buildFactsText } from './facts.js';
import { humanizeReply, makeOptions, translateReply, understand, type GeminiContext } from './gemini.js';
import { factLoss } from './factGuard.js';
import { callBudget } from '../journeyReplyService.js';
import { arabicReply } from './arabic.js';
import { loadKnowledge, type Knowledge } from './knowledge.js';
import {
  datedEstimateReply,
  durationReply,
  findMessageProblem,
  formatDay,
  problemText,
  stateSummary,
} from './problems.js';

/**
 * The Conversation Engine — the one place that decides how every customer message is answered:
 *
 *   STEP 0  load the whole fleet + the location database + the delivery rule  (always first)
 *   rules / intent  ->  understood?  yes -> ACTION
 *                                    no  -> GEMINI (with the same databases)  ->  understood? yes -> ACTION
 *                                    no  -> 4 OPTIONS (1 fleet answer, 2 likely meanings, 4 "repeat in detail")
 *                                           -> next message: understood? yes -> ACTION
 *                                           no -> 3 NEW likely meanings + 4th "contact my team"
 *                                           -> a person joins THE SAME CHAT, and the engine keeps going.
 *
 * Nothing here ever mutes the concierge: a person owning the case adds their replies to the same
 * chat and the engine keeps answering in between (and pages the person on every new customer message).
 */

export interface EngineInput {
  message: string;
  conversationId: string;
  requestId: string;
  progress: JourneyProgress;
  collected: CollectedBookingInfo;
  /** Step 4's verdict for this message (NOT_APPLICABLE = no booking is underway). */
  missingInfoStatus: string;
  resolvedVehicleId: string | null;
  turns: RecentTurn[];
  /** When the model must stop being waited for (epoch ms); past it the deterministic wording is sent. */
  deadlineAt?: number;
}

export interface EngineOverride {
  text: string;
  /** The customer has been handed to a person. */
  escalated: boolean;
  attachments?: OutboundAttachment[];
  /** Stored with the reply; fallback stages are how the next message knows what was just asked. */
  stage: string;
  /** True: `text` goes in FRONT of the booking pipeline's own reply instead of replacing it. */
  continuePipeline?: boolean;
  /** Gemini reworded (or translated) this reply; the facts in it were verified to be unchanged. */
  aiWorded?: boolean;
}

/** Stage tags on stored replies. */
export const ConciergeStage = {
  OPTIONS_1: 'FB1_OPTIONS',
  REPEAT: 'FB_REPEAT',
  OPTIONS_2: 'FB2_OPTIONS',
  UNCONFIGURED: 'POLICY_UNCONFIGURED',
  TEAM: 'TEAM_HANDOFF',
  ANSWER: 'CONCIERGE_ANSWER',
  ESCALATED_NOTE: 'ESCALATED_NOTED',
} as const;

type Decision =
  | {
      kind: 'REPLY';
      text: string;
      stage: string;
      attachments?: OutboundAttachment[];
      prefix?: boolean;
      /** Reply is fixed wording that must not be translated (the option lists). */
      keepEnglish?: boolean;
      /** Policy and FAQ wording: never reworded, so a precise rule can not be softened. */
      fixed?: boolean;
    }
  | { kind: 'HANDOFF'; reason: EscalationReasonValue; tier: EscalationTierValue; detail: string; reply: string }
  | { kind: 'PIPELINE' }
  | { kind: 'UNKNOWN' };

const TZ = 'Asia/Dubai';
const dateReader = new DateExtractionService();

// ---------------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------------

function isEscalated(progress: JourneyProgress): boolean {
  return progress.stage === 'ESCALATED_WAITING' || progress.stage === 'HUMAN_REVIEW';
}

function phaseOf(progress: JourneyProgress, collected: CollectedBookingInfo): ConversationPhaseValue {
  switch (progress.stage) {
    case 'HUMAN_REVIEW':
    case 'ESCALATED_WAITING':
      return ConversationPhase.ESCALATED;
    case 'QUOTE_ISSUED':
    case 'QUOTE_FOLLOWUP':
    case 'LATER_STAGE':
      return ConversationPhase.QUOTED;
    case 'STEP4_PENDING':
      return collected.vehicle || collected.pickupDate || collected.returnDate || collected.pickupLocation
        ? ConversationPhase.COLLECTING
        : ConversationPhase.NO_CONTEXT;
    default:
      return ConversationPhase.COLLECTING;
  }
}

function lastAssistant(turns: RecentTurn[]): RecentTurn | undefined {
  return [...turns].reverse().find((turn) => turn.role === 'assistant');
}

/** Every numbered option the concierge already put to this customer (so new questions are new). */
function optionsAlreadyAsked(turns: RecentTurn[]): string[] {
  return turns
    .filter(
      (turn) =>
        turn.role === 'assistant' &&
        (turn.stage === ConciergeStage.OPTIONS_1 || turn.stage === ConciergeStage.OPTIONS_2),
    )
    .flatMap((turn) => parseNumberedOptions(turn.content));
}

function modelOfRow(k: Knowledge, rowId: string | null): FleetModel | null {
  if (!rowId) return null;
  return k.fleet.models.find((model) => model.rows.some((row) => row.id === rowId)) ?? null;
}

function chatSummary(k: Knowledge, input: EngineInput) {
  const model = modelOfRow(k, input.resolvedVehicleId ?? input.collected.vehicle?.id ?? null);
  return {
    vehicleName: model?.name ?? null,
    hasDates: Boolean(input.collected.pickupDate && input.collected.returnDate),
    location: input.collected.pickupLocation?.normalized ?? null,
    customerMessages: input.turns.filter((turn) => turn.role === 'customer').map((turn) => turn.content),
  };
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

type Language = 'en' | 'ar' | 'hi' | 'hinglish';

const HINGLISH_WORDS =
  /\b(?:kya|hai|hain|chahiye|chahie|mujhe|mereko|kitna|kitne|nahi|nahin|aap|ap|gaadi|gadi|bhai|karo|kar do|kal|parso|aaj|din|hafte|mahina|se|tak|ke liye|ka|ki|ko|me|mein|pe|par|wala|wali|batao|bataiye|dikhao|dikhaiye|haan|theek|achha|accha|shukriya|dhanyavad|kaise|kahan|kab|kaun|konsi|kaunsi)\b/i;

function detectLanguage(message: string): Language {
  if (/[؀-ۿ]/.test(message)) return 'ar';
  if (/[ऀ-ॿ]/.test(message)) return 'hi';
  const hits = message.toLowerCase().match(new RegExp(HINGLISH_WORDS.source, 'gi')) ?? [];
  return hits.length >= 2 ? 'hinglish' : 'en';
}

/** Rewrites a finished reply in the customer's language; accepted only when every fact survived (see factGuard). */
async function localize(
  ctx: AppContext,
  k: Knowledge,
  draft: string,
  message: string,
  timeoutMs?: number,
): Promise<string> {
  const language = detectLanguage(message);
  if (language === 'en') return draft;
  const translated = await translateReply(ctx.aiProvider, k.profile.brand, draft, message, timeoutMs);
  if (!translated) return draft;
  // The same fact check as an English rewrite (numbers, car and place names, links, refusals, the question
  // asked), with room for a language that needs more words.
  const loss = factLoss(draft, translated, knownNames(k), 2.2);
  if (loss || translated.length > 1400) {
    ctx.logger.info({ engine: { translate: loss ?? 'too long' } }, 'concierge translation refused');
    return draft;
  }
  return translated;
}

/** Every car, place and branch name the business uses: a reworded reply must keep the ones its draft names. */
function knownNames(k: Knowledge): string[] {
  return [
    ...k.fleet.models.map((model) => model.name),
    ...UAE_PLACES.map((place) => place.name),
    ...k.profile.branches.filter((branch) => branch.confirmed).map((branch) => branchLabel(branch.name)),
  ];
}

/**
 * The final wording of a reply. Customers writing in Arabic, Hindi or Hinglish get it in their language;
 * English customers get it reworded so repeated questions never read the same. Gemini only ever changes
 * the words: a rewrite whose numbers, names or links differ from the draft is thrown away for the draft.
 */
async function polish(
  ctx: AppContext,
  k: Knowledge,
  input: EngineInput,
  draft: string,
  fixed: boolean,
): Promise<{ text: string; ai: boolean }> {
  if (ctx.aiProviderStatus !== 'CONFIGURED') return { text: draft, ai: false };
  const budget = callBudget(input.deadlineAt);
  if (budget === 'EXHAUSTED') return { text: draft, ai: false };
  if (detectLanguage(input.message) !== 'en') {
    const text = await localize(ctx, k, draft, input.message, budget);
    return { text, ai: text !== draft };
  }
  if (fixed || draft.length > 700) return { text: draft, ai: false };
  const openings = input.turns
    .filter((turn) => turn.role === 'assistant')
    .slice(-4)
    .map((turn) => turn.content.slice(0, 50));
  const reworded = await humanizeReply(ctx.aiProvider, k.profile.brand, draft, input.message, openings, budget);
  if (!reworded) {
    ctx.logger.info({ engine: { polish: 'no reply from the model' } }, 'concierge reword skipped');
    return { text: draft, ai: false };
  }
  const loss = factLoss(draft, reworded, knownNames(k));
  if (loss) {
    ctx.logger.info({ engine: { polish: loss } }, 'concierge reword refused');
    return { text: draft, ai: false };
  }
  return { text: reworded, ai: true };
}

// ---------------------------------------------------------------------------
// Small talk
// ---------------------------------------------------------------------------

const THANKS_RE =
  /^(?:ok(?:ay)?[ ,]*)?(?:thanks?|thank you|thank u|thx|ty|shukriya|shukria|dhanyavad|syukran|شكرا|great,? thanks?)\b.{0,25}$/i;
const BYE_RE = /^(?:bye|goodbye|good ?bye|good ?night|gn|shab ?b?a ?khair|see you|see ya|take care|khuda hafiz|allah hafiz|alvida|ma salama)\b.{0,20}$/i;
const IDENTITY_RE =
  /\b(?:are you (?:a )?(?:bot|robot|ai|machine|human|real|person)|am i (?:talking|speaking|chatting) (?:to|with)|who are you|who am i (?:talking|speaking)|real person|tum kaun|aap kaun|(?:bot|robot|insaan|insan|aadmi|admi|human|machine|ai)\s+(?:ho|hai|hain)(?:\s+ya\s+\w+)?|(?:insaan|insan|aadmi|admi)\s+ho)\b/i;
const HOW_ARE_YOU_RE =
  /\b(?:how are you|how(?:'s| is) it going|how r u|what'?s up|wh?assup|sup|kaise ho|kaisa hai|kaise hain|aap kaise|kya haal|kya chal raha)\b/i;
/** Wording that makes "real person / human" a request to be connected, not a question about me. */
const ASKS_FOR_PERSON_RE =
  /\b(?:talk|speak|connect|chat|call|transfer|put me|let me|give me|want|need|get me|escalate|manager|supervisor)\b/i;
const WEATHER_RE = /\b(?:weather|temperature|how hot|how cold|raining|rain today|mausam)\b/i;
const VIP_RE = /\b(?:vip|v\.i\.p|very important (?:person|client|customer)|celebrity|royal family|sheikh|shaikh)\b/i;
const CORPORATE_RE =
  /\b(?:corporate|company booking|business account|bulk (?:booking|order)|fleet (?:booking|of|hire)|event fleet|wedding fleet|(?:1[0-9]|[2-9][0-9]|[1-9][0-9]{2})\s+(?:cars|vehicles|gaadi|gaadiyan|gadiyan))\b/i;
const JOKE_RE = /\b(?:tell me a joke|joke|funny|mazak|chutkula|ek joke)\b/i;
const WRONG_NUMBER_RE = /\b(?:wrong (?:number|person|chat)|galat (?:number|jagah)|sorry wrong)\b/i;
const VOICE_RE = /\b(?:voice (?:note|message)|audio (?:note|message)|recording|voice bheja)\b/i;
/** No letters or digits at all ("???", emoji only), or a run of neighbouring keys ("asdfghjkl"). */
function isNoise(text: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  const letters = text.toLowerCase().replace(/[^a-z]/g, '');
  if (letters.length < 5 || /\s/.test(text.trim())) return false;
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  return rows.some((row) => {
    for (let i = 0; i + 4 <= row.length; i += 1) {
      const run = row.slice(i, i + 4);
      if (letters.includes(run) || letters.includes([...run].reverse().join(''))) return true;
    }
    return false;
  });
}

/** "return kab hai?", "when do I pick up?", "which car did I choose?": answered from the booking so far. */
const RETURN_WHEN_RE = /\b(?:return|wapas|vapas)\b.{0,15}\b(?:kab|when|date|kis din)\b|\b(?:kab|when)\b.{0,15}\b(?:return|wapas|vapas)\b/i;
const PICKUP_WHEN_RE = /\b(?:pick ?-?up|collect(?:ion)?|start)\b.{0,15}\b(?:kab|when|date)\b|\b(?:kab|when)\b.{0,15}\b(?:pick ?-?up|collect|start)\b/i;
const STATE_RE =
  /\bwhich (?:car|vehicle)\b.{0,20}\b(?:book|choose|chose|select|pick)|\bkaun ?si (?:car|gaadi|gadi)\b.{0,20}\b(?:book|li|chun)|\bwhat (?:are|were) (?:my|the) (?:dates|details)\b|\b(?:my|meri|mera) booking\b|\bwhat (?:did|have) i (?:book|choose|select)\b/i;
const TOTAL_RE = /\b(?:total|kitna|kitne ka|how much|price|cost|kharcha|rate)\b/i;

function greeting(k: Knowledge, started: boolean, seed: string): string {
  return started
    ? pickVariant(seed, [
        'Hello again! How can I help — a car, dates, a price or delivery?',
        'Hi again! What can I do for you: a car, dates, a price or delivery?',
        'Good to hear from you again. Shall we look at a car, dates, a price or delivery?',
      ])
    : pickVariant(seed, [
        `Welcome to ${k.profile.brand}! I'm your AI concierge. I can show you our cars and prices, check availability, arrange delivery and prepare your quote. What are you looking for?`,
        `Welcome to ${k.profile.brand}! I'm the AI concierge here. I can help with cars, prices, availability, delivery and your quote. What would you like to start with?`,
        `Welcome to ${k.profile.brand}! I'm your AI concierge, happy to show you the fleet, check dates and arrange delivery. What can I help you find?`,
      ]);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const DELIVERY_WORDS =
  /\b(?:deliver\w*|delivery|(?:come|coming|reach|arrive|drop|send)(?: it| the car| a car| me)? (?:to|at)|bring (?:it|the car|a car)|send (?:the |a )?car|collect(?:ion)? from|at my (?:hotel|home|house|villa|office|apartment|flat|place|address)|to my (?:hotel|home|house|villa|office|apartment|flat|place|address)|home delivery|door ?step|(?:mere|meri|mera|apne|apni)\s+(?:hotel|villa|ghar|home|house|apartment|flat|office)|hotel (?:me|mein|pe|par))\b/i;

/** "Mujhe Yas Island pe car chahiye": a place plus a want. */
const WANT_AT_PLACE =
  /\b(?:need|want|chahiye|chahie|require|looking for)\b.{0,40}\b(?:at|in|near|from|pe|par|mein|me)\b|\b(?:pe|par|mein)\b.{0,15}\b(?:car|gaadi|gadi)\b|\bpick ?-?up\b.{0,30}\b(?:from|at|in)\b/i;

function mapsFor(ctx: AppContext): MapsProvider | undefined {
  return createMapsProvider(ctx.config);
}

function branchLabel(name: string): string {
  return name.split(' (')[0]!.split(',')[0]!.trim();
}

/** One seed per reply: the same conversation and turn always read the same, different ones differ. */
function seedOf(input: EngineInput): string {
  return `${input.conversationId}:${input.turns.length}`;
}

/** The short "we can deliver there, for this fee" note; the wording rotates, the facts do not. */
function deliveryNoteText(
  decision: Extract<DeliveryDecision, { kind: 'DELIVERY_POSSIBLE' }>,
  k: Knowledge,
  seed: string,
): string {
  const fee = describeFee(decision.fee, k.profile.currency);
  const km = decision.from.roadKm;
  const branch = branchLabel(decision.from.branch.name);
  const place = decision.destination;
  return pickVariant(seed, [
    `Delivery to ${place} is possible: ${fee}, about ${km} km from our ${branch} branch.`,
    `We can bring the car to ${place} for ${fee}; it is about ${km} km from our ${branch} branch.`,
    `${place} is inside our delivery area (about ${km} km from ${branch}), and delivery costs ${fee}.`,
    `Good news, we deliver to ${place}. It is ${km} km from our ${branch} branch and costs ${fee}.`,
    `Delivery to ${place} works: ${fee}, roughly ${km} km from ${branch}.`,
    `Yes, ${place} is covered. Delivery is ${fee}, about ${km} km from our ${branch} branch.`,
  ]);
}

function deliveryText(decision: DeliveryDecision, k: Knowledge, input: EngineInput): string {
  const cur = k.profile.currency;
  switch (decision.kind) {
    case 'BRANCH_PICKUP':
      return `You can pick the car up from our ${decision.branch.name}, with no delivery fee, or we can deliver it to you for ${cur} ${k.profile.delivery.feeByEmirate[decision.branch.emirate]}. Which car and which dates?`;
    case 'DELIVERY_POSSIBLE': {
      const km = `${decision.from.estimated ? 'about ' : ''}${decision.from.roadKm} km`;
      const car = input.collected.vehicle ? `${input.collected.vehicle.make} ${input.collected.vehicle.model}` : null;
      return (
        pickVariant(seedOf(input), [
          `Yes, delivery to ${decision.destination} (${EMIRATE_LABEL[decision.emirate]}) is possible from our ${branchLabel(decision.from.branch.name)} branch, ${km} away. `,
          `We can deliver to ${decision.destination} (${EMIRATE_LABEL[decision.emirate]}) from our ${branchLabel(decision.from.branch.name)} branch, which is ${km} away. `,
          `${decision.destination} (${EMIRATE_LABEL[decision.emirate]}) is within our delivery area, ${km} from our ${branchLabel(decision.from.branch.name)} branch. `,
        ]) +
        `Delivery or collection costs ${describeFee(decision.fee, cur)}. ` +
        `The car must stay inside the UAE. ${car ? `Shall I check the ${car} for your dates?` : 'Which car and which dates would you like?'}`
      );
    }
    case 'TOO_FAR': {
      const popular = branchNamesNear(k, decision);
      return (
        `Sorry, ${decision.destination} is too far for delivery: it is ${decision.from.estimated ? 'about ' : ''}${decision.from.roadKm} km from our nearest branch (${branchLabel(decision.from.branch.name)}), and we deliver up to ${k.profile.delivery.maxRoadKm} km. ` +
        `You can pick the car up from ${branchLabel(decision.from.branch.name)}${popular ? `, or from ${popular}` : ''}. Shall I arrange that?`
      );
    }
    case 'NEEDS_PIN':
      return 'Please share the exact area or location pin (or the hotel / building name) and I will check delivery for you.';
  }
}

function branchNamesNear(k: Knowledge, decision: Extract<DeliveryDecision, { kind: 'TOO_FAR' }>): string {
  const others = k.profile.branches
    .filter((branch) => branch.confirmed && branch.id !== decision.from.branch.id)
    .slice(0, 3)
    .map((branch) => branchLabel(branch.name));
  return joinList(others);
}

async function deliveryDecisionFor(
  ctx: AppContext,
  k: Knowledge,
  input: EngineInput,
  message: string,
): Promise<DeliveryDecision> {
  return checkDelivery(
    {
      message,
      whenIso: input.collected.pickupDate,
      airportOffHire: /\b(?:drop|return|off-?hire)\b.{0,25}\bairport\b/i.test(message),
    },
    k.profile,
    mapsFor(ctx),
  );
}

// ---------------------------------------------------------------------------
// Hand-off
// ---------------------------------------------------------------------------

interface HandOffSpec {
  reason: EscalationReasonValue;
  tier: EscalationTierValue;
  reply: string;
}

/** "the pickup change to 7 PM" — the requested time is recorded in the words, never acted on. */
function describeChange(pickupTime: string | undefined): string {
  if (!pickupTime) return 'the change';
  const [hour, minute] = pickupTime.split(':').map(Number) as [number, number];
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour >= 12 ? 'PM' : 'AM'}`;
  return `the pickup change to ${clock}`;
}

function highRiskHandOff(intent: FrontDoorIntentValue, pickupTime: string | undefined): HandOffSpec | null {
  switch (intent) {
    case FrontDoorIntent.CANCELLATION:
      return {
        reason: EscalationReason.AI_UNABLE_TO_PROCEED,
        tier: EscalationTier.T2,
        reply:
          "I've passed your cancellation request to our team so they can review it with you. Nothing has been cancelled yet, and they'll follow up in this chat.",
      };
    case FrontDoorIntent.PAYMENT_REFUND:
      return {
        reason: EscalationReason.PAYMENT_EXCEPTION,
        tier: EscalationTier.T3,
        reply:
          "Payments and refunds are handled by our team directly, so I've passed this to them. They'll get back to you in this chat.",
      };
    case FrontDoorIntent.COMPLAINT_DAMAGE:
      return {
        reason: EscalationReason.DAMAGE_OR_DISPUTE,
        tier: EscalationTier.T3,
        reply: "I'm sorry to hear that. I've passed this to our team right away and they'll be in touch in this chat.",
      };
    case FrontDoorIntent.MODIFY_BOOKING:
      return {
        reason: EscalationReason.AI_UNABLE_TO_PROCEED,
        tier: EscalationTier.T2,
        reply: `Sure, I've noted ${describeChange(pickupTime)}. Changes to an existing booking need our team's approval, so they'll confirm it with you in this chat.`,
      };
    default:
      return null;
  }
}

async function carryOutHandOff(
  ctx: AppContext,
  input: EngineInput,
  decision: Extract<Decision, { kind: 'HANDOFF' }>,
): Promise<EngineOverride | null> {
  let escalated = isEscalated(input.progress);
  if (!escalated) {
    const result = await escalateJourney(
      { prisma: ctx.prisma, notificationProvider: ctx.notificationProvider },
      {
        tenantId: ctx.config.DEFAULT_TENANT_ID,
        conversationId: input.conversationId,
        decision: { tier: decision.tier, reason: decision.reason, detail: decision.detail },
        requestId: input.requestId,
      },
    );
    escalated = result.escalated;
  }
  // Never tell the customer a person was notified when no case could be recorded.
  if (!escalated) return null;
  return { text: decision.reply, escalated: true, stage: ConciergeStage.TEAM };
}

// ---------------------------------------------------------------------------
// Understanding (rules / intent, with the databases)
// ---------------------------------------------------------------------------

function looksLikeBookingDetail(
  message: string,
  k: Knowledge,
  phase: ConversationPhaseValue,
  classification: FrontDoorClassification,
): boolean {
  const dates = dateReader.extract(message, { referenceDate: new Date(), timezone: TZ });
  if (
    dates.pickupDate ||
    dates.returnDate ||
    dates.duration ||
    (dates.times?.length ?? 0) > 0 ||
    dates.impossibleDateMentions.length > 0 ||
    dates.ambiguities.length > 0
  ) {
    return true;
  }
  if (phase !== ConversationPhase.NO_CONTEXT && matchLocation(message, k.profile).kind !== 'UNKNOWN') return true;
  if (classification.intent === FrontDoorIntent.CONTINUATION && phase !== ConversationPhase.NO_CONTEXT) return true;
  // "I want to rent a car", "book it": the booking steps ask for what is missing.
  if (
    (classification.intent === FrontDoorIntent.BOOKING || classification.intent === FrontDoorIntent.AVAILABILITY) &&
    classification.confidence >= 0.75
  ) {
    return true;
  }
  // A bare yes / ok answers whatever the booking steps asked last.
  if (wordCount(message) <= 3 && classifyShortReply(message) === ShortReplyIntent.AFFIRMATIVE) return true;
  // Mid-booking, a short reply that is not a question belongs to the question that is open.
  if (
    (phase === ConversationPhase.COLLECTING) &&
    wordCount(message) <= 3 &&
    !/[?؟]/.test(message)
  ) {
    return true;
  }
  return false;
}

/** A customer talking about themselves ("I hold a UAE licence"): a detail for the booking, not a question. */
const FIRST_PERSON_RE = /\b(?:i|i'm|im|i've|ive|my|mine|me|mera|meri|mere|maine|mujhe|hum|humne)\b/i;

const QUESTION_START =
  /^\s*(?:what|which|how|where|when|why|who|whom|whose|can|could|do|does|did|is|are|am|was|will|would|should|may|might|any|kya|kitna|kitne|kaun|kaunsi|konsi|kab|kahan|kaise|kyun|क्या|कितना|ما|هل|كم|كيف|أين|متى)\b/i;
const QUESTION_CUES =
  /\b(?:tell me|let me know|want to know|wanted to know|need to know|batao|bataiye|bataye|puchna|pata karna|jaanna|kya|kaise|kitna|kitne|kitni|kab|kahan|kaun|kaunsi|kaunsa|kaunse|konsi|konsa|kyun|kyu|hota|hoti|milega|milegi|hoga)\b|[?؟]/i;

/** A question, or a very short topic query ("min age?", "deposit"). A statement about oneself is not one. */
function isQuestionLike(text: string): boolean {
  return QUESTION_START.test(text) || QUESTION_CUES.test(text) || wordCount(text) <= 4;
}

/** An actual question (not just a short phrase). */
function isRealQuestion(text: string): boolean {
  return QUESTION_START.test(text) || QUESTION_CUES.test(text);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

interface UnderstandContext {
  ctx: AppContext;
  k: Knowledge;
  input: EngineInput;
  phase: ConversationPhaseValue;
  /** The text to understand: the customer's message, or the option sentence they picked. */
  message: string;
}

/**
 * Booking details the pipeline reports include what THIS message just said. "Collecting" only counts
 * when something was already collected before it (otherwise this is a first message that merely
 * contains booking words), so the first mention of a car is answered with the car's details.
 */
function refinePhase(
  phase: ConversationPhaseValue,
  input: EngineInput,
  k: Knowledge,
  text: string,
): ConversationPhaseValue {
  if (phase !== ConversationPhase.COLLECTING) return phase;
  // The booking steps just asked the customer a question: this message answers it.
  const asked = lastAssistant(input.turns)?.stage;
  if (asked === 'STEP4_PENDING' || asked === 'NEEDS_ELIGIBILITY_INFO') return phase;
  const c = input.collected;
  const expanded = expandVehicleAliases(text, k.fleet);
  const dates = dateReader.extract(text, { referenceDate: new Date(), timezone: TZ });
  const namesCar = resolveVehicleMention(expanded, k.fleet).kind !== 'NONE';
  const hasDates = Boolean(dates.pickupDate || dates.returnDate || dates.duration);
  const hasPlace = matchLocation(expanded, k.profile).kind !== 'UNKNOWN';
  const earlier =
    (c.vehicle && !namesCar) || ((c.pickupDate || c.returnDate) && !hasDates) || (c.pickupLocation && !hasPlace);
  return earlier ? phase : ConversationPhase.NO_CONTEXT;
}

async function understandWithRules(base: UnderstandContext): Promise<Decision> {
  const { ctx, k, input } = base;
  const phase = refinePhase(base.phase, input, k, base.message);
  const u: UnderstandContext = { ...base, phase };
  const original = u.message.trim();
  const message = expandVehicleAliases(original, k.fleet);
  const classification = classifyFrontDoor(original, { phase });
  const words = wordCount(original);

  // 0. "Are you a real human?" is a question about me, not a request for a person.
  if (IDENTITY_RE.test(original) && !ASKS_FOR_PERSON_RE.test(original)) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      text: `I'm ${k.profile.brand}'s AI concierge, not a person, and our team is here too if you would rather speak to someone. How can I help: a car, dates or delivery?`,
    };
  }

  // 1. A person, asked for outright.
  if (wantsTeamByWords(original) || classification.intent === FrontDoorIntent.HUMAN_REQUEST) {
    return {
      kind: 'HANDOFF',
      reason: EscalationReason.AI_UNABLE_TO_PROCEED,
      tier: EscalationTier.T2,
      detail: 'Customer asked to speak with a person',
      reply: TEAM_HANDOFF_TEXT,
    };
  }

  // 1b. VIP and corporate / bulk customers are looked after by the senior team, not by a price list.
  if (VIP_RE.test(original) || CORPORATE_RE.test(original)) {
    return {
      kind: 'HANDOFF',
      reason: EscalationReason.AI_UNABLE_TO_PROCEED,
      tier: EscalationTier.T3,
      detail: VIP_RE.test(original) ? 'VIP customer' : 'Corporate or bulk booking',
      reply:
        "Thank you for choosing us. VIP and corporate bookings are looked after personally by our senior team, so I've passed yours to them right away. They'll reply here in this chat shortly.",
    };
  }

  // 1c. Arabic: the common questions are answered in Arabic straight from the fleet.
  if (detectLanguage(original) === 'ar') {
    const arabic = arabicReply(original, k);
    if (arabic) return { kind: 'REPLY', stage: ConciergeStage.ANSWER, text: arabic, keepEnglish: true };
  }

  // 2. Money, safety, bookings that already exist: always a person.
  const handOff = highRiskHandOff(classification.intent, classification.entities.pickupTime);
  if (handOff && classification.confidence >= 0.5) {
    if (classification.intent === FrontDoorIntent.MODIFY_BOOKING && phase === ConversationPhase.COLLECTING) {
      return { kind: 'PIPELINE' }; // a change request with no booking behind it is a booking detail
    }
    if (classification.intent === FrontDoorIntent.MODIFY_BOOKING && phase === ConversationPhase.NO_CONTEXT) {
      return {
        kind: 'REPLY',
        stage: ConciergeStage.ANSWER,
        text: "I can't see a booking in this chat yet. Tell me which car and dates you'd like, or share your booking details and I'll bring in our team.",
      };
    }
    // "price, and cancel": the part that can be answered is answered, then the person is brought in.
    let reply = handOff.reply;
    const asked = resolveVehicleMention(message, k.fleet);
    const askedModels =
      asked.kind === 'MODEL'
        ? asked.models
        : ((): FleetModel[] => {
            const context = modelOfRow(k, input.resolvedVehicleId ?? input.collected.vehicle?.id ?? null);
            return context ? [context] : [];
          })();
    if (classification.secondaryIntents.includes(FrontDoorIntent.PRICING) && askedModels.length > 0) {
      reply = `On pricing: ${priceListReply(askedModels).split('\n\n')[0]}\n\n${reply}`;
    }
    if (classification.secondaryIntents.includes(FrontDoorIntent.DELIVERY_PICKUP)) {
      const fees = answerPolicy('how much is delivery fee', policyContext(k));
      if (fees) reply = `${reply}\n\n${fees.text}`;
    }
    return {
      kind: 'HANDOFF',
      reason: handOff.reason,
      tier: handOff.tier,
      detail: `Concierge engine: ${classification.intent} (${classification.confidence})${classification.entities.pickupTime ? ` pickup ${classification.entities.pickupTime}` : ''}; other intents: ${classification.secondaryIntents.join(', ') || 'none'}`,
      reply,
    };
  }

  // 3. The vehicle the message is about (FLEET FIRST).
  const mention = resolveVehicleMention(message, k.fleet);
  const kinds = detectFleetQuestion(original);

  // 3b. Driver details being collected: anything that is not a question is the answer to what was asked.
  if (input.progress.stage === 'NEEDS_ELIGIBILITY_INFO' && !isRealQuestion(original) && !TOTAL_RE.test(original)) {
    return { kind: 'PIPELINE' };
  }
  // 3c. A quote is out: questions about its price, deposit or VAT are answered by the quote itself.
  if (
    phase === ConversationPhase.QUOTED &&
    mention.kind === 'NONE' &&
    (kinds.includes('PRICE') || ['DEPOSIT', 'VAT'].includes(detectPolicyTopic(original) ?? ''))
  ) {
    return { kind: 'PIPELINE' };
  }

  if (mention.kind === 'NOT_IN_FLEET') {
    return { kind: 'REPLY', stage: ConciergeStage.ANSWER, text: notInFleetReply(mention, k.fleet, k.profile) };
  }

  // 4. Plain fleet questions with no car named.
  if (kinds.includes('LIST') && mention.kind !== 'MODEL') {
    return { kind: 'REPLY', stage: ConciergeStage.ANSWER, text: fleetListReply(k.fleet) };
  }

  // 4b. The booking already in progress: what the customer gave, and its total.
  const progress = await bookingProgressReply(u, original, mention, kinds);
  if (progress) return progress;

  // 5. Delivery and places.
  const place = matchLocation(message, k.profile);
  const ownDates = dateReader.extract(original, { referenceDate: new Date(), timezone: TZ });
  const statesDates = Boolean(ownDates.pickupDate || ownDates.returnDate || ownDates.duration);
  // A booking message that merely names a drop-off place ("... pickup Marina, drop-off Sharjah airport")
  // is booking detail, not a delivery question.
  const deliveryAsked =
    DELIVERY_WORDS.test(original) ||
    (classification.intent === FrontDoorIntent.DELIVERY_PICKUP && !statesDates);
  const placeWanted = place.kind !== 'UNKNOWN' && (WANT_AT_PLACE.test(original) || words <= 5);
  if (deliveryAsked || (placeWanted && mention.kind !== 'MODEL')) {
    if (place.kind === 'UNKNOWN' && !deliveryAsked) {
      // fall through to other rules
    } else if (place.kind === 'UNKNOWN') {
      // A delivery asked for a place the gazetteer does not know: Google Maps (when configured) tries it;
      // otherwise the customer is asked once for the exact area or a pin — never a guess about distance.
      // A place outside the UAE ("drop it to Muscat airport") is not a pin to ask for: say so.
      const abroad = await findMessageProblem(ctx, original);
      if (abroad?.kind === 'UNSUPPORTED_LOCATION') {
        return { kind: 'REPLY', stage: ConciergeStage.ANSWER, text: await problemText(abroad, async () => '') };
      }
      const decision = await deliveryDecisionFor(ctx, k, input, message);
      // The fee table is added only when the customer actually asked about fees.
      const fees = detectPolicyTopics(original).includes('DELIVERY_FEES')
        ? answerPolicy('how much is delivery fee', policyContext(k))
        : null;
      return {
        kind: 'REPLY',
        stage: ConciergeStage.ANSWER,
        text:
          decision.kind === 'NEEDS_PIN' && fees
            ? `${deliveryText(decision, k, input)} ${fees.text}`
            : deliveryText(decision, k, input),
      };
    } else {
      const decision = await deliveryDecisionFor(ctx, k, input, message);
      const inBooking = phase === ConversationPhase.COLLECTING;
      // Mid-booking, a place that works is also the booking's pickup place: the pipeline carries on
      // after the fee note. A place that does not work must not continue.
      if (decision.kind === 'DELIVERY_POSSIBLE' && inBooking && !deliveryAsked) {
        return {
          kind: 'REPLY',
          stage: ConciergeStage.ANSWER,
          prefix: true,
          text: deliveryNoteText(decision, k, seedOf(input)),
        };
      }
      if (decision.kind === 'BRANCH_PICKUP' && inBooking) return { kind: 'PIPELINE' };
      // "price of Urus and G63 and delivery to JBR": the prices are answered too, not only the delivery.
      const priced =
        mention.kind === 'MODEL' && (kinds.includes('PRICE') || /\b(?:price|rate|kitne|kitna|cost)\b/i.test(original))
          ? `${priceListReply(mention.models)}\n\n`
          : '';
      return { kind: 'REPLY', stage: ConciergeStage.ANSWER, text: `${priced}${deliveryText(decision, k, input)}` };
    }
  }

  // 6. Policy and FAQ (age, licence, deposit, payment, travel, VAT ...) — only when it is a question:
  // "I hold a UAE licence and can provide my passport" is the customer's own details, not a question.
  // A bare topic phrase ("minimum driver age for the Urus") is a question too; a sentence about oneself is not.
  const topicPhrase = !FIRST_PERSON_RE.test(original) && detectPolicyTopics(original).length > 0;
  if (isQuestionLike(original) || topicPhrase) {
    if (mention.kind !== 'MODEL' || kinds.length === 0 || detectPolicyTopics(original).length > 0) {
      const policy = answerPolicies(original, policyContext(k));
      // A question asked together with booking details ("Urus kal Marina, and is card accepted?"): the
      // answer goes first and the booking steps carry on with whatever is still missing.
      const alsoBooking = statesDates || (place.kind !== 'UNKNOWN' && mention.kind === 'MODEL');
      if (policy) return policyDecision(policy, asNote(input, phase).prefix === true || alsoBooking);
    } else {
      const policy = answerPolicy(original, policyContext(k));
      if (
        policy &&
        /\b(?:age|old|licen[cs]e|passport|deposit)\b/i.test(original) &&
        /\b(?:i am|i'?m|im)\s*\d{2}\b|\bage\b/i.test(original)
      ) {
        return policyDecision(policy, asNote(input, phase).prefix === true);
      }
    }
  }

  // 6b. Something in this message cannot be used (a date that does not exist or has passed, a place outside
  // the UAE or beyond the delivery rule): say what, instead of describing the car.
  const problem = input.progress.stage === 'NEEDS_ELIGIBILITY_INFO' ? null : await findMessageProblem(ctx, original);
  if (problem) {
    const text = await problemText(problem, async () => {
      const decision = await deliveryDecisionFor(ctx, k, input, original);
      return decision.kind === 'TOO_FAR'
        ? deliveryText(decision, k, input)
        : `Sorry, that place is further than we deliver (up to ${k.profile.delivery.maxRoadKm} km from a branch). Would you like to collect the car from one of our branches instead?`;
    });
    return { kind: 'REPLY', stage: ConciergeStage.ANSWER, text };
  }

  // 7. Cars: named, or asked about in general.
  const contextModel = modelOfRow(k, input.resolvedVehicleId ?? input.collected.vehicle?.id ?? null);
  const vehicleDecision = await vehicleReply(u, message, mention, kinds, contextModel, classification);
  if (vehicleDecision) return vehicleDecision;

  // 8. Greetings, thanks, who-are-you, small talk.
  if (IDENTITY_RE.test(original)) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      text: `I'm ${k.profile.brand}'s AI concierge, and our team is here too if you'd rather speak to a person. How can I help — a car, dates or delivery?`,
    };
  }
  if (WEATHER_RE.test(original)) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      text: "I can't check the weather, but I can help you pick the right car. Are you after an SUV, a sports car or something more luxurious?",
    };
  }
  if (JOKE_RE.test(original) && words <= 8) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      text: "I'll leave the jokes to the professionals, but I can find you a car that is no joke. Are you after an SUV or a sports car?",
    };
  }
  if (WRONG_NUMBER_RE.test(original)) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      text: `No problem at all, thank you for letting me know. If you ever need a luxury car in the UAE, ${k.profile.brand} is here.`,
    };
  }
  if (VOICE_RE.test(original)) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      text: "I can't play voice notes here, sorry. Could you type it for me: the car, your dates and the pickup place? You can also share a location pin.",
    };
  }
  if (isNoise(original)) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      text: "I couldn't read that one. I can help with our cars, prices, availability and delivery. What would you like to know?",
    };
  }
  const note = asNote(input, phase);
  if (THANKS_RE.test(original) && words <= 8) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      ...note,
      text: note.prefix
        ? 'My pleasure!'
        : `My pleasure! ${teamNote(input)}Is there anything else I can help with — a car, dates or delivery?`,
    };
  }
  if (BYE_RE.test(original)) {
    return { kind: 'REPLY', stage: ConciergeStage.ANSWER, text: `Thank you for contacting ${k.profile.brand}. Have a great day!` };
  }
  if (HOW_ARE_YOU_RE.test(original)) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      text: "I'm doing great, thank you! How can I help — a car, dates, a price or delivery?",
    };
  }
  if (classification.intent === FrontDoorIntent.GREETING && classification.confidence >= 0.75) {
    return {
      kind: 'REPLY',
      stage: ConciergeStage.ANSWER,
      ...note,
      text: note.prefix
        ? 'Hello again!'
        : `${greeting(k, input.turns.some((turn) => turn.role === 'assistant'), seedOf(input))}${teamNote(input) ? ` ${teamNote(input).trim()}` : ''}`,
    };
  }

  // 9. A booking detail: the booking steps answer.
  if (looksLikeBookingDetail(original, k, phase, classification)) {
    // "I want to rent a car" with nothing underway yet: start the booking with real suggestions.
    if (
      input.missingInfoStatus === 'NOT_APPLICABLE' &&
      (classification.intent === FrontDoorIntent.BOOKING ||
        classification.intent === FrontDoorIntent.AVAILABILITY) &&
      classification.confidence >= 0.75
    ) {
      const picks = popularModels(k.fleet, k.profile, 3, { onlyAvailable: true });
      return {
        kind: 'REPLY',
        stage: ConciergeStage.ANSWER,
        text:
          `Happy to help you rent a car! ${picks.length > 0 ? `Our most popular right now: ${joinList(picks.map((m) => `${m.name} (${money(m.dailyRate, m.currency)}/day)`))}. ` : ''}` +
          'Which car would you like, and for which dates and pickup place?',
      };
    }
    return { kind: 'PIPELINE' };
  }

  return { kind: 'UNKNOWN' };
}

/** While a person owns the case, small talk reminds the customer they are looked after. */
function teamNote(input: EngineInput): string {
  return input.progress.stage === 'ESCALATED_WAITING'
    ? 'Our team is looking after your booking and will reply here in this chat. '
    : '';
}

function policyContext(k: Knowledge) {
  return {
    profile: k.profile,
    fleet: k.fleet,
    minAgeByTier: k.policy.minAgeByTier,
    policyMinAge: k.policy.policyMinAge,
    vatPercent: k.policy.vatPercent,
    defaultDeposit: k.policy.defaultDeposit ?? null,
    configured: k.policy.configured,
  };
}

function policyDecision(answer: PolicyAnswer, inBooking: boolean): Decision {
  return {
    kind: 'REPLY',
    stage: answer.kind === 'UNCONFIGURED' ? ConciergeStage.UNCONFIGURED : ConciergeStage.ANSWER,
    text: answer.text,
    fixed: true,
    // Answered while a booking is open: the booking's own pending question follows the answer.
    ...(inBooking && answer.kind === 'ANSWER' ? { prefix: true } : {}),
  };
}

/**
 * While booking details are still being collected, an answer to a side question goes in front of
 * the booking's own pending question instead of replacing it — the customer's progress is never lost.
 */
function asNote(input: EngineInput, phase: ConversationPhaseValue): { prefix?: boolean } {
  const collecting =
    phase === ConversationPhase.COLLECTING &&
    (input.progress.stage === 'STEP4_PENDING' || input.progress.stage === 'NEEDS_ELIGIBILITY_INFO');
  return collecting ? { prefix: true } : {};
}

/** Days stated in the message ("3 days", "a week"): used for price estimates. */
function statedDays(message: string): number | null {
  const duration = extractStatedDuration(message);
  if (!duration) return null;
  if (duration.unit === 'hour' || duration.unit === 'minute') return null; // rentals are per day
  return duration.unit === 'week' ? duration.amount * 7 : duration.unit === 'month' ? duration.amount * 30 : duration.amount;
}

async function vehicleReply(
  u: UnderstandContext,
  message: string,
  mention: ReturnType<typeof resolveVehicleMention>,
  kinds: ReturnType<typeof detectFleetQuestion>,
  contextModel: FleetModel | null,
  classification: FrontDoorClassification,
): Promise<Decision | null> {
  const { ctx, k, input, phase } = u;
  const original = u.message;
  const reply = (text: string, extra: Partial<Extract<Decision, { kind: 'REPLY' }>> = {}): Decision => ({
    kind: 'REPLY',
    stage: ConciergeStage.ANSWER,
    text,
    ...extra,
  });
  const dates = input.collected;
  const days = statedDays(original);
  const own = dateReader.extract(original, { referenceDate: new Date(), timezone: TZ });
  /** This very message carries dates (so the pipeline's dates are not an earlier, separate step). */
  const msgHasDates = Boolean(own.pickupDate || own.returnDate || own.duration);

  // A rental length with no start date ("3 din ke liye"), or in hours (rentals are per day).
  const pricingAsked = kinds.includes('PRICE') && !/\b(?:ghant\w*|hours?|hrs?)\b/i.test(original);
  if (!(own.pickupDate && own.returnDate) && !pricingAsked) {
    const named = mention.kind === 'MODEL' && mention.models.length === 1 ? mention.models[0]! : contextModel;
    const lengthReply = durationReply(
      original,
      named,
      Boolean(dates.pickupDate || own.pickupDate),
      named ? (length) => estimateText(ctx, k, named, length) : undefined,
    );
    if (lengthReply) return reply(lengthReply, asNote(input, phase));
  }

  // The car in the booking, and dates just given: availability and an estimate, then ask for the place.
  if (
    mention.kind === 'NONE' &&
    contextModel &&
    msgHasDates &&
    dates.pickupDate &&
    dates.returnDate &&
    !dates.pickupLocation
  ) {
    const text = await availabilityReply(
      ctx,
      k,
      contextModel,
      new Date(dates.pickupDate),
      new Date(dates.returnDate),
      undefined,
      seedOf(input),
    );
    if (text) return reply(text);
  }

  // Photos: while a booking is being collected the pipeline's reply carries the photos (existing path).
  if (isPhotoRequest(original) && phase !== ConversationPhase.COLLECTING) {
    const photos = await buildPhotoReply(
      { prisma: ctx.prisma },
      { tenantId: ctx.config.DEFAULT_TENANT_ID, message, resolvedVehicleId: input.resolvedVehicleId },
    );
    if (photos) {
      const next = photos.attachments.length > 0 ? "\n\nTell me your dates and I'll check availability." : '';
      return reply(`${photos.text}${next}`, { attachments: photos.attachments });
    }
  }
  if (isPhotoRequest(original)) return null;

  if (mention.kind === 'MODEL') {
    if (mention.models.length > 1 && (kinds.includes('COMPARE') || /\b(?:and|&|or|vs|versus)\b/i.test(original))) {
      return reply(compareReply(mention.models));
    }
    const bookingStatement =
      !kinds.length &&
      (classification.intent === FrontDoorIntent.BOOKING || /\b(?:book|rent|hire|reserve)\b/i.test(original));
    const model = mention.models.length === 1 ? mention.models[0]! : null;

    if (model) {
      // Dates were given but the booking steps rejected them (in the past, return before pickup): they
      // explain what is wrong and ask again.
      if ((own.pickupDate && !dates.pickupDate) || (own.returnDate && !dates.returnDate)) {
        return { kind: 'PIPELINE' };
      }
      const bothDates = dates.pickupDate && dates.returnDate;
      // Everything is known (car, dates, place): the booking steps run availability, eligibility and the quote.
      if (bothDates && dates.pickupLocation && dates.vehicle) return { kind: 'PIPELINE' };
      // A car together with a date or a place ("Urus kal Dubai Marina"): a booking begun, so the booking
      // steps ask only for what is still missing.
      if (
        kinds.length === 0 &&
        !days &&
        !bothDates &&
        (own.pickupDate || own.returnDate || matchLocation(message, k.profile).kind !== 'UNKNOWN')
      ) {
        return { kind: 'PIPELINE' };
      }
      // A car named again while a booking is already being filled in carries on with that booking.
      if (
        phase === ConversationPhase.COLLECTING &&
        (dates.pickupDate || dates.returnDate || dates.pickupLocation) &&
        !msgHasDates &&
        kinds.length === 0
      ) {
        return { kind: 'PIPELINE' };
      }
      if (kinds.includes('COLOURS') && !kinds.includes('PRICE')) return reply(coloursReply([model]), asNote(input, phase));
      if (kinds.includes('SEATS') && !kinds.includes('PRICE')) return reply(seatsReply([model]), asNote(input, phase));
      if (bothDates && (kinds.includes('AVAILABILITY') || kinds.includes('PRICE') || bookingStatement || kinds.length === 0)) {
        const text = await availabilityReply(
          ctx,
          k,
          model,
          new Date(dates.pickupDate!),
          new Date(dates.returnDate!),
          mention.colour,
          seedOf(input),
        );
        if (text) return reply(text);
      }
      if (days && (kinds.includes('PRICE') || kinds.length === 0 || bookingStatement)) {
        const estimate = estimateText(ctx, k, model, days, mention.colour);
        if (estimate) {
          return reply(`${estimate}\n\nSend me your pickup date and place and I will check availability and prepare your exact quote.`);
        }
      }
      if (kinds.includes('PRICE')) return reply(priceListReply([model]));
    }
    if (mention.models.length > 1 && kinds.includes('PRICE')) return reply(priceListReply(mention.models));
    if (mention.models.length > 1 && kinds.includes('COLOURS')) return reply(coloursReply(mention.models));
    // Naming a car (or asking if it is there): the fleet answers with its details.
    // While the booking steps are waiting for an answer, the car's details go in front of their question.
    const note = asNote(input, phase);
    return reply(foundModelsReply(mention, k.fleet, k.profile, { askNext: !note.prefix, seed: seedOf(input) }), note);
  }

  if (mention.kind === 'BRAND') {
    if (kinds.includes('COLOURS')) return reply(coloursReply(mention.models));
    if (kinds.includes('PRICE')) return reply(priceListReply(mention.models));
    if (kinds.includes('SEATS')) return reply(seatsReply(mention.models));
    return reply(brandReply(mention));
  }

  // "any 7 seater?": the cars with at least that many seats.
  const seatCount = /\b(\d{1,2})\s*[- ]?(?:seater|seats?|sitter)\b/i.exec(original);
  if ((mention.kind === 'NONE' || mention.kind === 'CATEGORY') && seatCount && Number(seatCount[1]) >= 5) {
    return reply(seatFilterReply(k.fleet, Number(seatCount[1]), k.profile));
  }

  if (mention.kind === 'CATEGORY') {
    if (looksLikeBookingDetail(original, k, phase, classification) && phase === ConversationPhase.COLLECTING) {
      return { kind: 'PIPELINE' };
    }
    return reply(categoryReply(mention, k.fleet, k.profile));
  }

  // No car named: questions about "it" (the car already in the booking) or about the fleet in general.
  if (kinds.includes('CHEAPEST')) return reply(extremeReply(k.fleet, 'cheapest'));
  if (kinds.includes('PRICIEST')) return reply(extremeReply(k.fleet, 'priciest'));
  if (kinds.includes('RECOMMEND')) {
    return reply(recommendReply(detectRecommendNeed(original), k.fleet, k.profile));
  }
  if (contextModel && (kinds.includes('COLOURS') || kinds.includes('SEATS') || kinds.includes('PRICE'))) {
    if (kinds.includes('COLOURS')) return reply(coloursReply([contextModel]));
    if (kinds.includes('SEATS')) return reply(seatsReply([contextModel]));
    if (days) {
      const estimate = estimateText(ctx, k, contextModel, days);
      if (estimate) return reply(estimate);
    }
    return reply(priceListReply([contextModel]));
  }
  if (kinds.includes('PRICE') && !looksLikeBookingDetail(original, k, phase, classification)) {
    const popular = popularModels(k.fleet, k.profile, 4, { onlyAvailable: true });
    return reply(`${priceListReply(popular)}\n\nWhich car do you have in mind?`);
  }
  if (kinds.includes('AVAILABILITY') && !looksLikeBookingDetail(original, k, phase, classification)) {
    const popular = popularModels(k.fleet, k.profile, 4, { onlyAvailable: true });
    return reply(
      popular.length > 0
        ? `Cars free right now: ${joinList(popular.map((m) => `${m.name} (${money(m.dailyRate, m.currency)}/day)`))}. Tell me which one and your dates, and I will check it.`
        : 'Tell me which car and your dates and I will check availability for you.',
    );
  }
  if (kinds.includes('COLOURS') || kinds.includes('SEATS')) {
    return reply('Which car do you mean? Tell me the model, or reply LIST to see every car in our fleet.');
  }
  return null;
}

/**
 * Questions about the booking in progress: when does it return, which car is it, and what is the total
 * for the dates already given. Answered from the collected booking and the pricing rules, never from
 * the fleet list (which would ask for dates the customer already gave).
 */
async function bookingProgressReply(
  u: UnderstandContext,
  original: string,
  mention: ReturnType<typeof resolveVehicleMention>,
  kinds: ReturnType<typeof detectFleetQuestion>,
): Promise<Decision | null> {
  const { ctx, k, input, phase } = u;
  const c = input.collected;
  const model = modelOfRow(k, input.resolvedVehicleId ?? c.vehicle?.id ?? null);
  const answer = (text: string): Decision => ({
    kind: 'REPLY',
    stage: ConciergeStage.ANSWER,
    text,
    ...asNote(input, phase),
  });
  if (phase === ConversationPhase.QUOTED) return null; // the issued quote answers its own questions

  const pickupAt = c.pickupDate ? new Date(c.pickupDate) : null;
  const returnAt = c.returnDate ? new Date(c.returnDate) : null;
  const place = c.pickupLocation?.normalized ?? null;
  const asksReturn = RETURN_WHEN_RE.test(original);
  const asksPickup = PICKUP_WHEN_RE.test(original);
  if (asksReturn || asksPickup || STATE_RE.test(original)) {
    if (!model && !pickupAt && !returnAt && !place) return null; // nothing booked yet: the other rules answer
    if (asksReturn) {
      return answer(
        returnAt
          ? `Your return is on ${formatDay(returnAt)}${pickupAt ? ` (pickup ${formatDay(pickupAt)})` : ''}. Shall I change it?`
          : 'I do not have a return date yet. Which day would you like to return the car?',
      );
    }
    if (asksPickup) {
      return answer(
        pickupAt
          ? `Your pickup is on ${formatDay(pickupAt)}${place ? ` in ${place}` : ''}. Shall I change it?`
          : 'I do not have a pickup date yet. Which day should we start?',
      );
    }
    const summary = stateSummary(model, pickupAt, returnAt, place);
    if (summary) return answer(`So far I have: ${summary}. What would you like to change?`);
  }

  // "total kitna", "price?" once car and dates are known: the estimate for those dates.
  const wantsTotal = kinds.includes('PRICE') || TOTAL_RE.test(original);
  if (wantsTotal && model && pickupAt && returnAt && mention.kind === 'NONE') {
    let deliveryNote: string | null = null;
    if (place) {
      const decision = await checkDelivery({ message: place, whenIso: c.pickupDate }, k.profile, mapsFor(ctx));
      if (decision.kind === 'DELIVERY_POSSIBLE') {
        deliveryNote = `Delivery to ${decision.destination}: ${describeFee(decision.fee, k.profile.currency)}, charged in addition.`;
      } else if (decision.kind === 'BRANCH_PICKUP') {
        deliveryNote = `Picking up from our ${branchLabel(decision.branch.name)} branch has no delivery fee.`;
      }
    }
    const text = datedEstimateReply(ctx, k, model, pickupAt, returnAt, deliveryNote);
    if (text) return answer(text);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

function geminiContext(ctx: AppContext, k: Knowledge, input: EngineInput, message: string): GeminiContext {
  return {
    ai: ctx.aiProvider,
    brand: k.profile.brand,
    factsText: buildFactsText(k, input.collected),
    knownTopics: k.knownTopics,
    turns: input.turns.map((turn) => ({ role: turn.role, content: turn.content })),
    message,
  };
}

async function optionsReply(
  ctx: AppContext,
  k: Knowledge,
  input: EngineInput,
  message: string,
  stage: 1 | 2,
): Promise<Decision> {
  const summary = chatSummary(k, input);
  const asked = optionsAlreadyAsked(input.turns);
  const generated = await makeOptions(geminiContext(ctx, k, input, message), stage, asked);

  if (stage === 1) {
    const base = stageOneOptions(k.fleet, k.profile, summary, asked);
    // Gemini's option 1 (a fleet answer) and 2-3 (likely meanings) replace the deterministic ones when valid.
    const options = [generated[0] ?? base[0]!, generated[1] ?? base[1]!, generated[2] ?? base[2]!, OPTION_REPEAT];
    return {
      kind: 'REPLY',
      stage: ConciergeStage.OPTIONS_1,
      keepEnglish: true,
      text: formatOptions(
        pickVariant(`${input.conversationId}:${input.turns.length}`, [
          STAGE_ONE_INTRO,
          'I want to be sure I help properly. Did you mean one of these?',
          'Hmm, I am not certain I followed that. Did you mean one of these?',
        ]),
        options,
      ),
    };
  }
  const base = stageTwoOptions(summary, asked);
  const options = [generated[0] ?? base[0]!, generated[1] ?? base[1]!, generated[2] ?? base[2]!, OPTION_TEAM];
  return {
    kind: 'REPLY',
    stage: ConciergeStage.OPTIONS_2,
    keepEnglish: true,
    text: formatOptions(STAGE_TWO_INTRO, options),
  };
}

/**
 * A place the customer just gave that we can serve: the fee (or "collect from our branch") goes in front
 * of the booking steps' own question, so the delivery rule is visible on every path — one message with
 * the dates, a later turn, or a correction. A place beyond the rule never gets here (it is a problem).
 */
async function newPlaceNote(
  ctx: AppContext,
  k: Knowledge,
  input: EngineInput,
  phase: ConversationPhaseValue,
  message: string,
): Promise<Decision | null> {
  if (phase === ConversationPhase.QUOTED || phase === ConversationPhase.ESCALATED) return null;
  if (matchLocation(message, k.profile).kind === 'UNKNOWN') return null;
  const decision = await deliveryDecisionFor(ctx, k, input, message);
  const stated =
    decision.kind === 'DELIVERY_POSSIBLE'
      ? decision.destination
      : decision.kind === 'BRANCH_PICKUP'
        ? branchLabel(decision.branch.name)
        : null;
  if (!stated) return null;
  // Said already a moment ago: do not repeat the same note.
  const recent = input.turns.filter((turn) => turn.role === 'assistant').slice(-2);
  if (recent.some((turn) => turn.content.includes(stated) && /deliver|collect|branch/i.test(turn.content))) return null;
  const text =
    decision.kind === 'DELIVERY_POSSIBLE'
      ? deliveryNoteText(decision, k, seedOf(input))
      : pickVariant(seedOf(input), [
          `You can collect the car from our ${stated} branch, with no delivery fee.`,
          `Our ${stated} branch is right there: collecting the car from it costs no delivery fee.`,
          `No delivery fee if you pick the car up from our ${stated} branch.`,
        ]);
  return { kind: 'REPLY', stage: ConciergeStage.ANSWER, prefix: true, text };
}

type Ladder = 'FIRST' | 'AFTER_OPTIONS_1' | 'AFTER_OPTIONS_2';

async function decide(ctx: AppContext, k: Knowledge, input: EngineInput): Promise<Decision> {
  const phase = phaseOf(input.progress, input.collected);
  const previous = lastAssistant(input.turns);
  const lastStage = previous?.stage ?? '';
  const customerText = input.message.trim();
  let message = customerText;
  let ladder: Ladder =
    lastStage === ConciergeStage.OPTIONS_2
      ? 'AFTER_OPTIONS_2'
      : lastStage === ConciergeStage.OPTIONS_1 || lastStage === ConciergeStage.REPEAT
        ? 'AFTER_OPTIONS_1'
        : 'FIRST';

  // The customer is answering a question we put to them in the options.
  if ((lastStage === ConciergeStage.OPTIONS_1 || lastStage === ConciergeStage.OPTIONS_2) && previous) {
    const options = parseNumberedOptions(previous.content);
    const pick = parseOptionPick(customerText, 4);
    const wantsTeam = wantsTeamByWords(customerText) || (pick === 4 && lastStage === ConciergeStage.OPTIONS_2);
    if (wantsTeam) {
      return {
        kind: 'HANDOFF',
        reason: EscalationReason.AI_UNABLE_TO_PROCEED,
        tier: EscalationTier.T2,
        detail: 'Customer chose CONTACT MY TEAM',
        reply: TEAM_HANDOFF_TEXT,
      };
    }
    if ((pick === 4 && lastStage === ConciergeStage.OPTIONS_1) || wantsToRepeat(customerText)) {
      return { kind: 'REPLY', stage: ConciergeStage.REPEAT, text: ASK_REPEAT_TEXT, keepEnglish: false };
    }
    if (pick !== null && options[pick - 1]) {
      message = options[pick - 1]!;
      // Option 1 of the first list is a fleet suggestion: choosing it means "yes, that car".
      if (lastStage === ConciergeStage.OPTIONS_1 && pick === 1) {
        const mention = resolveVehicleMention(expandVehicleAliases(message, k.fleet), k.fleet);
        if (mention.kind === 'MODEL') {
          return {
            kind: 'REPLY',
            stage: ConciergeStage.ANSWER,
            text: foundModelsReply(mention, k.fleet, k.profile),
          };
        }
      }
      ladder = 'FIRST'; // an option the customer picked is understood on its own terms
    } else if (/^(?:yes|yeah|yep|ok|okay|sure|haan|han|ji|no|nope|nahi|nahin|hmm)[.! ]*$/i.test(customerText)) {
      // A bare yes/no does not choose between options: ask again, same options, same stage.
      return {
        kind: 'REPLY',
        stage: lastStage,
        keepEnglish: true,
        text: `Please reply with the number of the option you mean (1, 2, 3 or 4):\n${options.map((o, i) => `${i + 1}) ${o}`).join('\n')}`,
      };
    }
  }

  const understood = await understandWithRules({ ctx, k, input, phase, message });
  if (understood.kind === 'PIPELINE') {
    const note = await newPlaceNote(ctx, k, input, phase, customerText);
    if (note) return note;
  }
  if (understood.kind !== 'UNKNOWN') return understood;

  // The booking steps moved on because of this very message (driver details read, a quote or the
  // alternatives issued): it was consumed there, so their reply stands — it is not "not understood".
  if (
    ['QUOTE_ISSUED', 'ALTERNATIVES', 'ELIGIBILITY_DECLINED', 'NEEDS_ELIGIBILITY_INFO'].includes(
      input.progress.stage,
    ) &&
    !isRealQuestion(message)
  ) {
    return { kind: 'PIPELINE' };
  }

  // Gemini, with the same databases and the whole chat.
  const gemini = await understand(geminiContext(ctx, k, input, message));
  ctx.logger.info(
    {
      requestId: input.requestId,
      conversationId: input.conversationId,
      engine: { source: 'gemini', ladder, understood: gemini.understood, action: gemini.understood ? gemini.action : undefined },
    },
    'concierge engine gemini turn',
  );
  if (gemini.understood) {
    if (gemini.action === 'ANSWER') {
      return { kind: 'REPLY', stage: ConciergeStage.ANSWER, text: gemini.answer };
    }
    if (gemini.action === 'CONTINUE_BOOKING') return { kind: 'PIPELINE' };
    const spec = highRiskHandOff(gemini.intent, undefined);
    return {
      kind: 'HANDOFF',
      reason: spec?.reason ?? EscalationReason.AI_UNABLE_TO_PROCEED,
      tier: spec?.tier ?? EscalationTier.T2,
      detail: `Concierge engine (gemini): ${gemini.intent}. ${gemini.reason}`,
      reply: spec?.reply ?? TEAM_HANDOFF_TEXT,
    };
  }

  // Still not understood: the options ladder.
  if (ladder === 'FIRST') return optionsReply(ctx, k, input, message, 1);
  if (ladder === 'AFTER_OPTIONS_1') return optionsReply(ctx, k, input, message, 2);
  return {
    kind: 'HANDOFF',
    reason: EscalationReason.AI_UNABLE_TO_PROCEED,
    tier: EscalationTier.T2,
    detail: `Concierge engine: not understood after two rounds of options. ${gemini.reason}`,
    reply: TEAM_HANDOFF_TEXT,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Returns the reply to send instead of the booking pipeline's own (or in front of it), or `null`
 * to let the pipeline's reply stand.
 */
export async function runConciergeEngine(
  ctx: AppContext,
  input: EngineInput,
): Promise<EngineOverride | null> {
  // A person was brought in by the booking steps in THIS very turn (quote accepted, complaint, ...):
  // that fixed, reviewed hand-over wording is the reply.
  if (input.progress.stage === 'HUMAN_REVIEW' && input.progress.handoffRecorded) return null;

  const k = await loadKnowledge(ctx); // STEP 0 — before any rule
  const decision = await decide(ctx, k, input);
  ctx.logger.info(
    {
      requestId: input.requestId,
      conversationId: input.conversationId,
      engine: { decision: decision.kind, stage: decision.kind === 'REPLY' ? decision.stage : undefined },
    },
    'concierge engine decision',
  );

  switch (decision.kind) {
    case 'PIPELINE': {
      // A person owns the case and the customer only added a detail: acknowledge in the same chat.
      if (input.progress.stage === 'ESCALATED_WAITING') {
        const text = await localize(
          ctx,
          k,
          'Noted. I have added that for our team, and they will reply in this chat.',
          input.message,
        );
        return { text, escalated: false, stage: ConciergeStage.ESCALATED_NOTE };
      }
      return null;
    }
    case 'UNKNOWN':
      return null;
    case 'HANDOFF': {
      const done = await carryOutHandOff(ctx, input, decision);
      if (!done) return null;
      return { ...done, text: await localize(ctx, k, done.text, input.message) };
    }
    case 'REPLY': {
      const worded = decision.keepEnglish
        ? { text: decision.text, ai: false }
        : await polish(ctx, k, input, decision.text, decision.fixed === true || decision.prefix === true);
      return {
        text: worded.text,
        escalated: false,
        stage: decision.stage,
        ...(worded.ai ? { aiWorded: true } : {}),
        ...(decision.attachments ? { attachments: decision.attachments } : {}),
        ...(decision.prefix ? { continuePipeline: true } : {}),
      };
    }
  }
}

