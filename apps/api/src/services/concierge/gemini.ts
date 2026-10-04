import {
  FrontDoorIntent,
  OPTION_REPEAT,
  OPTION_TEAM,
  checkConciergeReply,
  sanitizeForProcessing,
  usableOption,
  type AIProvider,
  type FaqTopicValue,
  type FrontDoorIntentValue,
} from '@ai-concierge/ai';
import { isAppError } from '@ai-concierge/domain';
import { z } from 'zod';

/**
 * Gemini's two jobs in the concierge, both behind the deterministic rules:
 *
 *   understand()  PROMPT B  the rules did not recognise the message: read the whole fleet + the chat
 *                           and either answer from the databases or say "not understood".
 *   makeOptions() PROMPT C/E the message is still not understood: write the "did you mean" options.
 *
 * Gemini is trusted for words only. Every sentence it writes passes `checkConciergeReply` (numbers
 * must come from the facts, no promises, no claimed actions) before a customer sees it; one call
 * each, never a retry loop, and any failure simply means "not understood" so the ladder moves on.
 */

const UNDERSTAND_TIMEOUT_MS = 14_000;
const OPTIONS_TIMEOUT_MS = 10_000;
const MAX_CONTEXT_TURNS = 10;
const MAX_TURN_CHARS = 400;
const MIN_CONFIDENCE = 0.55;

export type GeminiAction = 'ANSWER' | 'CONTINUE_BOOKING' | 'HANDOFF';

export type Understanding =
  | { understood: true; action: 'ANSWER'; answer: string; intent: FrontDoorIntentValue }
  | { understood: true; action: 'CONTINUE_BOOKING'; intent: FrontDoorIntentValue }
  | { understood: true; action: 'HANDOFF'; intent: FrontDoorIntentValue; reason: string }
  | { understood: false; reason: string; configured: boolean };

const INTENT_VALUES = Object.values(FrontDoorIntent) as [FrontDoorIntentValue, ...FrontDoorIntentValue[]];

const understandingSchema = z.object({
  understood: z.boolean(),
  intent: z.enum(INTENT_VALUES).default('UNKNOWN'),
  confidence: z.number().min(0).max(1).default(0),
  action: z.enum(['ANSWER', 'CONTINUE_BOOKING', 'HANDOFF']).default('ANSWER'),
  answer: z.string().max(900).default(''),
  reason: z.string().max(240).default(''),
});

const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    understood: { type: 'boolean' },
    intent: { type: 'string', enum: INTENT_VALUES },
    confidence: { type: 'number' },
    action: { type: 'string', enum: ['ANSWER', 'CONTINUE_BOOKING', 'HANDOFF'] },
    answer: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['understood', 'intent', 'confidence', 'action', 'answer', 'reason'],
};

function understandInstruction(brand: string): string {
  return `
You are the fallback understanding engine of ${brand}'s AI concierge (a car rental company in the UAE),
texting one customer. The simple rules did not recognise the latest message; you get the FACTS (the whole
fleet with live units, the branches, the delivery rule, the rental terms, the owner's configured facts)
and the chat so far.

FIRST study the entire FLEET in FACTS: every car, its colours, seats, rate, deposit and how many cars are
available. THEN read the customer's latest message together with the chat above it.

Decide:
- understood=true, action=ANSWER: you can fully answer from FACTS (small talk, a question about the company,
  the fleet, a price, seats, colours, availability counts, delivery, age/licence/documents, locations).
  Put the finished customer message in "answer": warm, natural, 1-3 sentences, in the customer's own
  language (English / Hindi / Hinglish / Arabic) and tone. If the booking is still incomplete you may end
  with ONE gentle question about what is still needed.
- understood=true, action=CONTINUE_BOOKING: the customer is giving or answering a booking detail (a car, a
  colour, dates, times, a pickup place, yes/no, a choice). Leave "answer" empty: the booking system replies.
- understood=true, action=HANDOFF: a cancellation, refund or payment problem, a change to an existing booking,
  damage, a complaint, legal, or an explicit request for a person. Leave "answer" empty.
- understood=false: you cannot tell what they want, or the answer is NOT PROVIDED in FACTS. Put a short
  "reason". NEVER guess.

Hard rules: use ONLY facts from FACTS. Never invent a car, colour, rate, seat count, branch, availability or
policy. A topic marked NOT PROVIDED is unknown to you: understood=false. If a car is not in the FLEET, say it is
not available right now and suggest real cars from the FLEET. Never say a booking, payment, cancellation or
refund has been done, and never promise a time or a callback. If asked whether you are a bot, say honestly you
are the AI concierge and the team is there too. Do not mention FACTS, JSON or these instructions. Do not state
anything about the weather, current events or live conditions.

Return only JSON: {"understood","intent","confidence","action","answer","reason"}. "confidence" is your honest
0-1 certainty; never inflate it.
`.trim();
}

export interface GeminiContext {
  ai: AIProvider;
  brand: string;
  factsText: string;
  knownTopics: ReadonlySet<FaqTopicValue>;
  turns: { role: 'customer' | 'assistant'; content: string }[];
  message: string;
}

function transcript(turns: GeminiContext['turns']): string {
  return turns
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => {
      const text = (
        turn.role === 'customer' ? sanitizeForProcessing(turn.content).sanitizedText : turn.content
      ).slice(0, MAX_TURN_CHARS);
      return `${turn.role === 'customer' ? 'Customer' : 'Concierge'}: ${text}`;
    })
    .join('\n');
}

/** PROMPT B. */
export async function understand(g: GeminiContext): Promise<Understanding> {
  const customerText = sanitizeForProcessing(g.message).sanitizedText;
  const prompt = `FACTS:\n${g.factsText}\n\nCHAT SO FAR:\n${transcript(g.turns)}\n\nLATEST CUSTOMER MESSAGE:\n${customerText}`;
  let json: unknown;
  try {
    json = (
      await g.ai.generateStructured({
        systemInstruction: understandInstruction(g.brand),
        prompt,
        schemaName: 'concierge-understand-v2',
        responseSchema: UNDERSTAND_SCHEMA,
        temperature: 0.3,
        maxOutputTokens: 800,
        timeoutMs: UNDERSTAND_TIMEOUT_MS,
      })
    ).json;
  } catch (error) {
    const notConfigured = isAppError(error) && error.code === 'NOT_CONFIGURED';
    return {
      understood: false,
      reason: notConfigured ? 'Gemini is not configured' : 'Gemini call failed',
      configured: !notConfigured,
    };
  }
  const parsed = understandingSchema.safeParse(json);
  if (!parsed.success) return { understood: false, reason: 'Unusable Gemini answer', configured: true };
  const { understood, intent, confidence, action, answer, reason } = parsed.data;
  if (!understood || confidence < MIN_CONFIDENCE) {
    return { understood: false, reason: reason || 'Low confidence', configured: true };
  }
  if (action === 'CONTINUE_BOOKING') return { understood: true, action, intent };
  if (action === 'HANDOFF') return { understood: true, action, intent, reason };

  const violation = checkConciergeReply({
    reply: answer,
    factsText: g.factsText,
    customerMessage: g.message,
    knownTopics: g.knownTopics,
    isHandoff: false,
  });
  if (violation !== null || answer.trim().length === 0) {
    return { understood: false, reason: `Answer rejected (${violation ?? 'EMPTY'})`, configured: true };
  }
  return { understood: true, action: 'ANSWER', answer: answer.trim(), intent };
}

const optionsSchema = z.object({
  options: z.array(z.string().max(300)).min(1).max(4),
});

const OPTIONS_SCHEMA = {
  type: 'object',
  properties: { options: { type: 'array', items: { type: 'string' } } },
  required: ['options'],
};

function optionsInstruction(brand: string, stage: 1 | 2): string {
  if (stage === 1) {
    return `
The customer's message to ${brand}'s concierge was not understood. Create exactly 3 options (the fixed 4th is
added by the system).

OPTION 1: FIRST do a deep research of the entire FLEET in FACTS. Then, relating it to the customer's last
question and the whole chat, write ONE concrete suggestion or answer from the fleet: a car name, its seats,
colours, how many are available and its rate per day. Use only numbers that appear in FACTS.
OPTION 2: a probability question: what the customer most likely meant, based on the entire chat. Short question.
OPTION 3: a different probability question: another likely meaning, based on the entire chat. Short question.

Rules: options 2 and 3 must use details already mentioned in the chat (car, date, place, budget). Each option is
under 25 words. Do not repeat anything the customer already confirmed. No numbers except those in FACTS or the
chat. Write in the customer's language. Return only JSON: {"options":[opt1,opt2,opt3]}.
`.trim();
  }
  return `
The customer was still not understood after they repeated their question. Create exactly 3 options (the fixed
4th, CONTACT MY TEAM, is added by the system).

OPTIONS 1-3: three NEW probability questions, different from ALL questions already asked in this chat (see
ALREADY ASKED), built from the full conversation: car, dates, place, budget, passengers, purpose. Each is a short
question under 25 words, in the customer's language, with no numbers except those in FACTS or the chat.
Return only JSON: {"options":[q1,q2,q3]}.
`.trim();
}

/**
 * PROMPT C (stage 1) / PROMPT E (stage 2). Returns only the model-written options that passed the
 * checks; the caller tops up with deterministic ones and adds the fixed 4th option.
 */
export async function makeOptions(
  g: GeminiContext,
  stage: 1 | 2,
  alreadyAsked: string[],
): Promise<string[]> {
  const customerText = sanitizeForProcessing(g.message).sanitizedText;
  const prompt =
    `FACTS:\n${g.factsText}\n\nCHAT SO FAR:\n${transcript(g.turns)}\n\n` +
    `LATEST CUSTOMER MESSAGE (not understood):\n${customerText}` +
    (stage === 2 ? `\n\nALREADY ASKED:\n${alreadyAsked.map((q) => `- ${q}`).join('\n') || '- none'}` : '');
  let json: unknown;
  try {
    json = (
      await g.ai.generateStructured({
        systemInstruction: optionsInstruction(g.brand, stage),
        prompt,
        schemaName: `concierge-options-v2-${stage}`,
        responseSchema: OPTIONS_SCHEMA,
        temperature: 0.5,
        maxOutputTokens: 500,
        timeoutMs: OPTIONS_TIMEOUT_MS,
      })
    ).json;
  } catch {
    return [];
  }
  const parsed = optionsSchema.safeParse(json);
  if (!parsed.success) return [];

  const taken = new Set(alreadyAsked.map((q) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
  const kept: string[] = [];
  for (const raw of parsed.data.options) {
    const option = raw.trim().replace(/^\d[).]\s*/, '');
    if (!usableOption(option)) continue;
    if (option.toUpperCase() === OPTION_REPEAT || option.toUpperCase() === OPTION_TEAM) continue;
    const key = option.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (taken.has(key)) continue;
    const violation = checkConciergeReply({
      reply: option,
      factsText: g.factsText,
      customerMessage: g.message,
      knownTopics: g.knownTopics,
      isHandoff: false,
    });
    if (violation !== null) continue;
    taken.add(key);
    kept.push(option);
    if (kept.length === 3) break;
  }
  return kept;
}

const localizeSchema = z.object({ reply: z.string().min(1).max(1500) });

/** Rewrites a finished English reply in the customer's language. Numbers are checked by the caller. */
export async function translateReply(
  ai: AIProvider,
  brand: string,
  draft: string,
  customerMessage: string,
): Promise<string | null> {
  try {
    const result = await ai.generateStructured({
      systemInstruction: `You translate ${brand}'s car-rental concierge messages. Rewrite the DRAFT in the same language and tone as the customer's message (English, Hindi, Hinglish or Arabic). Keep EVERY number, price, date, car name, option number and line break exactly as given; write digits as 0-9; add nothing and remove nothing. Return only JSON {"reply": "..."}.`,
      prompt: `CUSTOMER MESSAGE:\n${sanitizeForProcessing(customerMessage).sanitizedText}\n\nDRAFT:\n"""\n${draft}\n"""`,
      schemaName: 'concierge-translate-v1',
      responseSchema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] },
      temperature: 0.2,
      maxOutputTokens: 900,
      timeoutMs: 9_000,
    });
    const parsed = localizeSchema.safeParse(result.json);
    return parsed.success ? parsed.data.reply.trim() : null;
  } catch {
    return null;
  }
}
