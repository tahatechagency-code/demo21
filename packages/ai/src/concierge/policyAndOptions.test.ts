import { describe, expect, it } from 'vitest';
import { FaqTopic } from '../router/faqTopics.js';
import { fixtureFleet } from './test/fleetFixture.js';
import { DEFAULT_BUSINESS_PROFILE as profile } from './profile.js';
import { answerPolicy, detectPolicyTopic, type PolicyContext } from './policyFaq.js';
import {
  OPTION_REPEAT,
  OPTION_TEAM,
  formatOptions,
  parseNumberedOptions,
  parseOptionPick,
  probabilityQuestions,
  stageOneOptions,
  stageTwoOptions,
  usableOption,
  wantsTeamByWords,
} from './options.js';

const fleet = fixtureFleet();
const ctx = (configured: [string, string][] = []): PolicyContext => ({
  profile,
  fleet,
  minAgeByTier: { ULTRA_LUXURY: 25 },
  policyMinAge: 21,
  vatPercent: 5,
  configured: new Map(configured as [(typeof FaqTopic)[keyof typeof FaqTopic], string][]),
});
const ask = (text: string, c = ctx()) => answerPolicy(text, c);

describe('policy answers come from the owner terms', () => {
  it('states the minimum age (23) and the higher tier ages', () => {
    const a = ask('what is the minimum age to rent?')!;
    expect(a.kind).toBe('ANSWER');
    expect(a.text).toContain('23');
    expect(a.text).toContain('25');
    expect(a.text).toContain('Lamborghini Urus');
  });

  it('says no to a 22-year-old, with the number', () => {
    const a = ask("I'm 22, can I rent a Ferrari?")!;
    expect(a.kind).toBe('ANSWER');
    expect(a.text).toMatch(/under our minimum driver age of 23/);
  });

  it('allows a 24-year-old the standard fleet but not the top tier', () => {
    const a = ask("I am 24, can I rent a car?")!;
    expect(a.text).toMatch(/cannot|not/);
    expect(a.text).toContain('25');
  });

  it('allows a 30-year-old everything', () => {
    const a = ask("I'm 30, am I allowed to rent a Urus?")!;
    expect(a.text).toContain('meet our age requirement');
  });

  it('explains licence, IDP and passport', () => {
    expect(ask('which driving licence do you accept?')!.text).toMatch(/UAE driving licence|international driving permit/);
    expect(ask('do I need a passport?')!.text).toMatch(/passport/);
    expect(ask('what documents do I need')!.text).toMatch(/passport/);
  });

  it('answers the deposit from the fleet rows', () => {
    const a = ask('what is the security deposit for the Urus?')!;
    expect(a.text).toMatch(/AED 10,000/);
  });

  it('refuses cash and travel outside the UAE', () => {
    expect(ask('can I pay in cash?')!.text).toMatch(/do not accept cash/);
    expect(ask('can I take the car to Oman?')!.text).toMatch(/inside the UAE/);
    expect(ask('can I go off-road in the desert?')!.text).toMatch(/not allowed/);
  });

  it('quotes the delivery fees exactly', () => {
    const t = ask('how much is delivery?')!.text;
    expect(t).toContain('AED 100 in Dubai');
    expect(t).toContain('AED 150 in Sharjah');
    expect(t).toContain('AED 250');
    expect(t).toContain('100 km');
  });

  it('answers VAT and currency', () => {
    expect(ask('is VAT included?')!.text).toContain('5%');
    expect(ask('can you quote in dollars?')!.text).toMatch(/3\.6725/);
  });

  it('lists only confirmed branches', () => {
    const t = ask('where are your branches?')!.text;
    expect(t).toContain('Al Quoz');
    expect(t).not.toContain('Habtoor');
  });
});

describe('facts the owner has not supplied are never invented', () => {
  it.each(['is insurance included?', 'what is the mileage limit?', 'what time do you open?', 'is fuel included?'])(
    '%s',
    (text) => {
      const a = ask(text)!;
      expect(a.kind).toBe('UNCONFIGURED');
      expect(a.text).toMatch(/TEAM/);
    },
  );

  it('answers once the owner configures the fact', () => {
    const a = ask('is insurance included?', ctx([[FaqTopic.INSURANCE, 'Comprehensive insurance is included.']]))!;
    expect(a.kind).toBe('ANSWER');
    expect(a.text).toBe('Comprehensive insurance is included.');
  });
});

describe('detectPolicyTopic', () => {
  it('does not treat a booking message as policy', () => {
    for (const text of ['I want the Urus from 20 Oct to 25 Oct', 'hello', 'black one', 'Dubai Marina']) {
      expect(detectPolicyTopic(text)).toBeNull();
    }
  });
});

describe('option picks', () => {
  it.each([
    ['1', 1],
    ['2)', 2],
    ['option 3', 3],
    ['Number 2 please', 2],
    ['the second one', 2],
    ['four', 4],
    ['pehla', 1],
    ['4.', 4],
  ])('%s', (text, n) => expect(parseOptionPick(text)).toBe(n));

  it.each(['5', 'yes', 'show me the urus', 'I want 2 cars for 3 days', '0'])('%s is not a pick', (text) =>
    expect(parseOptionPick(text)).toBeNull(),
  );

  it('recognises asking for the team in words', () => {
    expect(wantsTeamByWords('contact my team')).toBe(true);
    expect(wantsTeamByWords('TEAM')).toBe(true);
    expect(wantsTeamByWords('I want to speak with a person')).toBe(true);
    expect(wantsTeamByWords('team leader of the Urus')).toBe(false);
  });
});

describe('the options ladder', () => {
  const summary = { vehicleName: 'Lamborghini Urus', hasDates: false, location: null, customerMessages: ['hmm the thing'] };

  it('stage 1 has a fleet suggestion, two likely meanings and the fixed repeat text', () => {
    const o = stageOneOptions(fleet, profile, summary);
    expect(o).toHaveLength(4);
    expect(o[0]).toMatch(/AED/);
    expect(o[3]).toBe(OPTION_REPEAT);
    expect(o[1]).not.toBe(o[2]);
  });

  it('stage 2 has three NEW questions and CONTACT MY TEAM', () => {
    const first = stageOneOptions(fleet, profile, summary);
    const o = stageTwoOptions(summary, first);
    expect(o).toHaveLength(4);
    expect(o[3]).toBe(OPTION_TEAM);
    for (const q of o.slice(0, 3)) expect(first).not.toContain(q);
    expect(new Set(o.slice(0, 3)).size).toBe(3);
  });

  it('round-trips through the message format', () => {
    const o = stageOneOptions(fleet, profile, summary);
    expect(parseNumberedOptions(formatOptions('Did you mean:', o))).toEqual(o);
  });

  it('rejects an unusable model-written option', () => {
    expect(usableOption(OPTION_TEAM)).toBe(false);
    expect(usableOption('x')).toBe(false);
    expect(usableOption('Do you want photos of the Urus?')).toBe(true);
    expect(usableOption('word '.repeat(30))).toBe(false);
  });

  it('without a car, asks general questions', () => {
    const q = probabilityQuestions({ vehicleName: null, hasDates: false, location: null, customerMessages: [] });
    expect(q.join(' ')).toMatch(/popular|SUV|deliver/);
  });
});
