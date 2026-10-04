import {
  CLARIFY_STAGE_FIRST,
  CLARIFY_STAGE_SECOND,
  CONTACT_TEAM_LABEL,
  formatClarifyMessage,
  isClarifyStage,
  LOCATION_KEYWORDS,
  parseClarifyOptions,
  pickOptions,
  repeatQuestionOption,
  sanitizeSuggestions,
  type BookingProgressFlags,
  type HedgedKind,
} from '@ai-concierge/ai';
import {
  findOpenConversationForCustomer,
  findOutboundMessagesForConversation,
  type Channel,
  type PrismaClient,
} from '@ai-concierge/db';
import type { CollectedBookingInfo, TenantId } from '@ai-concierge/domain';

/**
 * The "not understood" half of the concierge's flow, kept free of the model and of I/O so that every
 * wording and every rule here can be tested on its own:
 *
 *   first miss   -> 2 probable meanings (from the chat) + 1 question the fleet database answers + "Contact my team"
 *   second miss  -> 3 new probable meanings + "Contact my team"
 *   third miss   -> a person takes over the same chat
 *
 * The round is read back from the stage of the last message we sent, so nothing new is stored.
 */

export type ClarifyRound = 0 | 1 | 2;

export interface ClarifyContext {
  /** How many rounds of options the customer has already been shown and not resolved. */
  round: ClarifyRound;
  /** The numbered options of the last round, in order; empty when none are open. */
  options: string[];
}

const NO_CLARIFICATION: ClarifyContext = { round: 0, options: [] };

/** Follow-up nudges sent after a clarification must not hide its options from a late reply. */
const FOLLOW_UP_STAGE_PREFIX = 'FOLLOWUP_';
const RECENT_OUTBOUND_LOOKBACK = 6;

export async function loadClarifyContext(
  prisma: PrismaClient,
  tenantId: TenantId,
  channel: Channel,
  customerRef: string,
): Promise<ClarifyContext> {
  const conversation = await findOpenConversationForCustomer(
    prisma,
    tenantId,
    channel,
    customerRef,
  );
  if (!conversation) return NO_CLARIFICATION;
  const recent = await findOutboundMessagesForConversation(
    prisma,
    tenantId,
    conversation.id,
    RECENT_OUTBOUND_LOOKBACK,
  );
  const last = [...recent].reverse().find((row) => !row.stage.startsWith(FOLLOW_UP_STAGE_PREFIX));
  if (!last || !isClarifyStage(last.stage)) return NO_CLARIFICATION;
  return {
    round: last.stage === CLARIFY_STAGE_FIRST ? 1 : 2,
    options: parseClarifyOptions(last.content),
  };
}

export function progressFlags(collected: CollectedBookingInfo): BookingProgressFlags {
  return {
    hasCar: Boolean(collected.vehicle),
    hasDates: Boolean(collected.pickupDate && collected.returnDate),
    hasPlace: Boolean(collected.pickupLocation),
  };
}

/**
 * The one option answered from the database, always shown first: a car's price when a car is
 * chosen, otherwise the cheapest and dearest cars in the fleet. Worded so the rules recognise it as
 * a pricing question, which the fleet search then answers.
 */
export function buildDatabaseQuestion(
  collected: CollectedBookingInfo,
  budgetHint: number | null = null,
): string {
  if (collected.vehicle) {
    return `What is the price of the ${collected.vehicle.make} ${collected.vehicle.model} per day and per hour?`;
  }
  // "I want a car under 400 dollars": the fleet database is searched and the lowest and highest price are told.
  return budgetHint !== null
    ? `I want a car under ${budgetHint} dollars`
    : 'What are the cheapest and most expensive cars per day and per hour?';
}

/** A round dollar ceiling just above the middle of the fleet's daily prices, e.g. 354 -> 400; null for an empty fleet. */
export function budgetHintFor(dailyPricesUsd: readonly number[]): number | null {
  if (dailyPricesUsd.length === 0) return null;
  const sorted = [...dailyPricesUsd].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)]!;
  return Math.max(100, Math.ceil(middle / 100) * 100);
}

const FIRST_INTRO = 'I want to be sure I help with the right thing. Did you mean one of these?';
const SECOND_INTRO = 'Sorry, I still want to be sure I understand you. Did you mean one of these?';

/** The customer picked "Repeat my question in detail": their words back, and what can be done with them. */
export function buildRepeatInDetailReply(original: string): string {
  const quoted = original ? `You wrote: "${original}". ` : '';
  return `${quoted}I couldn't match that to a car, a price, a date or a place yet. In detail, I can: show our cars and their photos; search our fleet by price (for example "I want a car under 300 dollars" and I tell you the lowest and the highest price per day and per hour); or collect your pickup date, return date and pickup place. Please tell me which one you need, in a few words.`;
}

export const TEAM_AFTER_OPTIONS_TEXT =
  "I'm sorry I haven't been able to work out what you need, so I've asked a member of our team to take over. They'll reply to you here, in this same chat.";

export interface ClarifyReply {
  text: string;
  stage: typeof CLARIFY_STAGE_FIRST | typeof CLARIFY_STAGE_SECOND;
}

/** The next round of options for a message nobody understood; `null` once two rounds are used up (a person takes over). */
export function buildClarifyReply(input: {
  round: ClarifyRound;
  /** What the model thought the customer might mean. */
  suggestions: readonly string[];
  customerMessage: string;
  collected: CollectedBookingInfo;
  previousOptions: readonly string[];
  /** A round dollar amount for the database option ("I want a car under 400 dollars"). */
  budgetHint?: number | null;
}): ClarifyReply | null {
  if (input.round >= 2) return null;
  const flags = progressFlags(input.collected);
  const suggestions = sanitizeSuggestions(
    input.suggestions,
    input.customerMessage,
    input.previousOptions,
  );
  if (input.round === 0) {
    // 1) the customer's own question, to be repeated in detail  2-3) two probable meanings from the
    // chat  4) one question the fleet database answers ("I want a car under 400 dollars").
    const databaseQuestion = buildDatabaseQuestion(input.collected, input.budgetHint ?? null);
    const probable = pickOptions(suggestions, flags, 2, [databaseQuestion]);
    return {
      text: formatClarifyMessage(
        FIRST_INTRO,
        [repeatQuestionOption(input.customerMessage), ...probable, databaseQuestion],
        false,
      ),
      stage: CLARIFY_STAGE_FIRST,
    };
  }
  // Second miss: three new probable meanings, and the team as the last option.
  const probable = pickOptions(suggestions, flags, 3, input.previousOptions);
  return { text: formatClarifyMessage(SECOND_INTRO, probable), stage: CLARIFY_STAGE_SECOND };
}

const NOT_A_PLACE = new Set(['dubai', 'dxb']);
const MAX_HEDGE_CHOICES = 3;

function titleCase(place: string): string {
  return place === 'jbr'
    ? 'JBR'
    : place
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export interface HedgeReply {
  text: string;
  /** Set when the reply carries numbered options the customer can pick from. */
  stage?: typeof CLARIFY_STAGE_FIRST;
}

/**
 * "I think Range Rover" / "maybe pick up in Dubai" is a guess, not a choice. Nothing is recorded; the
 * customer is told they have not selected anything yet and asked to pick, with the real choices below.
 */
export function buildHedgeReply(input: {
  kinds: readonly HedgedKind[];
  collected: CollectedBookingInfo;
  /** Distinct "Make Model" names in the fleet. */
  carNames: readonly string[];
}): HedgeReply | null {
  const { kinds, collected } = input;
  if (kinds.length === 0) return null;
  const parts: string[] = [];
  if (kinds.includes('CAR')) {
    parts.push(
      collected.vehicle
        ? `I've kept your current choice, the ${collected.vehicle.make} ${collected.vehicle.model}. If you'd like a different car, please tell me clearly which one.`
        : "You haven't selected a car yet. Please select the car you'd like.",
    );
  }
  if (kinds.includes('PLACE')) {
    parts.push(
      collected.pickupLocation
        ? `I've kept your current pickup place, ${titleCase(collected.pickupLocation.normalized)}. If you'd like a different one, please tell me clearly where.`
        : "You haven't selected a pickup place yet. Please select a place.",
    );
  }
  if (kinds.includes('DATE')) {
    parts.push(
      'Please confirm your pickup and return dates clearly, for example "15 to 19 October", so I can check them against today\'s calendar.',
    );
  }
  const intro = parts.join(' ');

  const choices = kinds.includes('CAR')
    ? input.carNames.slice(0, MAX_HEDGE_CHOICES).map((name) => `I want the ${name}`)
    : kinds.includes('PLACE')
      ? LOCATION_KEYWORDS.filter((place) => !NOT_A_PLACE.has(place))
          .slice(0, MAX_HEDGE_CHOICES)
          .map((place) => `Pick me up at ${titleCase(place)}`)
      : [];
  if (choices.length === 0) return { text: intro };
  return { text: formatClarifyMessage(intro, choices), stage: CLARIFY_STAGE_FIRST };
}
