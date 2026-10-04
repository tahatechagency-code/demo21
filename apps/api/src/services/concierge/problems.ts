import {
  computeRentalDurationDays,
  extractStatedDuration,
  joinList,
  type FleetModel,
} from '@ai-concierge/ai';
import type { ValidationIssue } from '@ai-concierge/domain';
import type { AppContext } from '../../context.js';
import { estimateText } from './estimate.js';
import type { Knowledge } from './knowledge.js';

/**
 * What the concierge says when a message gave something it cannot use — a date that does not exist,
 * one that has passed, a return before the pickup, a place outside the UAE or beyond the delivery
 * rule — and when a rental length arrives without a start date. The facts come from the same Step 2
 * verifier the booking steps use (`ctx.dateLocationOrchestrator`), read on THIS message alone, so the
 * reply is about what the customer just said and never repeats an old problem.
 */

const TZ = 'Asia/Dubai';

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function todayText(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
}

export type MessageProblem =
  | { kind: 'IMPOSSIBLE_DATE'; issue: ValidationIssue }
  | { kind: 'PAST_DATE' }
  | { kind: 'RETURN_BEFORE_PICKUP'; pickup: Date; returnAt: Date }
  | { kind: 'OUT_OF_DELIVERY_RANGE'; issue: ValidationIssue }
  | { kind: 'UNSUPPORTED_LOCATION'; place: string };

/** The first problem THIS message has, in the order a customer should fix them (place, then dates). */
export async function findMessageProblem(ctx: AppContext, message: string): Promise<MessageProblem | null> {
  // A date of birth or an expiry date is a driver detail, never a rental date.
  if (/\b(?:born|birth|dob|d\.o\.b|expir\w*|valid (?:until|till))\b/i.test(message)) return null;
  const result = await ctx.dateLocationOrchestrator.extract(message);
  const errors = result.validationErrors.filter((issue) => issue.severity === 'ERROR');
  const unsupported = errors.find((issue) => issue.code === 'UNSUPPORTED_LOCATION');
  if (unsupported) {
    return { kind: 'UNSUPPORTED_LOCATION', place: /"([^"]+)"/.exec(unsupported.message)?.[1] ?? 'that place' };
  }
  const far = errors.find((issue) => issue.code === 'OUT_OF_DELIVERY_RANGE');
  if (far) return { kind: 'OUT_OF_DELIVERY_RANGE', issue: far };
  // A date with a year long gone ("3 April 1990") is a driver's date of birth or a licence date, not a rental date.
  const currentYear = new Date().getUTCFullYear();
  const oldYear = [...message.matchAll(/\b(19\d{2}|20\d{2})\b/g)].some((match) => Number(match[1]) < currentYear - 1);
  if (oldYear) return null;
  const impossible = errors.find((issue) => issue.code === 'IMPOSSIBLE_DATE');
  if (impossible) return { kind: 'IMPOSSIBLE_DATE', issue: impossible };
  if (errors.some((issue) => issue.code === 'PAST_DATE')) return { kind: 'PAST_DATE' };
  // "last year december": a month of a year that is over has no day to resolve, but it is plainly the past.
  if (/\b(?:last year|pichle saal|pichhle saal)\b/i.test(message)) return { kind: 'PAST_DATE' };
  if (errors.some((issue) => issue.code === 'RETURN_BEFORE_OR_EQUAL_PICKUP') && result.pickupDate && result.returnDate) {
    return { kind: 'RETURN_BEFORE_PICKUP', pickup: new Date(result.pickupDate), returnAt: new Date(result.returnDate) };
  }
  return null;
}

/** The reply for a problem; `deliveryText` explains a place that is too far (branch pickup alternatives). */
export function problemText(problem: MessageProblem, deliveryText: () => Promise<string>): Promise<string> | string {
  switch (problem.kind) {
    case 'UNSUPPORTED_LOCATION':
      return `Sorry, we only rent and deliver within the UAE, so ${problem.place} is not possible, and our cars cannot leave the country. Would you like the car in Dubai, Abu Dhabi or another emirate?`;
    case 'OUT_OF_DELIVERY_RANGE':
      return deliveryText();
    case 'IMPOSSIBLE_DATE':
      return `I could not use that date: ${problem.issue.message}. Could you give me the date again, for example 15 October?`;
    case 'PAST_DATE':
      return `That date has already passed (today is ${todayText()}), so I have not used it. Which pickup date from today onwards would you like?`;
    case 'RETURN_BEFORE_PICKUP':
      return `The return date (${formatDay(problem.returnAt)}) is not after the pickup date (${formatDay(problem.pickup)}). Could you confirm a return date that is after your pickup date?`;
  }
}

/**
 * A rental length with no start date ("3 din ke liye", "1 week"), or a length in hours: rentals are
 * charged per day, so hours are explained instead of silently ignored.
 */
export function durationReply(
  message: string,
  model: FleetModel | null,
  hasPickupDate: boolean,
  estimateFor?: (days: number) => string | null,
): string | null {
  const duration = extractStatedDuration(message);
  if (!duration) return null;
  const car = model ? ` with the ${model.name}` : '';
  if (duration.unit === 'hour' || duration.unit === 'minute') {
    const length = `${duration.amount} ${duration.unit}${duration.amount === 1 ? '' : 's'}`;
    return `Our rentals are charged per day (24 hours), so ${length} would be billed as 1 day${car}. ${hasPickupDate ? 'Shall I go ahead with 1 day?' : 'Is 1 day fine? And which date should we start?'}`;
  }
  if (hasPickupDate) return null;
  const days = duration.unit === 'week' ? duration.amount * 7 : duration.unit === 'month' ? duration.amount * 30 : duration.amount;
  const estimate = estimateFor?.(days);
  const lead = `Got it, ${days} day${days === 1 ? '' : 's'}${car}.`;
  return [lead, estimate, 'Which pickup date would you like to start from?'].filter(Boolean).join('\n\n');
}

/** Total for the dates already in the booking: the estimate, plus the delivery fee when the place is known. */
export function datedEstimateReply(
  ctx: AppContext,
  k: Knowledge,
  model: FleetModel,
  pickupAt: Date,
  returnAt: Date,
  deliveryNote: string | null,
): string | null {
  const days = computeRentalDurationDays(pickupAt, returnAt);
  const estimate = estimateText(ctx, k, model, days);
  if (!estimate) return null;
  return `${estimate}${deliveryNote ? `\n\n${deliveryNote}` : ''}\n\nThe exact quote is prepared once I have your driver details.`;
}

/** "Your booking so far": car, dates, place — used when the customer asks about what they already gave. */
export function stateSummary(
  model: FleetModel | null,
  pickupAt: Date | null,
  returnAt: Date | null,
  place: string | null,
): string | null {
  const parts: string[] = [];
  if (model) parts.push(`car: ${model.name}`);
  if (pickupAt) parts.push(`pickup: ${formatDay(pickupAt)}`);
  if (returnAt) parts.push(`return: ${formatDay(returnAt)}`);
  if (place) parts.push(`place: ${place}`);
  return parts.length > 0 ? joinList(parts) : null;
}

export { formatDay };
