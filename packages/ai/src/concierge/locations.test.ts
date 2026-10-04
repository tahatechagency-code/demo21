import { describe, expect, it } from 'vitest';
import {
  checkDelivery,
  deliveryFee,
  describeFee,
  haversineKm,
  isFridayOrHoliday,
  matchLocation,
  nearestBranch,
  type MapsProvider,
} from './locations.js';
import { DEFAULT_BUSINESS_PROFILE as profile, resolveBusinessProfile } from './profile.js';

describe('matchLocation', () => {
  it('finds a branch by its name', () => {
    const m = matchLocation('can I pick up from Al Quoz?', profile);
    expect(m.kind).toBe('BRANCH');
    if (m.kind === 'BRANCH') expect(m.branch.id).toBe('al-quoz');
  });

  it('finds the airport branch, not just "Dubai"', () => {
    const m = matchLocation('Dubai Airport Terminal 1 please', profile);
    expect(m.kind).toBe('BRANCH');
    if (m.kind === 'BRANCH') expect(m.branch.id).toBe('dxb-t1');
  });

  it('knows a covered area is a branch pickup', () => {
    const m = matchLocation('Rashidiya', profile);
    expect(m.kind).toBe('BRANCH');
  });

  it('knows an area that is not a branch', () => {
    const m = matchLocation('hotel in Dubai Marina', profile);
    expect(m.kind).toBe('PLACE');
    if (m.kind === 'PLACE') expect(m.place.emirate).toBe('DUBAI');
  });

  it('prefers the more specific place over the branch city', () => {
    const m = matchLocation('Sharjah airport', profile);
    expect(m.kind).toBe('PLACE');
    if (m.kind === 'PLACE') expect(m.place.isAirport).toBe(true);
  });

  it('does not offer a branch the owner has not confirmed', () => {
    const m = matchLocation('Habtoor Grand', profile);
    expect(m.kind).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for text with no place', () => {
    expect(matchLocation('I want a car', profile).kind).toBe('UNKNOWN');
  });
});

describe('haversine / nearestBranch', () => {
  it('measures a known distance', () => {
    // Dubai Marina to Dubai Airport is roughly 35 km straight.
    const km = haversineKm(25.0805, 55.1403, 25.2532, 55.3657);
    expect(km).toBeGreaterThan(28);
    expect(km).toBeLessThan(40);
  });

  it('picks the nearest confirmed branch and estimates road km', async () => {
    const near = await nearestBranch({ lat: 25.0805, lng: 55.1403 }, profile);
    expect(['dip-hq', 'jebel-ali']).toContain(near!.branch.id);
    expect(near!.estimated).toBe(true);
    expect(near!.roadKm).toBeGreaterThan(10);
  });

  it('prefers the measured route when a maps provider answers', async () => {
    const maps: MapsProvider = {
      name: 'fake',
      geocode: async () => null,
      drivingKm: async (from) => (from.lat > 25.2 ? 5 : 80),
    };
    const near = await nearestBranch({ lat: 25.21, lng: 55.38 }, profile, maps);
    expect(near!.estimated).toBe(false);
    expect(near!.roadKm).toBe(5);
  });
});

describe('checkDelivery: the 100 km rule', () => {
  it('delivers inside Dubai and charges the Dubai fee', async () => {
    const d = await checkDelivery({ message: 'deliver to Dubai Marina' }, profile);
    expect(d.kind).toBe('DELIVERY_POSSIBLE');
    if (d.kind === 'DELIVERY_POSSIBLE') {
      expect(d.fee.total).toBe(100);
      expect(d.from.roadKm).toBeLessThanOrEqual(100);
    }
  });

  it('charges the Sharjah/Ajman fee', async () => {
    const d = await checkDelivery({ message: 'deliver to Ajman' }, profile);
    expect(d.kind).toBe('DELIVERY_POSSIBLE');
    if (d.kind === 'DELIVERY_POSSIBLE') expect(d.fee.total).toBe(150);
  });

  it('charges the other-emirates fee for Abu Dhabi city', async () => {
    const d = await checkDelivery({ message: 'deliver to Yas Island' }, profile);
    expect(d.kind).toBe('DELIVERY_POSSIBLE');
    if (d.kind === 'DELIVERY_POSSIBLE') expect(d.fee.total).toBe(250);
  });

  it('adds the Friday surcharge from the delivery date', async () => {
    // 2026-10-09 is a Friday.
    const d = await checkDelivery(
      { message: 'deliver to Jumeirah', whenIso: '2026-10-09T08:00:00Z' },
      profile,
    );
    expect(d.kind).toBe('DELIVERY_POSSIBLE');
    if (d.kind === 'DELIVERY_POSSIBLE') expect(d.fee.total).toBe(200);
  });

  it('adds the airport off-hire surcharge only for an airport', async () => {
    const airport = await checkDelivery(
      { message: 'drop at Abu Dhabi airport', airportOffHire: true },
      profile,
    );
    expect(airport.kind).toBe('DELIVERY_POSSIBLE');
    if (airport.kind === 'DELIVERY_POSSIBLE') expect(airport.fee.total).toBe(300);
  });

  it('is a branch pickup for a branch location', async () => {
    const d = await checkDelivery({ message: 'Jebel Ali' }, profile);
    expect(d.kind).toBe('BRANCH_PICKUP');
  });

  it('refuses Al Ain: more than 100 km from every branch', async () => {
    const d = await checkDelivery({ message: 'deliver to Al Ain' }, profile);
    expect(d.kind).toBe('TOO_FAR');
    if (d.kind === 'TOO_FAR') expect(d.from.roadKm).toBeGreaterThan(100);
  });

  it('refuses Liwa and Ruwais', async () => {
    for (const place of ['Liwa', 'Ruwais']) {
      const d = await checkDelivery({ message: `deliver to ${place}` }, profile);
      expect(d.kind).toBe('TOO_FAR');
    }
  });

  it('asks for a pin when the place is unknown and no maps provider exists', async () => {
    const d = await checkDelivery({ message: 'deliver to the blue villa near the palm tree' }, profile);
    expect(d.kind).toBe('NEEDS_PIN');
  });

  it('uses the maps provider for a place it cannot find itself', async () => {
    const maps: MapsProvider = {
      name: 'fake',
      geocode: async () => ({ name: 'Secret Villa', lat: 25.2, lng: 55.3, emirate: 'DUBAI' }),
      drivingKm: async () => 12,
    };
    const d = await checkDelivery({ message: 'the secret villa' }, profile, maps);
    expect(d.kind).toBe('DELIVERY_POSSIBLE');
    if (d.kind === 'DELIVERY_POSSIBLE') {
      expect(d.from.estimated).toBe(false);
      expect(d.destination).toBe('Secret Villa');
    }
  });

  it('never measures from an unconfirmed branch', async () => {
    const confirmed = resolveBusinessProfile(JSON.stringify({ confirmBranches: ['abu-dhabi-airport'] }));
    const near = await nearestBranch({ lat: 24.433, lng: 54.65 }, confirmed);
    expect(near!.branch.id).toBe('abu-dhabi-airport');
    const notConfirmed = await nearestBranch({ lat: 24.433, lng: 54.65 }, profile);
    expect(notConfirmed!.branch.id).toBe('mussafah');
  });
});

describe('fees', () => {
  it('recognises Fridays in Dubai time and listed holidays', () => {
    expect(isFridayOrHoliday('2026-10-09T10:00:00Z', profile)).toBe(true);
    expect(isFridayOrHoliday('2026-10-08T10:00:00Z', profile)).toBe(false);
    expect(isFridayOrHoliday('2026-12-02T10:00:00Z', profile)).toBe(true);
    expect(isFridayOrHoliday(null, profile)).toBe(false);
  });

  it('describes a surcharged fee', () => {
    const fee = deliveryFee('SHARJAH', profile, { whenIso: '2026-10-09T10:00:00Z' });
    expect(describeFee(fee, 'AED')).toBe('AED 250 (AED 150 + AED 100 Friday / public holiday)');
  });
});
