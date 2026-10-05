/**
 * The check every reworded sentence passes before a customer sees it. Gemini may change the words of a
 * reply but never its facts: the numbers must be exactly the draft's, every car and place the draft names
 * must still be named, and no link may appear that the draft did not have. Anything else falls back to
 * the draft itself, so a bad rewrite can never reach a customer.
 */

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

export function numbersOf(text: string): Set<string> {
  return new Set((text.match(NUMBER_RE) ?? []).map((raw) => String(Number.parseFloat(raw.replace(/,/g, '')))));
}

const LINK_RE = /https?:\/\/|www\./i;

/** A refusal or limit in the draft ("not in our fleet", "no delivery fee", "cannot") must still be one after rewording. */
const NEGATION_IN_DRAFT = /\b(?:not|no|cannot|can't|don't|do not|never|without|nothing|none)\b/i;
const NEGATION_IN_REWRITE =
  /\b(?:not|no|cannot|can't|don't|do not|never|without|nothing|none|isn't|aren't|nahi|nahin|nhi|mat|bina|na)\b|[\u0600-\u06FF]/i;

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/**
 * Why a rewrite must be refused, or null when it keeps every fact. `names`: every car / place / branch name
 * the business uses; only those present in the draft are required to survive.
 */
export function factLoss(
  draft: string,
  candidate: string,
  names: readonly string[],
  maxGrowth = 1.35,
): string | null {
  const wantedNumbers = numbersOf(draft);
  const gotNumbers = numbersOf(candidate);
  if (!sameSet(wantedNumbers, gotNumbers)) {
    const missing = [...wantedNumbers].filter((n) => !gotNumbers.has(n));
    const added = [...gotNumbers].filter((n) => !wantedNumbers.has(n));
    return `numbers changed (missing ${missing.join(',') || '-'}, added ${added.join(',') || '-'})`;
  }
  if (LINK_RE.test(candidate) && !LINK_RE.test(draft)) return 'link added';
  const lowerDraft = draft.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();
  for (const name of names) {
    const wanted = name.toLowerCase();
    if (wanted.length >= 3 && lowerDraft.includes(wanted) && !lowerCandidate.includes(wanted)) return `name dropped: ${name}`;
  }
  if (NEGATION_IN_DRAFT.test(draft) && !NEGATION_IN_REWRITE.test(candidate)) return 'negation lost';
  // A question the draft asks ("Which pickup date would you like?") must still be asked.
  if (/[?؟]/.test(draft) && !/[?؟]/.test(candidate)) return 'question lost';
  // A rewrite is never much longer than what it rewrites (no invented extra sentences).
  return candidate.length <= Math.max(draft.length * maxGrowth, 160) ? null : 'too long';
}

export function keepsFacts(draft: string, candidate: string, names: readonly string[]): boolean {
  return factLoss(draft, candidate, names) === null;
}
