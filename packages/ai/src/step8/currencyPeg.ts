/**
 * The one fixed exchange rate this system trusts: the UAE dirham is pegged to the US dollar
 * (1 USD = 3.6725 AED, set by the central bank). A catalog row priced in USD can therefore be
 * shown and quoted in AED exactly. Any other currency pair has no fixed rate, so it is NOT
 * converted: the caller keeps the original currency (or fails loudly), never guesses a rate.
 */
export const USD_AED_PEG = 3.6725;

/** How many `to` units one `from` unit is worth, or null when there is no fixed rate. */
export function pegRate(from: string, to: string): number | null {
  if (from === to) return 1;
  if (from === 'USD' && to === 'AED') return USD_AED_PEG;
  if (from === 'AED' && to === 'USD') return 1 / USD_AED_PEG;
  return null;
}

/** `amount` in `from` converted to `to` and rounded to 2 decimals; null when there is no fixed rate. */
export function convertPegged(amount: number, from: string, to: string): number | null {
  const rate = pegRate(from, to);
  return rate === null ? null : Math.round(amount * rate * 100) / 100;
}
