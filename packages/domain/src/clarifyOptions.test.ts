import { describe, expect, it } from 'vitest';
import { CONTACT_TEAM_LABEL, parseClarifyOptions, splitClarifyMessage } from './clarifyOptions.js';

const MESSAGE = `Did you mean one of these?

1) What are the cheapest and most expensive cars per day and per hour?
2) I want to choose a car
3) Get a price quote
4) ${CONTACT_TEAM_LABEL}

Reply with 1, 2, 3 or 4.`;

describe('clarify options', () => {
  it('reads the numbered options in order', () => {
    expect(parseClarifyOptions(MESSAGE)).toEqual([
      'What are the cheapest and most expensive cars per day and per hour?',
      'I want to choose a car',
      'Get a price quote',
      CONTACT_TEAM_LABEL,
    ]);
  });

  it('reads the same options when WhatsApp bold markers are present', () => {
    const bold = MESSAGE.replace(/^(\d\) .+)$/gm, '*$1*');
    expect(parseClarifyOptions(bold)).toHaveLength(4);
  });

  it('splits a message into its intro and options', () => {
    expect(splitClarifyMessage(MESSAGE)).toMatchObject({
      intro: 'Did you mean one of these?',
      options: expect.arrayContaining([CONTACT_TEAM_LABEL]),
    });
  });

  it('is not fooled by ordinary text that happens to contain a number', () => {
    expect(splitClarifyMessage('We have 3) cars')).toBeNull();
    expect(splitClarifyMessage('Totals:\n2) second\n1) first')).toBeNull();
  });
});
