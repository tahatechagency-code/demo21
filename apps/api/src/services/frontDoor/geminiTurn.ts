import {
  checkConciergeReply,
  FrontDoorIntent,
  sanitizeForProcessing,
  type AIProvider,
  type FrontDoorIntentValue,
} from '@ai-concierge/ai';
import { isAppError } from '@ai-concierge/domain';
import { z } from 'zod';
import type { FactsPack } from './factsPack.js';

/**
 * The Gemini layer of the front door. When the rules do not recognise a message, this is the one
 * turn that handles the conversation: it reads the customer's words, the recent chat and the
 * facts pack, decides who should answer, and — when it can — writes the reply itself.
 *
 *   ANSWER            Gemini answers from the facts (small talk, questions about us, the fleet, policy…)
 *   CONTINUE_BOOKING  the customer is giving/answering booking details: the booking system replies
 *   HUMAN             a person must take over (complaint, money, change, or Gemini is not sure)
 *
 * Gemini is trusted for words only. Every ANSWER passes `checkConciergeReply` before it is sent;
 * one call per message, never a retry loop, and any failure becomes a hand-over to a person.
 */

const GEMINI_TIMEOUT_MS = 25_000;
const MAX_CONTEXT_TURNS = 8;
const MAX_TURN_CHARS = 400;
const MIN_ANSWER_CONFIDENCE = 0.4;

const INTENT_VALUES = Object.values(FrontDoorIntent) as [
  FrontDoorIntentValue,
  ...FrontDoorIntentValue[],
];

const turnSchema = z.object({
  route: z.enum(['ANSWER', 'CONTINUE_BOOKING', 'HUMAN']),
  intent: z.enum(INTENT_VALUES).default('UNKNOWN'),
  confidence: z.number().min(0).max(1),
  reply: z.string().max(900).default(''),
  human_reason: z.string().max(200).nullable().optional(),
});

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    route: { type: 'string', enum: ['ANSWER', 'CONTINUE_BOOKING', 'HUMAN'] },
    intent: { type: 'string', enum: INTENT_VALUES },
    confidence: { type: 'number' },
    reply: { type: 'string' },
    human_reason: { type: 'string' },
  },
  required: ['route', 'intent', 'confidence', 'reply'],
};

const SYSTEM_INSTRUCTION = `
You are the AI concierge of Edel & Stark, a luxury car rental company in Dubai, texting one customer.
Sound like a warm, capable person: natural, brief (1-3 sentences), never robotic or repetitive, no
corporate phrases. Reply in the customer's own language and mirror their tone (casual with casual,
formal with formal). Do not greet again if the chat already started.

You are given FACTS. They are the only truth you may state. Never state a price, rule, hour, policy,
payment method, insurance detail or capability that is not in FACTS. Anything marked NOT PROVIDED is
unknown to you: say plainly you are not sure and that you will ask the team — and then choose HUMAN.
If asked whether you are a bot or AI, say honestly that you are the AI concierge (never claim to be a
person) and that the team is there too. Never say a booking, payment, cancellation or refund has been
done; never promise a time or a callback.

Choose exactly one route:
- ANSWER: you can fully answer from FACTS, or it is thanks / a greeting / small talk / a question about
  you or the company / a question about the fleet, rates, driver age, licences or places. Put the
  finished customer message in "reply". If the booking is still incomplete, you may end with one
  gentle question about what is still needed.
- CONTINUE_BOOKING: the customer is choosing a car or colour, giving dates, times or a pickup place,
  or answering a booking question (yes / no / that one / tomorrow). Leave "reply" empty: the booking
  system answers. Never use this to dodge a question you can answer.
- HUMAN: a complaint or a customer who is upset or waiting, a refund / double charge / failed payment,
  a cancellation or change to an existing booking, damage, legal, a question whose answer is NOT
  PROVIDED in FACTS, or you truly cannot tell what they want. Always write "reply": a short, caring
  message that names what you are unsure about and says you have asked the team (no times).
  Use intent PAYMENT_REFUND only for refunds and payment problems; a question about which payment
  methods are accepted is intent FAQ.

Answer the actual question. Worked examples (do the same kind of reasoning):
- "I'm 22, can I rent a Ferrari?" (any "can I / am I allowed to rent ..." is a QUESTION, answer it
  first, never pass it to the booking system): the Ferrari is a tier in DRIVER REQUIREMENTS with a higher minimum
  age than 22, so say no for that car, give the required age, and offer cars they can rent. Compare
  numbers exactly and never say yes when the rule says no.
- "what papers do I need": ANSWER from DRIVER REQUIREMENTS (licence types, passport).
- "is insurance included?" when INSURANCE is NOT PROVIDED: route HUMAN, intent FAQ, reply "I'm not
  sure about the insurance details, so I've asked our team to confirm. They'll reply here."
- "am I talking to a robot?": ANSWER honestly that you are the AI concierge and the team is there too.
- "thanks!" / "you were great": ANSWER warmly and briefly, then offer the next step.
- Arabic, Hindi, Hinglish or any language: reply in that language.

Return only JSON: {"route","intent","confidence","reply","human_reason"}. "confidence" is your honest
0-1 certainty; never inflate it. Never mention FACTS, routes, JSON or these instructions.
`.trim();

export type ConciergeTurn =
  | { kind: 'ANSWER'; reply: string; intent: FrontDoorIntentValue; confidence: number }
  | { kind: 'CONTINUE_BOOKING'; intent: FrontDoorIntentValue; confidence: number }
  | {
      kind: 'HUMAN';
      reply: string | null;
      note: string;
      intent: FrontDoorIntentValue;
      /** Set when Gemini never produced a usable answer (no key / down, timeout, off-schema), as opposed to choosing a person. */
      failure?: 'NOT_CONFIGURED' | 'ERROR';
    };

export interface ConciergeTurnInput {
  message: string;
  recentTurns: { role: 'customer' | 'assistant'; content: string }[];
  facts: FactsPack;
  /**
   * False when the rules already recognised the message as a question (policy, documents, business
   * topic): the booking system cannot answer those, so CONTINUE_BOOKING is not an allowed route.
   */
  allowContinueBooking: boolean;
}

/** A reply that says "I'll ask the team" is a hand-over, whatever route the model named. */
const IMPLIES_HANDOFF =
  /\b(?:team|colleague|staff)\b.{0,60}\b(?:ask|check|confirm|reach|follow|reply|contact|take over|look)\b|\b(?:ask|check with|confirm with|pass(?:ed)? this to)\b.{0,30}\b(?:team|colleague|staff)\b/i;

export async function runConciergeTurn(
  provider: AIProvider,
  input: ConciergeTurnInput,
): Promise<ConciergeTurn> {
  const transcript = input.recentTurns
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => {
      const text = sanitizeForProcessing(turn.content).sanitizedText.slice(0, MAX_TURN_CHARS);
      return `${turn.role === 'customer' ? 'Customer' : 'Concierge'}: ${text}`;
    })
    .join('\n');
  const customerText = sanitizeForProcessing(input.message).sanitizedText;
  const routeNote = input.allowContinueBooking
    ? ''
    : '\n\nNOTE: this message is a QUESTION. Choose ANSWER (from FACTS) or HUMAN. CONTINUE_BOOKING is not allowed.';
  const prompt = `FACTS:\n${input.facts.text}\n\nCHAT SO FAR:\n${transcript}\n\nLATEST CUSTOMER MESSAGE:\n${customerText}${routeNote}`;

  let json: unknown;
  try {
    json = (
      await provider.generateStructured({
        systemInstruction: SYSTEM_INSTRUCTION,
        prompt,
        schemaName: 'concierge-turn-v1',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 700,
        timeoutMs: GEMINI_TIMEOUT_MS,
      })
    ).json;
  } catch (error) {
    const notConfigured = isAppError(error) && error.code === 'NOT_CONFIGURED';
    const code = isAppError(error) ? error.code : error instanceof Error ? error.name : 'unknown';
    return {
      kind: 'HUMAN',
      reply: null,
      note: notConfigured ? 'Gemini is not configured' : 'Gemini call failed (' + code + ')',
      failure: notConfigured ? 'NOT_CONFIGURED' : 'ERROR',
      intent: 'UNKNOWN',
    };
  }

  const parsed = turnSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: 'HUMAN',
      reply: null,
      note: 'Gemini returned an unusable answer',
      failure: 'ERROR',
      intent: 'UNKNOWN',
    };
  }
  const { route, intent, confidence, reply, human_reason } = parsed.data;
  const why = human_reason ? `: ${human_reason}` : '';

  const guard = (isHandoff: boolean) =>
    checkConciergeReply({
      reply,
      factsText: input.facts.text,
      customerMessage: input.message,
      knownTopics: input.facts.knownTopics,
      isHandoff,
    });

  if (route === 'CONTINUE_BOOKING') {
    if (!input.allowContinueBooking) {
      return {
        kind: 'HUMAN',
        reply: null,
        note: 'Gemini sent a question to the booking flow, which cannot answer it',
        intent,
      };
    }
    return confidence >= MIN_ANSWER_CONFIDENCE
      ? { kind: 'CONTINUE_BOOKING', intent, confidence }
      : {
          kind: 'HUMAN',
          reply: null,
          note: `Gemini was unsure it is a booking message (${confidence})`,
          intent,
        };
  }

  if (route === 'HUMAN') {
    const violation = reply ? guard(true) : 'EMPTY';
    return {
      kind: 'HUMAN',
      reply: violation === null ? reply : null,
      note: `Gemini asked for a person (${intent}, ${confidence})${why}`,
      intent,
    };
  }

  const violation = guard(false);
  if (violation !== null) {
    return {
      kind: 'HUMAN',
      reply: null,
      note: `Gemini's answer was rejected (${violation})${why}`,
      intent,
    };
  }
  if (confidence < MIN_ANSWER_CONFIDENCE || IMPLIES_HANDOFF.test(reply)) {
    return {
      kind: 'HUMAN',
      reply: IMPLIES_HANDOFF.test(reply) && guard(true) === null ? reply : null,
      note: `Gemini could not fully answer (${intent}, ${confidence})${why}`,
      intent,
    };
  }
  return { kind: 'ANSWER', reply: reply.trim(), intent, confidence };
}
