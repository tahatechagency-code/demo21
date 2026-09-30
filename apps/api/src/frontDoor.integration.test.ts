import { randomUUID } from 'node:crypto';
import type {
  AIProvider,
  GenerateStructuredInput,
  GenerateStructuredResult,
} from '@ai-concierge/ai';
import { createVehicle, createVehiclePhoto } from '@ai-concierge/db';
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

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    if (input.schemaName !== 'front-door-interpretation-v1') throw new Error('unscripted call');
    this.interpretationCalls += 1;
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

  it('asks Gemini once for an unreadable message and trusts a confident answer', async () => {
    gemini.interpretation = {
      understood: true,
      intent: 'DOCUMENTS',
      confidence: 0.91,
      entities: {},
      needs_clarification: false,
    };
    const result = await chat(randomUUID(), 'whats the deal with my papers');
    expect(gemini.interpretationCalls).toBe(1);
    expect(result.escalated).toBe(false);
  });

  it.each([
    [
      'unsure',
      {
        understood: false,
        intent: 'UNKNOWN',
        confidence: 0.2,
        needs_clarification: true,
        reason: 'unclear',
      },
    ],
    [
      'low confidence',
      { understood: true, intent: 'BOOKING', confidence: 0.4, needs_clarification: false },
    ],
    ['misunderstanding (off-schema)', { hello: 'world' }],
    ['timeout / failure', 'THROW'],
  ])('escalates to a person when Gemini is %s — one call, no loop', async (_label, answer) => {
    gemini.interpretation = answer;
    const result = await chat(randomUUID(), 'asdf qwerty zzz');
    expect(gemini.interpretationCalls).toBe(1);
    expect(result.escalated).toBe(true);
    expect(result.reply.text).toMatch(/member of our team/i);
    const escalation = await testApp.ctx.prisma.escalationCase.findFirstOrThrow();
    expect(escalation.detail).toMatch(/AI_UNCERTAIN/);
  });

  it('never lets a confident-but-risky Gemini reading act on its own', async () => {
    gemini.interpretation = {
      understood: true,
      intent: 'PAYMENT_REFUND',
      confidence: 0.95,
      entities: {},
      needs_clarification: false,
    };
    const result = await chat(randomUUID(), 'my money situation is a mess again');
    expect(result.escalated).toBe(true);
    expect(result.reply.text).not.toMatch(/refunded/i);
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
