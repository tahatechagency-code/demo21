import { levenshteinDistance } from '../step3/levenshtein.js';
import { PRICE_EXTREMES_RE, parsePriceBudget } from './clarify.js';
import { isPhotoRequest } from './photoRequest.js';

/**
 * Layers 1-2 of the concierge front door: a deterministic, whole-message
 * intent classifier that reports what it understood *and how sure it is*.
 * It never acts — the router (`decideRoute`) turns the result into a path:
 * confident -> business logic, uncertain -> Gemini, still unsure -> a person.
 */

export const FrontDoorIntent = {
  GREETING: 'GREETING',
  BOOKING: 'BOOKING',
  AVAILABILITY: 'AVAILABILITY',
  PRICING: 'PRICING',
  PHOTO_REQUEST: 'PHOTO_REQUEST',
  CANCELLATION: 'CANCELLATION',
  MODIFY_BOOKING: 'MODIFY_BOOKING',
  PAYMENT_REFUND: 'PAYMENT_REFUND',
  COMPLAINT_DAMAGE: 'COMPLAINT_DAMAGE',
  DOCUMENTS: 'DOCUMENTS',
  DELIVERY_PICKUP: 'DELIVERY_PICKUP',
  RETURN: 'RETURN',
  FAQ: 'FAQ',
  HUMAN_REQUEST: 'HUMAN_REQUEST',
  CONTINUATION: 'CONTINUATION',
  UNKNOWN: 'UNKNOWN',
} as const;
export type FrontDoorIntentValue = (typeof FrontDoorIntent)[keyof typeof FrontDoorIntent];

/** Money, safety, identity, legal: never executed on an uncertain reading and never without a person. */
export const HIGH_RISK_INTENTS: readonly FrontDoorIntentValue[] = [
  FrontDoorIntent.CANCELLATION,
  FrontDoorIntent.PAYMENT_REFUND,
  FrontDoorIntent.COMPLAINT_DAMAGE,
  FrontDoorIntent.HUMAN_REQUEST,
];

export const ConversationPhase = {
  NO_CONTEXT: 'NO_CONTEXT',
  COLLECTING: 'COLLECTING',
  QUOTED: 'QUOTED',
  ESCALATED: 'ESCALATED',
} as const;
export type ConversationPhaseValue = (typeof ConversationPhase)[keyof typeof ConversationPhase];

export const RequiredAction = {
  CONTINUE_PIPELINE: 'CONTINUE_PIPELINE',
  ANSWER_PRICE: 'ANSWER_PRICE',
  SEND_PHOTOS: 'SEND_PHOTOS',
  ESCALATE_HUMAN: 'ESCALATE_HUMAN',
  ASK_GEMINI: 'ASK_GEMINI',
} as const;
export type RequiredActionValue = (typeof RequiredAction)[keyof typeof RequiredAction];

/** Tunable in one place. */
export const FRONT_DOOR_THRESHOLDS = { high: 0.75, low: 0.5 } as const;

export interface FrontDoorEntities {
  /** 24h HH:MM, e.g. the "19:00" in "move pickup to 7 pm". */
  pickupTime?: string;
  dateWords?: string;
  durationDays?: number;
  /** A daily price ceiling / floor in dollars, e.g. the 300 in "a car under 300 dollars". */
  budgetMax?: number;
  budgetMin?: number;
}

export interface FrontDoorClassification {
  intent: FrontDoorIntentValue;
  confidence: number;
  /** Other intents the same message also carries (multi-intent), strongest first. */
  secondaryIntents: FrontDoorIntentValue[];
  entities: FrontDoorEntities;
  requiredAction: RequiredActionValue;
  conversationPhase: ConversationPhaseValue;
}

export interface FrontDoorContext {
  phase: ConversationPhaseValue;
}

// ---------------------------------------------------------------------------
// Normalisation: case, punctuation, abbreviations, common typos.
// ---------------------------------------------------------------------------

const ABBREVIATIONS: Record<string, string> = {
  pls: 'please',
  plz: 'please',
  u: 'you',
  ur: 'your',
  rnt: 'rent',
  wana: 'want',
  wanna: 'want',
  dayz: 'days',
  helo: 'hello',
  hii: 'hi',
  tmrw: 'tomorrow',
  tmr: 'tomorrow',
  tomorow: 'tomorrow',
  cancle: 'cancel',
  avail: 'available',
  bkng: 'booking',
  pix: 'photo',
  img: 'photo',
  imgs: 'photo',
  pic: 'photo',
  pics: 'photo',
  mercedez: 'mercedes',
  lambo: 'lamborghini',
};

/** Words the rules key on: a longer token close to one of these (and not itself a word) is corrected. */
const VOCABULARY = [
  'cancel',
  'refund',
  'booking',
  'available',
  'availability',
  'price',
  'pricing',
  'rental',
  'reserve',
  'photo',
  'picture',
  'pictures',
  'documents',
  'passport',
  'license',
  'licence',
  'delivery',
  'airport',
  'change',
  'reschedule',
  'postpone',
  'extend',
  'payment',
  'deposit',
  'invoice',
  'complaint',
  'accident',
  'damage',
  'insurance',
  'human',
  'manager',
  'tomorrow',
  'hello',
  'please',
  'return',
  'pickup',
];

export function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}:'\s]+/gu, ' ')
    .replace(/(.)\1{2,}/g, '$1$1')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const direct = ABBREVIATIONS[token];
      if (direct) return direct;
      if (token.length < 5 || VOCABULARY.includes(token)) return token;
      const limit = token.length >= 8 ? 2 : 1;
      const near = VOCABULARY.find(
        (word) =>
          Math.abs(word.length - token.length) <= limit &&
          levenshteinDistance(word, token) <= limit,
      );
      return near ?? token;
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Rules: each intent scores by its strongest matching pattern over the whole message.
// ---------------------------------------------------------------------------

interface Rule {
  intent: FrontDoorIntentValue;
  weight: number;
  re: RegExp;
}

const rule = (intent: FrontDoorIntentValue, weight: number, re: RegExp): Rule => ({
  intent,
  weight,
  re,
});

const RULES: Rule[] = [
  rule(
    'HUMAN_REQUEST',
    0.96,
    /\b(?:human|real person|live agent|customer service|representative|manager|someone from (?:your )?team)\b/,
  ),
  rule(
    'HUMAN_REQUEST',
    0.9,
    /\b(?:talk|speak|connect|transfer|call|contact)\b.{0,20}\b(?:person|agent|someone|staff|team)\b/,
  ),
  rule(
    'PAYMENT_REFUND',
    0.96,
    /\b(?:refund|chargeback|money back|charged twice|double charge|overcharg\w*|dispute\w*)\b/,
  ),
  rule(
    'PAYMENT_REFUND',
    0.9,
    /\b(?:card declined|payment (?:failed|problem|issue|error)|transaction failed|paid twice|wrong amount)\b/,
  ),
  // Ordinary payment questions ("what deposit do I pay?") are answered by the booking flow, not a person.
  rule('FAQ', 0.8, /\b(?:pay|paid|payment|invoice|deposit|bank transfer|payment link)\b/),
  rule(
    'COMPLAINT_DAMAGE',
    0.94,
    /\b(?:accident|crash\w*|damage\w*|dent|scratch\w*|broke down|breakdown|police|stolen|theft|lawyer|legal|sue|court|fraud|scam)\b/,
  ),
  rule(
    'COMPLAINT_DAMAGE',
    0.86,
    /\b(?:complaint|complain|unhappy|disappointed|terrible|worst|awful|unacceptable|rude|angry|bad experience)\b/,
  ),
  rule(
    'CANCELLATION',
    0.96,
    /\bcancel\w*\b|\bcall off\b|\bno longer (?:need|want)\b|\bdon'?t want (?:it|the car|this) any ?more\b/,
  ),
  rule('CANCELLATION', 0.7, /\bnever ?mind\b|\bforget it\b/),
  rule(
    'MODIFY_BOOKING',
    0.93,
    /\b(?:change|move|shift|reschedule|postpone|extend|modify|update|push|swap|switch)\b.{0,30}\b(?:pickup|pick up|return|drop ?off|booking|date|dates|time|car|vehicle|to \d|by \d)/,
  ),
  rule(
    'MODIFY_BOOKING',
    0.85,
    /\b(?:earlier|later)\b.{0,20}\b(?:pickup|pick up|return|drop ?off)\b/,
  ),
  rule(
    'PHOTO_REQUEST',
    0.94,
    /\b(?:photo|photos|picture|pictures|images?|snaps?|tasveer\w*|tasvir|foto\w*)\b|\bshow me\b.{0,40}\b(?:car|cars|fleet|gaadi|gadi)\b/,
  ),
  rule(
    'PRICING',
    0.92,
    /\b(?:how much|price\w*|pricing|cost\w*|rates?|per day|daily|weekly|charges?|fees?|tariff|quote|quotation|kitna|kimat)\b/,
  ),
  rule(
    'AVAILABILITY',
    0.92,
    /\b(?:available|availability|do you have|have you got|got any|in stock|any .{1,30} left|is there a|are there)\b/,
  ),
  rule('BOOKING', 0.93, /\b(?:book|reserve|hire)\b/),
  rule(
    'BOOKING',
    0.86,
    /\b(?:want|need|like|looking|wish)\b.{0,20}\b(?:rent|hire|book|car)\b|\b(?:rent|renting|rental)\b/,
  ),
  rule(
    'DOCUMENTS',
    0.95,
    /\b(?:documents?|papers?|paperwork|passport|licen[cs]e|emirates id|international driving|idp|visa|id (?:required|needed)|what do i need|requirements?|eligib\w*|minimum age|age limit)\b/,
  ),
  // "I'm 22, can I rent a Ferrari?" is a question about the rules, not a booking: Gemini answers it from the policy.
  rule(
    'FAQ',
    0.96,
    /\b(?:i am|i'?m|im)\s*\d{2}\b.{0,40}\b(?:rent|drive|book|allowed|eligible|old enough|can i)\b|\b(?:can|could|may) i (?:even )?(?:rent|drive|book|hire)\b|\bam i (?:allowed|eligible|old enough)\b|\bold enough\b|\b(?:minimum|lowest|youngest) age\b|\bage (?:limit|requirement)s?\b/,
  ),
  rule(
    'DELIVERY_PICKUP',
    0.88,
    /\b(?:deliver\w*|drop ?off|pick ?up)\b.{0,25}\b(?:airport|hotel|home|office|address|location|villa|residence)\b|\b(?:airport|hotel)\b.{0,20}\b(?:delivery|pickup|pick up)\b|\bdeliver\w*\b/,
  ),
  rule(
    'RETURN',
    0.85,
    /\b(?:return|returning|give back|bring back)\b.{0,15}\b(?:car|vehicle|it)\b|\blate return\b/,
  ),
  rule(
    'FAQ',
    0.84,
    /\b(?:opening hours|open on|working hours|timings?|where are you|address|contact|phone number|insurance|mileage|km limit|fuel|salik|toll|smoking|child seat|gps|security deposit|cross border|oman|policy|policies|terms)\b/,
  ),
  rule(
    'GREETING',
    0.9,
    /^(?:hi|hello|hey|salam|salaam|assalam\w*|namaste|hola|good (?:morning|evening|afternoon))\b(?:\s+\w+){0,3}$/,
  ),
  // Arabic and Hindi greetings.
  rule(
    'GREETING',
    0.9,
    /^(?:مرحبا|مرحباً|السلام عليكم|سلام|اهلا|أهلا|هلا|صباح الخير|مساء الخير|नमस्ते|नमस्कार|हेलो|हैलो)(?:\s+\S+){0,3}$/u,
  ),
  // Hinglish: "mujhe gaadi chahiye", "car chahiye", "kiraye par".
  rule(
    'BOOKING',
    0.9,
    /\b(?:gaadi|gadi|car|kar|vehicle)\b.{0,15}\b(?:chahiye|chahie|chaahiye|lena hai|leni hai)\b|\b(?:chahiye|chahie|chaahiye)\b.{0,15}\b(?:gaadi|gadi|car)\b|\bkiraye\b|\brent par\b/,
  ),
  rule(
    'HUMAN_REQUEST',
    0.9,
    /\b(?:team|staff|manager|insaan|aadmi|banda|admi|koi)\b.{0,12}\b(?:se|ko)\b.{0,12}\b(?:baat|bat|connect|milna)\b/,
  ),
  rule(
    'CONTINUATION',
    0.9,
    /^(?:(?:ok|okay|yes|yeah|sure)\s+)?(?:the )?(?:yes|yeah|yep|yup|ok|okay|sure|no|nope|nah|that one|this one|the first(?: one)?|the second(?: one)?|the last(?: one)?|first|second|white|black|red|blue|grey|gray|silver|green|today|tomorrow|day after tomorrow|next week|thanks|thank you|please|haan|nahi|theek hai)(?:\s+\w+){0,2}$/,
  ),
];

/** On a tie the riskier intent wins, so a risky request is never quietly downgraded. */
const TIE_PRIORITY: FrontDoorIntentValue[] = [
  'HUMAN_REQUEST',
  'PAYMENT_REFUND',
  'COMPLAINT_DAMAGE',
  'CANCELLATION',
  'MODIFY_BOOKING',
  'PHOTO_REQUEST',
  'PRICING',
  'AVAILABILITY',
  'BOOKING',
  'DOCUMENTS',
  'DELIVERY_PICKUP',
  'RETURN',
  'FAQ',
  'CONTINUATION',
  'GREETING',
  'UNKNOWN',
];

function extractEntities(text: string): FrontDoorEntities {
  const entities: FrontDoorEntities = {};
  const clock =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text) ??
    /\b(?:pickup|pick up|return|drop ?off|time)\b.{0,15}\b(?:to|at|by)\s+(\d{1,2})(?::(\d{2}))?\b/.exec(
      text,
    );
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const meridiem = clock[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    // "move pickup to 7" with no am/pm: an evening hour is the sensible reading for a small hour.
    if (!meridiem && hour >= 1 && hour <= 7) hour += 12;
    if (hour <= 23 && minute <= 59) {
      entities.pickupTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  const dateWords =
    /\b(day after tomorrow|tomorrow|today|tonight|next week|this weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(
      text,
    );
  if (dateWords) entities.dateWords = dateWords[1]!;
  const duration = /\b(\d{1,3})\s*(?:days?|nights?)\b/.exec(text);
  if (duration) entities.durationDays = Number(duration[1]);
  return entities;
}

function actionFor(intent: FrontDoorIntentValue, confidence: number): RequiredActionValue {
  if (confidence < FRONT_DOOR_THRESHOLDS.low) return RequiredAction.ASK_GEMINI;
  // Risky intents never wait on a second opinion: a person handles them once the reading is even plausible.
  if (HIGH_RISK_INTENTS.includes(intent) || intent === FrontDoorIntent.MODIFY_BOOKING) {
    return RequiredAction.ESCALATE_HUMAN;
  }
  if (intent === FrontDoorIntent.CONTINUATION) return RequiredAction.CONTINUE_PIPELINE;
  if (confidence < FRONT_DOOR_THRESHOLDS.high) return RequiredAction.ASK_GEMINI;
  if (intent === FrontDoorIntent.PHOTO_REQUEST) return RequiredAction.SEND_PHOTOS;
  if (intent === FrontDoorIntent.PRICING) return RequiredAction.ANSWER_PRICE;
  return RequiredAction.CONTINUE_PIPELINE;
}

/**
 * Reads the complete message (never one keyword in isolation) plus where the
 * conversation stands. "Do you have the BMW available?" is availability,
 * "How much is the BMW?" pricing, "Book the BMW" booking, "Cancel my BMW
 * booking" cancellation — the vehicle name alone decides nothing.
 */
export function classifyFrontDoor(
  message: string,
  context: FrontDoorContext,
): FrontDoorClassification {
  const text = normalizeMessage(message);
  const scores = new Map<FrontDoorIntentValue, number>();
  for (const { intent, weight, re } of RULES) {
    if (re.test(text)) scores.set(intent, Math.max(scores.get(intent) ?? 0, weight));
  }
  if (isPhotoRequest(message)) scores.set('PHOTO_REQUEST', 0.94);

  // "A car under 300 dollars" / "your cheapest car": a question the fleet database answers.
  const budget = parsePriceBudget(message);
  if (budget || PRICE_EXTREMES_RE.test(text)) {
    scores.set('PRICING', Math.max(scores.get('PRICING') ?? 0, 0.92));
  }

  // A one-word answer only means something against an open question.
  if (scores.has('CONTINUATION') && context.phase === ConversationPhase.NO_CONTEXT) {
    scores.set('CONTINUATION', 0.6);
  }
  // A greeting that also asks for something is that something.
  if (scores.size > 1) scores.delete('GREETING');

  const ranked = [...scores.entries()].sort(
    (a, b) => b[1] - a[1] || TIE_PRIORITY.indexOf(a[0]) - TIE_PRIORITY.indexOf(b[0]),
  );
  const entities = extractEntities(text);
  if (budget?.max) entities.budgetMax = budget.max;
  if (budget?.min) entities.budgetMin = budget.min;
  const top = ranked[0];
  if (!top) {
    return {
      intent: 'UNKNOWN',
      confidence: 0.2,
      secondaryIntents: [],
      entities,
      requiredAction:
        context.phase !== ConversationPhase.NO_CONTEXT
          ? RequiredAction.CONTINUE_PIPELINE
          : RequiredAction.ASK_GEMINI,
      conversationPhase: context.phase,
    };
  }

  const secondaryIntents = ranked
    .slice(1)
    .filter(([, score]) => score >= FRONT_DOOR_THRESHOLDS.low)
    .map(([intent]) => intent);
  const confidence = Number(
    Math.min(0.99, top[1] + (secondaryIntents.length > 0 ? 0.03 : 0)).toFixed(2),
  );
  return {
    intent: top[0],
    confidence,
    secondaryIntents,
    entities,
    requiredAction: actionFor(top[0], confidence),
    conversationPhase: context.phase,
  };
}
