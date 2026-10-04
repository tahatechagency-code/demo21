import { describe, expect, it } from 'vitest';
import { FaqTopic } from '../router/faqTopics.js';
import { expandVehicleAliases, resolveVehicleMention } from './fleetKnowledge.js';
import { answerPolicies, detectPolicyTopics, type PolicyContext } from './policyFaq.js';
import { DEFAULT_BUSINESS_PROFILE as profile } from './profile.js';
import { fixtureFleet } from './test/fleetFixture.js';

const fleet = fixtureFleet();
const ctx = (configured: [string, string][] = []): PolicyContext => ({
  profile,
  fleet,
  minAgeByTier: { ULTRA_LUXURY: 25 },
  policyMinAge: 21,
  vatPercent: 5,
  configured: new Map(configured as [(typeof FaqTopic)[keyof typeof FaqTopic], string][]),
});

describe('FAQ topics people ask in Hinglish', () => {
  it.each([
    ['kitne km free hain?', 'MILEAGE'],
    ['how many km are included', 'MILEAGE'],
    ['late return charge kya hai?', 'LATE_RETURN'],
    ['what if I return the car late', 'LATE_RETURN'],
    ['booking confirm kaise hoga?', 'BOOKING_PROCESS'],
    ['how do I book?', 'BOOKING_PROCESS'],
    ['payment link bhejo', 'PAYMENT_LINK'],
  ] as const)('"%s" is %s', (text, topic) => {
    expect(detectPolicyTopics(text)).toContain(topic);
  });

  it('"payment link" is not also a payment-methods question', () => {
    expect(detectPolicyTopics('payment link bhejo')).toEqual(['PAYMENT_LINK']);
  });

  it('the payment link and booking steps are answered from how the concierge works', () => {
    expect(answerPolicies('payment link bhejo', ctx())!.text).toMatch(/payment link right here in this chat/);
    expect(answerPolicies('booking confirm kaise hoga?', ctx())!.text).toMatch(/quote/);
  });
});

describe('several questions in one message', () => {
  it('answers the deposit and says honestly what it does not know, once', () => {
    const a = answerPolicies('Urus deposit aur insurance kya hai', ctx())!;
    expect(a.kind).toBe('ANSWER');
    expect(a.text).toMatch(/deposit/i);
    expect(a.text).toMatch(/I do not have insurance confirmed/);
    expect(a.text.match(/Reply TEAM/g)).toHaveLength(1);
  });

  it('answers every configured topic and joins the honest line for the rest', () => {
    const a = answerPolicies(
      'deposit kitna aur chauffeur bhi chahiye aur insurance?',
      ctx([[FaqTopic.CHAUFFEUR, 'Chauffeur service is available on request.']]),
    )!;
    expect(a.text).toContain('Chauffeur service is available on request.');
    expect(a.text).toMatch(/I do not have insurance confirmed/);
  });

  it('a lone unknown topic is the plain "not configured" answer', () => {
    expect(answerPolicies('fuel policy kya hai?', ctx())!.kind).toBe('UNCONFIGURED');
  });
});

describe('a place after a brand is a place, not a model', () => {
  it('"Lambo kal 5 din Marina" is the Urus brand request, not a missing "Lamborghini Marina"', () => {
    const mention = resolveVehicleMention(expandVehicleAliases('Lambo kal 5 din Marina deposit kitna', fleet), fleet);
    expect(mention.kind).not.toBe('NOT_IN_FLEET');
  });

  it('a car the fleet really lacks is still reported', () => {
    const mention = resolveVehicleMention('Lamborghini Huracan available hai', fleet);
    expect(mention.kind).toBe('NOT_IN_FLEET');
  });
});
