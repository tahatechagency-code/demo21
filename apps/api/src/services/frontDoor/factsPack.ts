import { FaqTopic, LOCATION_KEYWORDS, type FaqTopicValue } from '@ai-concierge/ai';
import { findActiveEligibilityPolicy, listVehicles } from '@ai-concierge/db';
import type { CollectedBookingInfo } from '@ai-concierge/domain';
import type { AppContext } from '../../context.js';

/**
 * Everything the concierge is allowed to state, assembled from the database (fleet, prices, the
 * driver-eligibility policy) and the owner's configured business facts. It is handed to Gemini as
 * the only source of truth and to the reply guard as the only place a number may come from.
 */
export interface FactsPack {
  text: string;
  /** Business topics that have a configured fact. */
  knownTopics: ReadonlySet<FaqTopicValue>;
}

const NOT_PROVIDED = 'NOT PROVIDED (say you are not sure and offer to ask the team; never guess)';
const NOT_A_PLACE = new Set(['dubai', 'dxb']);

function parseBusinessFacts(raw: string | undefined): Map<FaqTopicValue, string> {
  const facts = new Map<FaqTopicValue, string>();
  if (!raw) return facts;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return facts;
    for (const topic of Object.values(FaqTopic)) {
      const value = (parsed as Record<string, unknown>)[topic];
      if (typeof value === 'string' && value.trim()) facts.set(topic, value.trim().slice(0, 300));
    }
  } catch {
    // A malformed setting must never break chat; the facts are simply "not provided".
  }
  return facts;
}

function titleCase(place: string): string {
  return place === 'jbr'
    ? 'JBR'
    : place
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export async function buildFactsPack(
  ctx: AppContext,
  collected: CollectedBookingInfo,
): Promise<FactsPack> {
  const tenantId = ctx.config.DEFAULT_TENANT_ID;
  const [vehicles, policy] = await Promise.all([
    listVehicles(ctx.prisma, { tenantId, limit: 100, offset: 0 }),
    findActiveEligibilityPolicy(ctx.prisma, tenantId),
  ]);

  const models = new Map<
    string,
    { colours: string[]; from: number; currency: string; tier: string; deposit?: number }
  >();
  for (const vehicle of vehicles.filter((entry) => entry.active)) {
    const name = `${vehicle.make} ${vehicle.model}`;
    const existing = models.get(name);
    const { dailyRate, currency, depositAmount } = vehicle.pricingProfile;
    models.set(name, {
      colours: [...(existing?.colours ?? []), vehicle.color],
      from: Math.min(existing?.from ?? dailyRate, dailyRate),
      currency,
      tier: vehicle.luxuryTier,
      ...(depositAmount !== undefined ? { deposit: depositAmount } : {}),
    });
  }
  const fleetLines = [...models.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, model]) =>
        `- ${name} (${model.colours.join('/')}): from ${model.currency} ${model.from.toLocaleString('en-US')} per day` +
        `${model.deposit !== undefined ? `, deposit ${model.currency} ${model.deposit.toLocaleString('en-US')}` : ''}; tier ${model.tier}`,
    );

  const requirements = policy
    ? [
        `Minimum driver age ${policy.rules.minAge}.`,
        ...Object.entries(policy.rules.minAgeByLuxuryTier).map(
          ([tier, age]) =>
            `${tier} cars need the driver to be at least ${age}: ${
              [...models.entries()]
                .filter(([, model]) => model.tier === tier)
                .map(([name]) => name)
                .join(', ') || 'none in the fleet'
            }.`,
        ),
        `Accepted licence types: ${policy.rules.requiredLicenseTypes.join(', ')} (IDP = International Driving Permit).`,
        policy.rules.passportRequired ? 'A passport is required.' : 'A passport is not required.',
        'Final eligibility is checked when the customer books.',
      ].join(' ')
    : NOT_PROVIDED;

  const places = LOCATION_KEYWORDS.filter((place) => !NOT_A_PLACE.has(place)).map(titleCase);
  const configured = parseBusinessFacts(ctx.config.BUSINESS_FACTS_JSON);
  const businessLines = Object.values(FaqTopic).map(
    (topic) => `- ${topic}: ${configured.get(topic) ?? NOT_PROVIDED}`,
  );

  const missing = [
    collected.vehicle ? null : 'which car',
    collected.pickupDate ? null : 'pickup date',
    collected.returnDate ? null : 'return date',
    collected.pickupLocation ? null : 'pickup location',
  ].filter((entry): entry is string => entry !== null);

  const text = [
    'COMPANY: Edel & Stark, a luxury car rental concierge in Dubai. You are its AI concierge; if asked, say so plainly and mention the team is available for anyone who prefers a person.',
    'YOU CAN: answer from the facts below, quote daily rates, say photos of a car can be sent (the system attaches staff-uploaded photos), and collect booking details (car, dates, pickup place).',
    'YOU CANNOT (the team does these): cancel, refund, change or confirm a booking or payment, or promise a callback or a time.',
    `FLEET (rates are per day, in the currency shown):\n${fleetLines.join('\n')}`,
    `DRIVER REQUIREMENTS: ${requirements}`,
    `PICKUP / DELIVERY PLACES: ${places.join(', ')}.`,
    `BUSINESS FACTS:\n${businessLines.join('\n')}`,
    `BOOKING SO FAR: car ${collected.vehicle ? `${collected.vehicle.make} ${collected.vehicle.model} (${collected.vehicle.color})` : 'not chosen'}; pickup ${collected.pickupDate ?? 'not given'}; return ${collected.returnDate ?? 'not given'}; place ${collected.pickupLocation?.normalized ?? 'not given'}. Still needed: ${missing.join(', ') || 'nothing'}.`,
  ].join('\n');

  // Deposits are stated per car in the fleet lines, so the topic is answerable once any car has one.
  const known = new Set(configured.keys());
  if ([...models.values()].some((model) => model.deposit !== undefined))
    known.add(FaqTopic.DEPOSIT);
  return { text, knownTopics: known };
}
