import { Emirate, type EmirateValue, type GeoPlace, type MapsProvider } from '@ai-concierge/ai';
import { ssrfSafeFetch } from '@ai-concierge/security';

const HOST = 'maps.googleapis.com';
const TIMEOUT_MS = 4000;

/** Google's `administrative_area_level_1` long names for the seven emirates. */
const EMIRATE_BY_NAME: Record<string, EmirateValue> = {
  dubai: Emirate.DUBAI,
  'abu dhabi': Emirate.ABU_DHABI,
  'abu dhabi emirate': Emirate.ABU_DHABI,
  sharjah: Emirate.SHARJAH,
  'sharjah emirate': Emirate.SHARJAH,
  ajman: Emirate.AJMAN,
  'ajman emirate': Emirate.AJMAN,
  'umm al quwain': Emirate.UMM_AL_QUWAIN,
  'umm al quwain emirate': Emirate.UMM_AL_QUWAIN,
  'ras al khaimah': Emirate.RAS_AL_KHAIMAH,
  'ras al-khaimah': Emirate.RAS_AL_KHAIMAH,
  fujairah: Emirate.FUJAIRAH,
  'fujairah emirate': Emirate.FUJAIRAH,
};

interface GeocodeResponse {
  status?: string;
  results?: {
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: { long_name?: string; types?: string[] }[];
  }[];
}

interface DirectionsResponse {
  status?: string;
  routes?: { legs?: { distance?: { value?: number } }[] }[];
}

/**
 * Google Maps adapter for the delivery check: finds a place the built-in UAE gazetteer does not
 * know and measures the real driving distance from a branch to it. Every failure is `null` — the
 * delivery flow then falls back to its own estimate or asks for a pin; a Maps outage must never
 * turn into a promise (or a refusal) the customer is not owed.
 */
export class GoogleMapsProvider implements MapsProvider {
  readonly name = 'google-maps';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof ssrfSafeFetch = ssrfSafeFetch,
  ) {}

  private async getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
    const url = new URL(`https://${HOST}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('key', this.apiKey);
    try {
      const response = await this.fetchImpl(url.toString(), [HOST], {
        method: 'GET',
        timeoutMs: TIMEOUT_MS,
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  async geocode(query: string): Promise<GeoPlace | null> {
    const text = query.trim().slice(0, 200);
    if (!text) return null;
    const json = await this.getJson<GeocodeResponse>('/maps/api/geocode/json', {
      address: text,
      components: 'country:AE',
      region: 'ae',
    });
    if (json?.status !== 'OK') return null;
    const hit = json.results?.[0];
    const lat = hit?.geometry?.location?.lat;
    const lng = hit?.geometry?.location?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const area = hit?.address_components?.find((part) =>
      part.types?.includes('administrative_area_level_1'),
    )?.long_name;
    const emirate = area ? EMIRATE_BY_NAME[area.toLowerCase()] : undefined;
    if (!emirate) return null;
    return {
      name: (hit?.formatted_address ?? text).split(',').slice(0, 2).join(',').trim(),
      lat,
      lng,
      emirate,
    };
  }

  async drivingKm(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): Promise<number | null> {
    const json = await this.getJson<DirectionsResponse>('/maps/api/directions/json', {
      origin: `${from.lat},${from.lng}`,
      destination: `${to.lat},${to.lng}`,
      mode: 'driving',
    });
    if (json?.status !== 'OK') return null;
    const meters = json.routes?.[0]?.legs?.[0]?.distance?.value;
    return typeof meters === 'number' && meters >= 0 ? meters / 1000 : null;
  }
}
