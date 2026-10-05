import { describe, expect, it } from 'vitest';
import { classifyFrontDoor, ConversationPhase } from '../router/frontDoor.js';
import { seatFilterReply } from './fleetReplies.js';
import { detectPolicyTopics } from './policyFaq.js';
import { DEFAULT_BUSINESS_PROFILE as profile } from './profile.js';
import { fixtureFleet } from './test/fleetFixture.js';

const fleet = fixtureFleet();
const none = { phase: ConversationPhase.NO_CONTEXT } as const;

describe('seat-count questions', () => {
  it('lists only cars with enough seats', () => {
    const text = seatFilterReply(fleet, 7, profile);
    expect(text).toMatch(/7 or more seats/);
    for (const model of fleet.models.filter((m) => m.seats < 7)) {
      expect(text).not.toContain(model.name);
    }
  });

  it('says so, with the real maximum, when no car is big enough', () => {
    const biggest = Math.max(...fleet.models.map((model) => model.seats));
    const text = seatFilterReply(fleet, biggest + 3, profile);
    expect(text).toMatch(new RegExp(`largest seats ${biggest}`));
  });
});

describe('chauffeur wording', () => {
  it.each(['can I get a driver with the car?', 'I need a driver', 'chauffeur milega kya', 'driver included?'])(
    '"%s" is a chauffeur question',
    (text) => {
      expect(detectPolicyTopics(text)).toContain('CHAUFFEUR');
    },
  );
});

describe('complaints about honesty reach a person', () => {
  it.each([
    'you people are frauds',
    'this is a scam',
    'scammers!',
    'you cheated me',
    'ye to loot hai',
    'rip-off',
  ])('"%s" is a complaint', (text) => {
    expect(classifyFrontDoor(text, none).intent).toBe('COMPLAINT_DAMAGE');
  });
});

describe('policy wording from the second holdout', () => {
  it.each([
    ['minimum driver age for the Urus', 'MIN_AGE'],
    ['do tourists need anything extra to drive', 'LICENCE'],
    ['agar gaadi der se wapas karun to?', 'LATE_RETURN'],
  ] as const)('"%s" is %s', (text, topic) => {
    expect(detectPolicyTopics(text)).toContain(topic);
  });
});

describe('holdout 3 wording', () => {
  it.each(['mera paisa wapas karo', 'paise wapas chahiye', 'refund do'])('"%s" is a refund request', (text) => {
    expect(classifyFrontDoor(text, none).intent).toBe('PAYMENT_REFUND');
  });
});

describe('greeting typos', () => {
  it.each(['hlo', 'helo', 'hii', 'heyy', 'hellooo', 'yo'])('"%s" is a greeting', (text) => {
    expect(classifyFrontDoor(text, none).intent).toBe('GREETING');
  });
});
