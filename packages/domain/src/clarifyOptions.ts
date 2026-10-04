/**
 * The numbered options the concierge offers when it did not understand a message:
 *
 *   I want to be sure I help with the right thing. Did you mean one of these?
 *
 *   1) ...
 *   2) ...
 *   3) ...
 *   4) Contact my team
 *
 *   Reply with 1, 2, 3 or 4.
 *
 * Kept in the domain package because both sides read the same text: the engine reads the customer's
 * pick back from the message it sent, and the website chat draws the options as highlighted buttons.
 */

export const CONTACT_TEAM_LABEL = 'Contact my team';

/** One option line, with or without the `*bold*` markers WhatsApp gets. */
export const CLARIFY_OPTION_LINE_RE = /^\s*\*?([1-4])\)\s+(.+?)\*?\s*$/;

/** The numbered options in a message we sent, in order; empty when it offered none. */
export function parseClarifyOptions(text: string): string[] {
  const options: string[] = [];
  for (const line of text.split('\n')) {
    const match = CLARIFY_OPTION_LINE_RE.exec(line);
    if (match && Number(match[1]) === options.length + 1) options.push(match[2]!.trim());
  }
  return options;
}

export interface ClarifyMessageParts {
  /** The sentence before the options. */
  intro: string;
  options: string[];
}

/** A message split into its intro and its options, or `null` when it does not offer options. */
export function splitClarifyMessage(text: string): ClarifyMessageParts | null {
  const options = parseClarifyOptions(text);
  if (options.length < 2) return null;
  const firstOption = text.split('\n').findIndex((line) => CLARIFY_OPTION_LINE_RE.test(line));
  const intro = text.split('\n').slice(0, firstOption).join('\n').trim();
  return { intro, options };
}
