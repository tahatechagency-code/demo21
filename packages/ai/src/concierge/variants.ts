/**
 * Phrasing variety without randomness: the same seed always gives the same wording (so a retry, a test
 * or a replay reads identically), while different conversations and different turns land on different
 * wordings. Every variant of a sentence carries the SAME facts — only the words around them change —
 * and facts are never produced here, they are passed in by the caller.
 */

/** FNV-1a: small, stable across runs and platforms. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The variant for `seed`; with no seed the first (canonical) wording, so callers that do not vary stay unchanged. */
export function pickVariant<T>(seed: string | undefined, options: readonly T[]): T {
  if (options.length === 0) throw new Error('pickVariant needs at least one option');
  if (seed === undefined) return options[0]!;
  return options[hash(seed) % options.length]!;
}
