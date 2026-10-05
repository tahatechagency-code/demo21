import { describe, expect, it } from 'vitest';
import type { AIProvider } from './provider.js';
import { ResilientAIProvider } from './resilientAIProvider.js';

const INPUT = {
  systemInstruction: 's',
  prompt: 'p',
  schemaName: 'x',
  responseSchema: { type: 'object' },
};

describe('an exhausted quota (429) stops the calls at once', () => {
  it('the next call is refused without touching the provider', async () => {
    let calls = 0;
    const quotaOut: AIProvider = {
      name: 'quota-out',
      async generateStructured() {
        calls += 1;
        throw Object.assign(new Error('Gemini request failed'), { details: { status: 429 } });
      },
      async healthCheck() {
        return 'CONFIGURED' as const;
      },
    };
    const provider = new ResilientAIProvider(quotaOut);
    await expect(provider.generateStructured(INPUT)).rejects.toThrow('Gemini request failed');
    await expect(provider.generateStructured(INPUT)).rejects.toThrow(/Circuit breaker is open/);
    expect(calls).toBe(1);
  });

  it('an ordinary failure still takes five in a row to open the circuit', async () => {
    let calls = 0;
    const flaky: AIProvider = {
      name: 'flaky',
      async generateStructured() {
        calls += 1;
        throw new Error('boom');
      },
      async healthCheck() {
        return 'CONFIGURED' as const;
      },
    };
    const provider = new ResilientAIProvider(flaky);
    for (let i = 0; i < 4; i += 1) await expect(provider.generateStructured(INPUT)).rejects.toThrow('boom');
    expect(calls).toBe(4);
  });
});

describe('a timeout pauses the provider briefly', () => {
  it('the next customer is not made to wait the full timeout again', async () => {
    let calls = 0;
    const hanging: AIProvider = {
      name: 'hanging',
      async generateStructured() {
        calls += 1;
        return new Promise(() => undefined); // never answers
      },
      async healthCheck() {
        return 'CONFIGURED' as const;
      },
    };
    const provider = new ResilientAIProvider(hanging, { timeoutMs: 30 });
    await expect(provider.generateStructured(INPUT)).rejects.toMatchObject({ name: 'TimeoutError' });
    const started = Date.now();
    await expect(provider.generateStructured(INPUT)).rejects.toThrow(/Circuit breaker is open/);
    expect(Date.now() - started).toBeLessThan(20);
    expect(calls).toBe(1);
  });
});
