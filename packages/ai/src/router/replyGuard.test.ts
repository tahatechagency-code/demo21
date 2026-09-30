import { describe, expect, it } from 'vitest';
import { detectFaqTopic, FaqTopic } from './faqTopics.js';
import { checkConciergeReply } from './replyGuard.js';

const FACTS = 'BMW X5 AED 1,200 per day. Minimum age 21, 25 for ultra-luxury. HOURS: Daily 9-21.';
const check = (
  reply: string,
  options: { known?: string[]; handoff?: boolean; message?: string } = {},
) =>
  checkConciergeReply({
    reply,
    factsText: FACTS,
    customerMessage: options.message ?? 'hi',
    knownTopics: new Set((options.known ?? []) as never[]),
    isHandoff: options.handoff ?? false,
  });

describe('checkConciergeReply', () => {
  it('lets a grounded, friendly answer through', () => {
    expect(check('The BMW X5 starts from AED 1,200 per day. Which dates suit you?')).toBeNull();
  });

  it("repeats the customer's own numbers but never invents new ones", () => {
    expect(
      check('At 22 you can drive the BMW X5 (minimum age is 21).', { message: "I'm 22" }),
    ).toBeNull();
    expect(check('The BMW X5 is AED 999 per day.')).toBe('UNGROUNDED_NUMBER');
  });

  it('never lets the model deny being an AI', () => {
    expect(check("Nope, not a robot! I'm here to help.")).toBe('DENIES_BEING_AI');
    expect(check("I'm a real person here to help")).toBe('DENIES_BEING_AI');
  });

  it('rejects promises nobody will keep unless the reply is the hand-off itself', () => {
    expect(check('Let me check on that and get back to you.')).toBe('UNKEPT_PROMISE');
    expect(check('Our team will reply here.', { handoff: true })).toBeNull();
    expect(check('Our team will reply within 10 minutes.', { handoff: true })).toBe(
      'UNKEPT_PROMISE',
    );
  });

  it('rejects a claim that something was done', () => {
    expect(check("I've cancelled your booking.")).toBe('CLAIMS_AN_ACTION');
    expect(check('Your refund has been processed.')).toBe('CLAIMS_AN_ACTION');
    expect(check('The Urus is available tomorrow.')).toBe('CLAIMS_AN_ACTION');
  });

  it('states a business topic only when a fact is configured, otherwise only as "not sure"', () => {
    expect(check('We accept both card and cash.')).toBe(`UNGROUNDED_${FaqTopic.PAYMENT_METHODS}`);
    expect(check("We're open 24/7!")).toBe(`UNGROUNDED_${FaqTopic.HOURS}`);
    expect(
      check("I don't have confirmed details on insurance, so I'd rather not guess."),
    ).toBeNull();
    expect(check('Daily 9-21, so come by any time.', { known: [FaqTopic.HOURS] })).toBeNull();
  });

  it('rejects internal markup, links and over-long text', () => {
    expect(check('{"route":"ANSWER"}')).toBe('INTERNAL_MARKUP');
    expect(check('See https://example.com for more')).toBe('UNGROUNDED_CONTACT');
    expect(check('word '.repeat(200))).toBe('TOO_LONG');
    expect(check('  ')).toBe('EMPTY');
  });
});

describe('faq topics', () => {
  it.each([
    ['is insurance included?', FaqTopic.INSURANCE],
    ['can I drive it to Oman?', FaqTopic.CROSS_BORDER],
    ['do you accept cash or card', FaqTopic.PAYMENT_METHODS],
    ['what time are you open on friday', FaqTopic.HOURS],
    ['any discount for a month?', FaqTopic.DISCOUNT],
    ['do you have cars with a driver for a wedding', FaqTopic.CHAUFFEUR],
    ['where are you located?', FaqTopic.LOCATION],
  ])('%s -> %s', (message, topic) => {
    expect(detectFaqTopic(message)).toBe(topic);
  });

  it('finds no topic in an ordinary booking message', () => {
    expect(detectFaqTopic('I want the Urus from 15 October')).toBeNull();
  });
});
