import { formatUsdAmount, pricingProfileInUsd, type PricingProfile } from '@ai-concierge/domain';

/**
 * "A car under 300 dollars": the fleet database is searched first, and only then is anything said.
 * Pure — it reads the vehicles it is given and never invents a car, a price or a range. Prices are
 * the admin dashboard's own daily rates in US dollars; the hourly figure is that daily rate divided
 * by 24, shown for comparison only (the business does not price by the hour).
 */

export interface PriceSearchVehicle {
  make: string;
  model: string;
  color: string;
  active: boolean;
  pricingProfile: PricingProfile;
}

export interface PriceSearchRange {
  min: number | null;
  max: number | null;
}

export interface PricedModel {
  name: string;
  colours: string[];
  /** The lowest daily rate across this model's colours, in USD. */
  daily: number;
  hourly: number;
}

export interface PriceSearchResult {
  range: PriceSearchRange;
  /** Cars inside the range, cheapest first. */
  matches: PricedModel[];
  /** Every car in the fleet, cheapest first. */
  all: PricedModel[];
}

const HOURS_PER_DAY = 24;
const MAX_LISTED = 6;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The daily rate spread over 24 hours, in dollars and cents. */
export function hourlyFromDaily(daily: number): number {
  return round2(daily / HOURS_PER_DAY);
}

export function searchFleetByPrice(
  vehicles: readonly PriceSearchVehicle[],
  range: PriceSearchRange,
): PriceSearchResult {
  const byName = new Map<string, { colours: string[]; daily: number }>();
  for (const vehicle of vehicles) {
    if (!vehicle.active) continue;
    const name = `${vehicle.make} ${vehicle.model}`;
    const daily = pricingProfileInUsd(vehicle.pricingProfile).dailyRate;
    const entry = byName.get(name);
    byName.set(name, {
      colours: [...(entry?.colours ?? []), vehicle.color],
      daily: Math.min(entry?.daily ?? daily, daily),
    });
  }
  const all = [...byName.entries()]
    .map(([name, entry]) => ({
      name,
      colours: entry.colours,
      daily: round2(entry.daily),
      hourly: hourlyFromDaily(entry.daily),
    }))
    .sort((a, b) => a.daily - b.daily || a.name.localeCompare(b.name));
  const matches = all.filter(
    (model) =>
      (range.max === null || model.daily <= range.max) &&
      (range.min === null || model.daily >= range.min),
  );
  return { range, matches, all };
}

function describeRange(range: PriceSearchRange): string {
  if (range.min !== null && range.max !== null) {
    return `between ${formatUsdAmount(range.min)} and ${formatUsdAmount(range.max)} per day`;
  }
  if (range.max !== null) return `at or under ${formatUsdAmount(range.max)} per day`;
  if (range.min !== null) return `at or above ${formatUsdAmount(range.min)} per day`;
  return 'across the whole fleet';
}

function priced(model: PricedModel): string {
  return `${model.name} ${formatUsdAmount(model.daily)} per day (about ${formatUsdAmount(model.hourly)} per hour)`;
}

/** The result as facts for Gemini: the numbers it may use, nothing else. */
export function describePriceSearch(result: PriceSearchResult): string {
  const { range, matches, all } = result;
  const hasRange = range.min !== null || range.max !== null;
  const pool = hasRange ? matches : all;
  const lines: string[] = [
    `Search: cars ${describeRange(range)}. Hourly figures are the daily rate divided by 24, for comparison only.`,
  ];
  if (pool.length === 0) {
    lines.push('Cars found: none.');
    const cheapest = all[0];
    if (cheapest) lines.push(`Lowest-priced car in the whole fleet: ${priced(cheapest)}.`);
  } else {
    lines.push(`Cars found (${pool.length}): ${pool.slice(0, MAX_LISTED).map(priced).join('; ')}.`);
    lines.push(`Lowest price in this search: ${priced(pool[0]!)}.`);
    lines.push(`Highest price in this search: ${priced(pool[pool.length - 1]!)}.`);
  }
  return lines.join('\n');
}

/** The same answer without a language model: used when Gemini is unavailable or its words fail the guard. */
export function priceSearchReply(result: PriceSearchResult): string {
  const { range, matches, all } = result;
  const hasRange = range.min !== null || range.max !== null;
  const pool = hasRange ? matches : all;
  const next = ' Tell me which car you like and your dates, and I will prepare an exact quote.';
  const cheapest = all[0];
  if (pool.length === 0) {
    return cheapest
      ? `No car is ${describeRange(range)}. Our lowest price is the ${priced(cheapest)}.${next}`
      : 'I cannot see any cars in the fleet right now.';
  }
  const lowest = pool[0]!;
  const highest = pool[pool.length - 1]!;
  const intro = hasRange ? `Cars ${describeRange(range)}` : 'Our fleet';
  const list = pool.slice(0, MAX_LISTED).map(priced).join('; ');
  const ends =
    pool.length === 1
      ? ''
      : ` The lowest is the ${priced(lowest)} and the highest is the ${priced(highest)}.`;
  return `${intro}: ${list}.${ends} Hourly figures are the daily rate divided by 24, for comparison only.${next}`;
}
