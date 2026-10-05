import { Emirate, type EmirateValue, type GeoPlace, type MapsProvider } from '@ai-concierge/ai';
import { ssrfSafeFetch } from '@ai-concierge/security';

const HOST = 'api.mapbox.com';
const TIMEOUT_MS = 4000;

/** Mapbox `region` names for the seven emirates. */
const EMIRATE_BY_NAME: Record<string, EmirateValue> = {
  dubai: Emirate.DUBAI,
  'abu dhabi': Emirate.ABU_DHABI,
  'abu dhabi emirate': Emirate.ABU_DHABI,
  sharjah: Emirate.SHARJAH,
  'sharjah emirate': Emirate.SHARJAH,
  ajman: Emirate.AJMAN,
  'ajman emirate': Emirate.AJMAN,
  'umm al quwain': Emirate.UMM_AL_QUWAIN,
  'umm al-quwain': Emirate.UMM_AL_QUWAIN,
  'ras al khaimah': Emirate.RAS_AL_KHAIMAH,
  'ras al-khaimah': Emirate.RAS_AL_KHAIMAH,
  fujairah: Emirate.FUJAIRAH,
  'al fujayrah': Emirate.FUJAIRAH,
  'fujairah emirate': Emirate.FUJAIRAH,
};

interface GeocodeResponse {
  features?: {
    place_name?: string;
    text?: string;
    center?: [number, number];
    context?: { id?: string; text?: string }[];
  }[];
}

interface DirectionsResponse {
  code?: string;
  routes?: { distance?: number }[];
}

/**
 * Mapbox adapter for the delivery check: finds a place the built-in UAE gazetteer does not know and
 * measures the real driving distance from a branch to it. Every failure is `null`, so the delivery
 * flow falls back to its own estimate or asks for a pin; a Maps outage never becomes a promise (or a
 * refusal) the customer is not owed.
 */
export class MapboxProvider implements MapsProvider {
  readonly name = 'mapbox';

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof ssrfSafeFetch = ssrfSafeFetch,
  ) {}

  private async getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
    const url = new URL(`https://${HOST}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('access_token', this.accessToken);
    try {
      const response = await this.fetchImpl(url.toString(), [HOST], { method: 'GET', timeoutMs: TIMEOUT_MS });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  async geocode(query: string): Promise<GeoPlace | null> {
    const text = query.trim().slice(0, 200);
    if (!text) return null;
    const json = await this.getJson<GeocodeResponse>(
      `/geocoding/v5/mapbox.places/${encodeURIComponent(text)}.json`,
      { country: 'ae', limit: '1', types: 'poi,address,neighborhood,locality,place,district' },
    );
    const hit = json?.features?.[0];
    const lng = hit?.center?.[0];
    const lat = hit?.center?.[1];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const region = hit?.context?.find((part) => part.id?.startsWith('region'))?.text;
    const emirate = region ? EMIRATE_BY_NAME[region.toLowerCase()] : undefined;
    if (!emirate) return null;
    return { name: (hit?.place_name ?? text).split(',').slice(0, 2).join(',').trim(), lat, lng, emirate };
  }

  async drivingKm(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): Promise<number | null> {
    const json = await this.getJson<DirectionsResponse>(
      `/directions/v5/mapbox/driving/${from.lng},${from.lat};${to.lng},${to.lat}`,
      { overview: 'false', alternatives: 'false' },
    );
    const meters = json?.code === 'Ok' ? json.routes?.[0]?.distance : undefined;
    return typeof meters === 'number' && meters >= 0 ? meters / 1000 : null;
  }
}
