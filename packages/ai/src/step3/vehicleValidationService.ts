import {
  VehicleDeterminationStatus,
  VehicleMatchType,
  vehicleDeterminationResultSchema,
  type Vehicle,
  type VehicleAmbiguity,
  type VehicleDeterminationResult,
  type VehicleMatchTypeValue,
  type VehicleValidationError,
} from '@ai-concierge/domain';
import type { VehicleCatalogLookup } from './vehicleCatalogService.js';
import type { VehicleIntentProposal } from './vehicleIntentService.js';

export interface VehicleValidationInput {
  proposal: VehicleIntentProposal;
  lookup: VehicleCatalogLookup;
  promptInjectionDetected: boolean;
}

/**
 * The deterministic verifier: `VehicleIntentService` only *proposes* a
 * match against the real fleet lexicon; this decides whether it's actually
 * resolvable (single, active, available candidate), needs clarification
 * (multiple candidates, or nothing mentioned at all), or is unsupported
 * (unknown / inactive / unavailable) — and assembles the one result the
 * rest of the system is allowed to trust, always re-validated against the
 * shared Zod schema before it leaves here. Alternatives are always real
 * catalog entries the caller supplied — never fabricated here.
 */
export class VehicleValidationService {
  validate(input: VehicleValidationInput): VehicleDeterminationResult {
    const { proposal, lookup } = input;
    const ambiguities: VehicleAmbiguity[] = [];
    const validationErrors: VehicleValidationError[] = [];
    let resolvedVehicle: Vehicle | null = null;
    let status: VehicleDeterminationResult['status'];
    let matchType: VehicleMatchTypeValue = VehicleMatchType.NONE;
    let worstSimilarity = 1;
    let alternatives: Vehicle[] = [];

    // One model offered in several colours ("Cullinan" in Black and White) is ONE choice of car, not
    // an ambiguity: the model is resolved now and the colour stays open until the customer names one.
    let candidates = proposal.candidates;
    if (
      candidates.length > 1 &&
      candidates.every(
        (candidate) =>
          candidate.make === candidates[0]!.make && candidate.model === candidates[0]!.model,
      ) &&
      (candidates[0]!.matchType === VehicleMatchType.EXACT_MODEL ||
        candidates[0]!.matchType === VehicleMatchType.FUZZY_MATCH ||
        candidates[0]!.matchType === VehicleMatchType.BRAND_ONLY)
    ) {
      const bookable = candidates.find((candidate) =>
        lookup.matchedVehicles.some(
          (vehicle) =>
            vehicle.id === candidate.lexiconEntryId &&
            vehicle.active &&
            vehicle.availabilityStatus === 'AVAILABLE',
        ),
      );
      candidates = [bookable ?? candidates[0]!];
    }

    if (candidates.length === 0) {
      if (proposal.rawMention) {
        validationErrors.push({
          field: 'vehicle',
          code: 'UNKNOWN_VEHICLE',
          message: `"${proposal.rawMention}" is not a vehicle we currently offer`,
          severity: 'ERROR',
        });
        status = VehicleDeterminationStatus.UNSUPPORTED;
      } else {
        ambiguities.push({
          field: 'vehicle',
          code: 'NO_VEHICLE_MENTIONED',
          message: 'No vehicle preference was mentioned',
        });
        status = VehicleDeterminationStatus.NEEDS_CLARIFICATION;
      }
      alternatives = lookup.fallbackAlternatives;
    } else {
      matchType = candidates[0]!.matchType;
      worstSimilarity = Math.min(...candidates.map((candidate) => candidate.similarity));

      if (candidates.length > 1) {
        const code =
          matchType === VehicleMatchType.BRAND_ONLY
            ? ('BRAND_ONLY_MULTIPLE_MATCHES' as const)
            : matchType === VehicleMatchType.CATEGORY_ONLY
              ? ('CATEGORY_ONLY_MULTIPLE_MATCHES' as const)
              : matchType === VehicleMatchType.COLOR_ONLY
                ? ('COLOR_ONLY_MULTIPLE_MATCHES' as const)
                : ('MULTIPLE_CANDIDATE_VEHICLES' as const);
        ambiguities.push({
          field: 'vehicle',
          code,
          message: describeChoices(lookup.matchedVehicles, candidates.length),
          raw: candidates[0]!.matchedText,
        });
        status = VehicleDeterminationStatus.NEEDS_CLARIFICATION;
        alternatives = lookup.matchedVehicles;
      } else {
        const candidate = candidates[0]!;
        const matched = lookup.matchedVehicles.find(
          (vehicle) => vehicle.id === candidate.lexiconEntryId,
        );
        if (!matched) {
          validationErrors.push({
            field: 'vehicle',
            code: 'UNKNOWN_VEHICLE',
            message: `"${candidate.matchedText}" is not a vehicle we currently offer`,
            severity: 'ERROR',
          });
          status = VehicleDeterminationStatus.UNSUPPORTED;
          alternatives = lookup.fallbackAlternatives;
        } else if (!matched.active) {
          validationErrors.push({
            field: 'vehicle',
            code: 'VEHICLE_INACTIVE',
            message: `${matched.make} ${matched.model} is not currently offered`,
            severity: 'ERROR',
          });
          status = VehicleDeterminationStatus.UNSUPPORTED;
          alternatives = lookup.fallbackAlternatives;
        } else if (matched.availabilityStatus !== 'AVAILABLE') {
          validationErrors.push({
            field: 'vehicle',
            code: 'VEHICLE_UNAVAILABLE',
            message: `${matched.make} ${matched.model} is currently ${matched.availabilityStatus.toLowerCase()}`,
            severity: 'ERROR',
          });
          status = VehicleDeterminationStatus.UNSUPPORTED;
          alternatives = lookup.fallbackAlternatives;
        } else {
          resolvedVehicle = matched;
          status = VehicleDeterminationStatus.RESOLVED;
          alternatives = [];
        }
      }
    }

    const errorCount = validationErrors.filter((issue) => issue.severity === 'ERROR').length;
    let confidence = 1;
    confidence -= ambiguities.length * 0.15;
    confidence -= errorCount * 0.2;
    if (matchType === VehicleMatchType.FUZZY_MATCH) {
      confidence -= Math.max(0, 1 - worstSimilarity);
    }
    if (
      matchType === VehicleMatchType.BRAND_ONLY ||
      matchType === VehicleMatchType.CATEGORY_ONLY ||
      matchType === VehicleMatchType.COLOR_ONLY
    ) {
      confidence -= 0.1;
    }
    if (!resolvedVehicle) confidence -= 0.1;
    confidence = Math.max(0, Math.min(1, confidence));

    const result: VehicleDeterminationResult = {
      status,
      resolvedVehicle,
      confidence: Number(confidence.toFixed(2)),
      ambiguities,
      validationErrors,
      alternatives,
      flags: { promptInjectionDetected: input.promptInjectionDetected },
      modelMetadata: { engine: 'vehicle-validation-v1', version: '0.1.0', deterministic: true },
    };

    return vehicleDeterminationResultSchema.parse(result);
  }
}

/** "BMW X5 in Black or White" — what the customer is choosing between, not a count. */
function describeChoices(
  vehicles: { make: string; model: string; color: string }[],
  candidateCount: number,
): string {
  const byName = new Map<string, string[]>();
  for (const vehicle of vehicles) {
    const name = `${vehicle.make} ${vehicle.model}`;
    byName.set(name, [...(byName.get(name) ?? []), vehicle.color]);
  }
  const options = [...byName.entries()]
    .slice(0, 5)
    .map(([name, colours]) => `${name} in ${colours.join(' or ')}`);
  return options.length > 0
    ? `choose one: ${options.join('; ')}`
    : `${candidateCount} vehicles matched; please choose one`;
}
