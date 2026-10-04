import { RequiredField, type MissingField, type RequiredFieldValue } from '@ai-concierge/domain';

const FIELD_PHRASES: Record<RequiredFieldValue, (detail?: string) => string> = {
  [RequiredField.PICKUP_DATE]: (detail) =>
    detail && /past/i.test(detail)
      ? 'a pickup date from today onwards (the date you gave has already passed)'
      : detail
        ? `your exact pickup date (${detail})`
        : 'when you would like to pick up the car',
  [RequiredField.RETURN_DATE]: (detail) =>
    detail && /after the pickup/i.test(detail)
      ? 'a return date that is after your pickup date'
      : detail
        ? `your exact return date (${detail})`
        : 'when you would like to return the car',
  [RequiredField.PICKUP_LOCATION]: (detail) =>
    detail ? `your pickup location (${detail})` : 'where you would like to pick up the car',
  [RequiredField.VEHICLE]: (detail) =>
    detail && !/no vehicle preference/i.test(detail)
      ? `which vehicle you would like (${detail})`
      : 'which vehicle you would like to rent',
};

function joinWithOxfordComma(phrases: string[]): string {
  if (phrases.length === 1) return phrases[0]!;
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`;
}

/**
 * Deterministic, template-based — no LLM call. One combined question rather
 * than one message per gap, so the customer isn't asked several separate
 * questions in a row for a single reply.
 */
export function buildClarificationPrompt(missingFields: MissingField[]): string | null {
  if (missingFields.length === 0) return null;
  const phrases = missingFields.map((field) => FIELD_PHRASES[field.field](field.detail));
  return `Could you please confirm ${joinWithOxfordComma(phrases)}?`;
}
