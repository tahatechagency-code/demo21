import {
  EMIRATE_LABEL,
  Emirate,
  type Branch,
  type BusinessProfile,
  type EmirateValue,
} from './profile.js';

/**
 * Location database + the delivery sub-flow, as pure functions:
 *
 *   customer location  ->  branch pickup?  ->  else measure the distance from the NEAREST
 *   confirmed branch  ->  <= max km: delivery possible + fee   |   > max km: not possible + options
 *
 * A place is located from a built-in UAE gazetteer (area centres) or, when it is unknown, from an
 * injected `MapsProvider` (geocoding). Nothing here guesses: an unlocatable place is reported as
 * UNKNOWN so the caller can ask for a pin instead of promising anything.
 */

export interface GeoPlace {
  /** Display name. */
  name: string;
  lat: number;
  lng: number;
  emirate: EmirateValue;
  isAirport?: boolean;
}

interface GazetteerRow extends GeoPlace {
  aliases: string[];
}

const place = (
  name: string,
  emirate: EmirateValue,
  lat: number,
  lng: number,
  aliases: string[],
  isAirport = false,
): GazetteerRow => ({ name, emirate, lat, lng, aliases, ...(isAirport ? { isAirport } : {}) });

const { DUBAI, ABU_DHABI, SHARJAH, AJMAN, UMM_AL_QUWAIN, RAS_AL_KHAIMAH, FUJAIRAH } = Emirate;

/** Area centres. Order does not matter: the longest matching alias wins. */
export const UAE_PLACES: GazetteerRow[] = [
  // Dubai
  place('Dubai Marina', DUBAI, 25.0805, 55.1403, ['dubai marina', 'marina']),
  place('JBR', DUBAI, 25.078, 55.133, ['jbr', 'jumeirah beach residence', 'the walk']),
  place('Palm Jumeirah', DUBAI, 25.1124, 55.139, ['palm jumeirah']),
  place('Atlantis The Palm', DUBAI, 25.1304, 55.1171, ['atlantis']),
  place('Downtown Dubai', DUBAI, 25.1972, 55.2744, ['downtown dubai', 'downtown', 'burj khalifa', 'dubai mall']),
  place('Business Bay', DUBAI, 25.185, 55.265, ['business bay']),
  place('Deira', DUBAI, 25.2697, 55.3095, ['deira']),
  place('Bur Dubai', DUBAI, 25.2532, 55.2965, ['bur dubai', 'burdubai']),
  place('Jumeirah', DUBAI, 25.2048, 55.24, ['jumeirah', 'jumeira']),
  place('Burj Al Arab', DUBAI, 25.1412, 55.1853, ['burj al arab']),
  place('Madinat Jumeirah', DUBAI, 25.1337, 55.1853, ['madinat jumeirah']),
  place('Jumeirah Lake Towers', DUBAI, 25.069, 55.145, ['jlt', 'jumeirah lake towers', 'jumeirah lakes towers']),
  place('Dubai Media City', DUBAI, 25.0925, 55.1537, ['media city', 'dubai media city', 'internet city']),
  place('Al Barsha', DUBAI, 25.113, 55.2, ['al barsha', 'barsha']),
  place('Dubai Hills', DUBAI, 25.112, 55.245, ['dubai hills']),
  place('Arabian Ranches', DUBAI, 25.0526, 55.2676, ['arabian ranches']),
  place('Dubai Sports City', DUBAI, 25.0395, 55.2194, ['sports city', 'motor city']),
  place('Dubai Silicon Oasis', DUBAI, 25.119, 55.38, ['silicon oasis', 'dso']),
  place('Mirdif', DUBAI, 25.221, 55.421, ['mirdif', 'mirdiff']),
  place('Dubai Creek Harbour', DUBAI, 25.2, 55.345, ['creek harbour', 'dubai creek']),
  place('Al Nahda (Dubai)', DUBAI, 25.2896, 55.3727, ['al nahda dubai']),
  place('Al Qusais', DUBAI, 25.2858, 55.3774, ['al qusais', 'qusais']),
  place('Festival City', DUBAI, 25.2227, 55.3535, ['festival city']),
  place('Dubai South', DUBAI, 24.9, 55.1614, ['dubai south', 'expo city', 'expo 2020']),
  place('Al Maktoum International Airport (DWC)', DUBAI, 24.896, 55.1614, ['dwc', 'al maktoum airport', 'dwc airport', 'al maktoum international airport'], true),
  place('Dubai Airport Terminal 3', DUBAI, 25.2425, 55.3585, ['terminal 3', 't3']),
  place('Dubai Airport Terminal 2', DUBAI, 25.2634, 55.3544, ['terminal 2', 't2']),
  place('Hatta', DUBAI, 24.8, 56.11, ['hatta']),
  place('Al Awir', DUBAI, 25.1789, 55.5, ['al awir']),
  place('Meydan', DUBAI, 25.1553, 55.3085, ['meydan']),
  place('City Walk', DUBAI, 25.2075, 55.2615, ['city walk']),
  place('DIFC', DUBAI, 25.2138, 55.2796, ['difc']),
  // Sharjah / Ajman / UAQ
  place('Sharjah City', SHARJAH, 25.3463, 55.4209, ['sharjah city', 'al majaz', 'al khan', 'al nahda sharjah', 'sharjah corniche']),
  place('Sharjah Airport', SHARJAH, 25.3286, 55.5172, ['sharjah airport', 'shj', 'shj airport'], true),
  place('University City Sharjah', SHARJAH, 25.2864, 55.4743, ['university city']),
  place('Khor Fakkan', SHARJAH, 25.3404, 56.3552, ['khor fakkan', 'khorfakkan']),
  place('Kalba', SHARJAH, 25.0422, 56.3566, ['kalba']),
  place('Ajman', AJMAN, 25.4052, 55.5136, ['ajman']),
  place('Umm Al Quwain', UMM_AL_QUWAIN, 25.565, 55.555, ['umm al quwain', 'uaq']),
  // Abu Dhabi
  place('Abu Dhabi City', ABU_DHABI, 24.4539, 54.3773, ['abu dhabi', 'abudhabi', 'abu dhabi city', 'corniche abu dhabi', 'al reem', 'reem island']),
  place('Yas Island', ABU_DHABI, 24.4672, 54.6031, ['yas island', 'yas']),
  place('Saadiyat Island', ABU_DHABI, 24.545, 54.433, ['saadiyat']),
  place('Abu Dhabi International Airport', ABU_DHABI, 24.433, 54.6511, ['abu dhabi airport', 'auh', 'auh airport'], true),
  place('Khalifa City', ABU_DHABI, 24.4175, 54.5772, ['khalifa city']),
  place('Al Ain', ABU_DHABI, 24.2075, 55.7447, ['al ain']),
  place('Ghantoot', ABU_DHABI, 24.9744, 54.9, ['ghantoot']),
  place('Ruwais', ABU_DHABI, 24.1103, 52.7306, ['ruwais']),
  place('Liwa', ABU_DHABI, 23.1333, 53.7667, ['liwa']),
  // Ras Al Khaimah / Fujairah
  place('Ras Al Khaimah City', RAS_AL_KHAIMAH, 25.7895, 55.9432, ['ras al khaimah', 'rak city', 'al hamra', 'al marjan']),
  place('Ras Al Khaimah Airport', RAS_AL_KHAIMAH, 25.6135, 55.9388, ['rak airport'], true),
  place('Fujairah City', FUJAIRAH, 25.1288, 56.3265, ['fujairah city', 'fujairah']),
  place('Fujairah Airport', FUJAIRAH, 25.1122, 56.324, ['fujairah airport'], true),
  place('Dibba', FUJAIRAH, 25.5917, 56.2606, ['dibba']),
];

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `alias` appears in `text` as whole words. */
function mentions(text: string, alias: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escape(alias)}(?:$|[^a-z0-9])`, 'i').test(text);
}

function lower(text: string): string {
  return text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ');
}

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export type LocationMatch =
  | { kind: 'BRANCH'; branch: Branch }
  | { kind: 'PLACE'; place: GeoPlace }
  | { kind: 'UNKNOWN' };

/**
 * Looks for a branch or a known place in free text. A branch (or an area a branch covers) wins
 * over a place; within each group the longest alias wins, so "Dubai Airport Terminal 1" is the
 * airport branch and not "Dubai".
 */
export function matchLocation(message: string, profile: BusinessProfile): LocationMatch {
  const text = lower(message);
  let best: { branch: Branch; length: number } | null = null;
  for (const branch of profile.branches) {
    if (!branch.confirmed) continue;
    for (const alias of branch.aliases) {
      if (mentions(text, alias) && (!best || alias.length > best.length)) {
        best = { branch, length: alias.length };
      }
    }
  }
  let bestPlace: { row: GazetteerRow; length: number } | null = null;
  for (const row of UAE_PLACES) {
    for (const alias of row.aliases) {
      if (mentions(text, alias) && (!bestPlace || alias.length > bestPlace.length)) {
        bestPlace = { row, length: alias.length };
      }
    }
  }
  // "Sharjah airport" names a place more specifically than the Sharjah branch does.
  if (best && bestPlace && bestPlace.length > best.length) {
    return { kind: 'PLACE', place: toPlace(bestPlace.row) };
  }
  if (best) return { kind: 'BRANCH', branch: best.branch };
  if (bestPlace) return { kind: 'PLACE', place: toPlace(bestPlace.row) };
  return { kind: 'UNKNOWN' };
}

function toPlace(row: GazetteerRow): GeoPlace {
  return {
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    emirate: row.emirate,
    ...(row.isAirport ? { isAirport: true } : {}),
  };
}

/** Optional geocoder (Google Maps) for places the built-in gazetteer does not know. */
export interface MapsProvider {
  readonly name: string;
  /** Locates a free-text place inside the UAE, or null when it cannot. */
  geocode(query: string): Promise<GeoPlace | null>;
  /** Real driving distance in km between two points, or null when it cannot be measured. */
  drivingKm(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<number | null>;
}

export interface NearestBranch {
  branch: Branch;
  roadKm: number;
  /** True when the figure is a great-circle estimate x road factor rather than a measured route. */
  estimated: boolean;
}

/** The confirmed branch closest to a point, with the road distance to it. */
export async function nearestBranch(
  point: { lat: number; lng: number },
  profile: BusinessProfile,
  maps?: MapsProvider,
): Promise<NearestBranch | null> {
  const ranked = profile.branches
    .filter((branch) => branch.confirmed)
    .map((branch) => ({
      branch,
      straightKm: haversineKm(point.lat, point.lng, branch.lat, branch.lng),
    }))
    .sort((a, b) => a.straightKm - b.straightKm);
  const first = ranked[0];
  if (!first) return null;

  if (maps) {
    // Measure the closest few by real roads and keep the shortest; fall back to the estimate.
    const measured: NearestBranch[] = [];
    for (const candidate of ranked.slice(0, 3)) {
      const km = await maps
        .drivingKm({ lat: candidate.branch.lat, lng: candidate.branch.lng }, point)
        .catch(() => null);
      if (km !== null && Number.isFinite(km)) {
        measured.push({ branch: candidate.branch, roadKm: Math.round(km), estimated: false });
      }
    }
    if (measured.length > 0) return measured.sort((a, b) => a.roadKm - b.roadKm)[0]!;
  }
  return {
    branch: first.branch,
    roadKm: Math.max(1, Math.round(first.straightKm * profile.delivery.roadFactor)),
    estimated: true,
  };
}

export interface DeliveryFee {
  base: number;
  surcharges: { label: string; amount: number }[];
  total: number;
}

const DUBAI_TZ = 'Asia/Dubai';

/** Friday (in Dubai) or a configured public holiday. `iso` is any ISO timestamp or date. */
export function isFridayOrHoliday(iso: string | null, profile: BusinessProfile): boolean {
  if (!iso) return false;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DUBAI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(when);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return get('weekday') === 'Fri' || profile.delivery.publicHolidays.includes(day);
}

export function deliveryFee(
  emirate: EmirateValue,
  profile: BusinessProfile,
  options: { whenIso?: string | null; airportOffHire?: boolean } = {},
): DeliveryFee {
  const base = profile.delivery.feeByEmirate[emirate];
  const surcharges: DeliveryFee['surcharges'] = [];
  if (isFridayOrHoliday(options.whenIso ?? null, profile)) {
    surcharges.push({
      label: 'Friday / public holiday',
      amount: profile.delivery.fridayOrHolidaySurcharge,
    });
  }
  if (options.airportOffHire) {
    surcharges.push({
      label: 'airport off-hire',
      amount: profile.delivery.airportOffHireSurcharge,
    });
  }
  return { base, surcharges, total: base + surcharges.reduce((sum, item) => sum + item.amount, 0) };
}

export type DeliveryDecision =
  | { kind: 'BRANCH_PICKUP'; branch: Branch }
  | {
      kind: 'DELIVERY_POSSIBLE';
      destination: string;
      emirate: EmirateValue;
      from: NearestBranch;
      fee: DeliveryFee;
    }
  | { kind: 'TOO_FAR'; destination: string; from: NearestBranch }
  | { kind: 'NEEDS_PIN' };

export interface DeliveryCheckInput {
  message: string;
  /** ISO timestamp of the intended delivery (for the Friday/holiday surcharge), if known. */
  whenIso?: string | null;
  /** The customer wants the car left at an airport at the end (off-hire surcharge). */
  airportOffHire?: boolean;
}

/**
 * The whole delivery sub-flow for one location mention. Never promises delivery without a
 * distance: an unlocatable place is `NEEDS_PIN` (ask the customer for the area or a map pin).
 */
export async function checkDelivery(
  input: DeliveryCheckInput,
  profile: BusinessProfile,
  maps?: MapsProvider,
): Promise<DeliveryDecision> {
  const match = matchLocation(input.message, profile);
  if (match.kind === 'BRANCH') return { kind: 'BRANCH_PICKUP', branch: match.branch };

  let target: GeoPlace | null = match.kind === 'PLACE' ? match.place : null;
  if (!target && maps) {
    target = await maps.geocode(input.message).catch(() => null);
  }
  if (!target) return { kind: 'NEEDS_PIN' };

  const from = await nearestBranch(target, profile, maps);
  if (!from) return { kind: 'NEEDS_PIN' };

  if (from.roadKm > profile.delivery.maxRoadKm) {
    return { kind: 'TOO_FAR', destination: target.name, from };
  }
  return {
    kind: 'DELIVERY_POSSIBLE',
    destination: target.name,
    emirate: target.emirate,
    from,
    fee: deliveryFee(target.emirate, profile, {
      whenIso: input.whenIso ?? null,
      airportOffHire: input.airportOffHire === true && target.isAirport === true,
    }),
  };
}

/** Confirmed branches, as customer-facing names. */
export function branchNames(profile: BusinessProfile): string[] {
  return profile.branches.filter((branch) => branch.confirmed).map((branch) => branch.name);
}

export function emirateLabel(emirate: EmirateValue): string {
  return EMIRATE_LABEL[emirate];
}

/** "AED 100" / "AED 200 (AED 100 + AED 100 Friday / public holiday)". */
export function describeFee(fee: DeliveryFee, currency: string): string {
  if (fee.surcharges.length === 0) return `${currency} ${fee.total}`;
  const parts = [
    `${currency} ${fee.base}`,
    ...fee.surcharges.map((item) => `${currency} ${item.amount} ${item.label}`),
  ];
  return `${currency} ${fee.total} (${parts.join(' + ')})`;
}
