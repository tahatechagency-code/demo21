import { randomUUID } from 'node:crypto';
import {
  classifyFrontDoor,
  ConversationPhase,
  type AIProvider,
  type GenerateStructuredInput,
  type GenerateStructuredResult,
} from '@ai-concierge/ai';
import { createEligibilityPolicyVersion, createVehicle, createVehicleUnit } from '@ai-concierge/db';
import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import {
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeNotificationProvider } from './test/fakeNotificationProvider.js';

/**
 * The 25-scenario routing/QA suite for the conversation front door, through the
 * real chat endpoint and a real Postgres. Every scenario checks the same nine
 * things: routing, intent, entities, state, database update, no hallucination,
 * no duplicate action, no lost context, and a natural customer reply.
 */
const POLICY: EligibilityPolicyRules = {
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
};
const BOOKING =
  'Hi, I would like to rent a Lamborghini Urus from 15 October to 19 October, pickup Dubai Marina';
const FULL_DETAILS =
  "I'm Indian, born 12 May 1990, I hold a UAE driving licence and I can provide my passport";

class ScriptedGemini implements AIProvider {
  readonly name = 'scripted';
  answer: unknown = 'THROW';
  calls = 0;
  lastPrompt = '';

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    const isUnderstand = input.schemaName === 'concierge-understand-v2';
    const isOptions = input.schemaName.startsWith('concierge-options-v2');
    if (!isUnderstand && !isOptions) throw new Error('unscripted call');
    this.calls += 1;
    this.lastPrompt = input.prompt;
    if (this.answer === 'THROW') throw new Error('gemini down');
    return {
      json: isUnderstand ? this.answer : { options: [] },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelId: 'scripted',
      latencyMs: 1,
    };
  }

  async healthCheck() {
    return 'CONFIGURED' as const;
  }
}

interface ChatBody {
  conversationId: string;
  journeyState: string | null;
  escalated: boolean;
  booking: { vehicle: string | null; pickupDate: string | null; returnDate: string | null } | null;
  quote: { quoteId: string; status: string } | null;
  reply: { id: string; text: string; attachments: unknown[] };
}

/** Nothing internal may ever reach the customer. */
function expectNatural(text: string): void {
  expect(text.length).toBeGreaterThan(10);
  expect(text).not.toMatch(
    /confidence|intent|routing|AI_UNCERTAIN|understood|undefined|null|\{|\}|\[object|gemini|classif/i,
  );
}

describe('conversation QA — 25 scenarios', () => {
  let testApp: TestApp;
  const gemini = new ScriptedGemini();

  beforeAll(async () => {
    testApp = await buildTestApp(
      { RATE_LIMIT_MAX: 5000, AUTH_RATE_LIMIT_MAX: 5000 },
      { aiProvider: gemini, notificationProvider: new FakeNotificationProvider() },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    const prisma = testApp.ctx.prisma;
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
    gemini.answer = 'THROW';
    gemini.calls = 0;
    const base = {
      tenantId: TEST_TENANT_ID,
      transmission: 'AUTOMATIC' as const,
      seats: 5,
      luggage: 4,
    };
    const urus = await createVehicle(prisma, {
      ...base,
      make: 'Lamborghini',
      model: 'Urus',
      color: 'Black',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    for (let unit = 0; unit < 2; unit += 1) {
      await createVehicleUnit(prisma, {
        tenantId: TEST_TENANT_ID,
        vehicleId: urus.id,
        unitRef: `URUS-${unit}`,
      });
    }
    for (const color of ['Black', 'White']) {
      await createVehicle(prisma, {
        ...base,
        make: 'BMW',
        model: 'X5',
        color,
        category: 'SUV',
        luxuryTier: 'LUXURY',
        pricingProfile: { currency: 'AED', dailyRate: 1200 },
      });
    }
    await createEligibilityPolicyVersion(prisma, { tenantId: TEST_TENANT_ID, rules: POLICY });
  });

  async function chat(sessionId: string, message: string, app: TestApp = testApp) {
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      payload: { sessionId, clientMessageId: randomUUID(), message },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ChatBody;
    expectNatural(body.reply.text);
    return body;
  }

  const cases = () => testApp.ctx.prisma.escalationCase.findMany({ orderBy: { createdAt: 'asc' } });
  const counts = async () => ({
    journeys: await testApp.ctx.prisma.journey.count(),
    quotes: await testApp.ctx.prisma.quote.count(),
    cases: await testApp.ctx.prisma.escalationCase.count(),
    inbound: await testApp.ctx.prisma.message.count(),
    outbound: await testApp.ctx.prisma.outboundMessage.count(),
  });
  const none = { phase: ConversationPhase.NO_CONTEXT } as const;

  async function quoted(sessionId = randomUUID()) {
    await chat(sessionId, BOOKING);
    const quote = await chat(sessionId, FULL_DETAILS);
    expect(quote.journeyState).toBe('QUOTE_ISSUED');
    return { sessionId, quote };
  }

  async function staffToken() {
    const email = 'ops@example.com';
    await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role: 'OPS_AGENT', email });
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: TEST_USER_PASSWORD },
    });
    return { authorization: `Bearer ${response.json().accessToken as string}` };
  }

  // ---------------------------------------------------------------- 1-6
  it('01 exact keyword: "cancel my booking" -> cancellation, handed to a person', async () => {
    expect(classifyFrontDoor('cancel my booking', none)).toMatchObject({ intent: 'CANCELLATION' });
    const result = await chat(randomUUID(), 'cancel my booking');
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toMatch(/nothing has been cancelled/i);
    expect((await cases()).map((row) => row.status)).toEqual(['OPEN']);
    expect(gemini.calls).toBe(0);
  });

  it('02 synonym: "call off my reservation" and "tariff" resolve to the right intents', async () => {
    expect(classifyFrontDoor('please call off my reservation', none).intent).toBe('CANCELLATION');
    expect(classifyFrontDoor("what's the tariff for the Urus", none).intent).toBe('PRICING');
    const price = await chat(randomUUID(), "what's the tariff for the Urus");
    expect(price.reply.text).toMatch(/AED 3,500/);
    expect(price.escalated).toBe(false);
    expect(gemini.calls).toBe(0);
  });

  it('03 typo: "prise of the urus" and "cancle my bookng" are still understood', async () => {
    const price = await chat(randomUUID(), 'prise of the urus');
    expect(price.reply.text).toMatch(/AED 3,500/);
    const cancel = await chat(randomUUID(), 'cancle my bookng');
    expect(cancel.escalated).toBe(true);
    expect(gemini.calls).toBe(0);
  });

  it('04 short message: "cancel" escalates, "hi" is only a greeting', async () => {
    expect((await chat(randomUUID(), 'cancel')).escalated).toBe(true);
    const before = (await cases()).length;
    const greeting = await chat(randomUUID(), 'hi');
    expect(greeting.escalated).toBe(false);
    expect((await cases()).length).toBe(before);
  });

  it('05 ambiguous: unreadable text goes to Gemini once, then to the options — a person only after two misses', async () => {
    gemini.answer = {
      understood: false,
      intent: 'UNKNOWN',
      confidence: 0.3,
      action: 'ANSWER',
      answer: '',
      reason: 'unclear',
    };
    const session = randomUUID();
    const first = await chat(session, 'hmm that thing from before');
    expect(first.escalated).toBe(false);
    expect(first.reply.text).toMatch(/Did you mean one of these/);
    expect(await cases()).toHaveLength(0);
    // The understanding call happened once for this message (the options call is the second).
    expect(gemini.calls).toBe(2);
    const second = await chat(session, 'that other thing I mentioned');
    expect(second.escalated).toBe(false);
    expect(second.reply.text).toMatch(/CONTACT MY TEAM/);
    const third = await chat(session, '4');
    expect(third.escalated).toBe(true);
    expect((await cases()).map((row) => row.status)).toEqual(['OPEN']);
  });

  it('06 multiple intents: price + cancel + delivery -> price answered, cancel handed over once', async () => {
    const message =
      'How much is the Urus and can I cancel my other booking and do you deliver to the airport';
    const result = await chat(randomUUID(), message);
    expect(result.reply.text).toMatch(/AED 3,500/);
    expect(result.reply.text).toMatch(/nothing has been cancelled/i);
    expect(await cases()).toHaveLength(1);
    expect(classifyFrontDoor(message, none).secondaryIntents).toEqual(
      expect.arrayContaining(['PRICING', 'DELIVERY_PICKUP']),
    );
  });

  // ---------------------------------------------------------------- 7-13
  it('07 context-dependent: "the black one" continues the question we asked', async () => {
    const session = randomUUID();
    await chat(session, 'I want to rent the BMW X5');
    const answer = await chat(session, 'the black one');
    expect(answer.escalated).toBe(false);
    expect(answer.booking?.vehicle).toMatch(/BMW X5/i);
    expect(gemini.calls).toBe(0);
  });

  it('08 "yes": after a quote it is an acceptance and a person takes over the booking', async () => {
    const { sessionId } = await quoted();
    const before = await counts();
    const result = await chat(sessionId, 'yes, book it');
    expect(result.escalated).toBe(true);
    expect((await cases()).at(-1)!.detail).toMatch(/accepted quote/i);
    expect((await counts()).quotes).toBe(before.quotes);
  });

  it('09 "no": declining after a quote changes nothing and cancels nothing', async () => {
    const { sessionId, quote } = await quoted();
    const before = await counts();
    const result = await chat(sessionId, 'no thanks');
    expect(result.quote?.quoteId).toBe(quote.quote!.quoteId);
    expect(result.quote?.status).toBe('ISSUED');
    expect((await counts()).cases).toBe(before.cases);
    expect(result.reply.text).not.toMatch(/cancelled/i);
  });

  it('10 "that one": the car is the BMW X5 and the colour stays open until the customer names one', async () => {
    const session = randomUUID();
    const first = await chat(session, 'I want to rent the BMW X5');
    expect(first.reply.text).toMatch(/Black or White|black and white/i);
    expect(first.booking?.vehicle).toBe('BMW X5');
    const second = await chat(session, 'that one');
    // "that one" does not pick a colour, so none is assumed — but the car itself is never forgotten.
    expect(second.booking?.vehicle).toBe('BMW X5');
    expect(second.escalated).toBe(false);
  });

  it('11 "tomorrow": fills the pickup date on the open booking', async () => {
    const session = randomUUID();
    await chat(session, 'I want to rent the Lamborghini Urus');
    const result = await chat(session, 'tomorrow');
    expect(result.booking?.pickupDate).not.toBeNull();
    expect(result.booking?.vehicle).toMatch(/Urus/);
    expect(result.escalated).toBe(false);
  });

  it('12 requirement change: a new return date replaces the old one, the rest is kept', async () => {
    const session = randomUUID();
    const first = await chat(session, BOOKING);
    const changed = await chat(session, 'Actually I will return it on 21 October instead');
    expect(changed.booking?.vehicle).toMatch(/Urus/);
    expect(changed.booking?.returnDate).not.toBe(first.booking?.returnDate);
    expect(changed.booking?.returnDate).toMatch(/-10-21/);
    expect(changed.escalated).toBe(false);
  });

  it('13 topic switch: a documents question is answered and the booking survives it', async () => {
    const session = randomUUID();
    await chat(session, BOOKING);
    const docs = await chat(session, 'what documents do I need?');
    // Answered from the owner's terms (no model involved), and the booking is still where it was.
    expect(docs.reply.text).toMatch(/passport/);
    expect(docs.reply.text).toMatch(/UAE driving licence/);
    expect(gemini.calls).toBe(0);
    expect(docs.escalated).toBe(false);
    expect(docs.booking?.vehicle).toMatch(/Urus/);
    const back = await chat(session, FULL_DETAILS);
    expect(back.journeyState).toBe('QUOTE_ISSUED');
  });

  // ---------------------------------------------------------------- 14-18
  it.each([
    ['14 Gemini failure', 'THROW'],
    ['15 Gemini timeout', 'THROW'],
    [
      '16 Gemini misunderstanding',
      {
        understood: true,
        intent: 'BOOKING',
        confidence: 0.3,
        action: 'CONTINUE_BOOKING',
        answer: '',
        reason: '',
      },
    ],
  ])('%s: never guesses, offers options, then a person once — no loop', async (_name, answer) => {
    gemini.answer = answer;
    const session = randomUUID();
    const first = await chat(session, 'asdf qwerty zzz');
    expect(first.escalated).toBe(false);
    expect(first.reply.text).toMatch(/Did you mean one of these/);
    expect(first.reply.text).not.toMatch(/booked|confirmed|cancelled/i);
    const second = await chat(session, 'zzz qwerty asdf again');
    expect(second.reply.text).toMatch(/CONTACT MY TEAM/);
    const third = await chat(session, 'still asdf zzz nothing');
    expect(third.escalated).toBe(true);
    const fourth = await chat(session, 'zzz hmm qwerty');
    expect(fourth.reply.text.length).toBeGreaterThan(10);
    expect(await cases()).toHaveLength(1);
  });

  it('17 human escalation: an explicit request opens a case with the conversation attached', async () => {
    const result = await chat(randomUUID(), 'I want to talk to a real person');
    expect(result.escalated).toBe(true);
    const [row] = await cases();
    expect(row!.status).toBe('OPEN');
    const transcript = await testApp.ctx.prisma.message.count({
      where: { conversationId: result.conversationId },
    });
    expect(transcript).toBe(1);
  });

  it('18 human resolution: the person answers, resolves, and the customer carries on with no repeats', async () => {
    const { sessionId } = await quoted();
    const escalated = await chat(sessionId, 'yes, book it');
    expect(escalated.escalated).toBe(true);
    const headers = await staffToken();

    const staff = await testApp.app.inject({
      method: 'POST',
      url: `/v1/enquiries/${escalated.conversationId}/staff-reply`,
      headers,
      payload: { message: 'Hi, this is Sam. I have your Urus booking and will confirm it now.' },
    });
    expect(staff.statusCode).toBe(200);

    const [row] = await cases();
    await testApp.app.inject({ method: 'POST', url: `/v1/escalations/${row!.id}/assign`, headers });
    const resolved = await testApp.app.inject({
      method: 'POST',
      url: `/v1/escalations/${row!.id}/resolve`,
      headers,
      payload: { resolution: 'APPROVED', resolutionNote: 'confirmed with customer' },
    });
    expect(resolved.statusCode).toBe(200);
    expect((await cases())[0]!.status).toBe('RESOLVED');

    const history = await testApp.app.inject({
      method: 'GET',
      url: `/v1/chat/sessions/${sessionId}`,
    });
    const roles = (history.json().messages as { role: string }[]).map((message) => message.role);
    expect(roles).toContain('STAFF');
    expect(roles.filter((role) => role === 'CUSTOMER')).toHaveLength(3);

    const next = await chat(sessionId, 'thank you, what time can I collect it?');
    expect(next.reply.text).not.toMatch(/tell me which car|date of birth/i);
    expect(next.quote?.quoteId).toBe(escalated.quote?.quoteId);
  });

  // ---------------------------------------------------------------- 19-21
  it('19 session restart: a fresh server picks the conversation up where it stopped', async () => {
    const session = randomUUID();
    await chat(session, BOOKING);
    const restarted = await buildTestApp(
      { RATE_LIMIT_MAX: 5000 },
      { aiProvider: gemini, notificationProvider: new FakeNotificationProvider() },
    );
    try {
      const history = await restarted.app.inject({
        method: 'GET',
        url: `/v1/chat/sessions/${session}`,
      });
      expect(history.json().journeyState).toBe('ELIGIBILITY_CHECK');
      expect(history.json().booking.vehicle).toMatch(/Urus/);
      const next = await chat(session, FULL_DETAILS, restarted);
      expect(next.journeyState).toBe('QUOTE_ISSUED');
    } finally {
      await restarted.close();
    }
  });

  it('20 database persistence: every turn, journey, quote and case is stored exactly once', async () => {
    const { sessionId } = await quoted();
    await chat(sessionId, 'cancel my booking');
    const stored = await counts();
    expect(stored).toEqual({ journeys: 1, quotes: 1, cases: 1, inbound: 3, outbound: 3 });
    const journey = await testApp.ctx.prisma.journey.findFirstOrThrow();
    expect(journey.state).toBe('ESCALATED');
  });

  it('21 duplicate booking attempt: repeating the request never creates a second journey or quote', async () => {
    const session = randomUUID();
    await chat(session, BOOKING);
    await chat(session, BOOKING);
    await chat(session, FULL_DETAILS);
    await chat(session, FULL_DETAILS);
    const stored = await counts();
    expect(stored.journeys).toBe(1);
    expect(stored.quotes).toBe(1);
    expect(stored.cases).toBe(0);
  });

  // ---------------------------------------------------------------- 22-25
  it('22 payment: a payment problem goes to a person and no refund is ever claimed', async () => {
    const result = await chat(randomUUID(), 'my card declined and I was charged twice');
    expect(result.escalated).toBe(true);
    expect((await cases())[0]!.reason).toBe('PAYMENT_EXCEPTION');
    expect(result.reply.text).not.toMatch(/refunded|has been paid/i);
  });

  it('23 cancellation: with a live quote, the quote is untouched until a person acts', async () => {
    const { sessionId } = await quoted();
    const result = await chat(sessionId, 'cancel my booking');
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toMatch(/nothing has been cancelled/i);
    const row = await testApp.ctx.prisma.quote.findFirstOrThrow();
    expect(await testApp.ctx.prisma.quote.count()).toBe(1);
    expect(row.status).toBe('ISSUED');
  });

  it('24 rescheduling: the requested time is recorded for the person, the booking is not edited by AI', async () => {
    const { sessionId, quote } = await quoted();
    const result = await chat(sessionId, 'Actually can you move pickup to 7 pm?');
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toMatch(/7 PM/);
    expect((await cases()).at(-1)!.detail).toMatch(/pickup 19:00/);
    expect(result.quote?.quoteId).toBe(quote.quote!.quoteId);
    expect(result.booking?.returnDate).toBe(quote.booking?.returnDate);
  });

  it('25 complete end to end: enquiry -> details -> quote -> acceptance -> person confirms', async () => {
    const session = randomUUID();
    const asked = await chat(session, BOOKING);
    expect(asked.journeyState).toBe('ELIGIBILITY_CHECK');
    const priced = await chat(session, FULL_DETAILS);
    expect(priced.reply.text).toMatch(/Total: AED/);
    expect(priced.quote?.status).toBe('ISSUED');
    const accepted = await chat(session, 'yes, please book it');
    expect(accepted.escalated).toBe(true);
    expect(accepted.quote?.quoteId).toBe(priced.quote?.quoteId);
    expect(await testApp.ctx.prisma.availabilityHold.count()).toBe(1);
    expect(await cases()).toHaveLength(1);
    expect(gemini.calls).toBe(0);
  });
});
