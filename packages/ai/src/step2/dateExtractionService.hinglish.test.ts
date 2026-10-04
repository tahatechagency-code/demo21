import { describe, expect, it } from 'vitest';
import { DateExtractionService } from './dateExtractionService.js';

const service = new DateExtractionService();
const TZ = 'Asia/Dubai';
const REFERENCE_DATE = new Date('2026-09-15T09:00:00.000Z');

function extract(text: string, referenceDate: Date = REFERENCE_DATE) {
  return service.extract(text, { referenceDate, timezone: TZ });
}
const day = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;

describe('DateExtractionService: Hinglish ranges, DD/MM, past dates, day corrections', () => {
  it('"15 se 19 october" is pickup 15, return 19 (not pickup 19)', () => {
    const r = extract('Urus 15 se 19 october Marina');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-15', '2026-10-19']);
  });

  it('"15 se 18 october" is pickup 15, return 18', () => {
    const r = extract('Urus 15 se 18 october');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-15', '2026-10-18']);
  });

  it('a month-first range "Oct 15 to 19" works', () => {
    const r = extract('Oct 15 to 19');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-15', '2026-10-19']);
  });

  it('DD/MM without a year is read day-first once one date can only be day-first', () => {
    const r = extract('Urus 12/10 to 15/10');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-12', '2026-10-15']);
    expect(r.ambiguities).toEqual([]);
  });

  it('DD/MM/YYYY pairs resolve the same way', () => {
    const r = extract('15/10/2026 to 19/10/2026');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-15', '2026-10-19']);
  });

  it('a lone date that could be either order is still reported, not guessed', () => {
    const r = extract('pickup 12/10');
    expect(r.pickupDate).toBeNull();
    expect(r.ambiguities.map((a) => a.code)).toContain('AMBIGUOUS_NUMERIC_DATE');
  });

  it('a day range like 15-19 is never read as a numeric date', () => {
    const r = extract('15-19 Oct');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-15', '2026-10-19']);
    expect(r.impossibleDateMentions).toEqual([]);
  });

  it('a yearless date that passed long ago stays in the past instead of silently moving to next year', () => {
    const r = extract('Urus 20 september', new Date('2026-10-04T08:00:00.000Z'));
    expect(day(r.pickupDate)).toBe('2026-09-20');
  });

  it('a yearless date a few months back rolls to next year', () => {
    const r = extract('5 January', new Date('2026-10-04T08:00:00.000Z'));
    expect(day(r.pickupDate)).toBe('2027-01-05');
  });

  it("today's own date is today, not next year, even late in the day", () => {
    const r = extract('4 October', new Date('2026-10-04T15:00:00.000Z'));
    expect(day(r.pickupDate)).toBe('2026-10-04');
  });

  it('"nahi 20 tak" changes only the return day', () => {
    const r = extract('Urus 15 to 19 Oct Marina\nnahi 20 tak');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-15', '2026-10-20']);
  });

  it('"return date change karke 21 karo" changes the return day', () => {
    const r = extract('Urus 15 to 19 Oct Marina\nreturn date change karke 21 karo');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-15', '2026-10-21']);
  });

  it('"pickup date 16 kar do" changes only the pickup day', () => {
    const r = extract('Urus 15 to 19 Oct Marina\npickup date 16 kar do');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-16', '2026-10-19']);
  });

  it('a correction day that does not exist is reported, not moved', () => {
    const r = extract('Urus 15 to 19 Oct\nreturn 32 karo');
    expect(day(r.returnDate)).toBe('2026-10-19');
    expect(r.impossibleDateMentions.length).toBe(1);
  });

  it('a stated length is not read as a day correction', () => {
    const r = extract('Urus 15 to 19 Oct\nmujhe 3 din chahiye');
    expect([day(r.pickupDate), day(r.returnDate)]).toEqual(['2026-10-15', '2026-10-19']);
  });

  it('hours are a length but never become days', () => {
    const r = extract('Urus 2 ghante ke liye, pickup 20 Oct');
    expect(r.duration).toEqual({ amount: 2, unit: 'hour' });
    expect(r.returnDate).toBeNull();
  });
});
