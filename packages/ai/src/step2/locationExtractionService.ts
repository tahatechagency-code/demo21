import type { Ambiguity } from '@ai-concierge/domain';
import { KNOWN_UNSERVICED_CITIES } from './gazetteer.js';
import type { LocationCandidate, LocationProvider } from './locationProvider.js';

/** "in/at/from/to/near/pickup/dropoff <Capitalized Phrase>" — a location was clearly *mentioned*. */
const LOCATION_PHRASE_RE =
  /\b(?:in|at|from|to|near|pick(?:\s*-?\s*up)?(?:\s+(?:at|in|from))?|drop(?:\s*-?\s*off)?(?:\s+(?:at|to|in))?)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/g;

interface TextRange {
  start: number;
  end: number;
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && a.end > b.start;
}

interface UnmatchedPhrases {
  /** A real, known place name — just outside the current service area. */
  unsupported: string[];
  /** Looks like a location mention but isn't recognized as a place at all. */
  unrecognized: string[];
}

/** A weekday, month or time word that follows "to/from/at" in a date phrase ("Monday to Thursday") is never a place. */
const NOT_A_PLACE_WORD =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|today|tomorrow|tonight|noon|midnight|morning|evening|afternoon|night|weekend|week|month|day|days)$/i;

function findUnmatchedLocationPhrases(
  text: string,
  resolved: LocationCandidate[],
): UnmatchedPhrases {
  const resolvedRanges: TextRange[] = resolved.map((candidate) => ({
    start: candidate.matchIndex,
    end: candidate.matchIndex + candidate.raw.length,
  }));

  const result: UnmatchedPhrases = { unsupported: [], unrecognized: [] };
  for (const match of text.matchAll(LOCATION_PHRASE_RE)) {
    const phrase = match[1];
    if (!phrase) continue;
    if (phrase.split(/\s+/).every((word) => NOT_A_PLACE_WORD.test(word))) continue;
    const phraseStart = match.index + match[0].length - phrase.length;
    const phraseRange: TextRange = { start: phraseStart, end: phraseStart + phrase.length };
    const alreadyResolved = resolvedRanges.some((range) => rangesOverlap(range, phraseRange));
    if (alreadyResolved) continue;

    if (KNOWN_UNSERVICED_CITIES.has(phrase.toLowerCase())) {
      result.unsupported.push(phrase);
    } else {
      result.unrecognized.push(phrase);
    }
  }
  return result;
}

/** Bare names of real places outside the UAE, said without "in/to/at" ("Urus kal Delhi"). */
function findBareUnservicedCities(text: string, resolved: LocationCandidate[]): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const city of KNOWN_UNSERVICED_CITIES) {
    const at = new RegExp(`\\b${city.replace(/ /g, '\\s+')}\\b`, 'i').exec(lower);
    if (!at) continue;
    const range = { start: at.index, end: at.index + at[0].length };
    const overlapsResolved = resolved.some((candidate) =>
      rangesOverlap(range, { start: candidate.matchIndex, end: candidate.matchIndex + candidate.raw.length }),
    );
    if (!overlapsResolved) found.push(text.slice(range.start, range.end));
  }
  return found;
}

/** Whether a known place may be used as a pickup / drop-off (e.g. the delivery rule). */
export interface LocationPolicy {
  assess(candidate: LocationCandidate): Promise<{ allowed: true } | { allowed: false; message: string }>;
}

/** A place that was understood but refused by the policy; the customer is told why. */
export interface OutOfRangeMention {
  raw: string;
  role: 'pickup' | 'dropoff';
  message: string;
}

export interface LocationExtractionOutcome {
  pickupLocation: LocationCandidate | null;
  dropoffLocation: LocationCandidate | null;
  ambiguities: Ambiguity[];
  /** Real, known cities mentioned outside the current service area (see gazetteer.ts). */
  unsupportedLocationMentions: string[];
  /** The latest pickup / drop-off the policy refused (cleared when a later one is accepted). */
  outOfRangeMentions?: OutOfRangeMention[];
}

/** Wording that says the place is where the car comes back, not where it starts. */
const DROPOFF_CUE_RE =
  /\b(?:drop(?:\s*-?\s*off)?|dropping|return(?:ing)?|hand\s*over|wapas|vapas|chhod\w*)\b[^.\n]{0,25}$/i;
/** A question about a place ("do you deliver to Al Ain?") does not change where this booking starts. */
const QUESTION_LINE_RE =
  /\?\s*$|^\s*(?:do|does|can|could|is|are|will|what|how|which|kya|kitna|kitne)\b|\b(?:possible|milegi|milega|hogi|hoga|available)\b/i;

/**
 * AI-side proposal step: finds location mentions via the injected `LocationProvider` and assigns
 * pickup/dropoff message by message, so a later message ("JBR kar do") replaces the place named in an
 * earlier one instead of becoming a drop-off. It never invents a location that wasn't in the text, and
 * it flags (rather than silently drops) a location-shaped phrase it couldn't resolve —
 * `TemporalValidationService` decides what that means for the overall result.
 */
export class LocationExtractionService {
  constructor(
    private readonly provider: LocationProvider,
    private readonly policy?: LocationPolicy,
  ) {}

  async extract(sanitizedText: string): Promise<LocationExtractionOutcome> {
    const lines = sanitizedText.split('\n').filter((line) => line.trim().length > 0);
    let pickup: LocationCandidate | null = null;
    let dropoff: LocationCandidate | null = null;
    const ambiguities: Ambiguity[] = [];
    const unsupported: string[] = [];
    const pending = new Map<'pickup' | 'dropoff', OutOfRangeMention>();

    for (const line of lines.length > 0 ? lines : [sanitizedText]) {
      const candidates = await this.provider.resolve(line);
      const unmatched = findUnmatchedLocationPhrases(line, candidates);
      const asking = QUESTION_LINE_RE.test(line);
      // A question about another place must not wipe the place the booking already has.
      if (asking && (pickup || dropoff)) continue;

      for (const phrase of unmatched.unrecognized) {
        ambiguities.push({
          field: 'pickupLocation',
          code: 'UNRECOGNIZED_LOCATION_TEXT',
          message: `"${phrase}" was not recognized as a location`,
          raw: phrase,
        });
      }
      for (const city of [...unmatched.unsupported, ...findBareUnservicedCities(line, candidates)]) {
        if (!unsupported.includes(city)) unsupported.push(city);
      }

      if (candidates.length > 2) {
        ambiguities.push({
          field: 'dropoffLocation',
          code: 'MULTIPLE_CANDIDATE_LOCATIONS',
          message: `${candidates.length} distinct locations were mentioned; using the first two in reading order as pickup and dropoff`,
        });
      }
      let pickupTakenThisLine = false;
      for (const candidate of candidates.slice(0, 2)) {
        const before = line.slice(Math.max(0, candidate.matchIndex - 40), candidate.matchIndex);
        const role: 'pickup' | 'dropoff' =
          DROPOFF_CUE_RE.test(before) || pickupTakenThisLine ? 'dropoff' : 'pickup';
        if (role === 'pickup') pickupTakenThisLine = true;

        const verdict = this.policy ? await this.policy.assess(candidate) : { allowed: true as const };
        if (!verdict.allowed) {
          pending.set(role, { raw: candidate.raw, role, message: verdict.message });
          if (role === 'pickup') pickup = null;
          else dropoff = null;
          continue;
        }
        pending.delete(role);
        if (role === 'pickup') pickup = candidate;
        else dropoff = candidate;
      }
    }

    return {
      pickupLocation: pickup,
      dropoffLocation: dropoff,
      ambiguities,
      unsupportedLocationMentions: unsupported,
      outOfRangeMentions: [...pending.values()],
    };
  }
}
