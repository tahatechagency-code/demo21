import { checkDelivery, type MapsProvider } from '../concierge/locations.js';
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile } from '../concierge/profile.js';
import type { LocationPolicy } from './locationExtractionService.js';
import type { LocationCandidate } from './locationProvider.js';

function branchLabel(name: string): string {
  return name.split(' (')[0]!.split(',')[0]!.trim();
}

/**
 * The delivery rule applied to every pickup / drop-off the booking steps read — the same
 * `checkDelivery` the delivery questions use, so a place is judged the same way whether it comes in
 * one message with the dates, in a later turn, or as a correction. A place the gazetteer cannot
 * locate is not refused here (nothing can be measured); one that is further than the rule allows is.
 */
export class DeliveryRangePolicy implements LocationPolicy {
  constructor(
    private readonly profile: BusinessProfile = DEFAULT_BUSINESS_PROFILE,
    private readonly maps?: MapsProvider,
  ) {}

  async assess(candidate: LocationCandidate): Promise<{ allowed: true } | { allowed: false; message: string }> {
    for (const text of [candidate.raw, candidate.normalized]) {
      const decision = await checkDelivery({ message: text }, this.profile, this.maps);
      if (decision.kind === 'TOO_FAR') {
        const km = `${decision.from.estimated ? 'about ' : ''}${decision.from.roadKm} km`;
        return {
          allowed: false,
          message: `${decision.destination} is ${km} from our nearest branch (${branchLabel(decision.from.branch.name)}) and we deliver up to ${this.profile.delivery.maxRoadKm} km`,
        };
      }
      if (decision.kind !== 'NEEDS_PIN') return { allowed: true };
    }
    return { allowed: true };
  }
}
