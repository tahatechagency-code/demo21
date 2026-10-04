/**
 * The business the concierge speaks for, as plain data. Nothing here is a code path: the brand
 * name, the branches, the delivery rule and the rental terms are all values an owner can change
 * (the brand and extra facts come from the environment — see `resolveBusinessProfile`), so the
 * same engine serves any rental company.
 *
 * Every figure below comes from the owner's own published terms (website Terms + branch list). A
 * fact the owner has not supplied (insurance wording, mileage, opening hours, accepted card
 * brands, ...) is deliberately NOT in this file: the concierge says it is not sure and asks the
 * team instead of inventing it.
 */

export const Emirate = {
  DUBAI: 'DUBAI',
  ABU_DHABI: 'ABU_DHABI',
  SHARJAH: 'SHARJAH',
  AJMAN: 'AJMAN',
  UMM_AL_QUWAIN: 'UMM_AL_QUWAIN',
  RAS_AL_KHAIMAH: 'RAS_AL_KHAIMAH',
  FUJAIRAH: 'FUJAIRAH',
} as const;
export type EmirateValue = (typeof Emirate)[keyof typeof Emirate];

export const EMIRATE_LABEL: Record<EmirateValue, string> = {
  DUBAI: 'Dubai',
  ABU_DHABI: 'Abu Dhabi',
  SHARJAH: 'Sharjah',
  AJMAN: 'Ajman',
  UMM_AL_QUWAIN: 'Umm Al Quwain',
  RAS_AL_KHAIMAH: 'Ras Al Khaimah',
  FUJAIRAH: 'Fujairah',
};

export type BranchKind = 'HEAD_OFFICE' | 'BRANCH' | 'AIRPORT';

export interface Branch {
  id: string;
  /** What the customer is told. */
  name: string;
  kind: BranchKind;
  emirate: EmirateValue;
  lat: number;
  lng: number;
  /** Lowercase words a customer may use for this branch (matched on word boundaries). */
  aliases: string[];
  /**
   * False while the owner has not confirmed the branch is open. Unconfirmed branches are never
   * offered to a customer and never used to measure a delivery distance.
   */
  confirmed: boolean;
  /** Areas this branch also serves for a pick-up (a pickup there is a branch pickup, not a delivery). */
  alsoCovers?: string[];
}

export interface DeliveryRule {
  /** Delivery is possible only when the road distance from the NEAREST branch is at most this. */
  maxRoadKm: number;
  /** Great-circle distance is multiplied by this to estimate the road distance. */
  roadFactor: number;
  /** AED per delivery or collection, by the emirate the car goes to. */
  feeByEmirate: Record<EmirateValue, number>;
  /** Extra AED when the delivery/collection falls on a Friday or a public holiday. */
  fridayOrHolidaySurcharge: number;
  /** Extra AED when the car is handed back (off-hired) at an airport. */
  airportOffHireSurcharge: number;
  /** ISO dates (YYYY-MM-DD) that count as public holidays for the surcharge. */
  publicHolidays: string[];
}

export interface RentalTerms {
  minDriverAge: number;
  /** Licence wording shown to customers. */
  licenceRule: string;
  passportRequired: boolean;
  cashAccepted: boolean;
  /** The car may not leave the UAE. */
  uaeOnly: boolean;
  offRoadAllowed: boolean;
}

export interface BusinessProfile {
  brand: string;
  currency: string;
  /** Names of popular models, best first; used to rank suggestions. Matched loosely against the fleet. */
  popularModels: string[];
  branches: Branch[];
  delivery: DeliveryRule;
  terms: RentalTerms;
}

/** The owner's currently confirmed branch list. Coordinates are the branch's area centre (±1 km is irrelevant to a 100 km rule). */
export const DIAMONDLEASE_BRANCHES: Branch[] = [
  {
    id: 'dip-hq',
    name: 'Head Office & Operations Hub, Dubai Investments Park',
    kind: 'HEAD_OFFICE',
    emirate: Emirate.DUBAI,
    lat: 24.9857,
    lng: 55.1637,
    aliases: ['dubai investments park', 'dip', 'head office', 'investment park'],
    confirmed: true,
  },
  {
    id: 'al-quoz',
    name: 'Al Quoz (Sheikh Zayed Road showroom)',
    kind: 'BRANCH',
    emirate: Emirate.DUBAI,
    lat: 25.1415,
    lng: 55.227,
    aliases: ['al quoz', 'alquoz', 'sheikh zayed road', 'szr', 'al habtoor motors'],
    confirmed: true,
  },
  {
    id: 'jebel-ali',
    name: 'Jebel Ali (The Galleries, Downtown Jebel Ali)',
    kind: 'BRANCH',
    emirate: Emirate.DUBAI,
    lat: 25.005,
    lng: 55.076,
    aliases: ['jebel ali', 'downtown jebel ali', 'the galleries'],
    confirmed: true,
  },
  {
    id: 'umm-al-rumool',
    name: 'Umm Al Rumool (covers Rashidiya, Ras Al Khor and Dubai Commerce City)',
    kind: 'BRANCH',
    emirate: Emirate.DUBAI,
    lat: 25.207,
    lng: 55.383,
    aliases: ['umm al rumool', 'umm ramool', 'umm al ramool', 'rashidiya', 'ras al khor', 'dubai commerce city'],
    confirmed: true,
    alsoCovers: ['rashidiya', 'ras al khor', 'dubai commerce city'],
  },
  {
    id: 'dxb-t1',
    name: 'Dubai Airport Terminal 1',
    kind: 'AIRPORT',
    emirate: Emirate.DUBAI,
    lat: 25.2532,
    lng: 55.3657,
    aliases: ['dubai airport', 'dxb', 'dxb airport', 'dubai international airport', 'airport terminal 1', 'terminal 1', 't1'],
    confirmed: true,
  },
  {
    id: 'mussafah',
    name: 'Mussafah, Abu Dhabi (Industrial Area, near Mussafah Police Station)',
    kind: 'BRANCH',
    emirate: Emirate.ABU_DHABI,
    lat: 24.347,
    lng: 54.49,
    aliases: ['mussafah', 'musaffah', 'mussafa'],
    confirmed: true,
  },
  {
    id: 'sharjah',
    name: 'Sharjah',
    kind: 'BRANCH',
    emirate: Emirate.SHARJAH,
    lat: 25.3463,
    lng: 55.4209,
    aliases: ['sharjah'],
    confirmed: true,
  },
  {
    id: 'rak',
    name: 'Ras Al Khaimah',
    kind: 'BRANCH',
    emirate: Emirate.RAS_AL_KHAIMAH,
    lat: 25.7895,
    lng: 55.9432,
    aliases: ['ras al khaimah', 'rak', 'ras al khaima'],
    confirmed: true,
  },
  {
    id: 'fujairah',
    name: 'Fujairah',
    kind: 'BRANCH',
    emirate: Emirate.FUJAIRAH,
    lat: 25.1288,
    lng: 56.3265,
    aliases: ['fujairah', 'fujeirah'],
    confirmed: true,
  },
  // Listed on older sources; NOT offered until the owner confirms they are open.
  {
    id: 'habtoor-grand',
    name: 'Habtoor Grand Hotel',
    kind: 'BRANCH',
    emirate: Emirate.DUBAI,
    lat: 25.0802,
    lng: 55.1329,
    aliases: ['habtoor grand'],
    confirmed: false,
  },
  {
    id: 'knowledge-village',
    name: 'Knowledge Village',
    kind: 'BRANCH',
    emirate: Emirate.DUBAI,
    lat: 25.1013,
    lng: 55.1629,
    aliases: ['knowledge village'],
    confirmed: false,
  },
  {
    id: 'jafza',
    name: 'Jebel Ali Free Zone (JAFZA)',
    kind: 'BRANCH',
    emirate: Emirate.DUBAI,
    lat: 25.0,
    lng: 55.0602,
    aliases: ['jafza', 'jebel ali free zone'],
    confirmed: false,
  },
  {
    id: 'abu-dhabi-airport',
    name: 'Abu Dhabi Airport',
    kind: 'AIRPORT',
    emirate: Emirate.ABU_DHABI,
    lat: 24.433,
    lng: 54.6511,
    aliases: ['abu dhabi airport', 'auh'],
    confirmed: false,
  },
];

export const DIAMONDLEASE_DELIVERY: DeliveryRule = {
  maxRoadKm: 100,
  roadFactor: 1.35,
  feeByEmirate: {
    DUBAI: 100,
    SHARJAH: 150,
    AJMAN: 150,
    ABU_DHABI: 250,
    UMM_AL_QUWAIN: 250,
    RAS_AL_KHAIMAH: 250,
    FUJAIRAH: 250,
  },
  fridayOrHolidaySurcharge: 100,
  airportOffHireSurcharge: 50,
  // Fixed-date UAE holidays only. Islamic holidays move with the moon and are added by the owner
  // through BUSINESS_PROFILE_JSON once announced.
  publicHolidays: ['2026-12-02', '2026-12-03', '2027-01-01', '2027-12-02', '2027-12-03', '2028-01-01'],
};

export const DIAMONDLEASE_TERMS: RentalTerms = {
  minDriverAge: 23,
  licenceRule: 'a valid UAE driving licence, or an international driving permit (IDP) together with your home-country licence',
  passportRequired: true,
  cashAccepted: false,
  uaeOnly: true,
  offRoadAllowed: false,
};

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  brand: 'Diamondlease',
  currency: 'AED',
  popularModels: [
    'Lamborghini Urus',
    'Range Rover',
    'Mercedes-Benz G63 AMG',
    'Rolls-Royce Cullinan',
    'Ferrari Roma',
    'Porsche 911',
    'Bentley Bentayga',
    'BMW X5',
  ],
  branches: DIAMONDLEASE_BRANCHES,
  delivery: DIAMONDLEASE_DELIVERY,
  terms: DIAMONDLEASE_TERMS,
};

interface ProfileOverrides {
  brand?: unknown;
  currency?: unknown;
  popularModels?: unknown;
  publicHolidays?: unknown;
  confirmBranches?: unknown;
  extraBranches?: unknown;
  minDriverAge?: unknown;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * The default profile with the owner's overrides applied. A malformed override is ignored rather
 * than breaking chat. `raw` is the BUSINESS_PROFILE_JSON setting; `brand` is BUSINESS_NAME.
 */
export function resolveBusinessProfile(raw?: string, brand?: string): BusinessProfile {
  const profile: BusinessProfile = {
    ...DEFAULT_BUSINESS_PROFILE,
    branches: DEFAULT_BUSINESS_PROFILE.branches.map((branch) => ({ ...branch })),
    delivery: { ...DEFAULT_BUSINESS_PROFILE.delivery },
    terms: { ...DEFAULT_BUSINESS_PROFILE.terms },
  };
  if (brand && brand.trim()) profile.brand = brand.trim().slice(0, 60);
  if (!raw) return profile;
  let parsed: ProfileOverrides;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return profile;
    parsed = value as ProfileOverrides;
  } catch {
    return profile;
  }
  if (typeof parsed.brand === 'string' && parsed.brand.trim() && !brand) {
    profile.brand = parsed.brand.trim().slice(0, 60);
  }
  if (typeof parsed.currency === 'string' && /^[A-Z]{3}$/.test(parsed.currency)) {
    profile.currency = parsed.currency;
  }
  if (isStringArray(parsed.popularModels)) profile.popularModels = parsed.popularModels.slice(0, 20);
  if (isStringArray(parsed.publicHolidays)) {
    profile.delivery.publicHolidays = [
      ...profile.delivery.publicHolidays,
      ...parsed.publicHolidays.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)),
    ];
  }
  if (isStringArray(parsed.confirmBranches)) {
    const confirmed = new Set(parsed.confirmBranches);
    for (const branch of profile.branches) if (confirmed.has(branch.id)) branch.confirmed = true;
  }
  if (typeof parsed.minDriverAge === 'number' && parsed.minDriverAge >= 18 && parsed.minDriverAge <= 40) {
    profile.terms.minDriverAge = Math.round(parsed.minDriverAge);
  }
  if (Array.isArray(parsed.extraBranches)) {
    for (const entry of parsed.extraBranches.slice(0, 20)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const branch = entry as Partial<Branch>;
      const emirates = Object.values(Emirate) as string[];
      if (
        typeof branch.id === 'string' &&
        typeof branch.name === 'string' &&
        typeof branch.lat === 'number' &&
        typeof branch.lng === 'number' &&
        typeof branch.emirate === 'string' &&
        emirates.includes(branch.emirate) &&
        isStringArray(branch.aliases)
      ) {
        profile.branches.push({
          id: branch.id,
          name: branch.name,
          kind: branch.kind === 'AIRPORT' || branch.kind === 'HEAD_OFFICE' ? branch.kind : 'BRANCH',
          emirate: branch.emirate as EmirateValue,
          lat: branch.lat,
          lng: branch.lng,
          aliases: branch.aliases.map((alias) => alias.toLowerCase()),
          confirmed: branch.confirmed !== false,
        });
      }
    }
  }
  return profile;
}
