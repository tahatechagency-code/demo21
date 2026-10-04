import {
  buildFleetKnowledge,
  convertPegged,
  FaqTopic,
  resolveBusinessProfile,
  type BusinessProfile,
  type FaqTopicValue,
  type FleetKnowledge,
  type PolicyContext,
} from '@ai-concierge/ai';
import {
  countHeldNowForAllVehicles,
  countUnitsForAllVehicles,
  findActiveEligibilityPolicy,
  listVehicles,
} from '@ai-concierge/db';
import type { Vehicle } from '@ai-concierge/domain';
import type { AppContext } from '../../context.js';

/**
 * STEP 0 of every message: everything the concierge is allowed to say, loaded first —
 *   A) the whole fleet (models, colours, seats, rates, units total/booked/available)
 *   B) the location database (branches)
 *   C) the delivery rule (100 km, fees)
 *   + the eligibility policy and the owner's configured business facts.
 * One bundle per message, so rules, Gemini and the replies all read the same facts.
 */
export interface Knowledge {
  profile: BusinessProfile;
  fleet: FleetKnowledge;
  /** Active domain vehicles by catalog row id (for pricing and the booking steps). */
  vehicles: Map<string, Vehicle>;
  policy: Pick<PolicyContext, 'minAgeByTier' | 'policyMinAge' | 'vatPercent' | 'configured' | 'defaultDeposit'>;
  /** Business topics that have a configured answer. */
  knownTopics: ReadonlySet<FaqTopicValue>;
}

export function parseBusinessFacts(raw: string | undefined): Map<FaqTopicValue, string> {
  const facts = new Map<FaqTopicValue, string>();
  if (!raw) return facts;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return facts;
    for (const topic of Object.values(FaqTopic)) {
      const value = (parsed as Record<string, unknown>)[topic];
      if (typeof value === 'string' && value.trim()) facts.set(topic, value.trim().slice(0, 400));
    }
  } catch {
    // A malformed setting must never break chat; the facts are simply "not provided".
  }
  return facts;
}

const CACHE_MS = 10_000;
let cached: { at: number; tenantId: string; value: Knowledge } | null = null;

/** Test hook: forget the short-lived cache. */
export function clearKnowledgeCache(): void {
  cached = null;
}

export async function loadKnowledge(ctx: AppContext): Promise<Knowledge> {
  const tenantId = ctx.config.DEFAULT_TENANT_ID;
  const now = Date.now();
  // Tests reseed the database between cases, so they always read fresh.
  if (ctx.config.NODE_ENV !== 'test' && cached && cached.tenantId === tenantId && now - cached.at < CACHE_MS) {
    return cached.value;
  }

  const profile = resolveBusinessProfile(ctx.config.BUSINESS_PROFILE_JSON, ctx.config.BUSINESS_NAME);
  const [vehicles, unitCounts, heldNow, policy] = await Promise.all([
    listVehicles(ctx.prisma, { tenantId, limit: 200, offset: 0 }),
    countUnitsForAllVehicles(ctx.prisma, tenantId),
    countHeldNowForAllVehicles(ctx.prisma, tenantId, new Date()),
    findActiveEligibilityPolicy(ctx.prisma, tenantId),
  ]);

  const fleet = buildFleetKnowledge(
    vehicles.map((vehicle) => {
      const units = unitCounts.get(vehicle.id);
      // Shown in the business currency whenever a fixed peg allows (USD -> AED); otherwise as stored.
      const from = vehicle.pricingProfile.currency;
      const shown = (amount: number | undefined): number | undefined => {
        if (amount === undefined) return undefined;
        return convertPegged(amount, from, profile.currency) ?? amount;
      };
      const currency = convertPegged(1, from, profile.currency) === null ? from : profile.currency;
      return {
        id: vehicle.id,
        make: vehicle.make,
        model: vehicle.model,
        color: vehicle.color,
        category: vehicle.category,
        luxuryTier: vehicle.luxuryTier,
        seats: vehicle.seats,
        luggage: vehicle.luggage,
        transmission: vehicle.transmission,
        dailyRate: shown(vehicle.pricingProfile.dailyRate) ?? vehicle.pricingProfile.dailyRate,
        weeklyRate: shown(vehicle.pricingProfile.weeklyRate),
        depositAmount: shown(vehicle.pricingProfile.depositAmount),
        currency,
        active: vehicle.active,
        availabilityStatus: vehicle.availabilityStatus,
        totalUnits: (units?.activeUnits ?? 0) + (units?.maintenanceUnits ?? 0),
        bookedUnits: heldNow.get(vehicle.id) ?? 0,
        maintenanceUnits: units?.maintenanceUnits ?? 0,
      };
    }),
    profile.currency,
  );

  const configured = parseBusinessFacts(ctx.config.BUSINESS_FACTS_JSON);
  const knownTopics = new Set<FaqTopicValue>(configured.keys());
  if (fleet.models.some((model) => model.deposit !== null)) knownTopics.add(FaqTopic.DEPOSIT);
  knownTopics.add(FaqTopic.CROSS_BORDER); // the owner's terms state it
  knownTopics.add(FaqTopic.LOCATION);

  const value: Knowledge = {
    profile,
    fleet,
    vehicles: new Map(vehicles.filter((v) => v.active).map((vehicle) => [vehicle.id, vehicle])),
    policy: {
      minAgeByTier: policy?.rules.minAgeByLuxuryTier ?? {},
      policyMinAge: policy?.rules.minAge ?? null,
      vatPercent: ctx.pricingRules.vatRatePercent,
      defaultDeposit: {
        amount: ctx.pricingRules.defaultDepositAmount().minorUnits / 100,
        currency: ctx.pricingRules.defaultDepositAmount().currency,
      },
      configured,
    },
    knownTopics,
  };
  cached = { at: now, tenantId, value };
  return value;
}
