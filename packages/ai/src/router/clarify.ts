import {
  CLARIFY_OPTION_LINE_RE,
  CONTACT_TEAM_LABEL,
  parseClarifyOptions,
} from '@ai-concierge/domain';
import { LOCATION_KEYWORDS } from '../lexicon.js';
import { sanitizeForProcessing } from '../sanitize.js';

export { CONTACT_TEAM_LABEL, parseClarifyOptions };

/**
 * Pure helpers behind the "not understood" half of the concierge front door:
 *
 *   hedged wording ("I think Range Rover") is a probability, never a selection;
 *   a budget ("under 300 dollars") is answered from the fleet database;
 *   an unclear message gets numbered options the customer can pick from.
 *
 * Nothing here does I/O or calls a model — `frontDoorService.ts` wires it in.
 */

// ---------------------------------------------------------------------------
// Hedged wording: a guess is not a choice.
// ---------------------------------------------------------------------------

const HEDGE_RE =
  /\b(?:i think|i guess|i believe|i suppose|i feel|maybe|perhaps|probably|possibly|might be|not sure|shayad|lagta hai|mujhe lagta)\b/i;

/**
 * A clause that asks for something ("maybe show me the Urus", "I think what is the price") is a
 * request, not a guess about what to book: the hedge word there is politeness.
 */
const REQUEST_RE =
  /\b(?:show|send|photos?|pictures?|price|prices|how much|cost|available|availability|do you|can you|could you|would you|what|which|where|when|why|how|tell me|check)\b/i;

const DATE_WORDS_RE =
  /\b(?:today|tonight|tomorrow|day after tomorrow|next week|this weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{1,2}\b/i;

export type HedgedKind = 'CAR' | 'PLACE' | 'DATE';

export interface HedgeCatalogEntry {
  make: string;
  model: string;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function mentions(haystack: string, phrase: string): boolean {
  const needle = normalizeForMatch(phrase);
  return needle.length >= 3 && ` ${haystack} `.includes(` ${needle} `);
}

interface Clause {
  text: string;
  /** The punctuation that ended it ("" for the last clause when it has none). */
  terminator: string;
}

function splitClauses(message: string): Clause[] {
  const clauses: Clause[] = [];
  const re = /([^.?!;\n]*)([.?!;\n]+|$)/g;
  for (const match of message.matchAll(re)) {
    if (match[0] === '') continue;
    clauses.push({ text: match[1] ?? '', terminator: match[2] ?? '' });
  }
  return clauses;
}

function isGuess(clause: Clause): boolean {
  return (
    HEDGE_RE.test(clause.text) && !REQUEST_RE.test(clause.text) && !clause.terminator.includes('?')
  );
}

/**
 * Which things the customer only *guessed* at. "I think Range Rover" names a car but does not
 * choose it; "maybe pick up in Dubai" names a place but does not choose it. Each guessed kind is
 * reported once, in the order car, place, date.
 */
export function detectHedgedSelections(
  message: string,
  catalog: readonly HedgeCatalogEntry[],
): HedgedKind[] {
  const kinds = new Set<HedgedKind>();
  for (const clause of splitClauses(message)) {
    if (!isGuess(clause)) continue;
    const text = normalizeForMatch(clause.text);
    if (
      catalog.some(
        (entry) =>
          mentions(text, `${entry.make} ${entry.model}`) ||
          mentions(text, entry.model) ||
          mentions(text, entry.make),
      )
    ) {
      kinds.add('CAR');
    }
    if (LOCATION_KEYWORDS.some((place) => mentions(text, place))) kinds.add('PLACE');
    if (DATE_WORDS_RE.test(clause.text)) kinds.add('DATE');
  }
  return (['CAR', 'PLACE', 'DATE'] as const).filter((kind) => kinds.has(kind));
}

/**
 * The text the booking steps are allowed to read: every guessed clause is dropped, so a guess is
 * never extracted as a vehicle, a place or a date — now or when the whole chat is re-read later.
 */
export function maskHedgedClauses(text: string): string {
  return splitClauses(text)
    .map((clause) => (isGuess(clause) ? '' : `${clause.text}${clause.terminator}`))
    .join('')
    .trim();
}

// ---------------------------------------------------------------------------
// Budget: "under 300 dollars" is a question for the fleet database.
// ---------------------------------------------------------------------------

export interface PriceBudget {
  /** Highest daily rate the customer will pay, in dollars. */
  max: number | null;
  /** Lowest daily rate the customer asked for, in dollars. */
  min: number | null;
}

/** "under", "below", ... must be followed by an amount that is marked as money ("under 25" is an age, not a budget). */
const MAX_WORDS_RE =
  /\b(?:under|below|less than|lower than|within|upto|up to|at most|not more than|maximum|max|cheaper than)\b/i;
const MIN_WORDS_RE = /\b(?:above|over|more than|at least|minimum|min|starting from)\b/i;
/** "budget 300" needs no currency mark: the word itself says it is money. */
const BUDGET_WORD_RE = /\bbudget(?: is| of)?\b/i;
const BETWEEN_RE = /\bbetween\s+\$?(\d{2,6})\s*(?:and|to|-)\s*\$?(\d{2,6})\b/i;
const MONEY_MARK_RE = /\$|\busd\b|\bdollars?\b|\bbucks\b/i;
const AMOUNT_TAIL_RE =
  /^\s*(?:(\$|usd)\s*)?(\d{1,3}(?:,\d{3})+|\d{2,6})(?:\.\d+)?\s*(usd|dollars?|bucks|\$)?/i;
/** "300 dollars or less", "300 usd max" */
const AMOUNT_THEN_LIMIT_RE =
  /\b(\d{2,6})\s*(?:\$|usd|dollars?|bucks)\s*(?:or less|or under|max|maximum|budget|tak|se kam|ke andar)\b/i;

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The amount right after the first `keyword` match; with `requireMoneyMark`, only when it is written as money. */
function amountAfter(text: string, keyword: RegExp, requireMoneyMark: boolean): number | null {
  const found = keyword.exec(text);
  if (!found) return null;
  const tail = text.slice(found.index + found[0].length, found.index + found[0].length + 30);
  const amount = AMOUNT_TAIL_RE.exec(tail);
  if (!amount) return null;
  if (requireMoneyMark && !amount[1] && !amount[3]) return null;
  return toNumber(amount[2]);
}

/** The daily price range a message asks for, or `null` when it states no budget. */
export function parsePriceBudget(message: string): PriceBudget | null {
  const between = BETWEEN_RE.exec(message);
  if (between && MONEY_MARK_RE.test(message)) {
    const low = toNumber(between[1]);
    const high = toNumber(between[2]);
    if (low !== null && high !== null) {
      return { min: Math.min(low, high), max: Math.max(low, high) };
    }
  }
  const max =
    amountAfter(message, MAX_WORDS_RE, true) ??
    amountAfter(message, BUDGET_WORD_RE, false) ??
    toNumber(AMOUNT_THEN_LIMIT_RE.exec(message)?.[1]);
  const min = amountAfter(message, MIN_WORDS_RE, true);
  return max === null && min === null ? null : { max, min };
}

/** "cheapest car", "most expensive", "lowest price": a question about the ends of the price range. */
export const PRICE_EXTREMES_RE =
  /\b(?:cheapest|most expensive|lowest price|highest price|least expensive|min(?:imum)? (?:and|&) max(?:imum)?|price range)\b/i;

// ---------------------------------------------------------------------------
// Options: when the message is unclear, offer numbered choices.
// ---------------------------------------------------------------------------

export const REPEAT_OPTION_PREFIX = 'Repeat my question in detail';
const MAX_REPEATED_CHARS = 60;

/** Only short, plain words are ever echoed back: letters, digits, spaces and light punctuation. */
const SAFE_ECHO_RE = /^[\p{L}\p{N} .,?!'’-]+$/u;

/**
 * The first option of the first round: the customer's own words, offered back to be explained in
 * detail. A customer's text is never reflected blindly — markup, code, long text and anything that
 * reads like an instruction to the AI are left out, and the option names the request without quoting it.
 */
export function repeatQuestionOption(customerMessage: string): string {
  const plain = customerMessage.replace(/\s+/g, ' ').trim();
  const safe =
    plain.length > 0 &&
    plain.length <= MAX_REPEATED_CHARS &&
    SAFE_ECHO_RE.test(plain) &&
    !sanitizeForProcessing(plain).promptInjectionDetected;
  return safe ? `${REPEAT_OPTION_PREFIX}: "${plain}"` : REPEAT_OPTION_PREFIX;
}

/** The customer's original words inside a "Repeat my question in detail" option, or `null` when it is another option. */
export function originalOfRepeatOption(text: string): string | null {
  if (!text.startsWith(REPEAT_OPTION_PREFIX)) return null;
  return /"([^"]*)"/.exec(text)?.[1] ?? '';
}

/** What the customer's pick of the last option is processed as: the existing "talk to a person" path. */
export const CONTACT_TEAM_QUERY = 'I want to speak with someone from your team';

export const CLARIFY_STAGE_FIRST = 'CLARIFY_1';
export const CLARIFY_STAGE_SECOND = 'CLARIFY_2';

export function isClarifyStage(stage: string | null | undefined): boolean {
  return stage === CLARIFY_STAGE_FIRST || stage === CLARIFY_STAGE_SECOND;
}

const MAX_OPTION_CHARS = 90;

/**
 * "intro, then 1) .. 2) .. 3) .. 4) Contact my team". The team option is always the last one and
 * is added here, so no caller can forget or reorder it.
 */
export function formatClarifyMessage(
  intro: string,
  options: readonly string[],
  withTeam = true,
): string {
  const choices = withTeam ? [...options.slice(0, 3), CONTACT_TEAM_LABEL] : options.slice(0, 4);
  const lines = choices.map((option, index) => `${index + 1}) ${option}`);
  const numbers = choices.map((_, index) => index + 1).join(', ');
  return `${intro.trim()}\n\n${lines.join('\n')}\n\nReply with ${numbers.replace(/, (\d)$/, ' or $1')}.`;
}

/** WhatsApp renders `*text*` as bold: the options stand out without changing what is stored. */
export function boldOptionLines(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      CLARIFY_OPTION_LINE_RE.test(line) && !line.trim().startsWith('*') ? `*${line.trim()}*` : line,
    )
    .join('\n');
}

export interface ChosenOption {
  index: number;
  label: string;
  /** True when the customer picked "Contact my team". */
  contactTeam: boolean;
}

/** "2", "option 2", "2)" or the option's own words, matched against the options that were offered. */
export function resolveOptionChoice(
  message: string,
  options: readonly string[],
): ChosenOption | null {
  if (options.length === 0) return null;
  const typed = message.trim();
  const byNumber = /^(?:option\s*|number\s*|no\.?\s*)?([1-4])\s*[.)]?$/i.exec(typed);
  let index = byNumber ? Number(byNumber[1]) - 1 : -1;
  if (index < 0) {
    const wanted = normalizeForMatch(typed);
    index = options.findIndex((option) => normalizeForMatch(option) === wanted);
  }
  const label = options[index];
  if (label === undefined) return null;
  const contactTeam = normalizeForMatch(label) === normalizeForMatch(CONTACT_TEAM_LABEL);
  return { index, label, contactTeam };
}

/** What a chosen option is processed as: its own words, or the team hand-over phrase. */
export function queryForOption(choice: ChosenOption): string {
  return choice.contactTeam ? CONTACT_TEAM_QUERY : choice.label;
}

/**
 * A model-suggested option is only kept when it is short, plain text and carries no amount or date
 * the customer did not write (a number of two or more digits, or a currency sign) — an option must
 * never smuggle in a price or a date nobody gave. A single digit is part of a model name ("X5").
 */
export function sanitizeSuggestions(
  suggestions: readonly string[],
  customerMessage: string,
  exclude: readonly string[] = [],
): string[] {
  const seen = new Set(exclude.map(normalizeForMatch));
  const customerNumbers = new Set(customerMessage.match(/\d+/g) ?? []);
  const kept: string[] = [];
  for (const raw of suggestions) {
    const text = raw
      .replace(/\s+/g, ' ')
      .replace(/^[\d.)\-\s*]+/, '')
      .trim();
    const key = normalizeForMatch(text);
    if (text.length < 4 || text.length > MAX_OPTION_CHARS || seen.has(key)) continue;
    if (/[{}<>$€£]|https?:/.test(text)) continue;
    if ((text.match(/\d{2,}/g) ?? []).some((digits) => !customerNumbers.has(digits))) continue;
    if (key === normalizeForMatch(CONTACT_TEAM_LABEL)) continue;
    seen.add(key);
    kept.push(text);
  }
  return kept;
}

export interface BookingProgressFlags {
  hasCar: boolean;
  hasDates: boolean;
  hasPlace: boolean;
}

/**
 * Fixed fallback choices, most useful first for where the booking stands. Every one is written as
 * something a customer would say, so picking it is handled by the normal rules — never by another
 * round of guessing. Used when the model is unavailable, or to top up its own suggestions.
 */
export function fallbackProbabilityOptions(flags: BookingProgressFlags): string[] {
  const pool: string[] = [];
  if (!flags.hasCar) {
    pool.push('I want to choose a car', 'Show me the available cars with photos');
  }
  if (!flags.hasDates) pool.push('I want to give my pickup and return dates');
  if (!flags.hasPlace) pool.push('I want to choose a pickup place in Dubai');
  if (flags.hasCar && flags.hasDates) pool.push('Check if my car is available');
  pool.push(
    'Get a price quote',
    'What documents do I need to rent a car?',
    'Show me the available cars with photos',
    'Check if my car is available',
    'What is the security deposit?',
    'Which places do you deliver to?',
    'What is the minimum age to rent a car?',
  );
  return [...new Map(pool.map((option) => [normalizeForMatch(option), option])).values()];
}

/** Picks `count` options from the preferred list (model suggestions first), then the fixed pool, never repeating `exclude`. */
export function pickOptions(
  preferred: readonly string[],
  flags: BookingProgressFlags,
  count: number,
  exclude: readonly string[] = [],
): string[] {
  const seen = new Set(exclude.map(normalizeForMatch));
  const picked: string[] = [];
  for (const option of [...preferred, ...fallbackProbabilityOptions(flags)]) {
    const key = normalizeForMatch(option);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(option);
    if (picked.length === count) break;
  }
  return picked;
}
