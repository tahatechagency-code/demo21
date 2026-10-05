import type { GeoPlace, MapsProvider } from '@ai-concierge/ai';
import { ssrfSafeFetch } from '@ai-concierge/security';

const TIMEOUT_MS = 4000;

interface RouteResponse {
  code?: string;
  routes?: { distance?: number }[];
}

/**
 * Real road distance from an OSRM routing server (the project's own, or the public demo server for light
 * testing: https://router.project-osrm.org, which needs no key but is not for production traffic). OSRM
 * routes only; it cannot find a place by name, so `geocode` is always `null` and the gazetteer / a pin does
 * that part.
 */
export class OsrmProvider implements MapsProvider {
  readonly name = 'osrm';
  private readonly host: string;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof ssrfSafeFetch = ssrfSafeFetch,
  ) {
    this.host = new URL(baseUrl).host;
  }

  async geocode(): Promise<GeoPlace | null> {
    return null;
  }

  async drivingKm(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): Promise<number | null> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&alternatives=false`;
    try {
      const response = await this.fetchImpl(url, [this.host], { method: 'GET', timeoutMs: TIMEOUT_MS });
      if (!response.ok) return null;
      const json = (await response.json()) as RouteResponse;
      const meters = json.code === 'Ok' ? json.routes?.[0]?.distance : undefined;
      return typeof meters === 'number' && meters >= 0 ? meters / 1000 : null;
    } catch {
      return null;
    }
  }
}
