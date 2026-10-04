import {
  EMIRATE_LABEL,
  FaqTopic,
  money,
  type FaqTopicValue,
} from '@ai-concierge/ai';
import type { CollectedBookingInfo } from '@ai-concierge/domain';
import type { Knowledge } from './knowledge.js';

const NOT_PROVIDED = 'NOT PROVIDED (say you are not sure and offer the team; never guess)';

/**
 * The single text Gemini (and the reply guard) treats as the only truth: the fleet with live units,
 * the branches, the delivery rule, the rental terms and the owner's configured facts. Every number
 * a model-written reply may contain has to come from here or from the customer.
 */
export function buildFactsText(k: Knowledge, collected: CollectedBookingInfo): string {
  const { profile, fleet } = k;
  const fleetLines = fleet.models.map(
    (m) =>
      `- ${m.name} (${m.colours.join('/')}): ${m.category}, ${m.seats} seats, ${m.luggage} bags, ${m.transmission.toLowerCase()}, ` +
      `from ${money(m.dailyRate, m.currency)} per day` +
      `${m.weeklyRate !== null ? `, weekly ${money(m.weeklyRate, m.currency)}` : ''}` +
      `${m.deposit !== null ? `, deposit ${money(m.deposit, m.currency)}` : ''}; ` +
      `${m.availableUnits} of ${m.totalUnits} cars available now (${m.bookedUnits} booked)`,
  );

  const branches = profile.branches
    .filter((b) => b.confirmed)
    .map((b) => `- ${b.name} (${EMIRATE_LABEL[b.emirate]})`);

  const f = profile.delivery.feeByEmirate;
  const cur = profile.currency;
  const delivery =
    `Delivery or collection is possible only if the road distance from the NEAREST branch is at most ${profile.delivery.maxRoadKm} km. ` +
    `Fees: ${cur} ${f.DUBAI} in Dubai, ${cur} ${f.SHARJAH} in Sharjah and Ajman, ${cur} ${f.ABU_DHABI} to the other emirates; ` +
    `plus ${cur} ${profile.delivery.fridayOrHolidaySurcharge} on Fridays and public holidays; plus ${cur} ${profile.delivery.airportOffHireSurcharge} when the car is returned at an airport. ` +
    'Never promise a delivery without a measured distance.';

  const t = profile.terms;
  const minAge = Math.max(t.minDriverAge, k.policy.policyMinAge ?? 0);
  const tiers = Object.entries(k.policy.minAgeByTier)
    .filter(([, age]) => age > minAge)
    .map(([tier, age]) => {
      const names = fleet.models.filter((m) => m.luxuryTier === tier).map((m) => m.name);
      return `${tier} cars (${names.join(', ') || 'none'}) need age ${age}`;
    });
  const terms = [
    `Minimum driver age ${minAge}${tiers.length > 0 ? `; ${tiers.join('; ')}` : ''}.`,
    `Licence: ${t.licenceRule}.`,
    t.passportRequired ? 'Passport required.' : 'Passport not required.',
    t.cashAccepted ? 'Cash accepted.' : 'Cash is NOT accepted.',
    t.uaeOnly ? 'The car may NOT leave the UAE (no Oman or other countries).' : '',
    t.offRoadAllowed ? '' : 'Off-road and desert driving are NOT allowed.',
    `Prices are in ${cur}; daily rates are before ${k.policy.vatPercent}% VAT, which is added in the quote.`,
    'Eligibility is checked when the customer books; the team verifies documents at handover.',
  ]
    .filter(Boolean)
    .join(' ');

  const business = (Object.values(FaqTopic) as FaqTopicValue[]).map(
    (topic) => `- ${topic}: ${k.policy.configured.get(topic) ?? NOT_PROVIDED}`,
  );

  const missing = [
    collected.vehicle ? null : 'which car',
    collected.pickupDate ? null : 'pickup date',
    collected.returnDate ? null : 'return date',
    collected.pickupLocation ? null : 'pickup place',
  ].filter((entry): entry is string => entry !== null);

  return [
    `COMPANY: ${profile.brand}, a car rental company in the UAE. You are its AI concierge; if asked, say so plainly and mention the team is available for anyone who prefers a person.`,
    'YOU CAN: answer from the facts below, quote daily rates, say photos of a car can be sent, check a delivery, and collect booking details (car, dates, pickup place).',
    'YOU CANNOT (the team does these): cancel, refund, change or confirm a booking or payment, or promise a callback or a time.',
    `FLEET (live; rates per day in ${cur}):\n${fleetLines.join('\n')}`,
    `BRANCHES (pickup points):\n${branches.join('\n')}`,
    `DELIVERY RULE: ${delivery}`,
    `RENTAL TERMS: ${terms}`,
    `BUSINESS FACTS:\n${business.join('\n')}`,
    `BOOKING SO FAR: car ${collected.vehicle ? `${collected.vehicle.make} ${collected.vehicle.model}${collected.vehicle.color ? ` (${collected.vehicle.color})` : ''}` : 'not chosen'}; pickup ${collected.pickupDate ?? 'not given'}; return ${collected.returnDate ?? 'not given'}; place ${collected.pickupLocation?.normalized ?? 'not given'}. Still needed: ${missing.join(', ') || 'nothing'}.`,
  ].join('\n');
}
