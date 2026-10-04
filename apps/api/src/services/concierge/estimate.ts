import {
  calculatePricing,
  computeRentalDurationDays,
  freeAlternatives,
  joinList,
  money,
  type FleetModel,
} from '@ai-concierge/ai';
import { quoteSelectionsSchema, type Vehicle } from '@ai-concierge/domain';
import type { AppContext } from '../../context.js';
import { evaluateInventoryStatus } from '../inventoryStatusEvaluator.js';
import type { Knowledge } from './knowledge.js';

/**
 * Indicative totals and date-specific availability for a car the customer is asking about. Both
 * reuse the booking steps' own functions (`calculatePricing`, `evaluateInventoryStatus`), so an
 * estimate here can never disagree with the quote the autopilot later issues. Neither creates a
 * hold or a quote: the exact quote is still made by the journey once the details are complete.
 */

function majorText(minorUnits: number, currency: string): string {
  const whole = minorUnits % 100 === 0;
  return `${currency} ${(minorUnits / 100).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** The catalog row to price a model with: a colour that has a car free, else the first. */
export function representativeVehicle(k: Knowledge, model: FleetModel, colour?: string | null): Vehicle | null {
  const wanted = colour
    ? model.rows.filter((row) => row.colour.toLowerCase() === colour.toLowerCase())
    : model.rows;
  const rows = wanted.length > 0 ? wanted : model.rows;
  const row = rows.find((candidate) => candidate.availableUnits > 0) ?? rows[0];
  return row ? (k.vehicles.get(row.id) ?? null) : null;
}

export function estimateText(
  ctx: AppContext,
  k: Knowledge,
  model: FleetModel,
  days: number,
  colour?: string | null,
): string | null {
  const vehicle = representativeVehicle(k, model, colour);
  if (!vehicle) return null;
  let result;
  try {
    result = calculatePricing({
      vehicle,
      durationDays: days,
      selections: quoteSelectionsSchema.parse({}),
      rules: ctx.pricingRules,
    });
  } catch {
    return null;
  }
  const cur = result.currency;
  const lines = [
    ...result.lineItems.map((item) =>
      item.quantity > 1
        ? `• ${item.description}: ${item.quantity} × ${majorText(item.unitAmount.minorUnits, cur)} = ${majorText(item.amount.minorUnits, cur)}`
        : `• ${item.description}: ${majorText(item.amount.minorUnits, cur)}`,
    ),
    ...result.fees.map((fee) => `• ${fee.description}: ${majorText(fee.amount.minorUnits, cur)}`),
    ...result.taxes.map((tax) => `• ${tax.description}: ${majorText(tax.amount.minorUnits, cur)}`),
  ];
  return (
    `Estimate for the ${model.name}, ${days} day${days === 1 ? '' : 's'}:\n${lines.join('\n')}\n` +
    `Total: ${majorText(result.total.minorUnits, cur)}. Refundable security deposit: ${majorText(result.deposit.minorUnits, cur)}.`
  );
}

export interface DateAvailability {
  /** At least one car of the model is free for the whole period. */
  available: boolean;
  /** True when the check itself could not be completed (so nothing may be claimed either way). */
  unknown: boolean;
}

async function modelAvailability(
  ctx: AppContext,
  model: FleetModel,
  pickupAt: Date,
  returnAt: Date,
): Promise<DateAvailability> {
  let unknown = false;
  for (const row of model.rows) {
    const verdict = await evaluateInventoryStatus(ctx.prisma, ctx.fleetProvider, {
      tenantId: ctx.config.DEFAULT_TENANT_ID,
      vehicleId: row.id,
      pickupAt,
      returnAt,
      bufferMinutes: ctx.config.AVAILABILITY_TURNAROUND_BUFFER_MINUTES,
      now: new Date(),
    });
    if (verdict.status === 'AVAILABLE') return { available: true, unknown: false };
    if (verdict.status === 'UNKNOWN') unknown = true;
  }
  return { available: false, unknown };
}

function dateRange(pickupAt: Date, returnAt: Date): string {
  const fmt = (date: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dubai',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date);
  return `${fmt(pickupAt)} to ${fmt(returnAt)}`;
}

/**
 * "Is the Urus free 20-25 Oct?" Answers yes/no for the dates, with the price estimate when free and
 * real, date-checked alternatives when not. Returns null when the check could not be completed.
 */
export async function availabilityReply(
  ctx: AppContext,
  k: Knowledge,
  model: FleetModel,
  pickupAt: Date,
  returnAt: Date,
  colour?: string | null,
): Promise<string | null> {
  const verdict = await modelAvailability(ctx, model, pickupAt, returnAt);
  if (verdict.unknown && !verdict.available) return null;
  const range = dateRange(pickupAt, returnAt);

  if (verdict.available) {
    const days = computeRentalDurationDays(pickupAt, returnAt);
    const estimate = estimateText(ctx, k, model, days, colour);
    return (
      `Good news: the ${model.name} looks available for ${range}.` +
      `${estimate ? `\n\n${estimate}` : ''}\n\n` +
      'Send me your pickup place (or delivery address) and I will prepare your exact quote.'
    );
  }

  const free: FleetModel[] = [];
  for (const candidate of freeAlternatives(
    k.fleet,
    k.profile,
    model,
    6,
  )) {
    if (free.length >= 3) break;
    const check = await modelAvailability(ctx, candidate, pickupAt, returnAt);
    if (check.available) free.push(candidate);
  }
  if (free.length === 0) {
    return `Sorry, the ${model.name} is not available for ${range}, and I could not find a similar car that is free for those dates. Would you like to try other dates?`;
  }
  return (
    `Sorry, the ${model.name} is already booked for ${range}. These are free for those dates: ` +
    `${joinList(free.map((alt) => `${alt.name} (${money(alt.dailyRate, alt.currency)}/day)`))}. ` +
    'Shall I check one of them, or would you like different dates?'
  );
}
