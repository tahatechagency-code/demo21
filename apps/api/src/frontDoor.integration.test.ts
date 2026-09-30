import { randomUUID } from 'node:crypto';
import type {
  AIProvider,
  GenerateStructuredInput,
  GenerateStructuredResult,
} from '@ai-concierge/ai';
import {
  createEligibilityPolicyVersion,
  createVehicle,
  createVehiclePhoto,
} from '@ai-concierge/db';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeNotificationProvider } from './test/fakeNotificationProvider.js';

/**
 * The layered front door end to end, through the real chat endpoint and a real
 * Postgres: rules -> Gemini (scripted here) -> a person, with the database as
 * the only source of truth. Gemini's classification is scripted per test; every
 * other Gemini call fails, so replies are the deterministic drafts.
 */
class ScriptedGemini implements AIProvider {
  readonly name = 'scripted';
  interpretation: unknown = null;
  interpretationCalls = 0;
  lastPrompt = '';

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    if (input.schemaName !== 'concierge-turn-v1') throw new Error('unscripted call');
    this.interpretationCalls += 1;
    this.lastPrompt = input.prompt;
    if (this.interpretation === 'THROW') throw new Error('timeout');
    return {
      json: this.interpretation,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelId: 'scripted',
      latencyMs: 1,
    };
  }

  async healthCheck() {
    return 'CONFIGURED' as const;
  }
}

describe('front door — integration', () => {
  let testApp: TestApp;
  const gemini = new ScriptedGemini();

  beforeAll(async () => {
    testApp = await buildTestApp(
      { RATE_LIMIT_MAX: 5000 },
      { aiProvider: gemini, notificationProvider: new FakeNotificationProvider() },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  let bmwBlackId = '';

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    gemini.interpretation = null;
    gemini.interpretationCalls = 0;
    const base = {
      tenantId: TEST_TENANT_ID,
      category: 'SUV' as const,
      luxuryTier: 'LUXURY' as const,
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC' as const,
    };
    bmwBlackId = (
      await createVehicle(testApp.ctx.prisma, {
        ...base,
        make: 'BMW',
        model: 'X5',
        color: 'Black',
        pricingProfile: { currency: 'AED', dailyRate: 1200 },
      })
    ).id;
    await createVehicle(testApp.ctx.prisma, {
      ...base,
      make: 'BMW',
      model: 'X5',
      color: 'White',
      pricingProfile: { currency: 'AED', dailyRate: 1300 },
    });
    await createVehicle(testApp.ctx.prisma, {
      ...base,
      make: 'Ferrari',
      model: 'Roma',
      color: 'Red',
      pricingProfile: { currency: 'AED', dailyRate: 4000 },
    });
  });

  async function seedPolicy() {
    await createEligibilityPolicyVersion(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      rules: {
        minAge: 21,
        minAgeByLuxuryTier: { ULTRA_LUXURY: 25 },
        requiredLicenseTypes: ['UAE', 'GCC', 'IDP'],
        passportRequired: true,
        nationalityRules: { blockedNationalities: [], allowedNationalitiesOnly: [] },
        vehicleRestrictions: {},
        restrictedCities: [],
        driverRequirements: {
          maxAdditionalDrivers: 2,
          additionalDriverMinAge: 21,
          additionalDriversRequireValidLicense: true,
        },
      },
    });
  }

  async function chat(sessionId: string, message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      payload: { sessionId, clientMessageId: randomUUID(), message },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      reply: { text: string; attachments: { url: string; caption: string }[] };
      escalated: boolean;
      journeyState: string | null;
    };
  }

  it('hands a cancellation to a person and never claims it was cancelled', async () => {
    const result = await chat(randomUUID(), 'Cancel my BMW booking');
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toMatch(/passed .* to our team/i);
    expect(result.reply.text).toMatch(/nothing has been cancelled/i);
    expect(result.reply.text.replace(/nothing has been cancelled/i, '')).not.toMatch(/cancelled/i);
    expect(gemini.interpretationCalls).toBe(0);
  });

  it('hands refunds and damage to a person', async () => {
    const refund = await chat(randomUUID(), 'I want a refund for my last rental');
    expect(refund.escalated).toBe(true);
    const damage = await chat(randomUUID(), 'there was an accident with the car');
    expect(damage.escalated).toBe(true);
    const cases = await testApp.ctx.prisma.escalationCase.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(cases.map((row) => row.reason)).toEqual(['PAYMENT_EXCEPTION', 'DAMAGE_OR_DISPUTE']);
  });

  it('answers pricing from the catalog, not from the model', async () => {
    const result = await chat(randomUUID(), 'How much is the BMW X5 per day?');
    expect(result.reply.text).toMatch(/starts from AED 1,200 per day \(Black and White\)/);
    expect(result.reply.text).toMatch(/exact quote/i);
    expect(result.escalated).toBe(false);
    expect(gemini.interpretationCalls).toBe(0);
  });

  it('asks which car when pricing names none', async () => {
    const result = await chat(randomUUID(), 'what are your rates?');
    expect(result.reply.text).toMatch(/which car/i);
    expect(result.reply.text).toMatch(/BMW X5/i);
  });

  it('understands a typo-ridden booking message without Gemini', async () => {
    const result = await chat(randomUUID(), 'helo i wana rnt a bmw x5 for 3 dayz');
    expect(result.escalated).toBe(false);
    expect(result.reply.text).not.toMatch(/passed|team/i);
    expect(gemini.interpretationCalls).toBe(0);
  });

  it('sends stored photos of the named car, and only stored ones', async () => {
    const empty = await chat(randomUUID(), 'send me pics of the Ferrari');
    expect(empty.reply.attachments).toHaveLength(0);
    expect(empty.reply.text).toMatch(/do not have photos/i);

    await createVehiclePhoto(testApp.ctx.prisma, {
      id: randomUUID(),
      tenantId: TEST_TENANT_ID,
      vehicleId: bmwBlackId,
      storageKey: 'bmw-front.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1234,
      caption: 'front',
    });
    const withPhoto = await chat(randomUUID(), 'show me a picture of the BMW X5');
    expect(withPhoto.reply.attachments).toHaveLength(1);
    expect(withPhoto.reply.attachments[0]!.caption).toMatch(/BMW X5 \(Black\)/i);
  });

  it('lists the fleet from the catalogue when asked what cars there are', async () => {
    const result = await chat(randomUUID(), 'what cars do you have?');
    expect(result.reply.text).toMatch(/BMW \(X5\); Ferrari \(Roma\)/);
    expect(result.escalated).toBe(false);
  });

  it('turns a pickup change with no booking into a question, not a fake change', async () => {
    const result = await chat(randomUUID(), 'Actually can you move pickup to 7 pm?');
    expect(result.escalated).toBe(false);
    expect(result.reply.text).toMatch(/can't see a booking/i);
  });

  const turn = (fields: Record<string, unknown>) => ({
    route: 'ANSWER',
    intent: 'FAQ',
    confidence: 0.9,
    reply: '',
    human_reason: null,
    ...fields,
  });

  it('gives Gemini the facts pack: fleet, rates, driver rules and what is NOT PROVIDED', async () => {
    gemini.interpretation = turn({ reply: 'Happy to help with that.' });
    await chat(randomUUID(), 'whats the deal with my papers');
    expect(gemini.lastPrompt).toContain('BMW X5 (Black/White): from AED 1,200 per day');
    expect(gemini.lastPrompt).toContain('DRIVER REQUIREMENTS:');
    expect(gemini.lastPrompt).toContain('HOURS: NOT PROVIDED');
    expect(gemini.lastPrompt).toContain('LATEST CUSTOMER MESSAGE:\nwhats the deal with my papers');
  });

  it('asks Gemini once for an unreadable message and sends a grounded answer', async () => {
    gemini.interpretation = turn({
      intent: 'DOCUMENTS',
      reply: 'You will need your passport and a valid driving licence. Which car are you eyeing?',
    });
    const result = await chat(randomUUID(), 'whats the deal with my papers');
    expect(gemini.interpretationCalls).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.reply.text).toContain('passport and a valid driving licence');
    expect(await testApp.ctx.prisma.escalationCase.count()).toBe(0);
  });

  it('answers a recognised side question (documents) through Gemini instead of a template', async () => {
    gemini.interpretation = turn({
      intent: 'DOCUMENTS',
      reply: 'A valid licence and your passport are all you need.',
    });
    const result = await chat(randomUUID(), 'what documents do I need?');
    expect(gemini.interpretationCalls).toBe(1);
    expect(result.reply.text).toContain('A valid licence and your passport');
  });

  it('keeps the booking flow reply when Gemini is unavailable for a recognised side question', async () => {
    gemini.interpretation = 'THROW';
    const result = await chat(randomUUID(), 'what documents do I need?');
    expect(gemini.interpretationCalls).toBe(1);
    expect(result.escalated).toBe(false);
  });

  it('hands the turn back to the booking system when Gemini sees booking details', async () => {
    gemini.interpretation = turn({ route: 'CONTINUE_BOOKING', intent: 'BOOKING', confidence: 0.9 });
    const result = await chat(randomUUID(), 'something that would impress my in-laws');
    expect(gemini.interpretationCalls).toBe(1);
    expect(result.escalated).toBe(false);
  });

  it.each([
    [
      'unsure and asks for a person',
      turn({ route: 'HUMAN', intent: 'UNKNOWN', confidence: 0.2, human_reason: 'unclear' }),
    ],
    [
      'low confidence',
      turn({ intent: 'BOOKING', confidence: 0.3, reply: 'Sure, whatever you like.' }),
    ],
    ['off-schema', { hello: 'world' }],
    ['timing out / failing', 'THROW'],
  ])('escalates to a person when Gemini is %s — one call, no loop', async (_label, answer) => {
    gemini.interpretation = answer;
    const result = await chat(randomUUID(), 'asdf qwerty zzz');
    expect(gemini.interpretationCalls).toBe(1);
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toMatch(/member of our team/i);
    const escalation = await testApp.ctx.prisma.escalationCase.findFirstOrThrow();
    expect(escalation.detail).toMatch(/AI_UNCERTAIN/);
  });

  it('uses the caring reply Gemini wrote when it asks for a person and the reply is safe', async () => {
    gemini.interpretation = turn({
      route: 'HUMAN',
      intent: 'UNKNOWN',
      confidence: 0.6,
      reply: 'That one is best answered by our team, so I have passed it to them.',
    });
    const result = await chat(randomUUID(), 'my cousin told me something odd about the terms');
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toBe(
      'That one is best answered by our team, so I have passed it to them.',
    );
  });

  it.each([
    ['invents payment methods', 'We accept both card and cash here!', 'UNGROUNDED_PAYMENT_METHODS'],
    ['invents opening hours', 'Yes, we are open 24/7, any time.', 'UNGROUNDED_HOURS'],
    ['denies being an AI', 'Nope, not a robot! Ask me anything.', 'DENIES_BEING_AI'],
    ['promises to check', 'Let me check on that and get back to you.', 'UNKEPT_PROMISE'],
    ['invents a price', 'The X5 is only AED 500 per day.', 'UNGROUNDED_NUMBER'],
    ['claims an action', 'Done, I have cancelled it for you.', 'CLAIMS_AN_ACTION'],
  ])('never sends a Gemini answer that %s: a person takes over', async (_label, reply, why) => {
    gemini.interpretation = turn({ reply });
    const result = await chat(randomUUID(), 'tell me about your service please');
    expect(result.escalated).toBe(true);
    expect(result.reply.text).not.toContain(reply);
    const escalation = await testApp.ctx.prisma.escalationCase.findFirstOrThrow();
    expect(escalation.detail).toContain(why);
  });

  it('a business question is answered by Gemini even though a booking rule also matches', async () => {
    gemini.interpretation = turn({
      reply:
        "I'm not sure whether we offer chauffeurs, so I've asked our team to confirm. They'll reply here.",
    });
    const result = await chat(randomUUID(), 'do you have cars with a driver for a wedding?');
    expect(gemini.interpretationCalls).toBe(1);
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toContain('asked our team to confirm');
  });

  it('an eligibility question ("I am 22, can I rent a Ferrari?") reaches Gemini with the age rules', async () => {
    gemini.interpretation = turn({
      reply:
        'Ferraris need a driver of at least 25, so not yet at 22, but the BMW X5 is open to you.',
    });
    await seedPolicy();
    const result = await chat(randomUUID(), 'I am 22, can I rent a Ferrari?');
    expect(gemini.interpretationCalls).toBe(1);
    expect(gemini.lastPrompt).toContain('LATEST CUSTOMER MESSAGE:\nI am 22, can I rent a Ferrari?');
    expect(result.reply.text).toContain('at least 25');
    expect(gemini.lastPrompt).toContain('Minimum driver age 21.');
    expect(result.escalated).toBe(false);
  });

  it('a rules question is never passed on to the booking flow: Gemini answers it or a person does', async () => {
    gemini.interpretation = turn({
      route: 'CONTINUE_BOOKING',
      intent: 'BOOKING',
      confidence: 0.95,
    });
    const result = await chat(randomUUID(), 'I am 22, can I rent a Ferrari?');
    expect(gemini.interpretationCalls).toBe(1);
    expect(gemini.lastPrompt).toContain('CONTINUE_BOOKING is not allowed');
    expect(result.escalated).toBe(true);
  });

  it('an answer that promises the team will ask is treated as the hand-over it is', async () => {
    gemini.interpretation = turn({
      reply: 'I am not sure about the insurance details, so I will ask our team to confirm.',
    });
    const result = await chat(randomUUID(), 'is insurance included?');
    expect(result.escalated).toBe(true);
  });

  it('a configured business fact is answered; anything else is never invented', async () => {
    const withFacts = await buildTestApp(
      { RATE_LIMIT_MAX: 5000, BUSINESS_FACTS_JSON: '{"HOURS":"Daily 9-21"}' },
      { aiProvider: gemini, notificationProvider: new FakeNotificationProvider() },
    );
    try {
      gemini.interpretation = turn({ reply: 'We are open daily 9-21, so drop in any time.' });
      const response = await withFacts.app.inject({
        method: 'POST',
        url: '/v1/chat/messages',
        payload: {
          sessionId: randomUUID(),
          clientMessageId: randomUUID(),
          message: 'when are you open?',
        },
      });
      expect(response.json().reply.text).toContain('open daily 9-21');
      expect(response.json().escalated).toBe(false);
      expect(gemini.lastPrompt).toContain('HOURS: Daily 9-21');
    } finally {
      await withFacts.close();
    }
  });

  it('a risky reading by Gemini uses the reviewed hand-over wording, never its own', async () => {
    gemini.interpretation = turn({
      route: 'HUMAN',
      intent: 'PAYMENT_REFUND',
      confidence: 0.95,
      reply: 'Sure, I will sort your money out.',
    });
    const result = await chat(randomUUID(), 'my money situation is a mess again');
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toContain('Payments and refunds are handled by our team');
    expect(result.reply.text).not.toContain('sort your money out');
  });

  it('does not re-escalate or re-ask once a person owns the conversation', async () => {
    const session = randomUUID();
    await chat(session, 'Cancel my BMW booking');
    const cases = await testApp.ctx.prisma.escalationCase.count();
    await chat(session, 'hello??');
    await chat(session, 'asdf');
    expect(await testApp.ctx.prisma.escalationCase.count()).toBe(cases);
    expect(gemini.interpretationCalls).toBe(0);
  });

  it('keeps an open booking going through short, context-dependent replies', async () => {
    const session = randomUUID();
    await chat(session, 'I want to rent the BMW X5');
    for (const reply of ['yes', 'the white one', 'tomorrow']) {
      const result = await chat(session, reply);
      expect(result.escalated).toBe(false);
    }
    expect(gemini.interpretationCalls).toBe(0);
  });

  it('reads a short reply as the answer to the question we just asked', async () => {
    const session = randomUUID();
    const asked = await chat(session, 'what cars do you have?');
    expect(asked.reply.text).toMatch(/We offer/);
    // Our list ends "…availability." (no question), so an odd reply is still unknown.
    const question = await chat(session, 'I want to book');
    expect(question.reply.text).toContain('?');
    const answer = await chat(session, 'the blue one');
    expect(answer.escalated).toBe(false);
    expect(gemini.interpretationCalls).toBe(0);
  });

  it('while a person owns the conversation, plain factual questions are still answered from the database', async () => {
    const session = randomUUID();
    await chat(session, 'Cancel my BMW booking');
    const cases = await testApp.ctx.prisma.escalationCase.count();
    const price = await chat(session, 'How much is the Ferrari Roma?');
    expect(price.reply.text).toMatch(/starts from AED 4,000/);
    expect(price.reply.text).toMatch(/team is still looking after/i);
    const fleet = await chat(session, 'what cars do you have?');
    expect(fleet.reply.text).toMatch(/We offer/);
    expect(await testApp.ctx.prisma.escalationCase.count()).toBe(cases);
    // Anything that is not a plain factual question is still left to the person.
    const other = await chat(session, 'ok thanks, I will wait');
    expect(other.reply.text).toMatch(/team is already looking after/i);
  });

  it('answers every part of a multi-intent message it can, and hands over the risky part', async () => {
    const result = await chat(
      randomUUID(),
      'How much is the Ferrari Roma, can I cancel my other booking and do you deliver to the airport?',
    );
    expect(result.reply.text).toMatch(/On pricing: The Ferrari Roma starts from AED 4,000/);
    expect(result.reply.text).toMatch(/nothing has been cancelled/i);
    expect(result.reply.text).toMatch(/On pickup and delivery: we cover .*Dubai Airport/);
    expect(await testApp.ctx.prisma.escalationCase.count()).toBe(1);
  });

  it('a lone "yes" with no conversation is not escalated', async () => {
    const result = await chat(randomUUID(), 'yes');
    expect(result.escalated).toBe(false);
  });

  it('is idempotent: a retried message id does not create a second escalation', async () => {
    const session = randomUUID();
    const clientMessageId = randomUUID();
    const send = () =>
      testApp.app.inject({
        method: 'POST',
        url: '/v1/chat/messages',
        payload: { sessionId: session, clientMessageId, message: 'Cancel my BMW booking' },
      });
    await send();
    await send();
    expect(await testApp.ctx.prisma.escalationCase.count()).toBe(1);
  });
});
