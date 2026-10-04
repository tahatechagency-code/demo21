import type { Ambiguity } from '@ai-concierge/domain';
import { isValidCalendarDate } from './calendar.js';
import { MONTHS, MONTH_NAME_PATTERN } from '../shared/monthNames.js';
import { zonedTimeToUtc } from './timezone.js';

const DEFAULT_LOCAL_HOUR = 10;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_PATTERN = WEEKDAYS.join('|');

/** Wording that says a lone date is the return / the pickup. */
const RETURN_CUE_RE =
  /\b(?:return|returning|drop ?-?off|bring (?:it )?back|give (?:it )?back|until|till|back on)\b/i;
const PICKUP_CUE_RE = /\b(?:pick ?-?up|collect|start|begin|from)\b/i;

const VAGUE_RELATIVE_RE =
  /\b(next week|next month|sometime|soon|later|in a few days|one of these days)\b/i;
const BARE_WEEKDAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const NEXT_WEEKDAY_RE = /\b(?:next|this|coming)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  ek: 1,
  two: 2,
  do: 2,
  three: 3,
  teen: 3,
  four: 4,
  char: 4,
  five: 5,
  panch: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

interface LocalDateTime {
  year: number;
  month0: number;
  day: number;
  hour: number;
  minute: number;
}

interface DateToken {
  index: number;
  local: LocalDateTime | null; // null when found-but-not-resolvable (impossible / ambiguous)
  ambiguity?: Ambiguity;
  impossible?: boolean;
  raw: string;
}

/** A rental length the customer stated ("for 3 days", "a week", "ek mahina"). */
export interface StatedDuration {
  amount: number;
  unit: 'day' | 'week' | 'month';
}

/** A clock time the customer stated, and whether the wording ties it to the pickup or the return. */
export interface StatedTime {
  hour: number;
  minute: number;
  applies: 'PICKUP' | 'RETURN' | null;
}

function resolveYear(
  month0: number,
  day: number,
  referenceDate: Date,
  explicitYear?: number,
): number {
  if (explicitYear !== undefined) return explicitYear;
  const candidateUtc = Date.UTC(referenceDate.getUTCFullYear(), month0, day, DEFAULT_LOCAL_HOUR);
  return candidateUtc < referenceDate.getTime()
    ? referenceDate.getUTCFullYear() + 1
    : referenceDate.getUTCFullYear();
}

function normalizeTwoDigitYear(yy: number): number {
  return yy <= 79 ? 2000 + yy : 1900 + yy;
}

/** The calendar day of `instant` in `timeZone`, as plain numbers. */
function localDay(instant: Date, timeZone: string): { year: number; month0: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month0: get('month') - 1, day: get('day') };
}

/** Calendar arithmetic on plain numbers (no zone involved). */
function addDays(
  base: { year: number; month0: number; day: number },
  days: number,
): { year: number; month0: number; day: number } {
  const moved = new Date(Date.UTC(base.year, base.month0, base.day + days));
  return { year: moved.getUTCFullYear(), month0: moved.getUTCMonth(), day: moved.getUTCDate() };
}

function addMonths(
  base: { year: number; month0: number; day: number },
  months: number,
): { year: number; month0: number; day: number } {
  const target = new Date(Date.UTC(base.year, base.month0 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    year: target.getUTCFullYear(),
    month0: target.getUTCMonth(),
    day: Math.min(base.day, lastDay),
  };
}

function weekdayOf(day: { year: number; month0: number; day: number }): number {
  return new Date(Date.UTC(day.year, day.month0, day.day)).getUTCDay();
}

/** The first date on `weekday` at or after `from` (atOrAfter) or strictly after it. */
function nextWeekday(
  from: { year: number; month0: number; day: number },
  weekday: number,
  strictlyAfter: boolean,
) {
  let cursor = strictlyAfter ? addDays(from, 1) : from;
  for (let i = 0; i < 8 && weekdayOf(cursor) !== weekday; i += 1) cursor = addDays(cursor, 1);
  return cursor;
}

/** "for 3 days", "a week", "2 weeks", "a month", "5 nights", "3 din", "ek hafte". */
export function extractStatedDuration(text: string): StatedDuration | null {
  const re =
    /\b(for\s+)?(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|ek|do|teen|char|panch)[\s-]*(days?|nights?|din|raat|weeks?|hafte|hafta|months?|mahina|mahine|mahinay)\b/i;
  const match = re.exec(text);
  if (!match) return null;
  const amountRaw = match[2]!.toLowerCase();
  const amount = /^\d+$/.test(amountRaw) ? Number(amountRaw) : NUMBER_WORDS[amountRaw];
  if (amount === undefined || amount < 1 || amount > 365) return null;
  const unitRaw = match[3]!.toLowerCase();
  // "one day I will visit" is not a length; "for a day", "a week" and "a month" are.
  if (/^(?:a|an|one|ek)$/.test(amountRaw) && !match[1] && /^(?:day|days|din|night|nights|raat)/.test(unitRaw)) {
    return null;
  }
  const unit: StatedDuration['unit'] = /^(?:week|hafte|hafta)/.test(unitRaw)
    ? 'week'
    : /^(?:month|mahin)/.test(unitRaw)
      ? 'month'
      : 'day';
  return { amount, unit };
}

export interface DateExtractionOutcome {
  pickupDate: Date | null;
  returnDate: Date | null;
  ambiguities: Ambiguity[];
  /** Calendar-invalid mentions (e.g. "31 February") — never silently corrected. */
  impossibleDateMentions: string[];
  /** A stated rental length that had no pickup to hang off in this text (used across messages). */
  duration?: StatedDuration | null;
  /** Clock times mentioned in this text. */
  times?: StatedTime[];
}

export interface DateExtractionOptions {
  referenceDate: Date;
  timezone: string;
}

/**
 * AI-side proposal step for pickup/return dates. Deliberately conservative:
 * a numeric date like "10/11/26" that could be read as either DD/MM or
 * MM/DD is never guessed — it's reported as an ambiguity instead, and
 * `TemporalValidationService` is what a caller must consult before trusting
 * the result.
 *
 * Understands: named-month dates, ISO and numeric dates, "15-19 Oct", today / tomorrow / day after
 * tomorrow (and the Hinglish aaj / kal / parso), "next Monday", "next Monday to Thursday",
 * "this weekend", a stated length ("tomorrow for 2 days", "a month from 1 Dec") and clock times
 * ("pickup at 3pm", "return by 5 pm").
 */
export class DateExtractionService {
  /**
   * `rawText` may be an accumulated transcript, one message per line. Read message by message so a
   * later correction wins ("actually I will return it on 21 October"), instead of the first two dates
   * in the whole transcript being fixed forever. A single date in a message is assigned by its
   * wording (return/drop-off cue -> return date, pickup cue -> pickup date); without a cue it fills
   * the first empty slot, exactly as before. A length ("for 3 days") or a clock time ("3pm") given
   * in a later message attaches to the dates already known.
   */
  extract(rawText: string, options: DateExtractionOptions): DateExtractionOutcome {
    const lines = rawText.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2) return this.finish(this.extractFromText(rawText, options), options);

    let pickupDate: Date | null = null;
    let returnDate: Date | null = null;
    let duration: StatedDuration | null = null;
    let times: StatedTime[] = [];
    const ambiguities: Ambiguity[] = [];
    const impossibleDateMentions: string[] = [];
    for (const line of lines) {
      const outcome = this.extractFromText(line, options);
      ambiguities.push(...outcome.ambiguities);
      impossibleDateMentions.push(...outcome.impossibleDateMentions);
      if (outcome.pickupDate && outcome.returnDate) {
        pickupDate = outcome.pickupDate;
        returnDate = outcome.returnDate;
        duration = null;
      } else if (outcome.pickupDate) {
        if (RETURN_CUE_RE.test(line)) returnDate = outcome.pickupDate;
        else if (PICKUP_CUE_RE.test(line) || pickupDate === null || (duration && returnDate === null)) {
          pickupDate = outcome.pickupDate;
          returnDate = outcome.duration ? null : returnDate;
        } else if (returnDate === null && outcome.pickupDate.getTime() !== pickupDate.getTime()) {
          returnDate = outcome.pickupDate;
        }
      }
      if (outcome.duration) duration = outcome.duration;
      if (outcome.times && outcome.times.length > 0) times = outcome.times;
      if (outcome.pickupDate && outcome.duration && !outcome.returnDate) duration = outcome.duration;
    }
    return this.finish(
      { pickupDate, returnDate, ambiguities, impossibleDateMentions, duration, times },
      options,
    );
  }

  /** Applies a stated length and clock times to whatever dates were found. */
  private finish(outcome: DateExtractionOutcome, options: DateExtractionOptions): DateExtractionOutcome {
    let { pickupDate, returnDate } = outcome;
    const { duration, times } = outcome;

    if (pickupDate && !returnDate && duration) {
      const start = localDay(pickupDate, options.timezone);
      const end =
        duration.unit === 'month'
          ? addMonths(start, duration.amount)
          : addDays(start, duration.amount * (duration.unit === 'week' ? 7 : 1));
      returnDate = zonedTimeToUtc(
        end.year,
        end.month0,
        end.day,
        DEFAULT_LOCAL_HOUR,
        0,
        0,
        options.timezone,
      );
    }

    const withClock = (date: Date | null, time: StatedTime | undefined): Date | null => {
      if (!date || !time) return date;
      const day = localDay(date, options.timezone);
      return zonedTimeToUtc(day.year, day.month0, day.day, time.hour, time.minute, 0, options.timezone);
    };
    if (times && times.length > 0) {
      const pickupTime = times.find((time) => time.applies === 'PICKUP') ?? (times.length === 1 && times[0]!.applies === null ? times[0] : undefined);
      const returnTime = times.find((time) => time.applies === 'RETURN');
      pickupDate = withClock(pickupDate, pickupTime);
      returnDate = withClock(returnDate, returnTime);
    }

    return {
      pickupDate,
      returnDate,
      ambiguities: outcome.ambiguities,
      impossibleDateMentions: outcome.impossibleDateMentions,
      ...(duration !== undefined ? { duration } : {}),
      ...(times !== undefined ? { times } : {}),
    };
  }

  private extractFromText(rawText: string, options: DateExtractionOptions): DateExtractionOutcome {
    const ambiguities: Ambiguity[] = [];
    const impossibleDateMentions: string[] = [];
    const tokens: DateToken[] = [];
    let workingText = rawText;

    const range = this.matchDayRange(workingText, options.referenceDate);
    if (range) {
      tokens.push(...range.tokens);
      workingText = range.remainingText;
    }

    const weekdayRange = this.matchWeekdayRange(workingText, options);
    if (weekdayRange) {
      tokens.push(...weekdayRange.tokens);
      workingText = weekdayRange.remainingText;
    }

    const weekend = this.matchWeekend(workingText, options);
    if (weekend) {
      tokens.push(...weekend.tokens);
      workingText = weekend.remainingText;
    }

    tokens.push(...this.matchNamedMonthDates(workingText, options.referenceDate));
    tokens.push(...this.matchIsoDates(workingText));
    tokens.push(...this.matchNumericDates(workingText));
    tokens.push(...this.matchRelativeKeywords(workingText, options));
    tokens.push(...this.matchNextWeekday(workingText, options));

    for (const token of tokens) {
      if (token.impossible) impossibleDateMentions.push(token.raw);
      if (token.ambiguity) ambiguities.push(token.ambiguity);
    }

    if (VAGUE_RELATIVE_RE.test(rawText)) {
      ambiguities.push({
        field: 'pickupDate',
        code: 'VAGUE_RELATIVE_DATE',
        message: 'A vague relative date phrase was used and cannot be resolved to a specific day',
        raw: VAGUE_RELATIVE_RE.exec(rawText)?.[0],
      });
    }
    const resolvedByWeekdayWord = tokens.some((token) => /^(?:next|this|coming)\b/i.test(token.raw));
    if (BARE_WEEKDAY_RE.test(rawText) && !NEXT_WEEKDAY_RE.test(rawText) && !resolvedByWeekdayWord) {
      ambiguities.push({
        field: 'pickupDate',
        code: 'BARE_WEEKDAY',
        message:
          'A weekday was mentioned without "next"/"this" and could refer to more than one date',
        raw: BARE_WEEKDAY_RE.exec(rawText)?.[0],
      });
    }

    const resolved = tokens
      .filter((token): token is DateToken & { local: LocalDateTime } => token.local !== null)
      .sort((a, b) => a.index - b.index)
      .map((token) =>
        zonedTimeToUtc(
          token.local.year,
          token.local.month0,
          token.local.day,
          token.local.hour,
          token.local.minute,
          0,
          options.timezone,
        ),
      );

    const pickupDate = resolved[0] ?? null;
    const returnDate =
      resolved[1] && resolved[1].getTime() !== pickupDate?.getTime() ? resolved[1] : null;

    return {
      pickupDate,
      returnDate,
      ambiguities,
      impossibleDateMentions,
      duration: extractStatedDuration(rawText),
      times: this.matchTimes(rawText),
    };
  }

  /** "3pm", "5 pm", "at 15:00", "pickup at 9:30 am", "return by 5pm". */
  private matchTimes(text: string): StatedTime[] {
    const times: StatedTime[] = [];
    const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at|by|around|before)\s+(\d{1,2}):(\d{2})\b/gi;
    for (const match of text.matchAll(re)) {
      let hour = Number(match[1] ?? match[4]);
      const minute = Number(match[2] ?? match[5] ?? 0);
      const meridiem = match[3]?.toLowerCase();
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      if (hour > 23 || minute > 59) continue;
      const before = text.slice(Math.max(0, match.index - 40), match.index);
      const applies: StatedTime['applies'] = /\b(?:return|returning|drop ?-?off|bring (?:it )?back|give (?:it )?back|back by|till|until)\b[^.]*$/i.test(before)
        ? 'RETURN'
        : /\b(?:pick ?-?up|collect|start|from|deliver\w*)\b[^.]*$/i.test(before)
          ? 'PICKUP'
          : null;
      times.push({ hour, minute, applies });
    }
    return times;
  }

  private matchDayRange(
    text: string,
    referenceDate: Date,
  ): { tokens: DateToken[]; remainingText: string } | null {
    const rangeRe = new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|-|–|until|through)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME_PATTERN}\\.?\\s*(\\d{4})?\\b`,
      'i',
    );
    const match = rangeRe.exec(text);
    if (!match?.[1] || !match[2] || !match[3]) return null;

    const day1 = Number(match[1]);
    const day2 = Number(match[2]);
    const month0 = MONTHS[match[3].toLowerCase()];
    if (month0 === undefined) return null;
    const explicitYear = match[4] ? Number(match[4]) : undefined;

    const tokens: DateToken[] = [];
    for (const [offset, day] of [[0, day1] as const, [1, day2] as const]) {
      const year = resolveYear(month0, day, referenceDate, explicitYear);
      if (!isValidCalendarDate(year, month0, day)) {
        tokens.push({ index: match.index + offset, local: null, impossible: true, raw: match[0] });
        continue;
      }
      tokens.push({
        index: match.index + offset,
        local: { year, month0, day, hour: DEFAULT_LOCAL_HOUR, minute: 0 },
        raw: match[0],
      });
    }

    const remainingText = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    return { tokens, remainingText };
  }

  /** "next Monday to Thursday", "this Friday till Sunday": both ends resolved from the first weekday. */
  private matchWeekdayRange(
    text: string,
    options: DateExtractionOptions,
  ): { tokens: DateToken[]; remainingText: string } | null {
    const re = new RegExp(
      `\\b(next|this|coming)\\s+(${WEEKDAY_PATTERN})\\s*(?:to|-|–|till|until|through|se)\\s*(?:(?:next|this|coming)\\s+)?(${WEEKDAY_PATTERN})\\b`,
      'i',
    );
    const match = re.exec(text);
    if (!match) return null;
    const today = localDay(options.referenceDate, options.timezone);
    const strict = match[1]!.toLowerCase() === 'next';
    const start = nextWeekday(today, WEEKDAYS.indexOf(match[2]!.toLowerCase()), strict);
    const end = nextWeekday(start, WEEKDAYS.indexOf(match[3]!.toLowerCase()), true);
    const tokens: DateToken[] = [start, end].map((day, offset) => ({
      index: match.index + offset,
      local: { ...day, hour: DEFAULT_LOCAL_HOUR, minute: 0 },
      raw: match[0],
    }));
    return {
      tokens,
      remainingText: text.slice(0, match.index) + text.slice(match.index + match[0].length),
    };
  }

  /** "this weekend" / "next weekend": Saturday to Sunday. */
  private matchWeekend(
    text: string,
    options: DateExtractionOptions,
  ): { tokens: DateToken[]; remainingText: string } | null {
    const match = /\b(this|next|coming)?\s*weekend\b/i.exec(text);
    if (!match) return null;
    const today = localDay(options.referenceDate, options.timezone);
    let saturday = nextWeekday(today, 6, false);
    if (/^next/i.test(match[1] ?? '')) saturday = addDays(saturday, 7);
    const tokens: DateToken[] = [saturday, addDays(saturday, 1)].map((day, offset) => ({
      index: match.index + offset,
      local: { ...day, hour: DEFAULT_LOCAL_HOUR, minute: 0 },
      raw: `${match[1] ? `${match[1]} ` : 'this '}weekend`,
    }));
    return {
      tokens,
      remainingText: text.slice(0, match.index) + text.slice(match.index + match[0].length),
    };
  }

  private matchNamedMonthDates(text: string, referenceDate: Date): DateToken[] {
    const tokens: DateToken[] = [];

    const dayMonthRe = new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME_PATTERN}\\.?\\s*(\\d{4})?\\b`,
      'gi',
    );
    for (const match of text.matchAll(dayMonthRe)) {
      const day = Number(match[1]);
      const month0 = MONTHS[match[2]!.toLowerCase()];
      if (month0 === undefined) continue;
      tokens.push(
        this.buildNamedMonthToken(match.index, match[0], day, month0, match[3], referenceDate),
      );
    }

    const monthDayRe = new RegExp(
      `\\b${MONTH_NAME_PATTERN}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?\\b`,
      'gi',
    );
    for (const match of text.matchAll(monthDayRe)) {
      const month0 = MONTHS[match[1]!.toLowerCase()];
      const day = Number(match[2]);
      if (month0 === undefined) continue;
      tokens.push(
        this.buildNamedMonthToken(match.index, match[0], day, month0, match[3], referenceDate),
      );
    }

    return tokens;
  }

  private buildNamedMonthToken(
    index: number,
    raw: string,
    day: number,
    month0: number,
    explicitYearRaw: string | undefined,
    referenceDate: Date,
  ): DateToken {
    const explicitYear = explicitYearRaw ? Number(explicitYearRaw) : undefined;
    const year = resolveYear(month0, day, referenceDate, explicitYear);
    if (!isValidCalendarDate(year, month0, day)) {
      return { index, local: null, impossible: true, raw };
    }
    return { index, local: { year, month0, day, hour: DEFAULT_LOCAL_HOUR, minute: 0 }, raw };
  }

  private matchIsoDates(text: string): DateToken[] {
    const tokens: DateToken[] = [];
    const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    for (const match of text.matchAll(isoRe)) {
      const year = Number(match[1]);
      const month0 = Number(match[2]) - 1;
      const day = Number(match[3]);
      if (!isValidCalendarDate(year, month0, day)) {
        tokens.push({ index: match.index, local: null, impossible: true, raw: match[0] });
        continue;
      }
      tokens.push({
        index: match.index,
        local: { year, month0, day, hour: DEFAULT_LOCAL_HOUR, minute: 0 },
        raw: match[0],
      });
    }
    return tokens;
  }

  private matchNumericDates(text: string): DateToken[] {
    const tokens: DateToken[] = [];
    const numericRe = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;
    for (const match of text.matchAll(numericRe)) {
      const a = Number(match[1]);
      const b = Number(match[2]);
      const yearRaw = match[3]!;
      const year = yearRaw.length <= 2 ? normalizeTwoDigitYear(Number(yearRaw)) : Number(yearRaw);

      const asDayMonth = a >= 1 && a <= 31 && b >= 1 && b <= 12 ? { day: a, month0: b - 1 } : null;
      const asMonthDay = a >= 1 && a <= 12 && b >= 1 && b <= 31 ? { day: b, month0: a - 1 } : null;

      const validDayMonth =
        asDayMonth && isValidCalendarDate(year, asDayMonth.month0, asDayMonth.day);
      const validMonthDay =
        asMonthDay && isValidCalendarDate(year, asMonthDay.month0, asMonthDay.day);

      if (!validDayMonth && !validMonthDay) {
        tokens.push({ index: match.index, local: null, impossible: true, raw: match[0] });
        continue;
      }

      const sameResult =
        validDayMonth &&
        validMonthDay &&
        asDayMonth!.month0 === asMonthDay!.month0 &&
        asDayMonth!.day === asMonthDay!.day;

      if (validDayMonth && validMonthDay && !sameResult) {
        tokens.push({
          index: match.index,
          local: null,
          raw: match[0],
          ambiguity: {
            field: 'pickupDate',
            code: 'AMBIGUOUS_NUMERIC_DATE',
            message: `"${match[0]}" could be day/month or month/day and was not guessed`,
            raw: match[0],
          },
        });
        continue;
      }

      const resolved = (validDayMonth ? asDayMonth : asMonthDay)!;
      tokens.push({
        index: match.index,
        local: {
          year,
          month0: resolved.month0,
          day: resolved.day,
          hour: DEFAULT_LOCAL_HOUR,
          minute: 0,
        },
        raw: match[0],
      });
    }
    return tokens;
  }

  /** today / tomorrow / day after tomorrow, plus Hinglish aaj / kal / parso / narso. */
  private matchRelativeKeywords(text: string, options: DateExtractionOptions): DateToken[] {
    const today = localDay(options.referenceDate, options.timezone);
    const tokens: DateToken[] = [];
    // Longest phrases first, each blanked out so "day after tomorrow" never also matches "tomorrow".
    const phrases: [RegExp, number][] = [
      [/\bday after (?:tomorrow|tmrw|tmr)\b|\bparso\b|\bparson\b/i, 2],
      [/\bnarso\b|\bnarson\b/i, 3],
      [/\btomorrow\b|\btmrw\b|\btmr\b|\bkal\b/i, 1],
      [/\btoday\b|\btonight\b|\baaj\b/i, 0],
    ];
    let working = text;
    for (const [pattern, offset] of phrases) {
      const match = pattern.exec(working);
      if (!match) continue;
      const day = addDays(today, offset);
      tokens.push({
        index: match.index,
        local: { ...day, hour: DEFAULT_LOCAL_HOUR, minute: 0 },
        raw: match[0],
      });
      working = working.slice(0, match.index) + ' '.repeat(match[0].length) + working.slice(match.index + match[0].length);
    }
    return tokens;
  }

  private matchNextWeekday(text: string, options: DateExtractionOptions): DateToken[] {
    const match = NEXT_WEEKDAY_RE.exec(text);
    if (!match?.[1]) return [];
    // Already taken by a weekday range ("next Monday to Thursday") or removed with it.
    const today = localDay(options.referenceDate, options.timezone);
    const strict = /^next/i.test(match[0]);
    const target = nextWeekday(today, WEEKDAYS.indexOf(match[1].toLowerCase()), strict);
    return [
      {
        index: match.index,
        local: { ...target, hour: DEFAULT_LOCAL_HOUR, minute: 0 },
        raw: match[0],
      },
    ];
  }
}
