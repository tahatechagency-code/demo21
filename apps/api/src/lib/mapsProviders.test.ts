import { describe, expect, it } from 'vitest';
import { createMapsProvider } from './mapsFactory.js';
import { MapboxProvider } from './mapboxProvider.js';
import { OsrmProvider } from './osrmProvider.js';

type Fetch = ConstructorParameters<typeof MapboxProvider>[1];

/** A fake `ssrfSafeFetch` that answers with the given JSON and records the URL it was asked for. */
function fakeFetch(body: unknown, ok = true) {
  const seen: { url: string; hosts: string[] }[] = [];
  const impl = (async (url: string, hosts: string[]) => {
    seen.push({ url, hosts });
    return { ok, json: async () => body } as unknown as Response;
  }) as unknown as Fetch;
  return { impl, seen };
}

describe('MapboxProvider', () => {
  it('measures the driving distance in km from the route', async () => {
    const { impl, seen } = fakeFetch({ code: 'Ok', routes: [{ distance: 128_400 }] });
    const km = await new MapboxProvider('tok', impl).drivingKm({ lat: 24.35, lng: 54.49 }, { lat: 24.2, lng: 55.74 });
    expect(km).toBeCloseTo(128.4, 1);
    expect(seen[0]!.hosts).toEqual(['api.mapbox.com']);
    expect(seen[0]!.url).toContain('/directions/v5/mapbox/driving/54.49,24.35;55.74,24.2');
  });

  it('is null (never a made-up distance) when the route is missing or the call fails', async () => {
    expect(await new MapboxProvider('t', fakeFetch({ code: 'NoRoute', routes: [] }).impl).drivingKm({ lat: 1, lng: 1 }, { lat: 2, lng: 2 })).toBeNull();
    expect(await new MapboxProvider('t', fakeFetch({}, false).impl).drivingKm({ lat: 1, lng: 1 }, { lat: 2, lng: 2 })).toBeNull();
  });

  it('finds a UAE place with its emirate', async () => {
    const { impl, seen } = fakeFetch({
      features: [{ place_name: 'Dubai Hills Mall, Dubai, United Arab Emirates', center: [55.24, 25.1], context: [{ id: 'region.1', text: 'Dubai' }] }],
    });
    const place = await new MapboxProvider('t', impl).geocode('Dubai Hills Mall');
    expect(place).toMatchObject({ lat: 25.1, lng: 55.24, emirate: 'DUBAI' });
    expect(seen[0]!.url).toContain('country=ae');
  });

  it('refuses a result outside the seven emirates', async () => {
    const { impl } = fakeFetch({ features: [{ center: [58.4, 23.6], context: [{ id: 'region.9', text: 'Muscat' }] }] });
    expect(await new MapboxProvider('t', impl).geocode('Muscat')).toBeNull();
  });
});

describe('OsrmProvider', () => {
  it('reads the distance and only ever calls its own host', async () => {
    const { impl, seen } = fakeFetch({ code: 'Ok', routes: [{ distance: 57_000 }] });
    const km = await new OsrmProvider('https://router.example.org/', impl).drivingKm({ lat: 25.13, lng: 56.33 }, { lat: 24.8, lng: 56.11 });
    expect(km).toBe(57);
    expect(seen[0]!.hosts).toEqual(['router.example.org']);
    expect(seen[0]!.url).toBe('https://router.example.org/route/v1/driving/56.33,25.13;56.11,24.8?overview=false&alternatives=false');
  });

  it('cannot find places by name', async () => {
    expect(await new OsrmProvider('https://router.example.org').geocode()).toBeNull();
  });
});

describe('createMapsProvider', () => {
  it('prefers Mapbox, then Google, then OSRM, else nothing', () => {
    expect(createMapsProvider({ MAPBOX_ACCESS_TOKEN: 'a', GOOGLE_MAPS_API_KEY: 'b', OSRM_BASE_URL: 'https://x.org' })?.name).toBe('mapbox');
    expect(createMapsProvider({ GOOGLE_MAPS_API_KEY: 'b', OSRM_BASE_URL: 'https://x.org' } as never)?.name).toBe('google-maps');
    expect(createMapsProvider({ OSRM_BASE_URL: 'https://x.org' } as never)?.name).toBe('osrm');
    expect(createMapsProvider({} as never)).toBeUndefined();
  });
});
