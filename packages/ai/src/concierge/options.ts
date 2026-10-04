import { money, joinList, popularModels, type FleetKnowledge, type FleetModel } from './fleetKnowledge.js';
import type { BusinessProfile } from './profile.js';

/**
 * The "not understood" ladder:
 *
 *   stage 1 (4 options):  1) an answer/suggestion from the fleet   2) a likely meaning   3) another
 *                         likely meaning   4) PLEASE REPEAT QUESTION IN DETAIL
 *   stage 2 (4 options):  1-3) three NEW likely meanings            4) CONTACT MY TEAM
 *
 * This file is the pure part: the fixed texts, building deterministic options from the chat, and
 * reading the customer's pick back. (Gemini writes better options when it is available — see the
 * API layer — and falls back to these when it is not.)
 */

export const OPTION_REPEAT = 'PLEASE REPEAT QUESTION IN DETAIL';
export const OPTION_TEAM = 'CONTACT MY TEAM';

/** What the concierge already knows about the booking, as plain strings. */
export interface ChatSummary {
  vehicleName: string | null;
  hasDates: boolean;
  location: string | null;
  /** Customer messages, newest last (used to spot what they have been asking about). */
  customerMessages: string[];
}

export interface OptionPick {
  index: number;
}

const ORDINALS: Record<string, number> = {
  one: 1,
  first: 1,
  '1st': 1,
  pehla: 1,
  pehle: 1,
  two: 2,
  second: 2,
  '2nd': 2,
  dusra: 2,
  doosra: 2,
  three: 3,
  third: 3,
  '3rd': 3,
  teesra: 3,
  four: 4,
  fourth: 4,
  '4th': 4,
  chautha: 4,
  last: 4,
};

/**
 * The option number a short reply names: "2", "2)", "option 2", "number two", "the second one",
 * "2 please". Anything longer or vaguer is not a pick.
 */
export function parseOptionPick(message: string, count = 4): number | null {
  const text = message
    .toLowerCase()
    .replace(/[.!?)\]:,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.split(' ').length > 5) return null;
  const match =
    /^(?:option |number |no\.? |#)?(\d)(?: please| pls| ji| wala| wali)?$/.exec(text) ??
    /^(?:option|number|no|choose|pick|select|i choose|i pick|i will take|go with)\s+(\d)$/.exec(text);
  if (match) {
    const n = Number(match[1]);
    return n >= 1 && n <= count ? n : null;
  }
  const word = /^(?:option |the |number )?(one|two|three|four|first|second|third|fourth|last|pehla|pehle|dusra|doosra|teesra|chautha)(?: one| option| wala| wali)?$/.exec(
    text,
  );
  if (word) {
    const n = ORDINALS[word[1]!];
    return n !== undefined && n <= count ? n : null;
  }
  return null;
}

/** "contact my team", "team", "talk to staff" typed instead of a number. */
export function wantsTeamByWords(message: string): boolean {
  const text = message.toLowerCase().trim();
  return (
    /^(?:team|staff|human|agent|person|contact(?: my| the)? team|connect(?: me)?(?: to| with)?(?: the| your)? team)[\s.!]*$/.test(text) ||
    /\b(?:contact|connect|talk to|speak to|speak with|chat with)\b.{0,15}\b(?:team|staff|human|person|agent)\b/.test(text)
  );
}

/** "repeat", "will write again" — the customer picked option 4 in words. */
export function wantsToRepeat(message: string): boolean {
  return /^(?:repeat|repeat (?:question|again)|ask again|let me repeat)[\s.!]*$/i.test(message.trim());
}

/** The numbered options in one of our own earlier messages, in order ("1) text" / "1. text"). */
export function parseNumberedOptions(text: string): string[] {
  const options: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d)[).]\s+(.+?)\s*$/.exec(line);
    if (match && Number(match[1]) === options.length + 1) options.push(match[2]!);
  }
  return options;
}

export function formatOptions(intro: string, options: string[]): string {
  return `${intro}\n${options.map((option, index) => `${index + 1}) ${option}`).join('\n')}\n\nReply with 1, 2, 3 or 4.`;
}

function wordsOf(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** An option the model wrote is usable only if it is short, a question or statement, and not our fixed text. */
export function usableOption(option: string): boolean {
  const trimmed = option.trim();
  return (
    trimmed.length >= 8 &&
    wordsOf(trimmed) <= 25 &&
    !/\n/.test(trimmed) &&
    trimmed.toUpperCase() !== OPTION_REPEAT &&
    trimmed.toUpperCase() !== OPTION_TEAM
  );
}

const asked = (history: string[], question: string): boolean => {
  const key = question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return history.some((entry) => entry.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === key);
};

/**
 * Likely meanings, built only from what the chat already contains. Each one is phrased so that the
 * ordinary understanding rules recognise it again when the customer picks it (the engine feeds the
 * chosen sentence back through those rules).
 */
export function probabilityQuestions(summary: ChatSummary): string[] {
  const recent = summary.customerMessages.slice(-4).join(' ').toLowerCase();
  const questions: string[] = [];
  const v = summary.vehicleName;

  if (v) {
    if (!summary.hasDates) questions.push(`Check if the ${v} is available on my dates`);
    else questions.push(`Check the price of the ${v} for my dates`);
    questions.push(`Show me photos of the ${v}`);
    questions.push(`What is the price of the ${v} per day?`);
    questions.push(`Can the ${v} be delivered to my hotel or address?`);
    questions.push(`Show me cars similar to the ${v}`);
  } else {
    if (/\b(?:wedding|family|party|honeymoon|trip)\b/.test(recent)) {
      questions.push('Which car is best for my occasion?');
    }
    questions.push('Show me your most popular cars');
    questions.push('What is the price of your cheapest car?');
    questions.push('Show me your SUV options');
    questions.push('Can you deliver a car to my hotel or address?');
    questions.push('What documents do I need to rent a car?');
    questions.push('Where are your pickup locations?');
    questions.push('Show me the full list of cars');
  }
  if (summary.location) questions.push(`Can you deliver a car to ${summary.location}?`);
  return questions;
}

/** Option 1: one concrete suggestion from the fleet, related to what was just asked. */
export function fleetSuggestionOption(
  fleet: FleetKnowledge,
  profile: BusinessProfile,
  summary: ChatSummary,
): string {
  const lastAsk = summary.customerMessages[summary.customerMessages.length - 1]?.toLowerCase() ?? '';
  let pool: FleetModel[] = fleet.models.filter((model) => model.availableUnits > 0);
  if (/\b(?:suv|family|group|big|space)\b/.test(lastAsk)) {
    pool = pool.filter((model) => model.category === 'SUV');
  } else if (/\b(?:sport|fast|speed|supercar|convertible|fun)\b/.test(lastAsk)) {
    pool = pool.filter((model) => ['COUPE', 'CONVERTIBLE', 'SPORTS'].includes(model.category));
  } else if (/\b(?:wedding|luxury|sedan|chauffeur|business)\b/.test(lastAsk)) {
    pool = pool.filter((model) => model.category === 'SEDAN' || model.luxuryTier === 'ULTRA_LUXURY');
  }
  const base = pool.length > 0 ? pool : fleet.models;
  const pick = popularModels({ ...fleet, models: base }, profile, 1, { onlyAvailable: true })[0];
  if (!pick) return 'See our available cars with prices (reply LIST for every model)';
  return `${pick.name} (${joinList(pick.colours)}): ${pick.seats} seats, ${pick.availableUnits} available, from ${money(pick.dailyRate, pick.currency)}/day`;
}

export function stageOneOptions(
  fleet: FleetKnowledge,
  profile: BusinessProfile,
  summary: ChatSummary,
  askedBefore: string[] = [],
): string[] {
  const questions = probabilityQuestions(summary).filter((question) => !asked(askedBefore, question));
  const first = fleetSuggestionOption(fleet, profile, summary);
  return [
    first,
    questions[0] ?? 'Show me your most popular cars',
    questions[1] ?? 'What is the price of your cheapest car?',
    OPTION_REPEAT,
  ];
}

export function stageTwoOptions(summary: ChatSummary, askedBefore: string[] = []): string[] {
  const fresh = probabilityQuestions(summary).filter((question) => !asked(askedBefore, question));
  const filler = [
    'Show me your most popular cars',
    'Where are your pickup locations?',
    'What documents do I need to rent a car?',
    'Show me the full list of cars',
  ].filter((question) => !asked(askedBefore, question) && !fresh.includes(question));
  const three = [...fresh, ...filler].slice(0, 3);
  while (three.length < 3) three.push('Show me your most popular cars');
  return [...three, OPTION_TEAM];
}

export const STAGE_ONE_INTRO =
  'Sorry, I could not quite understand that. Did you mean one of these?';
export const STAGE_TWO_INTRO = 'I still want to get this right. Did you mean one of these?';
export const ASK_REPEAT_TEXT = 'Of course. Please write your question again with a little more detail.';
export const TEAM_HANDOFF_TEXT =
  'I am connecting you with our team now. You can keep chatting here: they will reply in this same chat, and I will keep helping in the meantime.';
