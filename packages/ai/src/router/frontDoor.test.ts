import { describe, expect, it } from 'vitest';
import {
  classifyFrontDoor,
  type FrontDoorContext,
  ConversationPhase,
  FrontDoorIntent as I,
  normalizeMessage,
  RequiredAction,
} from './frontDoor.js';

const none: FrontDoorContext = { phase: ConversationPhase.NO_CONTEXT };
const collecting: FrontDoorContext = { phase: ConversationPhase.COLLECTING };
const intentOf = (message: string, context: FrontDoorContext = none) =>
  classifyFrontDoor(message, context).intent;

describe('front door: whole-message intent, not one keyword', () => {
  it.each([
    ['Do you have the BMW available?', I.AVAILABILITY],
    ['How much is the BMW?', I.PRICING],
    ['Book the BMW.', I.BOOKING],
    ['Cancel my BMW booking.', I.CANCELLATION],
    ['show me a picture of the Range Rover', I.PHOTO_REQUEST],
    ['what documents do I need?', I.DOCUMENTS],
    ['I want to talk to a real person', I.HUMAN_REQUEST],
    ['I want a refund for my last rental', I.PAYMENT_REFUND],
    ['there was an accident with the car', I.COMPLAINT_DAMAGE],
    ['can you move pickup to 7 pm?', I.MODIFY_BOOKING],
    ['do you deliver to the airport', I.DELIVERY_PICKUP],
    ['hello', I.GREETING],
  ])('%s -> %s', (message, intent) => {
    expect(intentOf(message)).toBe(intent);
  });
});

describe('front door: normalisation', () => {
  it('handles typos, abbreviations and punctuation', () => {
    expect(intentOf('helo i wana rnt a mercedez for 3 dayz')).toBe(I.BOOKING);
    expect(intentOf('cancle my bookng!!!')).toBe(I.CANCELLATION);
    expect(intentOf('pls send pics of the urus')).toBe(I.PHOTO_REQUEST);
    expect(intentOf('avilable tomorow??')).toBe(I.AVAILABILITY);
    expect(normalizeMessage('  HELLOOOO!!  ')).toBe('hello');
  });
});

describe('front door: confidence and required action', () => {
  it('routes risky intents to a person, never to automation', () => {
    for (const message of [
      'cancel my booking',
      'refund please',
      'the car has a dent',
      'get me a manager',
    ]) {
      expect(classifyFrontDoor(message, none).requiredAction).toBe(RequiredAction.ESCALATE_HUMAN);
    }
  });

  it('extracts entities as structured data', () => {
    const result = classifyFrontDoor('Actually can you move pickup to 7 pm', none);
    expect(result).toMatchObject({ intent: I.MODIFY_BOOKING, entities: { pickupTime: '19:00' } });
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    expect(classifyFrontDoor('move the pickup to 7', none).entities.pickupTime).toBe('19:00');
    expect(classifyFrontDoor('need it for 5 days from tomorrow', none).entities).toMatchObject({
      durationDays: 5,
      dateWords: 'tomorrow',
    });
  });

  it('is unsure of gibberish and sends it to Gemini, not a greeting', () => {
    const result = classifyFrontDoor('asdf qwerty zzz', none);
    expect(result.intent).toBe(I.UNKNOWN);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.requiredAction).toBe(RequiredAction.ASK_GEMINI);
  });

  it('keeps an active booking going when a message is unclear', () => {
    expect(classifyFrontDoor('hmm asdf', collecting).requiredAction).toBe(
      RequiredAction.CONTINUE_PIPELINE,
    );
  });

  it('detects several intents in one message and still escalates the risky one', () => {
    const result = classifyFrontDoor(
      'How much is the Ferrari and can I cancel my other booking and do you deliver to the airport',
      none,
    );
    expect(result.intent).toBe(I.CANCELLATION);
    expect(result.secondaryIntents).toEqual(expect.arrayContaining([I.PRICING, I.DELIVERY_PICKUP]));
    expect(result.requiredAction).toBe(RequiredAction.ESCALATE_HUMAN);
  });
});

describe('front door: context-dependent short messages', () => {
  it.each(['yes', 'no', 'that one', 'tomorrow', 'the white one'])(
    '%s continues an open question',
    (message) => {
      expect(intentOf(message, collecting)).toBe(I.CONTINUATION);
    },
  );

  it('lets the pipeline ask what a lone "yes" with no conversation is answering', () => {
    expect(classifyFrontDoor('yes', none).requiredAction).toBe(RequiredAction.CONTINUE_PIPELINE);
  });

  it('a topic switch is read on its own words', () => {
    expect(intentOf('actually what documents do I need', collecting)).toBe(I.DOCUMENTS);
    expect(intentOf('forget the BMW, how much is the Ferrari', collecting)).toBe(I.PRICING);
  });
});

describe('front door: an unclear message inside an open journey', () => {
  it('stays with the booking pipeline in every phase except none', () => {
    for (const phase of [ConversationPhase.COLLECTING, ConversationPhase.QUOTED]) {
      expect(classifyFrontDoor('3 April 1990', { phase }).requiredAction).toBe(
        RequiredAction.CONTINUE_PIPELINE,
      );
    }
    expect(classifyFrontDoor('3 April 1990', none).requiredAction).toBe(RequiredAction.ASK_GEMINI);
  });
});

describe('front door: payments', () => {
  it('answers ordinary payment questions in the flow but hands payment problems to a person', () => {
    const deposit = classifyFrontDoor('what deposit do I need to pay?', {
      phase: ConversationPhase.QUOTED,
    });
    expect(deposit.requiredAction).toBe(RequiredAction.CONTINUE_PIPELINE);
    const failed = classifyFrontDoor('my card declined and I was charged twice', none);
    expect(failed.intent).toBe(I.PAYMENT_REFUND);
    expect(failed.requiredAction).toBe(RequiredAction.ESCALATE_HUMAN);
  });
});

describe('front door: short replies with a filler word', () => {
  it('reads "ok the white one" as an answer to an open question, not an unknown message', () => {
    expect(classifyFrontDoor('ok the white one', collecting).intent).toBe(I.CONTINUATION);
    expect(classifyFrontDoor('ok the white one', none).requiredAction).toBe(
      RequiredAction.CONTINUE_PIPELINE,
    );
  });
});

describe('front door: questions about the rules are not bookings', () => {
  it.each([
    'I am 22, can I rent a Ferrari?',
    'am I old enough to rent an Urus',
    'what is the minimum age',
    'can I even rent with a foreign licence',
  ])('%s -> FAQ (answered by Gemini from the policy)', (message) => {
    expect(classifyFrontDoor(message, none).intent).toBe(I.FAQ);
  });

  it('"papers" are documents', () => {
    expect(classifyFrontDoor('whats the deal with my papers', none).intent).toBe(I.DOCUMENTS);
  });
});
