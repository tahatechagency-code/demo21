import { describe, expect, it } from 'vitest';
import { DateExtractionService } from './dateExtractionService.js';

const service = new DateExtractionService();
const REFERENCE_DATE = new Date('2026-09-15T09:00:00.000Z');
const TZ = 'Asia/Dubai';

function extract(text: string) {
  return service.extract(text, { referenceDate: REFERENCE_DATE, timezone: TZ });
}

describe('DateExtractionService', () => {
  it('resolves "15 Oct" to pickup only', () => {
    const result = extract('pickup on 15 Oct');
    expect(result.pickupDate?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(result.returnDate).toBeNull();
    expect(result.ambiguities).toEqual([]);
  });

  it('resolves "15-19 Oct" as pickup and return', () => {
    const result = extract('from 15-19 Oct');
    expect(result.pickupDate?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(result.returnDate?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
  });

  it('resolves "tomorrow" relative to the reference date', () => {
    const result = extract('I need it tomorrow');
    expect(result.pickupDate?.toISOString()).toBe('2026-09-16T06:00:00.000Z');
  });

  it('resolves "next Friday" to a concrete future date', () => {
    // reference date 2026-09-15 is a Tuesday; next Friday = 2026-09-18
    const result = extract('pickup next Friday');
    expect(result.pickupDate?.toISOString()).toBe('2026-09-18T06:00:00.000Z');
  });

  it('flags an ambiguous numeric date (10/11/26) instead of guessing', () => {
    const result = extract('pickup on 10/11/26');
    expect(result.pickupDate).toBeNull();
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({ code: 'AMBIGUOUS_NUMERIC_DATE', raw: '10/11/26' }),
    );
  });

  it('resolves an unambiguous numeric date where only one reading is valid', () => {
    // 25 can only be a day (>12), so this is unambiguously DD/MM/YYYY = 25 Nov 2026
    const result = extract('pickup on 25/11/2026');
    expect(result.pickupDate?.toISOString()).toBe('2026-11-25T06:00:00.000Z');
    expect(result.ambiguities).toEqual([]);
  });

  it('does not flag ambiguity when both readings land on the same date', () => {
    const result = extract('pickup on 05/05/2026');
    expect(result.pickupDate?.toISOString()).toBe('2026-05-05T06:00:00.000Z');
    expect(result.ambiguities).toEqual([]);
  });

  it('treats an impossible named-month date (31 February) as invalid, never rounding it forward', () => {
    const result = extract('pickup on 31 February');
    expect(result.pickupDate).toBeNull();
    expect(result.impossibleDateMentions).toContain('31 February');
  });

  it('treats an impossible numeric date (32/13/2026) as invalid', () => {
    const result = extract('pickup on 32/13/2026');
    expect(result.pickupDate).toBeNull();
    expect(result.impossibleDateMentions.length).toBeGreaterThan(0);
  });

  it('resolves an explicit past date without hallucinating a different one (validation is a separate layer)', () => {
    const result = extract('pickup on 1 January 2020');
    expect(result.pickupDate?.toISOString()).toBe('2020-01-01T06:00:00.000Z');
  });

  it('flags a vague relative phrase as ambiguous', () => {
    const result = extract('sometime next month works');
    expect(result.pickupDate).toBeNull();
    expect(result.ambiguities.some((a) => a.code === 'VAGUE_RELATIVE_DATE')).toBe(true);
  });

  it('flags a bare weekday (no "next") as ambiguous', () => {
    const result = extract('maybe Friday works for me');
    expect(result.pickupDate).toBeNull();
    expect(result.ambiguities.some((a) => a.code === 'BARE_WEEKDAY')).toBe(true);
  });

  it('never fabricates a date when none is mentioned', () => {
    const result = extract('I want to rent a car in Dubai');
    expect(result.pickupDate).toBeNull();
    expect(result.returnDate).toBeNull();
    expect(result.ambiguities).toEqual([]);
  });

  it('converts local wall-clock time to the correct UTC instant for the given timezone', () => {
    const result = service.extract('pickup 2026-11-03', {
      referenceDate: REFERENCE_DATE,
      timezone: 'America/New_York',
    });
    // 10:00 local in New York (winter, UTC-5) = 15:00 UTC
    expect(result.pickupDate?.toISOString()).toBe('2026-11-03T15:00:00.000Z');
  });
});

describe('DateExtractionService: a later message corrects an earlier date', () => {
  it('a return-worded date replaces the return date and keeps the pickup', () => {
    const result = extract('from 15-19 Oct\nActually I will return it on 21 October instead');
    expect(result.pickupDate?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(result.returnDate?.toISOString()).toBe('2026-10-21T06:00:00.000Z');
  });

  it('a pickup-worded date replaces the pickup date and keeps the return', () => {
    const result = extract('from 15-19 Oct\nmake the pickup 16 October');
    expect(result.pickupDate?.toISOString()).toBe('2026-10-16T06:00:00.000Z');
    expect(result.returnDate?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
  });

  it('dates given across separate messages still fill pickup then return', () => {
    const result = extract('Urus from 15 October\nand 19 October');
    expect(result.pickupDate?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
    expect(result.returnDate?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
  });
});

describe('DateExtractionService: relative ranges, lengths and times', () => {
  const iso = (d: Date | null) => d?.toISOString();
  // Reference: Tuesday 15 Sep 2026 (Dubai).

  it('"tomorrow for 2 days" gives both dates', () => {
    const r = extract('I need a car tomorrow for 2 days');
    expect(iso(r.pickupDate)).toBe('2026-09-16T06:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2026-09-18T06:00:00.000Z');
  });

  it('"day after tomorrow" is not "tomorrow"', () => {
    const r = extract('day after tomorrow please');
    expect(iso(r.pickupDate)).toBe('2026-09-17T06:00:00.000Z');
  });

  it('"next Monday to Thursday" resolves both ends', () => {
    const r = extract('next Monday to Thursday');
    expect(iso(r.pickupDate)).toBe('2026-09-21T06:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2026-09-24T06:00:00.000Z');
  });

  it('"next Friday till Sunday" resolves both ends', () => {
    const r = extract('next Friday till Sunday');
    expect(iso(r.pickupDate)).toBe('2026-09-18T06:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2026-09-20T06:00:00.000Z');
  });

  it('"this weekend" is the coming Saturday and Sunday', () => {
    const r = extract('this weekend');
    expect(iso(r.pickupDate)).toBe('2026-09-19T06:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2026-09-20T06:00:00.000Z');
  });

  it('"a month from 1 Dec" returns on 1 Jan', () => {
    const r = extract('a month from 1 Dec');
    expect(iso(r.pickupDate)).toBe('2026-12-01T06:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2027-01-01T06:00:00.000Z');
  });

  it('"1 week from 20 Oct" and "5 days from 20 Oct"', () => {
    expect(iso(extract('a week from 20 Oct').returnDate)).toBe('2026-10-27T06:00:00.000Z');
    expect(iso(extract('20 Oct for 5 days').returnDate)).toBe('2026-10-25T06:00:00.000Z');
  });

  it('understands Hinglish "kal se parso tak"', () => {
    const r = extract('kal se parso tak gaadi chahiye');
    expect(iso(r.pickupDate)).toBe('2026-09-16T06:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2026-09-17T06:00:00.000Z');
  });

  it('reads a clock time for the pickup and the return', () => {
    const r = extract('15 Oct to 19 Oct, pickup at 3pm and return at 5pm');
    expect(iso(r.pickupDate)).toBe('2026-10-15T11:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2026-10-19T13:00:00.000Z');
  });

  it('a single time with no cue moves the pickup', () => {
    const r = extract('tomorrow at 3pm');
    expect(iso(r.pickupDate)).toBe('2026-09-16T11:00:00.000Z');
  });

  it('a later message adds the length to the pickup it already has', () => {
    const r = extract('Urus from 20 October\nfor 3 days');
    expect(iso(r.pickupDate)).toBe('2026-10-20T06:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2026-10-23T06:00:00.000Z');
  });

  it('a later message adds a time to the dates it already has', () => {
    const r = extract('15 Oct to 19 Oct\npickup at 9am');
    expect(iso(r.pickupDate)).toBe('2026-10-15T05:00:00.000Z');
    expect(iso(r.returnDate)).toBe('2026-10-19T06:00:00.000Z');
  });

  it('"one day" in ordinary speech is not a rental length', () => {
    const r = extract('one day I will rent a car, pickup 20 Oct');
    expect(r.returnDate).toBeNull();
  });

  it('near midnight in Dubai, "tomorrow" is still Dubai\'s tomorrow', () => {
    // 22:30 UTC on the 15th is 02:30 on the 16th in Dubai.
    const r = service.extract('tomorrow', {
      referenceDate: new Date('2026-09-15T22:30:00.000Z'),
      timezone: TZ,
    });
    expect(iso(r.pickupDate)).toBe('2026-09-17T06:00:00.000Z');
  });
});
