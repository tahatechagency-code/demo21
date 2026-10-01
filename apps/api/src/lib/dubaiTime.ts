/**
 * The business runs on Dubai's clock. Anything the concierge says about "today", "tomorrow" or "now",
 * and every timed follow-up, is read off this one place — never the server's own time zone.
 */
export const DUBAI_TIME_ZONE = 'Asia/Dubai';

/** "Thursday, 1 October 2026, 21:57" — what Gemini is told the current moment is. */
export function formatDubaiNow(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DUBAI_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('weekday')}, ${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`;
}

/** The hour of day (0-23) in Dubai. */
export function dubaiHour(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: DUBAI_TIME_ZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return Number(hour) % 24;
}
