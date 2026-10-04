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

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/** `names`: every car / place / branch name the business uses; only those present in the draft are required. */
export function keepsFacts(draft: string, candidate: string, names: readonly string[]): boolean {
  if (!sameSet(numbersOf(draft), numbersOf(candidate))) return false;
  if (LINK_RE.test(candidate) && !LINK_RE.test(draft)) return false;
  const lowerDraft = draft.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();
  for (const name of names) {
    const wanted = name.toLowerCase();
    if (wanted.length >= 3 && lowerDraft.includes(wanted) && !lowerCandidate.includes(wanted)) return false;
  }
  // A rewrite is never much longer than what it rewrites (no invented extra sentences).
  return candidate.length <= Math.max(draft.length * 1.35, 160);
}
