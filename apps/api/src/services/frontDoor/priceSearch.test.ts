import { describe, expect, it } from 'vitest';
import {
  describePriceSearch,
  priceSearchReply,
  searchFleetByPrice,
  type PriceSearchVehicle,
} from './priceSearch.js';

const car = (
  make: string,
  model: string,
  color: string,
  dailyRate: number,
  currency = 'USD',
  active = true,
): PriceSearchVehicle => ({
  make,
  model,
  color,
  active,
  pricingProfile: { currency, dailyRate },
});

const FLEET = [
  car('Toyota', 'Land Cruiser', 'Beige', 230),
  car('Ford', 'Mustang', 'Blue', 220),
  car('Ford', 'Mustang', 'Black', 240),
  car('Land Rover', 'Range Rover', 'Black', 490),
  car('Lamborghini', 'Urus', 'Yellow', 953),
  car('BMW', 'M4', 'Grey', 150, 'USD', false),
];

describe('searchFleetByPrice', () => {
  it('groups colours into one car priced at its lowest rate, cheapest first', () => {
    const { all } = searchFleetByPrice(FLEET, { min: null, max: null });
    expect(all.map((model) => [model.name, model.daily])).toEqual([
      ['Ford Mustang', 220],
      ['Toyota Land Cruiser', 230],
      ['Land Rover Range Rover', 490],
      ['Lamborghini Urus', 953],
    ]);
  });

  it('leaves out cars that are switched off', () => {
    const { all } = searchFleetByPrice(FLEET, { min: null, max: null });
    expect(all.some((model) => model.name === 'BMW M4')).toBe(false);
  });

  it('finds the cars under a budget with their per-hour figure', () => {
    const { matches } = searchFleetByPrice(FLEET, { min: null, max: 300 });
    expect(matches.map((model) => model.name)).toEqual(['Ford Mustang', 'Toyota Land Cruiser']);
    expect(matches[0]?.hourly).toBe(9.17);
  });

  it('honours a floor and a range', () => {
    expect(searchFleetByPrice(FLEET, { min: 400, max: null }).matches).toHaveLength(2);
    expect(searchFleetByPrice(FLEET, { min: 225, max: 500 }).matches.map((m) => m.name)).toEqual([
      'Toyota Land Cruiser',
      'Land Rover Range Rover',
    ]);
  });

  it('shows dirham-priced cars in dollars', () => {
    const { all } = searchFleetByPrice([car('Lamborghini', 'Urus', 'Yellow', 3500, 'AED')], {
      min: null,
      max: null,
    });
    expect(all[0]?.daily).toBe(953.03);
  });
});

describe('priceSearchReply', () => {
  it('names the lowest and highest car in the budget, per day and per hour', () => {
    const reply = priceSearchReply(searchFleetByPrice(FLEET, { min: null, max: 300 }));
    expect(reply).toContain('at or under $300 per day');
    expect(reply).toContain('The lowest is the Ford Mustang $220 per day (about $9.17 per hour)');
    expect(reply).toContain(
      'highest is the Toyota Land Cruiser $230 per day (about $9.58 per hour)',
    );
    expect(reply).not.toMatch(/AED/);
  });

  it('says plainly when nothing fits and offers the cheapest car', () => {
    const reply = priceSearchReply(searchFleetByPrice(FLEET, { min: null, max: 100 }));
    expect(reply).toContain('No car is at or under $100 per day');
    expect(reply).toContain('Ford Mustang $220 per day');
  });

  it('answers a question about the ends of the whole range', () => {
    const reply = priceSearchReply(searchFleetByPrice(FLEET, { min: null, max: null }));
    expect(reply).toContain('The lowest is the Ford Mustang');
    expect(reply).toContain('the highest is the Lamborghini Urus $953 per day');
  });
});

describe('describePriceSearch', () => {
  it('lists only database numbers for Gemini to use', () => {
    const facts = describePriceSearch(searchFleetByPrice(FLEET, { min: null, max: 300 }));
    expect(facts).toContain('Cars found (2)');
    expect(facts).toContain('Lowest price in this search: Ford Mustang $220 per day');
    expect(facts).toContain('Highest price in this search: Toyota Land Cruiser $230 per day');
  });

  it('reports an empty search instead of inventing a car', () => {
    const facts = describePriceSearch(searchFleetByPrice(FLEET, { min: null, max: 100 }));
    expect(facts).toContain('Cars found: none.');
  });
});
