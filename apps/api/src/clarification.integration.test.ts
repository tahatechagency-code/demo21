import { randomUUID } from 'node:crypto';
import type {
  AIProvider,
  GenerateStructuredInput,
  GenerateStructuredResult,
} from '@ai-concierge/ai';
import { createEligibilityPolicyVersion, createVehicle } from '@ai-concierge/db';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runFollowUpSweep } from './services/followUpService.js';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeNotificationProvider } from './test/fakeNotificationProvider.js';

/**
 * The customer-facing flow map, end to end through the real chat endpoint and a real Postgres:
 *
 *   understood -> action | not understood -> 3 options + "Contact my team" -> (wrong message) the same
 *   options again, in detail -> a person in the same chat; guesses are never selections; budgets are
 *   answered from the fleet database in dollars; quiet chats are checked in on.
 */
class ScriptedGemini implements AIProvider {
  readonly name = 'scripted';
  answer: unknown = 'THROW';
  lastPrompt = '';

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    if (input.schemaName !== 'concierge-turn-v1') throw new Error('unscripted call');
    this.lastPrompt = input.prompt;
    if (this.answer === 'THROW') throw new Error('gemini down');
    return {
      json: this.answer,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelId: 'scripted',
      latencyMs: 1,
    };
  }

  async healthCheck() {
    return 'CONFIGURED' as const;
  }
}

const UNCLEAR = {
  route: 'UNCLEAR',
  intent: 'UNKNOWN',
  confidence: 0.2,
  reply: '',
  suggestions: ['I want photos of the Ferrari Roma', 'I want to book the BMW X5'],
};

describe('conversation flow map — integration', () => {
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

  beforeEach(async () => {
    const prisma = testApp.ctx.prisma;
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
    gemini.answer = UNCLEAR;
    const base = {
      tenantId: TEST_TENANT_ID,
      category: 'SUV' as const,
      luxuryTier: 'LUXURY' as const,
      seats: 5,
      luggage: 4,
      transmission: 'AUTOMATIC' as const,
    };
    const priced = (dailyRate: number) => ({ currency: 'USD', dailyRate });
    await createVehicle(prisma, {
      ...base,
      make: 'BMW',
      model: 'X5',
      color: 'Black',
      pricingProfile: priced(250),
    });
    await createVehicle(prisma, {
      ...base,
      make: 'Toyota',
      model: 'Camry',
      color: 'White',
      pricingProfile: priced(120),
    });
    await createVehicle(prisma, {
      ...base,
      make: 'Ferrari',
      model: 'Roma',
      color: 'Red',
      pricingProfile: priced(1000),
    });
    await createEligibilityPolicyVersion(prisma, {
      tenantId: TEST_TENANT_ID,
      rules: {
        minAge: 21,
        minAgeByLuxuryTier: {},
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
  });

  interface Reply {
    conversationId: string;
    escalated: boolean;
    booking: { vehicle: string | null } | null;
    reply: { text: string };
  }

  async function chat(sessionId: string, message: string): Promise<Reply> {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      payload: { sessionId, clientMessageId: randomUUID(), message },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Reply;
  }

  const cases = () => testApp.ctx.prisma.escalationCase.findMany();
  const optionLines = (text: string) => text.split('\n').filter((line) => /^[1-4]\) /.test(line));

  it('not understood: option 1 repeats the question in detail, then two probable meanings, then the database question', async () => {
    const reply = await chat(randomUUID(), 'asdf qwerty zzz');
    expect(reply.escalated).toBe(false);
    // Fleet prices are $120, $250, $1,000: the budget question uses a round ceiling above the middle.
    expect(optionLines(reply.reply.text)).toEqual([
      '1) Repeat my question in detail: "asdf qwerty zzz"',
      '2) I want photos of the Ferrari Roma',
      '3) I want to book the BMW X5',
      '4) I want a car under 300 dollars',
    ]);
    expect(await cases()).toHaveLength(0);
  });

  it("option 1 explains the customer's own words in detail", async () => {
    const session = randomUUID();
    await chat(session, 'asdf qwerty zzz');
    const detail = await chat(session, '1');
    expect(detail.escalated).toBe(false);
    expect(detail.reply.text).toContain('You wrote: "asdf qwerty zzz"');
    expect(detail.reply.text).toContain('I want a car under 300 dollars');
  });

  it('a wrong new message brings three NEW options plus "Contact my team"; a third miss brings a person into the same chat', async () => {
    const session = randomUUID();
    const first = await chat(session, 'asdf qwerty zzz');
    const second = await chat(session, 'zxcv bnm');
    expect(second.escalated).toBe(false);
    const lines = optionLines(second.reply.text);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('4) Contact my team');
    for (const line of lines.slice(0, 3)) expect(optionLines(first.reply.text)).not.toContain(line);

    const third = await chat(session, 'qqq www');
    expect(third.escalated).toBe(true);
    expect(third.reply.text).toMatch(/same chat/i);
    const [row] = await cases();
    expect(row?.status).toBe('IN_PROGRESS');
    expect(row?.detail).toMatch(/still unclear after two rounds/);
  });

  it('option 4 of the first round searches the fleet database: the lowest and the highest price per day and per hour, in dollars', async () => {
    const session = randomUUID();
    await chat(session, 'asdf qwerty zzz');
    gemini.answer = 'THROW';
    const answer = await chat(session, '4');
    const text = answer.reply.text;
    expect(text).toContain('at or under $300 per day');
    expect(text).toContain('The lowest is the Toyota Camry $120 per day (about $5 per hour)');
    expect(text).toContain('the highest is the BMW X5 $250 per day (about $10.42 per hour)');
    expect(text).not.toMatch(/AED/);
    const stored = await testApp.ctx.prisma.message.findMany({ orderBy: { createdAt: 'asc' } });
    expect(stored.map((row) => row.content)).toContain('I want a car under 300 dollars');
    expect(stored.map((row) => row.content)).not.toContain('4');
  });

  it('"I want a car under 300 dollars" typed directly gets the same database answer', async () => {
    gemini.answer = 'THROW';
    const answer = await chat(randomUUID(), 'I want a car under 300 dollars');
    expect(answer.reply.text).toContain('The lowest is the Toyota Camry');
    expect(answer.reply.text).toContain('the highest is the BMW X5');
  });

  it('says plainly when no car fits the budget, and names the cheapest', async () => {
    gemini.answer = 'THROW';
    const answer = await chat(randomUUID(), 'any car below 50 usd?');
    expect(answer.reply.text).toContain('No car is at or under $50 per day');
    expect(answer.reply.text).toContain('Toyota Camry $120 per day');
  });

  it("uses Gemini's own wording when it states both ends of the price range", async () => {
    gemini.answer = {
      route: 'ANSWER',
      intent: 'PRICING',
      confidence: 0.9,
      reply:
        'Under $300 I have the Toyota Camry at $120 per day, about $5 per hour, up to the BMW X5 at $250 per day, about $10.42 per hour.',
      suggestions: [],
    };
    const answer = await chat(randomUUID(), 'I want a car under 300 dollars');
    expect(answer.reply.text).toMatch(/^Under \$300 I have the Toyota Camry/);
  });

  it('"Contact my team" (the last option of the second round) brings a person into the same chat', async () => {
    const session = randomUUID();
    await chat(session, 'asdf qwerty zzz');
    await chat(session, 'zxcv bnm');
    const picked = await chat(session, '4');
    expect(picked.escalated).toBe(true);
    expect(await cases()).toHaveLength(1);
  });

  it('"I think Ferrari Roma" is a guess: no car is selected, the customer is asked to choose', async () => {
    const session = randomUUID();
    const guess = await chat(session, 'I think Ferrari Roma');
    expect(guess.reply.text).toContain("You haven't selected a car yet");
    expect(guess.booking?.vehicle ?? null).toBeNull();
    expect(optionLines(guess.reply.text)).toContain('1) I want the BMW X5');

    const dates = await chat(session, 'Pickup in Dubai Marina from 15 to 19 October');
    expect(dates.booking?.vehicle ?? null).toBeNull();

    const chosen = await chat(session, 'I want the Ferrari Roma');
    expect(chosen.booking?.vehicle).toBe('Ferrari Roma');
  });

  it('"I think pick in dubai" is a guess: no place is selected, the customer is asked to choose', async () => {
    const guess = await chat(randomUUID(), 'I think pick in dubai');
    expect(guess.reply.text).toContain("You haven't selected a pickup place yet");
    expect(optionLines(guess.reply.text)).toContain('1) Pick me up at Dubai Marina');
  });

  it('tells Gemini the current Dubai time and that every price is in dollars', async () => {
    gemini.answer = { ...UNCLEAR, suggestions: [] };
    await chat(randomUUID(), 'asdf qwerty zzz');
    expect(gemini.lastPrompt).toMatch(/NOW: \w+, \d+ \w+ \d{4}, \d{2}:\d{2} \(Dubai time\)/);
    expect(gemini.lastPrompt).toContain('in US dollars');
    expect(gemini.lastPrompt).not.toMatch(/AED/);
  });

  describe('quiet chats are checked in on', () => {
    // 12:00 Dubai time on a fixed day, so the 08:00-22:00 window never makes this test flaky.
    const base = new Date(Date.UTC(2026, 9, 1, 8, 0, 0));
    const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);

    /**
     * Runs the sweep as if it were `now`. A follow-up it sends is stamped with that simulated moment
     * (the database would otherwise stamp the real one), so the next sweep sees a consistent history.
     */
    async function sweep(now: Date): Promise<number> {
      const prisma = testApp.ctx.prisma;
      const before = new Set(
        (await prisma.outboundMessage.findMany({ select: { id: true } })).map((row) => row.id),
      );
      const sent = await runFollowUpSweep(testApp.ctx, now);
      const created = (await prisma.outboundMessage.findMany({ select: { id: true } })).filter(
        (row) => !before.has(row.id),
      );
      await prisma.outboundMessage.updateMany({
        where: { id: { in: created.map((row) => row.id) } },
        data: { createdAt: now },
      });
      return sent;
    }

    async function chatThatAiAnsweredAtBase() {
      const session = randomUUID();
      const first = await chat(session, 'Hello');
      const prisma = testApp.ctx.prisma;
      await prisma.message.updateMany({
        where: { conversationId: first.conversationId },
        data: { createdAt: base },
      });
      await prisma.outboundMessage.updateMany({
        where: { conversationId: first.conversationId },
        data: { createdAt: at(0.5) },
      });
      return { session, conversationId: first.conversationId };
    }

    const followUps = (conversationId: string) =>
      testApp.ctx.prisma.outboundMessage.findMany({
        where: { conversationId, stage: { startsWith: 'FOLLOWUP_' } },
        orderBy: { createdAt: 'asc' },
      });

    it('nudges after 3 minutes, 30 minutes and a week — once each', async () => {
      const { conversationId } = await chatThatAiAnsweredAtBase();

      expect(await sweep(at(2))).toBe(0);
      expect(await sweep(at(4))).toBe(1);
      expect(await sweep(at(5))).toBe(0);
      expect(await sweep(at(31))).toBe(1);
      expect(await sweep(at(7 * 24 * 60 + 5))).toBe(1);
      expect(await sweep(at(8 * 24 * 60))).toBe(0);

      const sent = await followUps(conversationId);
      expect(sent.map((row) => row.stage)).toEqual(['FOLLOWUP_3M', 'FOLLOWUP_30M', 'FOLLOWUP_1W']);
      expect(sent.every((row) => row.source === 'TEMPLATE')).toBe(true);
      expect(sent[0]?.content).toContain('Contact my team');
    });

    it('does not nudge at night (Dubai time) and goes out in the morning instead', async () => {
      const { conversationId } = await chatThatAiAnsweredAtBase();
      const night = new Date(Date.UTC(2026, 9, 1, 20, 0, 0)); // 00:00 Dubai
      expect(await sweep(night)).toBe(0);
      const morning = new Date(Date.UTC(2026, 9, 2, 5, 0, 0)); // 09:00 Dubai
      expect(await sweep(morning)).toBe(1);
      expect(await followUps(conversationId)).toHaveLength(1);
    });

    it('stops when the customer answers, and when a person has the chat', async () => {
      const { session, conversationId } = await chatThatAiAnsweredAtBase();
      expect(await sweep(at(4))).toBe(1);

      // The customer answers: the count starts again from the AI's next message.
      const known = (
        await testApp.ctx.prisma.outboundMessage.findMany({ select: { id: true } })
      ).map((row) => row.id);
      const answered = await chat(session, 'I want the BMW X5');
      await testApp.ctx.prisma.message.updateMany({
        where: { conversationId, content: 'I want the BMW X5' },
        data: { createdAt: at(10) },
      });
      await testApp.ctx.prisma.outboundMessage.updateMany({
        where: { conversationId, id: { notIn: known } },
        data: { createdAt: at(10.5) },
      });
      expect(answered.escalated).toBe(false);
      expect(await sweep(at(11))).toBe(0);
      expect(await sweep(at(14))).toBe(1);

      // A person takes the chat: no more nudges.
      await testApp.ctx.prisma.journey.updateMany({ data: { state: 'ESCALATED' } });
      expect(await sweep(at(60))).toBe(0);
    });
  });
});
