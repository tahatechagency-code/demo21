import { LocationType } from '@ai-concierge/domain';
import { UAE_PLACES } from '../concierge/locations.js';
import { DIAMONDLEASE_BRANCHES, EMIRATE_LABEL } from '../concierge/profile.js';
import type { GazetteerEntry } from './gazetteer.js';

/** Aliases too short or too common to be safe as a place on their own. */
const SKIP_ALIASES = new Set(['dip', 't1', 't2', 't3']);

const SERVICE_TIMEZONE = 'Asia/Dubai';

/**
 * Every UAE area and every confirmed branch the concierge's delivery check knows, as Step 2 gazetteer
 * entries — so a pickup at "Al Quoz", "Yas Island" or "Mussafah" is a place the booking steps can
 * resolve, not an "unrecognised location". Entries whose aliases are all already in `base` are skipped.
 */
export function extraGazetteerEntries(base: GazetteerEntry[]): GazetteerEntry[] {
  const known = new Set(base.flatMap((entry) => entry.aliases));
  const entries: GazetteerEntry[] = [];

  const add = (
    normalized: string,
    city: string,
    aliases: string[],
    locationType: GazetteerEntry['locationType'],
  ) => {
    const fresh = aliases
      .map((alias) => alias.toLowerCase())
      .filter((alias) => !known.has(alias) && !SKIP_ALIASES.has(alias));
    if (fresh.length === 0) return;
    for (const alias of fresh) known.add(alias);
    entries.push({
      aliases: fresh,
      normalized,
      city,
      country: 'AE',
      timezone: SERVICE_TIMEZONE,
      locationType,
    });
  };

  for (const branch of DIAMONDLEASE_BRANCHES) {
    if (!branch.confirmed) continue;
    add(
      branch.name.split(' (')[0]!.split(',')[0]!.trim(),
      EMIRATE_LABEL[branch.emirate],
      branch.aliases,
      branch.kind === 'AIRPORT' ? LocationType.AIRPORT : LocationType.CITY_AREA,
    );
  }
  for (const place of UAE_PLACES) {
    add(
      place.name,
      EMIRATE_LABEL[place.emirate],
      place.aliases,
      place.isAirport ? LocationType.AIRPORT : LocationType.CITY_AREA,
    );
  }
  return entries;
}

/** Place words (4+ letters) the earlier steps treat as "a location, not a car". */
export function extraLocationKeywords(): string[] {
  const words = new Set<string>();
  for (const branch of DIAMONDLEASE_BRANCHES) for (const alias of branch.aliases) words.add(alias.toLowerCase());
  for (const place of UAE_PLACES) for (const alias of place.aliases) words.add(alias.toLowerCase());
  return [...words].filter((word) => word.length >= 4 && !SKIP_ALIASES.has(word));
}
