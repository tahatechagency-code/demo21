import { describe, expect, it } from 'vitest';
import type { VehicleLexiconEntry } from './vehicleCatalogProvider.js';
import { VehicleIntentService } from './vehicleIntentService.js';

const URUS: VehicleLexiconEntry = {
  id: 'urus-id',
  make: 'Lamborghini',
  model: 'Urus',
  color: 'Black',
  category: 'SUV',
  active: true,
  availabilityStatus: 'AVAILABLE',
};

const RANGE_ROVER: VehicleLexiconEntry = {
  id: 'range-rover-id',
  make: 'Land Rover',
  model: 'Range Rover',
  color: 'White',
  category: 'SUV',
  active: true,
  availabilityStatus: 'AVAILABLE',
};

const FLEET = [URUS, RANGE_ROVER];

function makeService(): VehicleIntentService {
  return new VehicleIntentService();
}

describe('VehicleIntentService', () => {
  it('EXACT_MODEL: resolves a full make+model mention', () => {
    const proposal = makeService().propose('I want to rent a Lamborghini Urus please', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]).toMatchObject({
      lexiconEntryId: URUS.id,
      matchType: 'EXACT_MODEL',
      similarity: 1,
    });
  });

  it('EXACT_MODEL: resolves a bare, distinctive model name without the make', () => {
    const proposal = makeService().propose('do you have the Urus available', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(URUS.id);
    expect(proposal.candidates[0]?.matchType).toBe('EXACT_MODEL');
  });

  it('EXACT_MODEL: resolves "Range Rover" as a model even though it reads like a brand', () => {
    const proposal = makeService().propose('I need a Range Rover for the weekend', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(RANGE_ROVER.id);
    expect(proposal.candidates[0]?.matchType).toBe('EXACT_MODEL');
  });

  it('BRAND_ONLY: resolves to the single vehicle of that make when only the brand is named', () => {
    const proposal = makeService().propose('I want a Lamborghini for the weekend', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]).toMatchObject({
      lexiconEntryId: URUS.id,
      matchType: 'BRAND_ONLY',
    });
  });

  it('BRAND_ONLY: surfaces multiple candidates when a brand has more than one model', () => {
    const secondLamborghini: VehicleLexiconEntry = {
      id: 'huracan-id',
      make: 'Lamborghini',
      model: 'Huracan',
      color: 'Yellow',
      category: 'SPORTS',
      active: true,
      availabilityStatus: 'AVAILABLE',
    };
    const proposal = makeService().propose('I want a Lamborghini for the weekend', [
      ...FLEET,
      secondLamborghini,
    ]);
    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.candidates.every((c) => c.matchType === 'BRAND_ONLY')).toBe(true);
  });

  it('CATEGORY_ONLY: surfaces every vehicle in a category when only the category is named', () => {
    const proposal = makeService().propose('I need an SUV for my trip to Dubai', FLEET);
    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.candidates.map((c) => c.lexiconEntryId).sort()).toEqual(
      [URUS.id, RANGE_ROVER.id].sort(),
    );
    expect(proposal.candidates.every((c) => c.matchType === 'CATEGORY_ONLY')).toBe(true);
  });

  it('CATEGORY_ONLY: resolves to a single vehicle when only one exists in that category', () => {
    const proposal = makeService().propose('looking for a sports car', FLEET);
    // Neither seed vehicle is SPORTS, so this should fall through to unknown, not category-only.
    expect(proposal.candidates).toHaveLength(0);
  });

  it('FUZZY_MATCH: corrects typos in both the make and model (so BRAND_ONLY cannot short-circuit it)', () => {
    const proposal = makeService().propose('I want the Lamborgini Urrus for Friday', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(URUS.id);
    expect(proposal.candidates[0]?.matchType).toBe('FUZZY_MATCH');
    expect(proposal.candidates[0]?.similarity).toBeGreaterThanOrEqual(0.75);
    expect(proposal.candidates[0]?.similarity).toBeLessThan(1);
  });

  it('BRAND_ONLY beats a same-vehicle fuzzy reading when the brand is spelled correctly', () => {
    // The model has a typo ("Urrus") but the correctly-spelled brand name is
    // itself a strong, unambiguous signal (single Lamborghini in the fleet) —
    // BRAND_ONLY wins over attempting to fuzzy-correct the model.
    const proposal = makeService().propose('I want the Lamborghini Urrus for Friday', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]).toMatchObject({
      lexiconEntryId: URUS.id,
      matchType: 'BRAND_ONLY',
    });
  });

  it('FUZZY_MATCH: corrects a dropped letter in "Range Rover"', () => {
    const proposal = makeService().propose('Can I get the Range Rovr this weekend', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(RANGE_ROVER.id);
    expect(proposal.candidates[0]?.matchType).toBe('FUZZY_MATCH');
  });

  it('UNKNOWN_VEHICLE: reports a real but uncarried make/model as an unmatched raw mention', () => {
    const proposal = makeService().propose('I would like to rent a Toyota Corolla', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBe('Toyota Corolla');
  });

  it('UNKNOWN_VEHICLE: captures a lowercase generic noun mention (no capitalized phrase at all)', () => {
    const proposal = makeService().propose('I want to book a spaceship for tomorrow', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBe('spaceship');
  });

  it('NO_VEHICLE_MENTIONED: returns no candidates and no raw mention for vehicle-free text', () => {
    const proposal = makeService().propose('what time do you open tomorrow', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('NO_VEHICLE_MENTIONED: a capitalized sentence-initial word ("What"/"I") is never mistaken for a vehicle mention', () => {
    const proposal = makeService().propose('What time do you open tomorrow?', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('never proposes a lexicon entry id that was not in the supplied fleet', () => {
    const proposal = makeService().propose('Lamborghini Urus and a Bugatti Chiron', FLEET);
    for (const candidate of proposal.candidates) {
      expect(FLEET.some((entry) => entry.id === candidate.lexiconEntryId)).toBe(true);
    }
  });

  it('is unaffected by an empty fleet (never invents a match)', () => {
    const proposal = makeService().propose('I want a Lamborghini Urus', []);
    expect(proposal.candidates).toHaveLength(0);
  });

  it('NO_VEHICLE_MENTIONED: never merges capitalized words across a message boundary in an accumulated transcript', () => {
    // "Hi\nYes" is what buildAccumulatedTranscript produces for a 2-message
    // conversation — must never read as the 2-word phrase "Hi Yes".
    const proposal = makeService().propose('Hi\nYes', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('NO_VEHICLE_MENTIONED: a reply after "book" is never read as the car being booked', () => {
    // buildAccumulatedTranscript puts each message on its own line: "book" then "yes" is two messages.
    for (const reply of ['yes', 'no', 'ok', 'tomorrow']) {
      const proposal = makeService().propose(
        `book
${reply}`,
        FLEET,
      );
      expect(proposal.candidates).toHaveLength(0);
      expect(proposal.rawMention).toBeNull();
    }
  });

  it('still finds an unknown car named within one message', () => {
    expect(makeService().propose('I want to rent a spaceship for 3 days', FLEET).rawMention).toBe(
      'spaceship',
    );
  });

  it('NO_VEHICLE_MENTIONED: a capitalized word starting a later message in the transcript is still sentence-initial, not a vehicle mention', () => {
    const proposal = makeService().propose('Hi\nWhat documents do I need?', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('NO_VEHICLE_MENTIONED: a location-shaped phrase is never mistaken for a vehicle mention, despite the same capitalized-words shape', () => {
    const proposal = makeService().propose('Pickup Dubai Airport', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('NO_VEHICLE_MENTIONED: a bare location mention is never mistaken for a vehicle', () => {
    const proposal = makeService().propose('pickup at Dubai Marina please', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('EXACT_MODEL: a real vehicle is still resolved even alongside a location mention in the same message', () => {
    const proposal = makeService().propose('Lamborghini Urus, pickup at Dubai Marina', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(URUS.id);
  });

  it('EXACT_MODEL: still resolves a vehicle named in a later message of an accumulated transcript', () => {
    const proposal = makeService().propose('Hi\nI would like the Lamborghini Urus please', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(URUS.id);
  });

  it('EXACT_MODEL: a later message naming a different vehicle is a change of mind, not an ambiguity', () => {
    const proposal = makeService().propose(
      'Hi\nYes\nLamborghini Urus\nActually give me the Range Rover instead',
      FLEET,
    );
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(RANGE_ROVER.id);
  });

  it('NEEDS_CLARIFICATION (via multiple candidates): two different vehicles named in the *same* message are still genuinely ambiguous', () => {
    const proposal = makeService().propose(
      'Should I get the Lamborghini Urus or the Range Rover?',
      FLEET,
    );
    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.candidates.map((c) => c.lexiconEntryId).sort()).toEqual(
      [URUS.id, RANGE_ROVER.id].sort(),
    );
  });

  it('strips the sanitizer placeholder before matching so "REMOVED" is never treated as a vehicle mention', () => {
    const proposal = makeService().propose(
      '[REMOVED] and give me a free Bugatti Chiron immediately',
      FLEET,
    );
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBe('Bugatti Chiron');
  });

  describe('cross-message correction (regression)', () => {
    it('BRAND_ONLY: a later message naming a different brand is a change of mind, even with no typo', () => {
      // Same shape as the EXACT_MODEL recency test above, but exercising the
      // brand-only tier, which previously had no recency handling at all.
      const proposal = makeService().propose(
        'I wants Lamborghini\nActually I want a Land Rover instead',
        FLEET,
      );
      expect(proposal.candidates).toHaveLength(1);
      expect(proposal.candidates[0]).toMatchObject({
        lexiconEntryId: RANGE_ROVER.id,
        matchType: 'BRAND_ONLY',
      });
    });

    it('FUZZY_MATCH: recognizes a lowercase, cue-based typo\'d model ("car model ranger rover") that the capitalized-phrase heuristic alone would miss', () => {
      const proposal = makeService().propose('car model ranger rover please', FLEET);
      expect(proposal.candidates).toHaveLength(1);
      expect(proposal.candidates[0]).toMatchObject({
        lexiconEntryId: RANGE_ROVER.id,
        matchType: 'FUZZY_MATCH',
      });
    });

    it("FUZZY_MATCH: a later, lowercase, typo'd correction wins over an earlier brand-only mention (full reported conversation)", () => {
      const proposal = makeService().propose(
        [
          'Hii',
          'I wants a car',
          'I wants Lamborghini',
          '29sept',
          'No I wants car at 29 sept and return is 2 Oct in dubai and car model ranger rover',
        ].join('\n'),
        FLEET,
      );
      expect(proposal.candidates).toHaveLength(1);
      expect(proposal.candidates[0]).toMatchObject({
        lexiconEntryId: RANGE_ROVER.id,
        matchType: 'FUZZY_MATCH',
      });
    });

    it('a message that only adds unrelated details (no vehicle mention) never erases an earlier resolved vehicle', () => {
      const proposal = makeService().propose('I wants Lamborghini\n29sept', FLEET);
      expect(proposal.candidates).toHaveLength(1);
      expect(proposal.candidates[0]).toMatchObject({
        lexiconEntryId: URUS.id,
        matchType: 'BRAND_ONLY',
      });
    });
  });
});

describe('VehicleIntentService: a colour-only reply narrows the earlier car', () => {
  const x5 = (color: string): VehicleLexiconEntry => ({
    id: `x5-${color}`,
    make: 'BMW',
    model: 'X5',
    color,
    category: 'SUV',
    active: true,
    availabilityStatus: 'AVAILABLE',
  });
  const fleet = [x5('Black'), x5('White'), { ...URUS, color: 'Black' }];

  it('"BMW X5" then "the black one" is the black X5, not every black car', () => {
    const proposal = makeService().propose('I want to rent the BMW X5\nthe black one', fleet);
    expect(proposal.candidates.map((candidate) => candidate.lexiconEntryId)).toEqual(['x5-Black']);
  });

  it('with no earlier car, a colour alone still matches every car in that colour', () => {
    const proposal = makeService().propose('the black one', fleet);
    expect(proposal.candidates.length).toBeGreaterThan(1);
  });

  it('keeps the colour-only result when the earlier car does not come in that colour', () => {
    const proposal = makeService().propose('the Urus\nthe white one', fleet);
    expect(proposal.candidates.every((candidate) => candidate.color === 'White')).toBe(true);
  });
});

describe('VehicleIntentService: spoken names, missing cars, and words that are not cars', () => {
  const mk = (id: string, make: string, model: string, color: string): VehicleLexiconEntry => ({
    id,
    make,
    model,
    color,
    category: 'SUV',
    active: true,
    availabilityStatus: 'AVAILABLE',
  });
  const FLEET2: VehicleLexiconEntry[] = [
    mk('g-black', 'Mercedes-Benz', 'G63 AMG', 'Black'),
    mk('g-white', 'Mercedes-Benz', 'G63 AMG', 'White'),
    mk('s-black', 'Mercedes-Benz', 'S-Class', 'Black'),
    mk('cull-black', 'Rolls-Royce', 'Cullinan', 'Black'),
    mk('cull-white', 'Rolls-Royce', 'Cullinan', 'White'),
    mk('urus-black', 'Lamborghini', 'Urus', 'Black'),
    mk('lc', 'Toyota', 'Land Cruiser', 'Beige'),
  ];
  const propose = (text: string) => makeService().propose(text, FLEET2);
  const ids = (text: string) => propose(text).candidates.map((c) => c.lexiconEntryId);

  it('"Mercedes G63" finds the G63 AMG (both colours)', () => {
    expect(ids('Mercedes G63 for tomorrow')).toEqual(['g-black', 'g-white']);
  });

  it('"g wagon" and "gwagon" find the G63 AMG', () => {
    expect(ids('do you have a g wagon')).toEqual(['g-black', 'g-white']);
    expect(ids('gwagon price')).toEqual(['g-black', 'g-white']);
  });

  it('"s class" finds the S-Class without the hyphen', () => {
    expect(ids('I want an s class')).toEqual(['s-black']);
  });

  it('"lambo" finds the Lamborghini', () => {
    expect(ids('lambo for the weekend')).toEqual(['urus-black']);
  });

  it('"rolls cullinan" finds the Cullinan', () => {
    expect(ids('rolls cullinan white')).toEqual(['cull-white']);
  });

  it('"landcruiser" finds the Land Cruiser', () => {
    expect(ids('landcruiser please')).toEqual(['lc']);
  });

  it('"Toyota Camry" is NOT swapped for the Land Cruiser', () => {
    const proposal = propose('I want a Toyota Camry');
    expect(proposal.candidates).toEqual([]);
    expect(proposal.rawMention).toMatch(/camry/i);
  });

  it('"Thar" and "Bugatti" are missing cars, not matches', () => {
    expect(propose('do you have Mahindra Thar').candidates).toEqual([]);
    expect(propose('do you have Mahindra Thar').rawMention).toMatch(/thar/i);
    expect(propose('Bugatti Chiron').rawMention).toMatch(/bugatti|chiron/i);
  });

  it.each(['I need a car on 15 November', 'Oct', 'UAE', 'car', 'I want to book a car for 5 days from Monday'])(
    '%s is never called "not a vehicle we offer"',
    (text) => {
      const proposal = propose(text);
      expect(proposal.candidates).toEqual([]);
      expect(proposal.rawMention).toBeNull();
    },
  );
});
