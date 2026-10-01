import {
  CLARIFY_STAGE_FIRST,
  CLARIFY_STAGE_SECOND,
  CONTACT_TEAM_LABEL,
  parseClarifyOptions,
} from '@ai-concierge/ai';
import type { CollectedBookingInfo } from '@ai-concierge/domain';
import { describe, expect, it } from 'vitest';
import {
  buildClarifyReply,
  budgetHintFor,
  buildDatabaseQuestion,
  buildHedgeReply,
  progressFlags,
} from './clarification.js';

const NOTHING = {
  vehicle: null,
  pickupDate: null,
  returnDate: null,
  pickupLocation: null,
} as unknown as CollectedBookingInfo;

const WITH_CAR = {
  ...NOTHING,
  vehicle: { make: 'Land Rover', model: 'Range Rover', color: 'Black' },
} as unknown as CollectedBookingInfo;

describe('buildClarifyReply — first miss', () => {
  const reply = buildClarifyReply({
    round: 0,
    suggestions: ['I want to see photos of the Range Rover', 'I want to book it for tomorrow'],
    customerMessage: 'range?',
    collected: NOTHING,
    previousOptions: [],
  })!;
  const options = parseClarifyOptions(reply.text);

  it('offers: 1) the question repeated in detail, 2-3) two probable meanings, 4) the database question', () => {
    expect(reply.stage).toBe(CLARIFY_STAGE_FIRST);
    expect(options).toEqual([
      'Repeat my question in detail: "range?"',
      'I want to see photos of the Range Rover',
      'I want to book it for tomorrow',
      'What are the cheapest and most expensive cars per day and per hour?',
    ]);
    expect(options).not.toContain(CONTACT_TEAM_LABEL);
  });

  it('puts the repeat-in-detail option on top, as option 1', () => {
    expect(reply.text).toContain('1) Repeat my question in detail: "range?"');
  });

  it('refuses a suggested option that smuggles in a number the customer never wrote', () => {
    const smuggled = buildClarifyReply({
      round: 0,
      suggestions: ['Rent it for 300 dollars', 'I want to choose a car'],
      customerMessage: 'hmm',
      collected: NOTHING,
      previousOptions: [],
    })!;
    expect(smuggled.text).not.toContain('300');
  });

  it('offers a budget question built from the fleet, e.g. "I want a car under 400 dollars"', () => {
    const reply = buildClarifyReply({
      round: 0,
      suggestions: [],
      customerMessage: 'asdf',
      collected: NOTHING,
      previousOptions: [],
      budgetHint: 400,
    })!;
    expect(parseClarifyOptions(reply.text)[3]).toBe('I want a car under 400 dollars');
  });

  it('picks a round budget just above the middle of the fleet prices', () => {
    expect(budgetHintFor([326.75, 353.98, 1089.17])).toBe(400);
    expect(budgetHintFor([953.03])).toBe(1000);
    expect(budgetHintFor([40])).toBe(100);
    expect(budgetHintFor([])).toBeNull();
  });

  it('asks about the price of the chosen car once a car is chosen', () => {
    expect(buildDatabaseQuestion(WITH_CAR)).toBe(
      'What is the price of the Land Rover Range Rover per day and per hour?',
    );
  });

  it('still produces three options when the model gave no suggestions at all', () => {
    const fallback = buildClarifyReply({
      round: 0,
      suggestions: [],
      customerMessage: 'asdf',
      collected: NOTHING,
      previousOptions: [],
    })!;
    expect(parseClarifyOptions(fallback.text)).toHaveLength(4);
  });
});

describe('buildClarifyReply — second miss', () => {
  it('offers three new probable meanings that repeat nothing, then the team', () => {
    const first = buildClarifyReply({
      round: 0,
      suggestions: [],
      customerMessage: 'asdf',
      collected: NOTHING,
      previousOptions: [],
    })!;
    const previous = parseClarifyOptions(first.text);
    const second = buildClarifyReply({
      round: 1,
      suggestions: [],
      customerMessage: 'still asdf',
      collected: NOTHING,
      previousOptions: previous,
    })!;
    const options = parseClarifyOptions(second.text);
    expect(second.stage).toBe(CLARIFY_STAGE_SECOND);
    expect(options).toHaveLength(4);
    expect(options[3]).toBe(CONTACT_TEAM_LABEL);
    for (const option of options.slice(0, 3)) expect(previous).not.toContain(option);
  });

  it('hands over to a person after two rounds', () => {
    expect(
      buildClarifyReply({
        round: 2,
        suggestions: [],
        customerMessage: 'asdf',
        collected: NOTHING,
        previousOptions: [],
      }),
    ).toBeNull();
  });
});

describe('buildHedgeReply', () => {
  const carNames = ['Lamborghini Urus', 'Land Rover Range Rover', 'Toyota Land Cruiser', 'BMW M4'];

  it('tells the customer they have not selected a car yet and offers the real cars', () => {
    const reply = buildHedgeReply({ kinds: ['CAR'], collected: NOTHING, carNames })!;
    expect(reply.text).toContain("You haven't selected a car yet");
    expect(reply.stage).toBe(CLARIFY_STAGE_FIRST);
    expect(parseClarifyOptions(reply.text)).toEqual([
      'I want the Lamborghini Urus',
      'I want the Land Rover Range Rover',
      'I want the Toyota Land Cruiser',
      CONTACT_TEAM_LABEL,
    ]);
  });

  it('tells the customer they have not selected a place yet', () => {
    const reply = buildHedgeReply({ kinds: ['PLACE'], collected: NOTHING, carNames })!;
    expect(reply.text).toContain("You haven't selected a pickup place yet");
    expect(parseClarifyOptions(reply.text)[0]).toBe('Pick me up at Dubai Marina');
  });

  it('never claims the guess was recorded when a car is already chosen', () => {
    const reply = buildHedgeReply({ kinds: ['CAR'], collected: WITH_CAR, carNames })!;
    expect(reply.text).toContain("I've kept your current choice, the Land Rover Range Rover");
    expect(reply.text).not.toMatch(/you(?:'ve| have) (?:selected|chosen)/i);
  });

  it('asks for a clear date with no options', () => {
    const reply = buildHedgeReply({ kinds: ['DATE'], collected: NOTHING, carNames })!;
    expect(reply.text).toContain('confirm your pickup and return dates');
    expect(reply.stage).toBeUndefined();
  });

  it('says nothing when nothing was guessed', () => {
    expect(buildHedgeReply({ kinds: [], collected: NOTHING, carNames })).toBeNull();
  });
});

describe('progressFlags', () => {
  it('reads what the booking already has', () => {
    expect(progressFlags(NOTHING)).toEqual({ hasCar: false, hasDates: false, hasPlace: false });
    expect(progressFlags(WITH_CAR).hasCar).toBe(true);
  });
});
