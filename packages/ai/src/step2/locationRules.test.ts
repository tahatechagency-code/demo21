import { describe, expect, it } from 'vitest';
import { DateLocationExtractionOrchestrator } from './orchestrator.js';

const orchestrator = new DateLocationExtractionOrchestrator();
const REFERENCE = new Date('2026-10-04T08:00:00.000Z');

async function read(transcript: string) {
  const result = await orchestrator.extract(transcript, { referenceDate: REFERENCE });
  return {
    pickup: result.pickupLocation?.normalized ?? null,
    dropoff: result.dropoffLocation?.normalized ?? null,
    codes: result.validationErrors.map((issue) => issue.code),
    messages: result.validationErrors.map((issue) => issue.message),
  };
}

describe('pickup / drop-off places across messages', () => {
  it('a bare "Marina" is Dubai Marina', async () => {
    expect((await read('Urus 15 se 19 october Marina')).pickup).toBe('Dubai Marina');
  });

  it('a bare "Yas" and "Palm" are places too', async () => {
    expect((await read('Urus kal Yas Island')).pickup).toBe('Yas Island');
    expect((await read('Urus kal Palm Jumeirah')).pickup).toBe('Palm Jumeirah');
  });

  it('a later message replaces the pickup place instead of becoming the drop-off', async () => {
    const r = await read('Urus 15 to 19 Oct Marina\nJBR kar do');
    expect(r.pickup).toBe('Jumeirah Beach Residence');
    expect(r.dropoff).toBeNull();
  });

  it('two places in one message are pickup then drop-off', async () => {
    const r = await read('Urus 15 to 19 Oct pickup Dubai Marina, drop-off Sharjah airport');
    expect(r.pickup).toBe('Dubai Marina');
    expect(r.dropoff).toBe('Sharjah Airport');
  });

  it('a drop-off cue in a later message sets the drop-off and keeps the pickup', async () => {
    const r = await read('Urus 15 to 19 Oct Marina\nreturn at Dubai Airport');
    expect(r.pickup).toBe('Dubai Marina');
    expect(r.dropoff).toBe('Dubai Airport Terminal 1');
  });

  it('a question about another place does not change the booking place', async () => {
    const r = await read('Urus 15 to 19 Oct Marina\nAl Ain pe delivery milegi?');
    expect(r.pickup).toBe('Dubai Marina');
    expect(r.codes).not.toContain('OUT_OF_DELIVERY_RANGE');
  });
});

describe('the delivery rule on the booking path', () => {
  it('a place beyond the delivery limit is refused with the distance and the limit', async () => {
    const r = await read('Urus 15 to 19 October pickup Al Ain');
    expect(r.pickup).toBeNull();
    expect(r.codes).toContain('OUT_OF_DELIVERY_RANGE');
    expect(r.messages.join(' ')).toMatch(/Al Ain is (?:about )?\d+ km .*100 km/);
  });

  it('is the same when the place arrives in a later message', async () => {
    const r = await read('Urus 15 to 19 October\nAl Ain');
    expect(r.pickup).toBeNull();
    expect(r.codes).toContain('OUT_OF_DELIVERY_RANGE');
  });

  it('a later place inside the limit clears the refusal', async () => {
    const r = await read('Urus 15 to 19 October pickup Al Ain\nok then Dubai Marina');
    expect(r.pickup).toBe('Dubai Marina');
    expect(r.codes).not.toContain('OUT_OF_DELIVERY_RANGE');
  });

  it('a correction to a far place replaces a good one with the refusal', async () => {
    const r = await read('Urus 15 to 19 October Marina\nAl Ain kar do');
    expect(r.pickup).toBeNull();
    expect(r.codes).toContain('OUT_OF_DELIVERY_RANGE');
  });

  it('a branch city and an area near a branch are accepted', async () => {
    expect((await read('Urus kal pickup Fujairah')).pickup).toBe('Fujairah');
    expect((await read('Urus kal pickup Abu Dhabi')).codes).not.toContain('OUT_OF_DELIVERY_RANGE');
  });

  it('a place outside the UAE is reported without "in/to", and is not a pickup', async () => {
    const r = await read('Urus kal Delhi');
    expect(r.pickup).toBeNull();
    expect(r.codes).toContain('UNSUPPORTED_LOCATION');
  });
});

describe('a place abroad inside a delivery sentence', () => {
  it('"drop it to Muscat airport" is outside the UAE, not a pin to ask for', async () => {
    const r = await read('can you drop it to Muscat airport');
    expect(r.pickup).toBeNull();
    expect(r.codes).toContain('UNSUPPORTED_LOCATION');
  });
});
