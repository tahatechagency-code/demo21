import { buildFleetKnowledge, type FleetKnowledge, type FleetRowInput } from '../fleetKnowledge.js';

type Spec = [
  make: string,
  model: string,
  category: string,
  tier: string,
  seats: number,
  luggage: number,
  rate: number,
  colours: string[],
];

/** The starter fleet of the seed, as the engine sees it (2 units per colour). */
const SPECS: Spec[] = [
  ['Lamborghini', 'Urus', 'SUV', 'ULTRA_LUXURY', 5, 4, 3500, ['Black', 'White']],
  ['Land Rover', 'Range Rover', 'SUV', 'LUXURY', 5, 5, 1800, ['White', 'Black']],
  ['Land Rover', 'Range Rover Sport', 'SUV', 'LUXURY', 5, 4, 1600, ['Grey']],
  ['BMW', 'X5', 'SUV', 'LUXURY', 5, 5, 1200, ['Black', 'White']],
  ['BMW', 'X7', 'SUV', 'LUXURY', 7, 5, 1600, ['Black']],
  ['BMW', 'M5', 'SEDAN', 'LUXURY', 5, 4, 1400, ['Blue']],
  ['Mercedes-Benz', 'G63 AMG', 'SUV', 'ULTRA_LUXURY', 5, 4, 3200, ['Black', 'White']],
  ['Mercedes-Benz', 'S-Class', 'SEDAN', 'ULTRA_LUXURY', 5, 5, 2200, ['Black', 'Silver']],
  ['Mercedes-Benz', 'GLE', 'SUV', 'LUXURY', 5, 5, 1300, ['White']],
  ['Porsche', 'Cayenne', 'SUV', 'LUXURY', 5, 4, 1700, ['Black', 'Grey']],
  ['Porsche', '911', 'COUPE', 'ULTRA_LUXURY', 4, 2, 2500, ['Red', 'Black']],
  ['Porsche', 'Panamera', 'SEDAN', 'LUXURY', 5, 4, 1900, ['Black']],
  ['Rolls-Royce', 'Cullinan', 'SUV', 'ULTRA_LUXURY', 5, 4, 6500, ['Black', 'White']],
  ['Rolls-Royce', 'Ghost', 'SEDAN', 'ULTRA_LUXURY', 5, 4, 5500, ['Black']],
  ['Bentley', 'Bentayga', 'SUV', 'ULTRA_LUXURY', 5, 4, 3800, ['Green']],
  ['Bentley', 'Continental GT', 'COUPE', 'ULTRA_LUXURY', 4, 3, 3600, ['Silver']],
  ['Ferrari', '488 Spider', 'CONVERTIBLE', 'ULTRA_LUXURY', 2, 2, 4500, ['Red']],
  ['Ferrari', 'Roma', 'COUPE', 'ULTRA_LUXURY', 4, 2, 4000, ['Red', 'Black']],
  ['Audi', 'Q8', 'SUV', 'LUXURY', 5, 5, 1200, ['Grey']],
  ['Audi', 'RS Q8', 'SUV', 'ULTRA_LUXURY', 5, 5, 2100, ['Black']],
  ['Maserati', 'Levante', 'SUV', 'LUXURY', 5, 4, 1500, ['White']],
  ['Maserati', 'Ghibli', 'SEDAN', 'LUXURY', 5, 4, 1300, ['Blue']],
  ['McLaren', '720S', 'COUPE', 'ULTRA_LUXURY', 2, 2, 5000, ['Orange']],
  ['Aston Martin', 'DBX', 'SUV', 'ULTRA_LUXURY', 5, 4, 3000, ['Green', 'Black']],
  ['Tesla', 'Model X', 'SUV', 'LUXURY', 6, 4, 1400, ['White', 'Black']],
  ['Nissan', 'Patrol', 'SUV', 'PREMIUM', 7, 5, 900, ['White']],
  ['Chevrolet', 'Camaro', 'COUPE', 'PREMIUM', 4, 2, 700, ['Yellow']],
  ['Chevrolet', 'Corvette', 'SPORTS', 'LUXURY', 2, 2, 1100, ['Red']],
  ['Ford', 'Mustang', 'CONVERTIBLE', 'PREMIUM', 4, 2, 800, ['Blue', 'Black']],
  ['Toyota', 'Land Cruiser', 'SUV', 'PREMIUM', 7, 5, 850, ['Beige']],
];

export function fixtureRows(overrides: (row: FleetRowInput) => Partial<FleetRowInput> = () => ({})): FleetRowInput[] {
  let n = 0;
  return SPECS.flatMap(([make, model, category, luxuryTier, seats, luggage, dailyRate, colours]) =>
    colours.map((color) => {
      n += 1;
      const row: FleetRowInput = {
        id: `veh-${n}`,
        make,
        model,
        color,
        category,
        luxuryTier,
        seats,
        luggage,
        transmission: 'AUTOMATIC',
        dailyRate,
        depositAmount: dailyRate >= 3000 ? 10000 : 5000,
        currency: 'AED',
        active: true,
        availabilityStatus: 'AVAILABLE',
        totalUnits: 2,
        bookedUnits: 0,
        maintenanceUnits: 0,
      };
      return { ...row, ...overrides(row) };
    }),
  );
}

export function fixtureFleet(
  overrides: (row: FleetRowInput) => Partial<FleetRowInput> = () => ({}),
): FleetKnowledge {
  return buildFleetKnowledge(fixtureRows(overrides), 'AED');
}
