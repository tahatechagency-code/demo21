import { levenshteinDistance } from '../step3/levenshtein.js';
import type { BusinessProfile } from './profile.js';

/**
 * Step 0 of every message: the whole fleet, held in memory and searched BEFORE anything else.
 * Pure data + pure functions — the API layer fills `FleetRowInput` from the database (vehicles,
 * physical units, live holds); nothing here reads a database or calls a model.
 *
 * Rules this file enforces (the owner's "fleet first" rules):
 *   - a car the customer names is found in the fleet or it is NOT in the fleet — it is never
 *     silently replaced by a different car;
 *   - a car outside the fleet is recognised as such ("Thar", "Bugatti", "Toyota Camry") so the
 *     caller can say so plainly and offer real alternatives;
 *   - colours, seats, rates and units come from the rows, never from this file.
 */

export interface FleetRowInput {
  id: string;
  make: string;
  model: string;
  color: string;
  category: string;
  luxuryTier: string;
  seats: number;
  luggage: number;
  transmission: string;
  dailyRate: number;
  weeklyRate?: number | undefined;
  depositAmount?: number | undefined;
  currency: string;
  active: boolean;
  availabilityStatus: string;
  totalUnits: number;
  bookedUnits: number;
  maintenanceUnits: number;
}

export interface FleetColourRow {
  id: string;
  colour: string;
  dailyRate: number;
  totalUnits: number;
  bookedUnits: number;
  availableUnits: number;
}

export interface FleetModel {
  key: string;
  make: string;
  model: string;
  /** "Rolls-Royce Cullinan" */
  name: string;
  category: string;
  luxuryTier: string;
  seats: number;
  luggage: number;
  transmission: string;
  currency: string;
  /** Cheapest colour's daily rate. */
  dailyRate: number;
  weeklyRate: number | null;
  deposit: number | null;
  colours: string[];
  rows: FleetColourRow[];
  totalUnits: number;
  bookedUnits: number;
  availableUnits: number;
}

export interface FleetKnowledge {
  models: FleetModel[];
  currency: string;
}

const norm = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Groups the per-colour rows into models with live unit counts. Inactive rows are not in the fleet. */
export function buildFleetKnowledge(rows: FleetRowInput[], currency: string): FleetKnowledge {
  const byKey = new Map<string, FleetModel>();
  for (const row of rows) {
    if (!row.active) continue;
    const key = `${norm(row.make)}|${norm(row.model)}`;
    const sellable = row.availabilityStatus === 'AVAILABLE';
    const total = Math.max(0, row.totalUnits);
    const available = sellable
      ? Math.max(0, total - Math.max(0, row.maintenanceUnits) - Math.max(0, row.bookedUnits))
      : 0;
    const colourRow: FleetColourRow = {
      id: row.id,
      colour: row.color,
      dailyRate: row.dailyRate,
      totalUnits: total,
      bookedUnits: Math.max(0, row.bookedUnits),
      availableUnits: available,
    };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        make: row.make,
        model: row.model,
        name: `${row.make} ${row.model}`,
        category: row.category,
        luxuryTier: row.luxuryTier,
        seats: row.seats,
        luggage: row.luggage,
        transmission: row.transmission,
        currency: row.currency,
        dailyRate: row.dailyRate,
        weeklyRate: row.weeklyRate ?? null,
        deposit: row.depositAmount ?? null,
        colours: [row.color],
        rows: [colourRow],
        totalUnits: total,
        bookedUnits: colourRow.bookedUnits,
        availableUnits: available,
      });
      continue;
    }
    existing.colours.push(row.color);
    existing.rows.push(colourRow);
    existing.totalUnits += total;
    existing.bookedUnits += colourRow.bookedUnits;
    existing.availableUnits += available;
    existing.dailyRate = Math.min(existing.dailyRate, row.dailyRate);
  }
  const models = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Same wording every time: colours (and their rows) in alphabetical order, whatever order the database returned.
  for (const model of models) {
    model.rows.sort((a, b) => a.colour.localeCompare(b.colour));
    model.colours = model.rows.map((row) => row.colour);
  }
  return { models, currency };
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

/** Spellings customers use for a make. Keys are normalised; the value is matched against fleet makes. */
const MAKE_SYNONYMS: Record<string, string[]> = {
  'mercedes benz': ['mercedes', 'mercedez', 'merc', 'benz', 'mercedes benz'],
  'rolls royce': ['rolls royce', 'rolls', 'rollsroyce', 'rolls-royce'],
  lamborghini: ['lambo', 'lamborghini'],
  'land rover': ['land rover', 'landrover'],
  chevrolet: ['chevy', 'chevrolet'],
  porsche: ['porsche'],
  ferrari: ['ferrari'],
  'aston martin': ['aston', 'aston martin'],
  bentley: ['bentley'],
  mclaren: ['mc laren', 'mclaren'],
  volkswagen: ['vw', 'volkswagen'],
};

/** Common misspellings of a make. Used only to *recognise* a make, never to rewrite the customer's text. */
const MAKE_TYPOS: Record<string, string[]> = {
  lamborghini: ['lamborgini', 'lamborghni', 'lamborgnini', 'lamborghinni'],
  porsche: ['porche', 'porshe', 'porsha'],
  ferrari: ['ferari', 'ferarri', 'ferrai'],
  bentley: ['bently', 'bentlie'],
  mclaren: ['maclaren', 'mclarin'],
  'rolls royce': ['rols royce', 'rolls roys'],
  'mercedes benz': ['mercedez', 'mercedes', 'mercdes'],
  maserati: ['maserai', 'masarati', 'maseratti'],
};

/** Model nicknames: [spoken form, fleet model it means]. Only used when the fleet really has that model. */
const MODEL_SYNONYMS: [string, string][] = [
  ['g wagon', 'g63 amg'],
  ['g wagen', 'g63 amg'],
  ['gwagon', 'g63 amg'],
  ['gwagen', 'g63 amg'],
  ['g class', 'g63 amg'],
  ['g63', 'g63 amg'],
  ['g 63', 'g63 amg'],
  ['s class', 's class'],
  ['sclass', 's class'],
  ['s500', 's class'],
  ['s580', 's class'],
  ['s 500', 's class'],
  ['landcruiser', 'land cruiser'],
  ['lc300', 'land cruiser'],
  ['lc 300', 'land cruiser'],
  ['rangerover', 'range rover'],
  ['rr sport', 'range rover sport'],
  ['carrera', '911'],
  ['nine eleven', '911'],
  ['conti', 'continental gt'],
  ['continental', 'continental gt'],
  ['cullinane', 'cullinan'],
  ['culinan', 'cullinan'],
  ['bentayga', 'bentayga'],
  ['720', '720s'],
  ['rsq8', 'rs q8'],
  ['rs q8', 'rs q8'],
  ['m 5', 'm5'],
  ['x 5', 'x5'],
  ['x 7', 'x7'],
  ['spider', '488 spider'],
  ['488', '488 spider'],
  ['model x', 'model x'],
];

const GENERIC_WORDS = new Set([
  'car', 'cars', 'vehicle', 'vehicles', 'rental', 'rent', 'hire', 'book', 'booking', 'want', 'need',
  'looking', 'like', 'have', 'got', 'any', 'available', 'availability', 'price', 'cost', 'rate',
  'rates', 'how', 'much', 'what', 'which', 'the', 'and', 'for', 'with', 'from', 'your', 'you',
  'pls', 'please', 'show', 'tell', 'about', 'details', 'detail', 'info', 'photo', 'photos', 'pic',
  'pics', 'one', 'new', 'good', 'best', 'nice', 'cheap', 'cheapest', 'colour', 'colours', 'color',
  'colors', 'seats', 'seat', 'seater', 'day', 'days', 'week', 'weeks', 'month', 'months', 'night',
  'nights', 'today', 'tomorrow', 'tonight', 'also', 'too', 'some', 'other', 'another', 'different',
  'else', 'more', 'same', 'its', 'in', 'on', 'at', 'to', 'of', 'is', 'are', 'do', 'does', 'can',
  'could', 'would', 'will', 'me', 'my', 'we', 'us', 'our', 'it', 'this', 'that', 'there', 'here',
  'dubai', 'uae', 'abu', 'dhabi', 'sharjah', 'airport', 'hotel', 'pickup', 'return', 'delivery',
  'aed', 'dirham', 'dirhams', 'am', 'pm', 'km', 'hi', 'hello', 'hey', 'thanks', 'thank', 'yes', 'no',
  'ok', 'okay', 'sir', 'madam', 'bro', 'brother', 'bhai', 'kya', 'hai', 'hain', 'ka', 'ki', 'ke',
  'ko', 'mujhe', 'chahiye', 'chahie', 'aap', 'ap', 'mera', 'meri', 'mere', 'kal', 'aaj', 'se', 'tak',
  'liye', 'wala', 'wali', 'black', 'white', 'red', 'blue', 'green', 'grey', 'gray', 'silver',
  'yellow', 'orange', 'beige', 'brown', 'gold', 'pink', 'purple', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan',
  'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'next', 'last', 'this', 'weekend',
  'morning', 'evening', 'afternoon', 'night', 'a', 'an', 'i', 'im', 'ill', 'if', 'or', 'but', 'so',
  'sport', 'sports', 'class', 'series', 'model', 'grand', 'luxury', 'family', 'wedding', 'compare',
  'comparison', 'versus', 'vs', 'between', 'both', 'all', 'only', 'just', 'tell', 'colours', 'seater',
  'passengers', 'people', 'persons', 'person', 'budget', 'under', 'below', 'above', 'over', 'around',
]);

/**
 * Cars and makes that exist in the world but that a given fleet may not carry. Used ONLY to
 * recognise "the customer asked for a car we do not have" — never as a source of fleet data.
 */
const WORLD_MAKES = [
  'toyota', 'honda', 'hyundai', 'kia', 'nissan', 'ford', 'chevrolet', 'mahindra', 'tata', 'bugatti',
  'koenigsegg', 'pagani', 'lexus', 'mazda', 'jeep', 'dodge', 'cadillac', 'gmc', 'infiniti',
  'volkswagen', 'skoda', 'suzuki', 'mitsubishi', 'peugeot', 'renault', 'fiat', 'volvo', 'jaguar',
  'bmw', 'audi', 'lotus', 'mini', 'tesla', 'rivian', 'lucid', 'byd', 'geely', 'mg', 'haval', 'subaru',
  'land rover', 'maserati', 'mclaren', 'aston martin', 'bentley', 'rolls royce', 'ferrari',
  'lamborghini', 'porsche', 'mercedes', 'mercedes benz', 'maybach', 'genesis', 'acura', 'lincoln',
  'hummer', 'alfa romeo', 'citroen', 'opel', 'cupra', 'ssangyong', 'isuzu', 'daihatsu',
  'maruti', 'polestar', 'zeekr', 'xpeng', 'chery', 'jetour', 'changan',
  'ineos', 'rimac', 'ariel', 'morgan', 'spyker', 'delorean',
];

const WORLD_MODELS = [
  'camry', 'corolla', 'yaris', 'prado', 'fortuner', 'hilux', 'rav4', 'innova', 'avalon', 'supra',
  'civic', 'accord', 'crv', 'jazz', 'elantra', 'sonata', 'tucson', 'santa fe', 'creta',
  'i10', 'i20', 'sportage', 'sorento', 'seltos', 'picanto', 'cerato', 'altima', 'maxima',
  'x trail', 'xtrail', 'gtr', 'thar', 'scorpio', 'xuv700', 'bolero', 'swift',
  'brezza', 'veyron', 'chiron', 'divo', 'huayra', 'agera', 'jesko', 'huracan', 'aventador',
  'gallardo', 'revuelto', 'sian', 'murcielago', 'countach', 'f8', 'sf90',
  'portofino', 'purosangue', 'enzo', 'laferrari', 'f40', 'f12',
  'senna', 'artura', '570s', '600lt', '765lt', 'phantom', 'wraith', 'spectre',
  'flying spur', 'mulsanne', 'ghost', 'vantage', 'db11', 'db12', 'dbs', 'valkyrie',
  'mustang', 'explorer', 'f150', 'bronco', 'ranger', 'raptor', 'camaro', 'corvette', 'tahoe',
  'suburban', 'silverado', 'wrangler', 'grand cherokee', 'gladiator', 'challenger', 'charger',
  'durango', 'escalade', 'yukon', 'lx570', 'lx600', 'rx350', 'gx460',
  'es350', 'is300', 'lc500', 'cx5', 'cx9', 'mazda3', 'mx5', 'outback', 'forester', 'wrx', 'brz',
  'model s', 'model 3', 'model y', 'cybertruck', 'taycan', 'macan', 'cayman', 'boxster',
  'panamera', 'cayenne', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'q3', 'q5', 'q7', 'q8', 'rs3', 'rs5',
  'rs6', 'rs7', 'r8', 'e tron', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'm2', 'm3', 'm4', 'm5', 'm8',
  'i7', 'i8', 'z4', '3 series', '5 series', '7 series', 'c class', 'e class', 's class',
  'a class', 'cla', 'cls', 'glc', 'gle', 'gls', 'gla', 'glb', 'g63', 'g class', 'amg gt', 'slk',
  'evoque', 'velar', 'discovery', 'defender', 'range rover', 'levante', 'ghibli',
  'quattroporte', 'grecale', 'mc20', 'granturismo', 'f type', 'f pace', 'e pace',
  'land cruiser', 'patrol', 'urus', 'cullinan', 'roma', 'dbx', '720s', 'continental gt', 'bentayga',
];

export type VehicleMention =
  | { kind: 'MODEL'; models: FleetModel[]; colour: string | null; matchedText: string }
  | { kind: 'BRAND'; make: string; models: FleetModel[] }
  | { kind: 'NOT_IN_FLEET'; mention: string; sameBrand: FleetModel[] }
  | { kind: 'CATEGORY'; category: string; label: string; models: FleetModel[] }
  | { kind: 'NONE' };

const CATEGORY_WORDS: [string, string, RegExp][] = [
  ['CONVERTIBLE', 'convertible', /\b(?:convertibles?|cabriolets?|cabrio|roadsters?|open[ -]?top|soft ?top|spider|drop ?top)\b/],
  ['SUV', 'SUV', /\b(?:suvs?|4x4|crossover|off ?road(?:er)?|jeep type|sport utility)\b/],
  ['SEDAN', 'sedan', /\b(?:sedans?|saloons?)\b/],
  ['COUPE', 'coupe', /\b(?:coupes?|coupe)\b/],
  ['SPORTS', 'sports car', /\b(?:sports? cars?|super ?cars?|hyper ?cars?|fast cars?|racing cars?)\b/],
  ['VAN', 'van', /\b(?:vans?|minivans?|people carriers?|mpv)\b/],
];

function tokens(text: string): string[] {
  return norm(text).split(' ').filter(Boolean);
}

/** Index of `phrase` in `haystack` as whole words, or -1. Both are already normalised. */
function includesPhrase(haystack: string, phrase: string): number {
  return ` ${haystack} `.indexOf(` ${phrase} `);
}

interface AliasEntry {
  alias: string;
  models: FleetModel[];
  strength: number;
}

function addAlias(map: Map<string, AliasEntry>, alias: string, model: FleetModel, strength: number) {
  const key = norm(alias);
  if (!key) return;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { alias: key, models: [model], strength });
    return;
  }
  if (!existing.models.includes(model)) existing.models.push(model);
  existing.strength = Math.max(existing.strength, strength);
}

/** Every phrase that means a specific model, derived from the live fleet. */
export function buildModelAliases(fleet: FleetKnowledge): AliasEntry[] {
  const map = new Map<string, AliasEntry>();
  const makeTokens = new Set<string>();
  for (const model of fleet.models) for (const token of tokens(model.make)) makeTokens.add(token);

  for (const model of fleet.models) {
    const make = norm(model.make);
    const modelName = norm(model.model);
    addAlias(map, `${make} ${modelName}`, model, 3);
    addAlias(map, model.name.replace(/-/g, ''), model, 3);
    addAlias(map, modelName, model, 2);
    addAlias(map, modelName.replace(/ /g, ''), model, 2);
    const first = modelName.split(' ')[0] ?? '';
    if (modelName.includes(' ') && first.length >= 3 && !GENERIC_WORDS.has(first) && !makeTokens.has(first)) {
      addAlias(map, first, model, 1);
    }
    for (const [spoken, target] of MODEL_SYNONYMS) {
      if (norm(target) === modelName) addAlias(map, spoken, model, 2);
    }
  }
  // A first-word alias that points at several models is not a nickname for any of them.
  for (const [key, entry] of map) {
    if (entry.strength === 1 && entry.models.length > 1) map.delete(key);
  }
  // "range" alone means the Range Rover only when there is exactly one model of that name.
  return [...map.values()].sort((a, b) => b.alias.length - a.alias.length);
}

function makeAliases(make: string, includeTypos = false): string[] {
  const normalised = norm(make);
  const out = new Set<string>([normalised, normalised.replace(/ /g, '')]);
  for (const [canonical, synonyms] of Object.entries(MAKE_SYNONYMS)) {
    if (canonical === normalised || synonyms.some((synonym) => norm(synonym) === normalised)) {
      for (const synonym of synonyms) out.add(norm(synonym));
    }
  }
  if (includeTypos) {
    for (const [canonical, typos] of Object.entries(MAKE_TYPOS)) {
      if (canonical === normalised) for (const typo of typos) out.add(norm(typo));
    }
  }
  return [...out];
}

const COLOUR_WORDS = [
  'black', 'white', 'red', 'blue', 'green', 'grey', 'gray', 'silver', 'yellow', 'orange', 'beige',
  'brown', 'gold', 'pink', 'purple',
];

function colourIn(text: string, model: FleetModel): string | null {
  const bag = tokens(text);
  for (const colour of model.colours) {
    const c = norm(colour);
    if (bag.includes(c) || (c === 'grey' && bag.includes('gray')) || (c === 'gray' && bag.includes('grey'))) {
      return colour;
    }
  }
  return null;
}

/**
 * Does the word after a brand name read like a model the customer is asking for ("Toyota Camry",
 * "BMW M3")? Only a known outside model, a model code with a digit, or a capitalised word counts —
 * an ordinary word ("BMW tomorrow", "BMW please") never turns a brand request into a missing car.
 */
function isModelLikeToken(token: string, originalWords: string[]): boolean {
  if (GENERIC_WORDS.has(token)) return false;
  if (/^\d+(?:st|nd|rd|th|am|pm)$/.test(token)) return false;
  if (WORLD_MODELS.includes(token) || WORLD_MAKES.includes(token)) return true;
  if (/^[a-z]{1,3}\d{1,3}[a-z]{0,2}$/.test(token)) return true; // m3, a4, x6, gt3
  if (/^\d{3}[a-z]{1,2}$/.test(token)) return true; // 320i, 720s
  const original = originalWords.findIndex((word) => norm(word) === token);
  return original > 0 && /^[A-Z]/.test(originalWords[original] ?? '');
}

function categoryOf(text: string): { category: string; label: string } | null {
  const lowered = text.toLowerCase();
  for (const [category, label, pattern] of CATEGORY_WORDS) {
    if (pattern.test(lowered)) return { category, label };
  }
  return null;
}

/**
 * Finds what car the message is about. FLEET FIRST: an exact model, then a brand, then a car that
 * exists in the world but not in this fleet, then a category. Fuzzy (typo) matching is tried last
 * and only against the fleet's own names.
 */
export function resolveVehicleMention(message: string, fleet: FleetKnowledge): VehicleMention {
  const text = norm(message);
  if (!text || fleet.models.length === 0) return { kind: 'NONE' };

  // 1. Specific models, longest alias first, each span consumed once.
  const aliases = buildModelAliases(fleet);
  let remaining = ` ${text} `;
  const found: FleetModel[] = [];
  let matchedText = '';
  for (const entry of aliases) {
    const needle = ` ${entry.alias} `;
    if (!remaining.includes(needle)) continue;
    // Several models behind one alias (a shared name): all of them are candidates.
    for (const model of entry.models) if (!found.includes(model)) found.push(model);
    if (!matchedText) matchedText = entry.alias;
    remaining = remaining.split(needle).join('  ');
  }
  if (found.length > 0) {
    const colour = found.length === 1 ? colourIn(text, found[0]!) : null;
    return { kind: 'MODEL', models: found, colour, matchedText };
  }

  // 2. A brand, possibly followed by a model the fleet does not have ("Toyota Camry").
  const bag = tokens(text);
  const originalWords = message.split(/\s+/).filter(Boolean);
  const makes = [...new Set(fleet.models.map((model) => model.make))];
  const brandAliases = makes
    .flatMap((make) => makeAliases(make, true).map((alias) => ({ make, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { make, alias } of brandAliases) {
    const at = includesPhrase(text, alias);
    if (at < 0) continue;
    const brandModels = fleet.models.filter((model) => model.make === make);
    const after = text
      .slice(at + alias.length)
      .trim()
      .split(' ')
      .filter(Boolean);
    const extra = after.find((token) => isModelLikeToken(token, originalWords));
    // "Lamborghini Urrus": a misspelt model of this brand is that model, not a missing car.
    const misspeltModel =
      extra !== undefined &&
      brandModels.some((model) =>
        tokens(model.model).some(
          (word) =>
            word.length >= 4 &&
            Math.abs(word.length - extra.length) <= 2 &&
            levenshteinDistance(word, extra) <= (word.length >= 5 ? 2 : 1),
        ),
      );
    if (extra && !misspeltModel && !COLOUR_WORDS.includes(extra)) {
      const shown = /\d/.test(extra) ? extra.toUpperCase() : extra.charAt(0).toUpperCase() + extra.slice(1);
      return { kind: 'NOT_IN_FLEET', mention: `${make} ${shown}`, sameBrand: brandModels };
    }
    return { kind: 'BRAND', make, models: brandModels };
  }

  // 3. Typos, against fleet names only (tokens of 6+ letters, edit distance 1-2): short words are
  // never "corrected" into a make, so gibberish like "fnord" is not Ford.
  for (const token of bag) {
    if (token.length < 6 || GENERIC_WORDS.has(token)) continue;
    const limit = token.length >= 8 ? 2 : 1;
    for (const make of makes) {
      for (const alias of makeAliases(make, true)) {
        if (alias.includes(' ') || Math.abs(alias.length - token.length) > limit) continue;
        if (levenshteinDistance(alias, token) <= limit) {
          return { kind: 'BRAND', make, models: fleet.models.filter((model) => model.make === make) };
        }
      }
    }
    for (const model of fleet.models) {
      for (const word of tokens(model.model)) {
        if (word.length < 5 || Math.abs(word.length - token.length) > limit) continue;
        if (levenshteinDistance(word, token) <= limit) {
          return { kind: 'MODEL', models: [model], colour: colourIn(text, model), matchedText: token };
        }
      }
    }
  }

  // 4. A car that exists, but not here.
  const outsideModel = WORLD_MODELS.find((name) => includesPhrase(text, name) >= 0);
  const outsideMake = WORLD_MAKES.find((name) => includesPhrase(text, name) >= 0);
  const outside = [outsideMake, outsideModel].filter(Boolean).join(' ');
  if (outside) {
    const title = outside.replace(/\b\w/g, (c) => c.toUpperCase());
    return { kind: 'NOT_IN_FLEET', mention: title, sameBrand: [] };
  }

  // 5. A category.
  const category = categoryOf(message);
  if (category) {
    return {
      kind: 'CATEGORY',
      category: category.category,
      label: category.label,
      models: fleet.models.filter((model) => model.category === category.category),
    };
  }
  return { kind: 'NONE' };
}

// ---------------------------------------------------------------------------
// Ranking helpers
// ---------------------------------------------------------------------------

const looseMatch = (model: FleetModel, wanted: string): boolean => {
  const a = norm(model.name).replace(/ /g, '');
  const b = norm(wanted).replace(/ /g, '');
  return a === b || a.includes(b) || b.includes(a);
};

/** Popular cars first (owner's list), then whatever has the most cars free. Only fleet cars, only free ones. */
export function popularModels(
  fleet: FleetKnowledge,
  profile: BusinessProfile,
  limit: number,
  options: { exclude?: FleetModel[]; onlyAvailable?: boolean } = {},
): FleetModel[] {
  const excluded = new Set((options.exclude ?? []).map((model) => model.key));
  const pool = fleet.models.filter(
    (model) => !excluded.has(model.key) && (!options.onlyAvailable || model.availableUnits > 0),
  );
  const ranked: FleetModel[] = [];
  for (const wanted of profile.popularModels) {
    const hit = pool.find((model) => looseMatch(model, wanted) && !ranked.includes(model));
    if (hit) ranked.push(hit);
  }
  const rest = pool
    .filter((model) => !ranked.includes(model))
    .sort((a, b) => b.availableUnits - a.availableUnits || b.dailyRate - a.dailyRate);
  return [...ranked, ...rest].slice(0, limit);
}

export function money(amount: number, currency: string): string {
  return `${currency} ${Math.round(amount).toLocaleString('en-US')}`;
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Black, White" -> "Black or White" */
export function coloursText(model: FleetModel): string {
  return joinList(model.colours);
}

// ---------------------------------------------------------------------------
// Alias expansion (for the booking steps' own matchers)
// ---------------------------------------------------------------------------

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function flexibleRegex(alias: string): RegExp {
  const body = alias.split(' ').map(escapeRe).join('[\\s-]+');
  return new RegExp(`(?<![\\w-])${body}(?![\\w-])`, 'gi');
}

/**
 * Rewrites the ways customers speak about cars ("merc", "lambo", "g63", "s class", "landcruiser")
 * into the fleet's own names ("Mercedes-Benz", "Lamborghini", "G63 AMG", "S-Class", "Land Cruiser"),
 * so the booking steps' exact-name matchers find them. Only names the fleet really has are ever
 * produced; text that matches nothing comes back unchanged.
 */
export function expandVehicleAliases(text: string, fleet: FleetKnowledge): string {
  let out = text;
  const makes = [...new Set(fleet.models.map((model) => model.make))];
  for (const make of makes) {
    const spoken = makeAliases(make)
      .filter((alias) => alias !== norm(make))
      .sort((a, b) => b.length - a.length);
    for (const alias of spoken) out = out.replace(flexibleRegex(alias), make);
  }
  for (const entry of buildModelAliases(fleet)) {
    // A first word alone ("range") is a hint for the chat, not a name to rewrite into.
    if (entry.models.length !== 1 || entry.strength < 2) continue;
    const model = entry.models[0]!;
    out = out.replace(flexibleRegex(entry.alias), model.model);
  }
  return out;
}
