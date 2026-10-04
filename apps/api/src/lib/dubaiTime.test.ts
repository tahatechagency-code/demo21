import { describe, expect, it } from 'vitest';
import { dubaiHour, formatDubaiNow } from './dubaiTime.js';

describe('Dubai clock', () => {
  it('reads the moment in Dubai time, not the server zone', () => {
    // 2026-10-01 17:57 UTC is 21:57 in Dubai (UTC+4, no daylight saving).
    const moment = new Date('2026-10-01T17:57:00Z');
    expect(formatDubaiNow(moment)).toBe('Thursday, 1 October 2026, 21:57');
    expect(dubaiHour(moment)).toBe(21);
  });

  it('rolls over to the next day in Dubai before it does in UTC', () => {
    const moment = new Date('2026-10-01T20:30:00Z');
    expect(formatDubaiNow(moment)).toBe('Friday, 2 October 2026, 00:30');
    expect(dubaiHour(moment)).toBe(0);
  });
});
