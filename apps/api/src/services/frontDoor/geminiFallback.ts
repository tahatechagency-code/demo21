import { z } from 'zod';
import {
  FRONT_DOOR_THRESHOLDS,
  FrontDoorIntent,
  sanitizeForProcessing,
  type AIProvider,
  type FrontDoorEntities,
  type FrontDoorIntentValue,
} from '@ai-concierge/ai';

/**
 * Layer 3: one structured Gemini call for a message the rules could not read.
 * Gemini only *interprets*; it never acts, and its answer is trusted only
 * after schema validation, an intent allow-list and a confidence floor. Anything
 * short of that is `null`, which the router turns into a human hand-off — there
 * is exactly one Gemini call per message, never a retry loop.
 */

const GEMINI_TIMEOUT_MS = 8_000;
const MAX_CONTEXT_TURNS = 4;
const MAX_TURN_CHARS = 300;

const INTENT_VALUES = Object.values(FrontDoorIntent) as [FrontDoorIntentValue, ...FrontDoorIntentValue[]];

const geminiInterpretationSchema = z.object({
  understood: z.boolean(),
  intent: z.enum(INTENT_VALUES),
  confidence: z.number().min(0).max(1),
  entities: z
    .object({
      pickupTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      dateWords: z.string().max(40).optional(),
      durationDays: z.number().int().min(1).max(365).optional(),
    })
    .partial()
    .default({}),
  needs_clarification: z.boolean(),
  reason: z.string().max(200).nullable().optional(),
});

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    understood: { type: 'boolean' },
    intent: { type: 'string', enum: INTENT_VALUES },
    confidence: { type: 'number' },
    entities: {
      type: 'object',
      properties: {
        pickupTime: { type: 'string' },
        dateWords: { type: 'string' },
        durationDays: { type: 'integer' },
      },
    },
    needs_clarification: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['understood', 'intent', 'confidence', 'needs_clarification'],
};

const SYSTEM_INSTRUCTION = `
You classify one message sent to a luxury car-rental concierge. Reply ONLY with JSON.
Pick exactly one intent from: ${INTENT_VALUES.join(', ')}.
- Set "understood" to false, and intent to UNKNOWN, when you cannot tell what the customer wants,
  when the message holds conflicting requests, or when you would have to guess.
- "confidence" is your honest 0-1 certainty. Never inflate it.
- Copy entities only if they are stated in the message (pickupTime as 24h HH:MM).
- Never invent facts. You are only reading the message; you do not answer it.
`.trim();

export interface GeminiInterpretation {
  intent: FrontDoorIntentValue;
  confidence: number;
  entities: FrontDoorEntities;
}

export interface GeminiFallbackResult {
  /** Set only when Gemini is confident, in-schema and on the allow-list. */
  interpretation: GeminiInterpretation | null;
  /** One line for the person who takes over if the router escalates. */
  note: string;
}

export interface FallbackTurn {
  role: 'customer' | 'assistant';
  content: string;
}

export interface GeminiFallbackInput {
  message: string;
  /** Only the few latest turns are sent, never the whole conversation or the database. */
  recentTurns: FallbackTurn[];
  /** Compact booking state, e.g. `{ vehicle: 'BMW X5', pickupDate: null }`. */
  bookingState: Record<string, string | null>;
}

export async function interpretWithGemini(
  provider: AIProvider,
  input: GeminiFallbackInput,
): Promise<GeminiFallbackResult> {
  const transcript = input.recentTurns
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => {
      const text = sanitizeForProcessing(turn.content).sanitizedText.slice(0, MAX_TURN_CHARS);
      return `${turn.role === 'customer' ? 'Customer' : 'Assistant'}: ${text}`;
    })
    .join('\n');
  const prompt = `Booking state: ${JSON.stringify(input.bookingState)}\n\nRecent conversation:\n${transcript}\n\nLatest customer message:\n${sanitizeForProcessing(input.message).sanitizedText}`;

  let json: unknown;
  try {
    json = (
      await provider.generateStructured({
        systemInstruction: SYSTEM_INSTRUCTION,
        prompt,
        schemaName: 'front-door-interpretation-v1',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
        timeoutMs: GEMINI_TIMEOUT_MS,
      })
    ).json;
  } catch {
    return { interpretation: null, note: 'Gemini was unavailable or timed out' };
  }

  const parsed = geminiInterpretationSchema.safeParse(json);
  if (!parsed.success) return { interpretation: null, note: 'Gemini returned an unusable answer' };

  const { understood, intent, confidence, entities, needs_clarification, reason } = parsed.data;
  if (
    !understood ||
    needs_clarification ||
    intent === FrontDoorIntent.UNKNOWN ||
    confidence < FRONT_DOOR_THRESHOLDS.high
  ) {
    const why = reason ? `: ${reason}` : '';
    return {
      interpretation: null,
      note: `Gemini was unsure (best guess ${intent}, confidence ${confidence})${why}`,
    };
  }
  return { interpretation: { intent, confidence, entities }, note: `Gemini read it as ${intent}` };
}
