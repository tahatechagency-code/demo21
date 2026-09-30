import { detectFaqTopic, type FaqTopicValue } from './faqTopics.js';

/**
 * The last line of defence for a free-text answer written by Gemini. The model is allowed to be
 * warm and to reason over the facts it was given, but its words are only sent after code has
 * checked them: nothing the business never supplied, no promise nobody will keep, no denial of
 * being an AI, no claim that something was done. Any violation returns a reason and the router
 * sends a person instead — the model's text is never "fixed up" and sent anyway.
 */

export interface ReplyGuardInput {
  reply: string;
  /** The exact facts text the model was given: every number in the reply must come from it or the customer. */
  factsText: string;
  /** What the customer wrote (numbers they said may be repeated back, e.g. their age). */
  customerMessage: string;
  /** Business topics that have a configured fact; any other topic may only be mentioned as "not sure". */
  knownTopics: ReadonlySet<FaqTopicValue>;
  /** True when the reply itself is the hand-off to a person (then "our team will reply" is truthful). */
  isHandoff: boolean;
}

const MAX_REPLY_CHARS = 700;

const AI_DENIAL =
  /\b(?:not|n't) (?:a |an )?(?:robot|bot|ai|machine|chatbot)\b|\bi(?:'m| am) (?:a )?(?:real )?(?:human|person)\b|\breal (?:person|human) (?:here|speaking|typing)\b/i;

const PROMISE =
  /\b(?:let me|i(?:'ll| will)|allow me to|give me a (?:moment|second|minute)) (?:just )?(?:check|find out|look into|confirm|verify|see|get back|follow up|call|look that up)\b|\bget back to you\b|\bright away\b|\bin a (?:moment|few minutes)\b/i;

const TIMEFRAME =
  /\b(?:within|in|after)\s+(?:the next\s+)?(?:\d+|a|an|one|two|three|five|ten)\s*(?:min|minute|hour|hr|day)s?\b|\bshortly\b|\bASAP\b|\bright away\b/i;

const ACTION_CLAIM =
  /\b(?:i(?:'ve| have)|we(?:'ve| have)|has been|have been|is now|are now)\s+(?:now\s+)?(?:cancell?ed|refunded|booked|confirmed|reserved|rescheduled|changed|updated|processed|charged|paid)\b|\b(?:is|are|'s) (?:available|confirmed|reserved)\b|\byou(?:'re| are) all set\b/i;

const LINK_OR_CONTACT = /https?:\/\/|www\.|@[\w-]+\.\w{2,}|\+\d[\d\s-]{6,}/i;
const MARKUP = /[{}]|\[object|```|"intent"|"route"/;

/** Wording that marks a sentence as an honest "I don't have that", which may name an unconfigured topic. */
const UNCERTAIN =
  /\b(?:not (?:sure|certain)|don'?t have|do not have|no confirmed|can'?t confirm|cannot confirm|unable to confirm|confirm (?:this|that|it) with|team (?:can|will|could)|rather not guess|wouldn'?t want to guess)\b/i;

function numbersIn(text: string): Set<string> {
  return new Set(
    (text.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))),
  );
}

/** Returns the first rule the reply breaks, or null when it is safe to send. */
export function checkConciergeReply(input: ReplyGuardInput): string | null {
  const { reply, factsText, customerMessage, knownTopics, isHandoff } = input;
  if (reply.trim().length === 0) return 'EMPTY';
  if (reply.length > MAX_REPLY_CHARS) return 'TOO_LONG';
  if (MARKUP.test(reply)) return 'INTERNAL_MARKUP';
  if (/[٠-٩۰-۹]/.test(reply)) return 'NON_ASCII_DIGITS';
  if (LINK_OR_CONTACT.test(reply) && !LINK_OR_CONTACT.test(factsText)) return 'UNGROUNDED_CONTACT';
  if (AI_DENIAL.test(reply)) return 'DENIES_BEING_AI';
  if (ACTION_CLAIM.test(reply)) return 'CLAIMS_AN_ACTION';
  if (isHandoff ? TIMEFRAME.test(reply) : PROMISE.test(reply) || TIMEFRAME.test(reply)) {
    return 'UNKEPT_PROMISE';
  }

  // A business topic with no configured fact is named before any number, so "open 24/7" reports the topic.
  const topic = detectFaqTopic(reply);
  if (topic && !knownTopics.has(topic) && !UNCERTAIN.test(reply)) return `UNGROUNDED_${topic}`;

  const allowed = new Set([...numbersIn(factsText), ...numbersIn(customerMessage)]);
  for (const used of numbersIn(reply)) {
    if (!allowed.has(used)) return 'UNGROUNDED_NUMBER';
  }
  return null;
}
