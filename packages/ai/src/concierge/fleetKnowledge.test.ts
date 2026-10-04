import { describe, expect, it } from 'vitest';
import { resolveVehicleMention, popularModels, buildFleetKnowledge } from './fleetKnowledge.js';
import { DEFAULT_BUSINESS_PROFILE } from './profile.js';
import { fixtureFleet, fixtureRows } from './test/fleetFixture.js';

const fleet = fixtureFleet();
const resolve = (text: string) => resolveVehicleMention(text, fleet);
const modelNames = (text: string) => {
  const r = resolve(text);
  return r.kind === 'MODEL' ? r.models.map((m) => m.name) : r.kind;
};

describe('buildFleetKnowledge', () => {
  it('groups colours into one model and counts free units', () => {
    const urus = fleet.models.find((m) => m.name === 'Lamborghini Urus')!;
    expect(urus.colours).toEqual(['Black', 'White']);
    expect(urus.totalUnits).toBe(4);
    expect(urus.availableUnits).toBe(4);
    expect(urus.dailyRate).toBe(3500);
  });

  it('subtracts booked and maintenance units, and ignores inactive rows', () => {
    const f = buildFleetKnowledge(
      fixtureRows((row) =>
        row.model === 'Urus' && row.color === 'Black'
          ? { bookedUnits: 1, maintenanceUnits: 1 }
          : row.model === 'Ghost'
            ? { active: false }
            : {},
      ),
      'AED',
    );
    expect(f.models.find((m) => m.name === 'Lamborghini Urus')!.availableUnits).toBe(2);
    expect(f.models.find((m) => m.model === 'Ghost')).toBeUndefined();
  });

  it('counts a car that is not sellable as zero available', () => {
    const f = buildFleetKnowledge(
      fixtureRows((row) => (row.model === 'Roma' ? { availabilityStatus: 'MAINTENANCE' } : {})),
      'AED',
    );
    expect(f.models.find((m) => m.model === 'Roma')!.availableUnits).toBe(0);
  });
});

describe('resolveVehicleMention: cars in the fleet', () => {
  it.each([
    ['Do you have Cullinan?', ['Rolls-Royce Cullinan']],
    ['Mercedes G63 for 3 days', ['Mercedes-Benz G63 AMG']],
    ['g wagon available?', ['Mercedes-Benz G63 AMG']],
    ['I want a lambo', 'BRAND'],
    ['urus price', ['Lamborghini Urus']],
    ['rolls royce ghost', ['Rolls-Royce Ghost']],
    ['bentley continental', ['Bentley Continental GT']],
    ['land cruiser', ['Toyota Land Cruiser']],
    ['landcruiser tomorrow', ['Toyota Land Cruiser']],
    ['BMW X5 black', ['BMW X5']],
    ['porsche 911 red', ['Porsche 911']],
    ['ferrari roma', ['Ferrari Roma']],
    ['patrol 7 seater', ['Nissan Patrol']],
  ])('%s', (text, expected) => {
    expect(modelNames(text)).toEqual(expected);
  });

  it('reads a colour with the model', () => {
    const r = resolve('Range Rover black?');
    expect(r.kind).toBe('MODEL');
    if (r.kind === 'MODEL') {
      expect(r.models.map((m) => m.name)).toEqual(['Land Rover Range Rover']);
      expect(r.colour).toBe('Black');
    }
  });

  it('prefers Range Rover Sport over Range Rover when the Sport is named', () => {
    expect(modelNames('range rover sport please')).toEqual(['Land Rover Range Rover Sport']);
  });

  it('keeps both cars when two are named together', () => {
    const r = resolve('compare Urus & Cullinan');
    expect(r.kind).toBe('MODEL');
    if (r.kind === 'MODEL') expect(r.models.map((m) => m.model).sort()).toEqual(['Cullinan', 'Urus']);
  });

  it('maps a brand to its models', () => {
    const r = resolve('what bentley colors do you have');
    expect(r.kind).toBe('BRAND');
    if (r.kind === 'BRAND') expect(r.models.map((m) => m.model).sort()).toEqual(['Bentayga', 'Continental GT']);
  });

  it('tolerates a typo in the fleet name', () => {
    expect(modelNames('rolls royce cullinane')).toEqual(['Rolls-Royce Cullinan']);
    const r = resolve('lamborgini');
    expect(r.kind).toBe('BRAND');
  });
});

describe('resolveVehicleMention: cars NOT in the fleet are never replaced', () => {
  it.each([
    ['Mahindra Thar', 'Thar'],
    ['do you have Bugatti', 'Bugatti'],
    ['Toyota Camry', 'Toyota Camry'],
    ['I want a Honda Civic', 'Honda'],
    ['BMW M3', 'BMW M3'],
    ['Mercedes Maybach', 'Mercedes-Benz Maybach'],
    ['Rolls Royce Phantom', 'Rolls-Royce Phantom'],
  ])('%s', (text, mention) => {
    const r = resolve(text);
    expect(r.kind).toBe('NOT_IN_FLEET');
    if (r.kind === 'NOT_IN_FLEET') expect(r.mention.toLowerCase()).toContain(mention.toLowerCase().split(' ').pop()!);
  });

  it('lists the same brand when only the model is missing', () => {
    const r = resolve('Toyota Camry');
    expect(r.kind).toBe('NOT_IN_FLEET');
    if (r.kind === 'NOT_IN_FLEET') expect(r.sameBrand.map((m) => m.model)).toEqual(['Land Cruiser']);
  });
});

describe('resolveVehicleMention: words that are not cars', () => {
  it.each([
    '15 November',
    'Oct',
    'UAE',
    'car',
    'I need it tomorrow for 3 days',
    'pickup at Dubai Marina',
    'hello',
    'BMW for 3 days',
    'Mercedes on 20th',
    'Audi tomorrow please',
  ])('%s', (text) => {
    const r = resolve(text);
    expect(['NONE', 'BRAND']).toContain(r.kind);
  });

  it('reads categories', () => {
    for (const [text, category] of [
      ['convertible', 'CONVERTIBLE'],
      ['any SUV?', 'SUV'],
      ['sports car', 'SPORTS'],
      ['sedan for a meeting', 'SEDAN'],
    ] as const) {
      const r = resolve(text);
      expect(r.kind).toBe('CATEGORY');
      if (r.kind === 'CATEGORY') expect(r.category).toBe(category);
    }
  });
});

describe('popularModels', () => {
  it('puts the owner list first and only free cars when asked', () => {
    const top = popularModels(fleet, DEFAULT_BUSINESS_PROFILE, 3, { onlyAvailable: true });
    expect(top[0]!.name).toBe('Lamborghini Urus');
    expect(top).toHaveLength(3);
  });

  it('skips a booked-out car', () => {
    const f = fixtureFleet((row) => (row.model === 'Urus' ? { bookedUnits: 2 } : {}));
    const top = popularModels(f, DEFAULT_BUSINESS_PROFILE, 3, { onlyAvailable: true });
    expect(top.map((m) => m.model)).not.toContain('Urus');
  });
});
