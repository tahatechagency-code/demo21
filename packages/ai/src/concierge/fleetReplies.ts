import {
  coloursText,
  joinList,
  money,
  popularModels,
  type FleetKnowledge,
  type FleetModel,
  type VehicleMention,
} from './fleetKnowledge.js';
import type { BusinessProfile } from './profile.js';
import { pickVariant } from './variants.js';

/**
 * Customer-facing wording for everything the fleet can answer by itself. Every figure is read
 * from the fleet rows passed in; nothing is remembered, rounded up or invented here, and a car
 * that is not in the rows is never described.
 */

const MAX_LIST = 5;

export function unitsText(model: FleetModel): string {
  if (model.availableUnits <= 0) return 'currently fully booked';
  if (model.availableUnits === 1) return '1 car available now';
  return `${model.availableUnits} cars available now`;
}

function perDay(model: FleetModel): string {
  return `${money(model.dailyRate, model.currency)}/day`;
}

/** One compact line: "Lamborghini Urus (Black, White) · 5 seats · from AED 3,500/day · 3 cars available now" */
export function modelLine(model: FleetModel): string {
  return `${model.name} (${coloursText(model)}) · ${model.seats} seats · from ${perDay(model)} · ${unitsText(model)}`;
}

function shortLine(model: FleetModel): string {
  return `${model.name} (${money(model.dailyRate, model.currency)}/day)`;
}

function transmissionText(model: FleetModel): string {
  return model.transmission.toLowerCase();
}

const NEXT_STEP = 'Send me your pickup place and dates and I will check it for you.';

/** Same-category cars that are actually free, best first, never the car itself. */
export function freeAlternatives(
  fleet: FleetKnowledge,
  profile: BusinessProfile,
  model: FleetModel,
  limit = 3,
): FleetModel[] {
  const sameCategory = fleet.models.filter(
    (other) => other.key !== model.key && other.category === model.category && other.availableUnits > 0,
  );
  const ranked = popularModels(
    { ...fleet, models: sameCategory },
    profile,
    limit,
    { onlyAvailable: true },
  );
  if (ranked.length >= limit) return ranked;
  const more = popularModels(fleet, profile, limit, {
    exclude: [model, ...ranked],
    onlyAvailable: true,
  });
  return [...ranked, ...more].slice(0, limit);
}

/** The customer named a car that IS in the fleet. */
export function foundModelsReply(
  mention: Extract<VehicleMention, { kind: 'MODEL' }>,
  fleet: FleetKnowledge,
  profile: BusinessProfile,
  options: { askNext?: boolean; seed?: string } = {},
): string {
  const askNext = options.askNext !== false;
  const { models, colour } = mention;
  if (models.length > 1) {
    return `Yes, these are in our fleet:\n${models
      .slice(0, MAX_LIST)
      .map((model) => `• ${modelLine(model)}`)
      .join('\n')}${askNext ? '\n\nWhich one would you like? Then send me your pickup place and dates.' : ''}`;
  }
  const model = models[0]!;
  const parts: string[] = [];

  let colourNote = '';
  if (colour) {
    const colourRow = model.rows.find((row) => row.colour.toLowerCase() === colour.toLowerCase());
    colourNote =
      colourRow && colourRow.availableUnits <= 0
        ? ` The ${colour} one is booked right now${
            model.availableUnits > 0 ? ', but another colour is free' : ''
          }.`
        : ` ${colour} is available in that model.`;
  }

  if (model.availableUnits > 0) {
    const lead = pickVariant(options.seed, [
      `Yes, we have the ${model.name}`,
      `Good choice, the ${model.name} is in our fleet`,
      `The ${model.name} is with us`,
      `We do have the ${model.name}`,
      `Sure, the ${model.name} is available to rent`,
    ]);
    parts.push(
      `${lead} (${coloursText(model)}). ${model.seats} seats, ${transmissionText(model)}, from ${perDay(model)}${
        model.deposit !== null ? `, security deposit ${money(model.deposit, model.currency)}` : ''
      }. ${unitsText(model).replace(/^./, (c) => c.toUpperCase())}.${colourNote}`,
    );
    if (askNext) parts.push(NEXT_STEP);
  } else {
    const alternatives = freeAlternatives(fleet, profile, model);
    parts.push(
      `The ${model.name} (${coloursText(model)}, from ${perDay(model)}) is fully booked right now.`,
    );
    if (alternatives.length > 0) {
      parts.push(
        `Similar cars that are free: ${joinList(alternatives.map(shortLine))}. Shall I check one of them, or other dates for the ${model.name}?`,
      );
    } else {
      parts.push('Would you like to try other dates?');
    }
  }
  return parts.join(' ');
}

/** The customer named a car that is NOT in the fleet (or named a brand with a model we do not carry). */
export function notInFleetReply(
  mention: Extract<VehicleMention, { kind: 'NOT_IN_FLEET' }>,
  fleet: FleetKnowledge,
  profile: BusinessProfile,
): string {
  const close = mention.sameBrand.length > 0
    ? mention.sameBrand.slice(0, 3)
    : popularModels(fleet, profile, 3, { exclude: mention.sameBrand, onlyAvailable: true });
  const head = `Sorry, the ${mention.mention} is not in our fleet right now.`;
  if (close.length === 0) return `${head} Reply LIST to see every model.`;
  const intro = mention.sameBrand.length > 0 ? `From ${mention.sameBrand[0]!.make} we do have:` : 'Our most popular cars right now:';
  return `${head} ${intro}\n${close.map((model) => `• ${shortLine(model)}`).join('\n')}\n\nTell me which one you like, or reply LIST to see every model.`;
}

/** "LIST": the complete fleet, grouped by brand, straight from the rows. */
export function fleetListReply(fleet: FleetKnowledge): string {
  const byMake = new Map<string, FleetModel[]>();
  for (const model of fleet.models) {
    byMake.set(model.make, [...(byMake.get(model.make) ?? []), model]);
  }
  const lines = [...byMake.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([make, models]) =>
        `• ${make}: ${models
          .map((model) => `${model.model} (${money(model.dailyRate, model.currency)})`)
          .join(', ')}`,
    );
  if (lines.length === 0) return 'Our fleet list is not available right now.';
  return `Our full fleet (from, per day):\n${lines.join('\n')}\n\nTell me which one you like and your dates.`;
}

export function categoryReply(
  mention: Extract<VehicleMention, { kind: 'CATEGORY' }>,
  fleet: FleetKnowledge,
  profile: BusinessProfile,
): string {
  if (mention.models.length === 0) {
    const popular = popularModels(fleet, profile, 4, { onlyAvailable: true });
    return `We do not have a ${mention.label} in the fleet right now. Popular alternatives: ${joinList(popular.map(shortLine))}. Reply LIST for every model.`;
  }
  const free = mention.models.filter((model) => model.availableUnits > 0);
  // The owner's popular cars lead, so the first few are the ones customers actually want.
  const shown = popularModels(
    { ...fleet, models: free.length > 0 ? free : mention.models },
    profile,
    6,
  );
  return `Our ${mention.label} options:\n${shown.map((model) => `• ${modelLine(model)}`).join('\n')}\n\nWhich one would you like? Send me your dates and pickup place too.`;
}

/** "any 7 seater?": the cars with at least that many seats, straight from the fleet rows. */
export function seatFilterReply(fleet: FleetKnowledge, minSeats: number, profile: BusinessProfile): string {
  const enough = fleet.models.filter((model) => model.seats >= minSeats);
  if (enough.length === 0) {
    const biggest = Math.max(0, ...fleet.models.map((model) => model.seats));
    return biggest > 0
      ? `We do not have a car with ${minSeats} or more seats right now; the largest seats ${biggest}. Reply LIST to see every model.`
      : 'Our fleet list is not available right now.';
  }
  const free = enough.filter((model) => model.availableUnits > 0);
  const shown = popularModels({ ...fleet, models: free.length > 0 ? free : enough }, profile, 6);
  return `Cars with ${minSeats} or more seats:\n${shown.map((model) => `• ${modelLine(model)}`).join('\n')}\n\nWhich one would you like? Send me your dates and pickup place too.`;
}

export function brandReply(
  mention: Extract<VehicleMention, { kind: 'BRAND' }>,
): string {
  const lines = mention.models.slice(0, 6).map((model) => `• ${modelLine(model)}`);
  return `From ${mention.make} we have:\n${lines.join('\n')}\n\nWhich model would you like? Then send me your dates and pickup place.`;
}

export function compareReply(models: FleetModel[]): string {
  const rows = models.slice(0, 3).map(
    (model) =>
      `• ${model.name}: ${model.seats} seats, ${model.luggage} bags, ${transmissionText(model)}, from ${perDay(model)}${
        model.deposit !== null ? `, deposit ${money(model.deposit, model.currency)}` : ''
      }, ${unitsText(model)}`,
  );
  const cheapest = [...models].sort((a, b) => a.dailyRate - b.dailyRate)[0]!;
  return `Here is the comparison:\n${rows.join('\n')}\n\nThe ${cheapest.name} is the lower daily rate. Which one shall I check for you?`;
}

export function coloursReply(models: FleetModel[]): string {
  return models
    .slice(0, 6)
    .map((model) => `The ${model.name} comes in ${coloursText(model)}.`)
    .join(' ');
}

export function seatsReply(models: FleetModel[]): string {
  return models
    .slice(0, 6)
    .map((model) => `The ${model.name} seats ${model.seats} (${model.luggage} bags).`)
    .join(' ');
}

export function priceListReply(models: FleetModel[]): string {
  const lines = models
    .slice(0, 5)
    .map(
      (model) =>
        `• ${model.name}: from ${perDay(model)}${model.weeklyRate !== null ? `, weekly ${money(model.weeklyRate, model.currency)}` : ''}${
          model.deposit !== null ? `, deposit ${money(model.deposit, model.currency)}` : ''
        }`,
    );
  return `${lines.join('\n')}\n\nDaily rates are before VAT. Tell me your dates and I will work out the total.`;
}

export function extremeReply(
  fleet: FleetKnowledge,
  which: 'cheapest' | 'priciest',
): string {
  const free = fleet.models.filter((model) => model.availableUnits > 0);
  const pool = free.length > 0 ? free : fleet.models;
  const sorted = [...pool].sort((a, b) => a.dailyRate - b.dailyRate);
  const picks = (which === 'cheapest' ? sorted : sorted.reverse()).slice(0, 3);
  return `${which === 'cheapest' ? 'Our most affordable' : 'Our top-end'} cars: ${joinList(picks.map(shortLine))}. Want me to check dates for one?`;
}

export interface RecommendNeed {
  seats?: number;
  occasion?: 'wedding' | 'family' | 'luxury' | 'sporty' | 'business' | 'budget' | 'fun';
  category?: string;
  maxDailyRate?: number;
}

/** "Best car for a wedding", "7 seater", "under 1500": a short list straight from the fleet. */
export function recommendReply(
  need: RecommendNeed,
  fleet: FleetKnowledge,
  profile: BusinessProfile,
): string {
  let pool = fleet.models.filter((model) => model.availableUnits > 0);
  if (pool.length === 0) pool = fleet.models;
  if (need.seats) pool = pool.filter((model) => model.seats >= need.seats!);
  if (need.maxDailyRate !== undefined) pool = pool.filter((model) => model.dailyRate <= need.maxDailyRate!);
  if (need.category) pool = pool.filter((model) => model.category === need.category);

  const rank = (model: FleetModel): number => {
    switch (need.occasion) {
      case 'wedding':
      case 'luxury':
      case 'business':
        return (model.luxuryTier === 'ULTRA_LUXURY' ? 2 : 0) + (model.category === 'SEDAN' ? 2 : 0) + model.dailyRate / 10_000;
      case 'sporty':
      case 'fun':
        return (['COUPE', 'CONVERTIBLE', 'SPORTS'].includes(model.category) ? 3 : 0) + model.dailyRate / 10_000;
      case 'family':
        return model.seats + (model.category === 'SUV' || model.category === 'VAN' ? 2 : 0);
      case 'budget':
        return -model.dailyRate;
      default:
        return profile.popularModels.some((name) => model.name.toLowerCase().includes(name.toLowerCase().split(' ').pop()!)) ? 1 : 0;
    }
  };
  const picks = [...pool].sort((a, b) => rank(b) - rank(a)).slice(0, 3);
  if (picks.length === 0) {
    return 'I could not find a car in our fleet that fits that exactly. Reply LIST to see every model, or tell me a little more about what you need.';
  }
  const intro =
    need.occasion === 'wedding'
      ? 'For a wedding, these look the part'
      : need.seats
        ? `For ${need.seats} people, these fit`
        : 'These would suit you';
  return `${intro}:\n${picks.map((model) => `• ${modelLine(model)}`).join('\n')}\n\nShall I check one for your dates?`;
}

/** What the customer's message is asking about the cars, beyond naming one. */
export type FleetQuestionKind =
  | 'LIST'
  | 'PRICE'
  | 'COLOURS'
  | 'SEATS'
  | 'COMPARE'
  | 'RECOMMEND'
  | 'CHEAPEST'
  | 'PRICIEST'
  | 'AVAILABILITY'
  | 'DETAIL';

export function detectFleetQuestion(message: string): FleetQuestionKind[] {
  const text = message.toLowerCase();
  const kinds: FleetQuestionKind[] = [];
  if (/^\s*(?:list|full list|model list|car list|fleet list|all (?:models|cars)|show (?:me )?(?:all|the) (?:cars|models|fleet))\s*[.!?]*\s*$/.test(text) || /\b(?:model list|car list|fleet list|full list|list of (?:all )?(?:cars|models|vehicles)|all (?:your )?(?:cars|models|vehicles)|what (?:cars|models|vehicles) (?:do you|are)|which (?:cars|models|vehicles)|your (?:fleet|collection|lineup))\b/.test(text)) {
    kinds.push('LIST');
  }
  if (/\b(?:compare|comparison|versus|vs\.?|difference between|better)\b/.test(text)) kinds.push('COMPARE');
  if (/\b(?:cheapest|cheap|lowest price|least expensive|most affordable|budget|sasta|sasti|kam price)\b/.test(text)) kinds.push('CHEAPEST');
  if (/\b(?:most expensive|priciest|highest price|top[- ]?end|costliest|mehenga)\b/.test(text)) kinds.push('PRICIEST');
  if (/\b(?:best|suggest|recommend|which (?:car|one)|what should|suitable|good for|ke liye|ke lye|for (?:a )?(?:wedding|family|business|party|honeymoon|trip|friends|kids)|\d+\s*(?:people|persons|passengers|seater|seats?|adults))\b/.test(text)) kinds.push('RECOMMEND');
  if (/\b(?:colou?rs?|rang|shades?)\b/.test(text)) kinds.push('COLOURS');
  if (/\b(?:seats?|seater|seating|passengers|capacity|how many people|bags|luggage)\b/.test(text)) kinds.push('SEATS');
  if (/\b(?:price|prices|pricing|cost|rate|rates|per day|daily|how much|kitna|kimat|charges?|tariff|weekly|monthly)\b/.test(text)) kinds.push('PRICE');
  if (/\b(?:available|availability|free|in stock|do you have|have you got|got any|is there)\b/.test(text)) kinds.push('AVAILABILITY');
  return kinds;
}

export function detectRecommendNeed(message: string): RecommendNeed {
  const text = message.toLowerCase();
  const need: RecommendNeed = {};
  const seats = /(\d{1,2})\s*(?:people|persons|passengers|seater|seats?|adults|pax|log)/.exec(text);
  if (seats) need.seats = Number(seats[1]);
  if (/\b(?:wedding|shaadi|bride|groom|nikah)\b/.test(text)) need.occasion = 'wedding';
  else if (/\b(?:family|kids|children|parents)\b/.test(text)) need.occasion = 'family';
  else if (/\b(?:business|meeting|client|corporate)\b/.test(text)) need.occasion = 'business';
  else if (/\b(?:sporty|fast|speed|fun|thrill|track|supercar|sports? car)\b/.test(text)) need.occasion = 'sporty';
  else if (/\b(?:luxury|luxurious|premium|vip|impress|special|honeymoon|party)\b/.test(text)) need.occasion = 'luxury';
  else if (/\b(?:budget|cheap|affordable|economical)\b/.test(text)) need.occasion = 'budget';
  const under = /(?:under|below|less than|within|max(?:imum)?|upto|up to)\s*(?:aed|dhs|dirhams?)?\s*(\d{3,6})/.exec(text);
  if (under) need.maxDailyRate = Number(under[1]);
  return need;
}
