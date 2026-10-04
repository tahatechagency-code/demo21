import {
  VehicleMatchType,
  type VehicleCategoryValue,
  type VehicleMatchTypeValue,
} from '@ai-concierge/domain';
import {
  buildFleetKnowledge,
  expandVehicleAliases,
  resolveVehicleMention,
  type FleetKnowledge,
} from '../concierge/fleetKnowledge.js';
import { LOCATION_KEYWORDS } from '../lexicon.js';
import { MONTHS } from '../shared/monthNames.js';
import { CATEGORY_KEYWORDS } from './categoryKeywords.js';
import { COLOR_KEYWORDS } from './colorKeywords.js';
import { similarityRatio } from './levenshtein.js';
import type { VehicleLexiconEntry } from './vehicleCatalogProvider.js';

export interface VehicleMentionCandidate {
  lexiconEntryId: string;
  make: string;
  model: string;
  color: string;
  category: VehicleCategoryValue;
  matchType: VehicleMatchTypeValue;
  matchedText: string;
  /** 1.0 for exact/brand/category matches; the typo-tolerance score for FUZZY_MATCH. */
  similarity: number;
}

export interface VehicleIntentProposal {
  /** Always one matchType, from the highest tier that produced any hits — see `propose`. */
  candidates: VehicleMentionCandidate[];
  /** A vehicle-shaped phrase that matched nothing in the fleet (for the UNKNOWN_VEHICLE message). */
  rawMention: string | null;
}

const FUZZY_SIMILARITY_THRESHOLD = 0.75;

/**
 * 2-3 word Capitalized phrases — two consecutive capitalized words together
 * are a strong proper-noun signal regardless of position (e.g. "Toyota
 * Corolla"), unlike ordinary English sentence-initial capitalization.
 * Always matched against one message's text (see `propose`), never a raw
 * multi-message transcript, so this never merges words across messages.
 */
const MULTI_WORD_CAPITALIZED_PHRASE_RE = /\b[A-Z][a-zA-Z]*(?:[ \t]+[A-Z][a-zA-Z]*){1,2}\b/g;

/** A single Capitalized word — only meaningful as a proper-noun signal away from the very start of the sentence (see `extractVehicleShapedPhrases`). */
const SINGLE_CAPITALIZED_WORD_RE = /\b[A-Z][a-zA-Z]+\b/g;

/**
 * A generic "verb + noun phrase" fallback for a lowercase mention (e.g. "book
 * a spaceship") that the capitalized-phrase heuristic above would miss.
 */
const GENERIC_MENTION_RE =
  /\b(?:book|rent|hire|need|want)(?:[ \t]+to[ \t]+(?:book|rent|hire))?[ \t]+(?:an?[ \t]+)?([a-zA-Z][a-zA-Z \t]{1,40}?)(?=[ \t]+(?:for|from|on|in|please|now|today|tomorrow|asap)\b|[.,!?\n]|$)/i;

/**
 * "model X" / "car model X" / "model: X", case-insensitive — catches a
 * typo'd model named in plain lowercase text (e.g. "car model ranger
 * rover"), which the capitalized-phrase heuristic above would never see
 * since it requires capitalized words. Lazy capture + explicit terminator
 * lookahead (same shape as `GENERIC_MENTION_RE`) so a trailing word like
 * "please" or a following clause is never swallowed into the model name.
 */
const MODEL_CUE_RE =
  /\bmodel\s*(?:is|:|-)?\s*([a-z][a-z\s]{1,40}?)(?=\s+(?:for|from|on|in|and|please|now|today|tomorrow|asap)\b|[.,!?]|$)/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textMentions(text: string, phrase: string): RegExpMatchArray | null {
  return text.match(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i'));
}

/**
 * True when nothing but horizontal whitespace precedes `index` on its line
 * — i.e. `index` is the first word of the whole text, or the first word of
 * a line within it. `matchFuzzy` always calls this (via
 * `extractVehicleShapedPhrases`) with a single message's text, where this
 * reduces to "first word of the message"; `findGenericVehiclePhrase`'s
 * final fallback still runs against the whole accumulated transcript (one
 * message per line), where each line is an independent message with its
 * own sentence-initial position — checking only absolute index 0 would
 * treat every message after the first as never sentence-initial, so a lone
 * reply like "Yes" or "What" would be misread as a proper-noun signal
 * purely for landing after the first message.
 */
function isLineInitial(text: string, index: number | undefined): boolean {
  if (index === undefined) return false;
  return /(?:^|\n)[ \t]*$/.test(text.slice(0, index));
}

/**
 * True when a capitalized phrase reads as a location mention rather than a
 * vehicle mention — e.g. "Pickup Dubai Airport" or "Dubai Marina" have
 * exactly the same "2-3 Capitalized Words" shape as "Lamborghini Urus", but
 * are answering a location question, not naming a car. Reuses
 * `LOCATION_KEYWORDS` (the same list Step 1 matches locations against —
 * `lexicon.ts`) rather than a second, potentially-drifting list. Checked
 * both directions since either side can be the longer string: the phrase
 * may carry extra words around a known location ("Pickup Dubai Airport"
 * contains "dubai airport"), or be a fragment of one after the multi-word
 * regex above and this single-word one split it ("Airport" alone is
 * contained in "dubai airport").
 *
 * Only suppresses the vehicle-shaped *fallback* signal (fuzzy matching and
 * the final "not a vehicle we currently offer" message) — real fleet
 * vehicles are always found first via `matchExactModel`/`matchBrandOnly`/
 * `matchCategoryOnly`, which match directly against the fleet lexicon and
 * never call this.
 */
function isLocationShapedPhrase(phrase: string): boolean {
  const lower = phrase.toLowerCase();
  return LOCATION_KEYWORDS.some((keyword) => lower.includes(keyword) || keyword.includes(lower));
}

/**
 * Words that are capitalised or sit after "book/need/want" in an ordinary booking message but never
 * name a car: months, weekdays, places, the generic words for a car itself. A phrase made only of
 * these ("November", "UAE", "car") is never reported as an unknown vehicle.
 */
const NOT_A_VEHICLE_WORDS = new Set([
  ...Object.keys(MONTHS),
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'today', 'tomorrow', 'tonight', 'next', 'this', 'week', 'weekend', 'month', 'day', 'days',
  'uae', 'dubai', 'abu', 'dhabi', 'sharjah', 'ajman', 'fujairah', 'airport', 'hotel', 'marina',
  'car', 'cars', 'vehicle', 'vehicles', 'ride', 'rental', 'rent', 'hire', 'booking', 'one', 'it',
  'a', 'an', 'the', 'some', 'any', 'please', 'pls', 'thanks', 'thank', 'you', 'hello', 'hi', 'hey',
  'yes', 'no', 'ok', 'okay', 'sir', 'madam', 'bro', 'am', 'pm', 'aed', 'for', 'from', 'to', 'in',
  'on', 'at', 'with', 'and', 'or', 'me', 'my', 'we', 'us', 'now', 'asap', 'soon', 'later',
  'cheap', 'best', 'good', 'new', 'nice', 'luxury', 'something', 'anything', 'vip', 'driver',
]);

function isNotAVehiclePhrase(phrase: string): boolean {
  const words = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return (
    words.length === 0 ||
    words.every((word) => NOT_A_VEHICLE_WORDS.has(word) || /^\d+(?:st|nd|rd|th)?$/.test(word))
  );
}

/**
 * Multi-word capitalized phrases anywhere, plus single capitalized words
 * that are *not* the first word of their message — sentence-initial
 * capitalization is grammatically mandatory in English and carries
 * no proper-noun signal on its own (e.g. "What time..." / "I want...").
 */
function extractVehicleShapedPhrases(text: string): string[] {
  const multiWord = [...text.matchAll(MULTI_WORD_CAPITALIZED_PHRASE_RE)].map((match) => match[0]);
  const singleWord = [...text.matchAll(SINGLE_CAPITALIZED_WORD_RE)]
    .filter((match) => !isLineInitial(text, match.index))
    .map((match) => match[0]);
  return [...multiWord, ...singleWord].filter(
    (phrase) => !isLocationShapedPhrase(phrase) && !isNotAVehiclePhrase(phrase),
  );
}

/**
 * Cue-based phrases: text following an explicit "model" cue, or the object
 * of a "book/rent/hire/need/want" verb — case-insensitive, so this catches
 * a typo'd vehicle name a customer typed entirely in lowercase (e.g. "car
 * model ranger rover"), which `extractVehicleShapedPhrases` cannot see.
 */
function extractCuedPhrases(text: string): string[] {
  const cued = [...text.matchAll(MODEL_CUE_RE)]
    .map((match) => match[1])
    .filter((phrase): phrase is string => Boolean(phrase));
  const generic = GENERIC_MENTION_RE.exec(text)?.[1]?.trim();
  if (generic && !isNotAVehiclePhrase(generic)) cued.push(generic);
  return cued;
}

/**
 * Every phrase `matchFuzzy` tries against the fleet: capitalized
 * proper-noun-shaped phrases (a customer who capitalizes brand names, even
 * with a typo) plus cue-based phrases (a customer typing entirely in
 * lowercase, e.g. "car model ranger rover" or "i want the range rovr").
 */
function extractFuzzyCandidatePhrases(text: string): string[] {
  return [...extractVehicleShapedPhrases(text), ...extractCuedPhrases(text)].filter(
    (phrase) => !isLocationShapedPhrase(phrase) && !isNotAVehiclePhrase(phrase),
  );
}

const fleetCache = new WeakMap<VehicleLexiconEntry[], FleetKnowledge>();

/** The lexicon as a searchable fleet (every row counts here; inactive ones are rejected later by validation). */
function fleetFromLexicon(lexicon: VehicleLexiconEntry[]): FleetKnowledge {
  const cached = fleetCache.get(lexicon);
  if (cached) return cached;
  const built = buildFleetKnowledge(
    lexicon.map((entry) => ({
      id: entry.id,
      make: entry.make,
      model: entry.model,
      color: entry.color,
      category: entry.category,
      luxuryTier: '',
      seats: 0,
      luggage: 0,
      transmission: '',
      dailyRate: 0,
      currency: '',
      active: true,
      availabilityStatus: 'AVAILABLE',
      totalUnits: 0,
      bookedUnits: 0,
      maintenanceUnits: 0,
    })),
    '',
  );
  fleetCache.set(lexicon, built);
  return built;
}

/**
 * AI-side proposal step: matches the (sanitized) message text against the
 * tenant's real fleet lexicon — never a hardcoded model list — so it can
 * never propose a vehicle the fleet doesn't actually carry. Tiered,
 * mutually-exclusive matching (exact model > brand only > category only >
 * typo-tolerant fuzzy), matching the distinct scenarios the business cares
 * about: naming the exact car, naming just the brand, naming just a
 * category, or a typo. `VehicleValidationService` decides what a given
 * proposal shape means for the final result.
 */
export class VehicleIntentService {
  propose(sanitizedText: string, lexicon: VehicleLexiconEntry[]): VehicleIntentProposal {
    // Strip the sanitizer's injection placeholder so it can never be
    // mistaken for a capitalized "vehicle-shaped" phrase (e.g. "REMOVED").
    const cleaned = sanitizedText.replace(/\[REMOVED\]/g, ' ').trim();
    // Spoken names ("merc", "g63", "lambo", "s class") become the fleet's own names before any matching.
    const fleet = fleetFromLexicon(lexicon);
    const text = cleaned
      .split('\n')
      .map((line) => expandVehicleAliases(line, fleet))
      .join('\n');

    // `text` may be an accumulated multi-message transcript, one message per
    // line (see `buildAccumulatedTranscript`, this method's only production
    // caller, via the orchestrator). That function guarantees every "\n" in
    // its output is a boundary between two different messages — it collapses
    // any newline a customer typed *inside* one message before joining — so
    // a line here is always exactly one whole message, never a fragment of
    // one. Scan from the most recent message backward: the first message
    // that names any vehicle — at *any* match tier — is what the customer
    // means now. A later, lower-tier correction (a typo, or a bare brand
    // where an earlier message named an exact model) is still a deliberate
    // change of mind and must win over an earlier, higher-tier mention from
    // an older message; evaluating every tier against the *whole* transcript
    // at once (the previous approach) let an early exact/brand match
    // permanently shadow a later correction that only qualified for a lower
    // tier. Two vehicles named in the *same* message remain a genuine
    // ambiguity — see `proposeForSingleMessage`.
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      // A car we do not carry is reported as such, never swapped for another model of the same brand.
      const outside = resolveVehicleMention(lines[i] as string, fleet);
      if (outside.kind === 'NOT_IN_FLEET') return { candidates: [], rawMention: outside.mention };
      const proposal = this.preferLastNamedWhenChanging(
        lines[i] as string,
        this.proposeForSingleMessage(lines[i] as string, lexicon),
      );
      if (proposal.candidates.length > 0) {
        return this.narrowByEarlierMention(proposal, lines.slice(0, i), lexicon);
      }
    }

    return { candidates: [], rawMention: this.findGenericVehiclePhrase(text) };
  }

  /**
   * "Urus se G63 change karo": two cars in one message together with change wording mean the customer is
   * switching to the one named LAST. Without that wording two cars stay a genuine ambiguity.
   */
  private preferLastNamedWhenChanging(line: string, proposal: VehicleIntentProposal): VehicleIntentProposal {
    const cars = new Map<string, VehicleMentionCandidate[]>();
    for (const candidate of proposal.candidates) {
      const key = `${candidate.make} ${candidate.model}`;
      cars.set(key, [...(cars.get(key) ?? []), candidate]);
    }
    if (cars.size < 2 || !/\b(?:change|badal\w*|instead|replace|switch|rather|jagah|kar ?do|karo)\b/i.test(line)) {
      return proposal;
    }
    const lower = line.toLowerCase();
    let best: { key: string; at: number } | null = null;
    for (const key of cars.keys()) {
      const model = key.slice(key.indexOf(' ') + 1).toLowerCase();
      const at = lower.lastIndexOf(model);
      if (at >= 0 && (!best || at > best.at)) best = { key, at };
    }
    return best ? { candidates: cars.get(best.key)!, rawMention: null } : proposal;
  }

  /**
   * "the black one" after "BMW X5" means the black BMW X5: a colour-only reply narrows the car named
   * in an earlier message instead of matching every black car in the fleet. With no earlier mention
   * (or none in that colour) the colour-only proposal stands.
   */
  private narrowByEarlierMention(
    proposal: VehicleIntentProposal,
    earlierLines: string[],
    lexicon: VehicleLexiconEntry[],
  ): VehicleIntentProposal {
    if (proposal.candidates[0]?.matchType !== VehicleMatchType.COLOR_ONLY) return proposal;
    const colours = new Set(proposal.candidates.map((candidate) => candidate.color));
    for (let i = earlierLines.length - 1; i >= 0; i -= 1) {
      const earlier = this.proposeForSingleMessage(earlierLines[i] as string, lexicon);
      if (
        earlier.candidates.length === 0 ||
        earlier.candidates[0]?.matchType === VehicleMatchType.COLOR_ONLY
      ) {
        continue;
      }
      const narrowed = earlier.candidates.filter((candidate) => colours.has(candidate.color));
      return narrowed.length > 0 ? { candidates: narrowed, rawMention: null } : proposal;
    }
    return proposal;
  }

  /** Tiered, mutually-exclusive matching (exact model > brand only > category only > typo-tolerant fuzzy) for one message's text. */
  private proposeForSingleMessage(
    text: string,
    lexicon: VehicleLexiconEntry[],
  ): VehicleIntentProposal {
    const exact = this.matchExactModel(text, lexicon);
    if (exact.length > 0) return { candidates: this.narrowToNamedColour(text, exact), rawMention: null };

    const brand = this.matchBrandOnly(text, lexicon);
    if (brand.length > 0) return { candidates: this.narrowToNamedColour(text, brand), rawMention: null };

    const category = this.matchCategoryOnly(text, lexicon);
    if (category.length > 0) return { candidates: category, rawMention: null };

    const color = this.matchColorOnly(text, lexicon);
    if (color.length > 0) return { candidates: color, rawMention: null };

    const fuzzy = this.matchFuzzy(text, lexicon);
    if (fuzzy.length > 0) return { candidates: fuzzy, rawMention: null };

    return { candidates: [], rawMention: null };
  }

  /**
   * "Cullinan white" names one catalog row, not both colours. Applies only when every candidate is
   * the same car (a colour cannot decide between two different models).
   */
  private narrowToNamedColour(
    text: string,
    candidates: VehicleMentionCandidate[],
  ): VehicleMentionCandidate[] {
    const first = candidates[0];
    if (!first || candidates.length < 2) return candidates;
    if (!candidates.every((c) => c.make === first.make && c.model === first.model)) return candidates;
    const lower = text.toLowerCase();
    const named = candidates.filter((candidate) =>
      (COLOR_KEYWORDS[candidate.color] ?? [candidate.color.toLowerCase()]).some((keyword) =>
        new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(lower),
      ),
    );
    return named.length > 0 ? named : candidates;
  }

  /**
   * `text` is a single message's text (see `propose`). Two different exact
   * models both matching is a genuine ambiguity ("the Urus or the Range
   * Rover?") since they were named together in one message. Tries
   * colour-qualified phrases first ("BMW X5 black") so a customer who states
   * make+model+colour together in one message resolves to exactly one
   * catalog row instead of every colour variant of that model.
   */
  private matchExactModel(text: string, lexicon: VehicleLexiconEntry[]): VehicleMentionCandidate[] {
    const results: VehicleMentionCandidate[] = [];
    for (const entry of lexicon) {
      const colorQualified =
        textMentions(text, `${entry.make} ${entry.model} ${entry.color}`) ??
        textMentions(text, `${entry.color} ${entry.make} ${entry.model}`) ??
        textMentions(text, `${entry.model} ${entry.color}`) ??
        textMentions(text, `${entry.color} ${entry.model}`);
      const fullMatch = colorQualified ?? textMentions(text, `${entry.make} ${entry.model}`);
      const match = fullMatch ?? textMentions(text, entry.model);
      if (match) {
        results.push({
          lexiconEntryId: entry.id,
          make: entry.make,
          model: entry.model,
          color: entry.color,
          category: entry.category,
          matchType: VehicleMatchType.EXACT_MODEL,
          matchedText: match[0],
          similarity: 1,
        });
      }
    }
    return results;
  }

  private matchBrandOnly(text: string, lexicon: VehicleLexiconEntry[]): VehicleMentionCandidate[] {
    const makes = [...new Set(lexicon.map((entry) => entry.make))];
    const results: VehicleMentionCandidate[] = [];
    for (const make of makes) {
      const match = textMentions(text, make);
      if (!match) continue;
      for (const entry of lexicon.filter((e) => e.make === make)) {
        results.push({
          lexiconEntryId: entry.id,
          make: entry.make,
          model: entry.model,
          color: entry.color,
          category: entry.category,
          matchType: VehicleMatchType.BRAND_ONLY,
          matchedText: match[0],
          similarity: 1,
        });
      }
    }
    return results;
  }

  private matchCategoryOnly(
    text: string,
    lexicon: VehicleLexiconEntry[],
  ): VehicleMentionCandidate[] {
    const lowerText = text.toLowerCase();
    const results: VehicleMentionCandidate[] = [];
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [
      VehicleCategoryValue,
      string[],
    ][]) {
      const matchedKeyword = keywords.find((keyword) => lowerText.includes(keyword));
      if (!matchedKeyword) continue;
      for (const entry of lexicon.filter((e) => e.category === category)) {
        results.push({
          lexiconEntryId: entry.id,
          make: entry.make,
          model: entry.model,
          color: entry.color,
          category: entry.category,
          matchType: VehicleMatchType.CATEGORY_ONLY,
          matchedText: matchedKeyword,
          similarity: 1,
        });
      }
    }
    return results;
  }

  /**
   * Colour named alone (e.g. "black"), with no model/brand/category word in
   * the same message — the weakest single-attribute signal, tried only after
   * every other tier has found nothing in this message. Matches every
   * catalog entry in that colour; a real narrowing to "the black one we were
   * already discussing" is a cross-message conversation-state question this
   * tier deliberately does not attempt (see `propose`'s own doc comment on
   * why a later message's signal replaces rather than intersects with an
   * earlier one).
   */
  private matchColorOnly(text: string, lexicon: VehicleLexiconEntry[]): VehicleMentionCandidate[] {
    const lowerText = text.toLowerCase();
    const results: VehicleMentionCandidate[] = [];
    for (const [color, keywords] of Object.entries(COLOR_KEYWORDS)) {
      const matchedKeyword = keywords.find((keyword) => lowerText.includes(keyword));
      if (!matchedKeyword) continue;
      for (const entry of lexicon.filter((e) => e.color === color)) {
        results.push({
          lexiconEntryId: entry.id,
          make: entry.make,
          model: entry.model,
          color: entry.color,
          category: entry.category,
          matchType: VehicleMatchType.COLOR_ONLY,
          matchedText: matchedKeyword,
          similarity: 1,
        });
      }
    }
    return results;
  }

  private matchFuzzy(text: string, lexicon: VehicleLexiconEntry[]): VehicleMentionCandidate[] {
    const phrases = extractFuzzyCandidatePhrases(text);
    const seen = new Set<string>();
    const results: VehicleMentionCandidate[] = [];

    for (const phrase of phrases) {
      let best: { entry: VehicleLexiconEntry; similarity: number } | null = null;
      for (const entry of lexicon) {
        for (const candidate of [`${entry.make} ${entry.model}`, entry.model, entry.make]) {
          const similarity = similarityRatio(phrase.toLowerCase(), candidate.toLowerCase());
          if (!best || similarity > best.similarity) best = { entry, similarity };
        }
      }
      if (
        best &&
        best.similarity >= FUZZY_SIMILARITY_THRESHOLD &&
        best.similarity < 1 &&
        !seen.has(best.entry.id)
      ) {
        seen.add(best.entry.id);
        results.push({
          lexiconEntryId: best.entry.id,
          make: best.entry.make,
          model: best.entry.model,
          color: best.entry.color,
          category: best.entry.category,
          matchType: VehicleMatchType.FUZZY_MATCH,
          matchedText: phrase,
          similarity: best.similarity,
        });
      }
    }
    return results;
  }

  private findGenericVehiclePhrase(text: string): string | null {
    const capitalizedPhrases = extractVehicleShapedPhrases(text);
    if (capitalizedPhrases.length > 0) return capitalizedPhrases[0]!;
    const generic = GENERIC_MENTION_RE.exec(text)?.[1]?.trim();
    return generic && !isNotAVehiclePhrase(generic) ? generic : null;
  }
}
