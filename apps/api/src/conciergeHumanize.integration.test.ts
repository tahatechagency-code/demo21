import { randomUUID } from 'node:crypto';
import type { AIProvider, GenerateStructuredInput, GenerateStructuredResult } from '@ai-concierge/ai';
import { createVehicle, createVehicleUnit } from '@ai-concierge/db';
import { seedTestTenants, truncateAllTables, TEST_TENANT_ID } from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';

/**
 * Gemini rewords the concierge's replies, but only the words: a rewrite with different numbers or a
 * missing place falls back to the deterministic draft, and the reply's source says which one was sent.
 */
class ScriptedWriter implements AIProvider {
  readonly name = 'scripted-writer';
  /** What the "model" answers to a humanize call; a function sees the draft it was given. */
  rewrite: (draft: string) => string | null = () => null;

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    if (input.schemaName !== 'concierge-humanize-v1') throw new Error('unscripted call');
    const draft = /DRAFT:\n"""\n([\s\S]*?)\n"""/.exec(input.prompt)?.[1] ?? '';
    const reply = this.rewrite(draft);
    if (reply === null) throw new Error('model unavailable');
    return {
      json: { reply },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelId: 'scripted',
      latencyMs: 1,
    };
  }

  async healthCheck() {
    return 'CONFIGURED' as const;
  }
}

describe('Gemini rewording of concierge replies', () => {
  let testApp: TestApp;
  const writer = new ScriptedWriter();

  beforeAll(async () => {
    testApp = await buildTestApp({ RATE_LIMIT_MAX: 5000 }, { aiProvider: writer });
  });
  afterAll(async () => testApp.close());

  beforeEach(async () => {
    const prisma = testApp.ctx.prisma;
    await truncateAllTables(prisma);
    await seedTestTenants(prisma);
    const vehicle = await createVehicle(prisma, {
      tenantId: TEST_TENANT_ID,
      transmission: 'AUTOMATIC',
      seats: 5,
      luggage: 4,
      make: 'Lamborghini',
      model: 'Urus',
      color: 'Black',
      category: 'SUV',
      luxuryTier: 'ULTRA_LUXURY',
      pricingProfile: { currency: 'AED', dailyRate: 3500 },
    });
    await createVehicleUnit(prisma, { tenantId: TEST_TENANT_ID, vehicleId: vehicle.id, unitRef: 'URUS-0' });
    writer.rewrite = () => null;
  });

  async function chat(message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      payload: { sessionId: randomUUID(), clientMessageId: randomUUID(), message },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { reply: { text: string; source: string } };
  }

  it('sends a valid rewrite and marks it AI_GENERATED', async () => {
    writer.rewrite = (draft) => `Good news! ${draft}`;
    const body = await chat('Urus available?');
    expect(body.reply.source).toBe('AI_GENERATED');
    expect(body.reply.text).toMatch(/^Good news! .*Lamborghini Urus/);
  });

  it('throws away a rewrite that changes a price and sends the draft', async () => {
    writer.rewrite = (draft) => draft.replace('3,500', '2,500');
    const body = await chat('Urus available?');
    expect(body.reply.source).toBe('TEMPLATE');
    expect(body.reply.text).toContain('AED 3,500');
    expect(body.reply.text).not.toContain('2,500');
  });

  it('throws away a rewrite that drops the car name', async () => {
    writer.rewrite = () => 'We have it! From AED 3,500 a day. 5 seats.';
    const body = await chat('Urus available?');
    expect(body.reply.source).toBe('TEMPLATE');
    expect(body.reply.text).toMatch(/Lamborghini Urus/);
  });

  it('falls back to the draft when the model is down', async () => {
    writer.rewrite = () => null;
    const body = await chat('Urus available?');
    expect(body.reply.source).toBe('TEMPLATE');
    expect(body.reply.text).toMatch(/Lamborghini Urus/);
  });

  it('never rewords a policy answer', async () => {
    writer.rewrite = () => 'Cash is fine with us.';
    const body = await chat('do you take cash?');
    expect(body.reply.text).toMatch(/do not accept cash/);
    expect(body.reply.source).toBe('TEMPLATE');
  });
});
