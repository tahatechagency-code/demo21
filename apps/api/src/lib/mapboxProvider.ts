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

/** A match Mapbox itself is not fairly sure of ("Dubai Frame" -> a side street) is no match: the customer is asked for a pin. */
const MIN_RELEVANCE = 0.8;

/** The place words of a delivery sentence: "can you deliver to Dubai Frame please" -> "Dubai Frame". */
export function placeQuery(text: string): string {
  return text
    .replace(/[?!.]+/g, ' ')
    .replace(/^\s*(?:hi|hello|hey|please|pls|ok|okay|and)\b[\s,]*/i, '')
    .replace(
      /^\s*(?:(?:can|could|will|would) (?:you|u|we) |do (?:you|u) |is it possible to |i (?:need|want|would like)(?: the car| a car| it)? |mujhe |kya (?:aap |tum )?)?(?:deliver(?:y| it| the car)?(?: possible)?|bring (?:it|the car)|come|drop(?: it| the car)?|send (?:it|the car)|pick ?-?up|collect(?:ion)?)(?: it| the car| a car)?(?: from| to| at| in| near)?\s+/i,
      '',
    )
    .replace(/\b(?:please|pls|possible|available|milegi|milega|hogi|hoga|ho sakti hai|ho sakta hai|pe delivery|me delivery|par delivery)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_WORDS = new Set(['the', 'of', 'park', 'tower', 'towers', 'center', 'centre', 'street', 'road', 'village', 'island', 'hotel', 'resort', 'city', 'area', 'near', 'dubai', 'abu', 'dhabi', 'sharjah']);

function normalised(text: string): string {
  return text.toLowerCase().replace(/['’`]/g, '');
}

/** At least one distinctive word of the query appears in the (first parts of the) match; a query of only generic words is accepted on relevance alone. */
export function namesTheQuery(query: string, matchName: string): boolean {
  const words = normalised(query)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !GENERIC_WORDS.has(word));
  if (words.length === 0) return true;
  const head = normalised(matchName.split(',').slice(0, 2).join(' '));
  return words.some((word) => head.includes(word));
}

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

interface GeocodeResponse {
  features?: {
    relevance?: number;
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
    const text = placeQuery(query).slice(0, 200);
    if (!text) return null;
    const json = await this.getJson<GeocodeResponse>(
      `/geocoding/v5/mapbox.places/${encodeURIComponent(text)}.json`,
      { country: 'ae', limit: '1', language: 'en', types: 'poi,neighborhood,locality,place,district,address' },
    );
    const hit = json?.features?.[0];
    if (typeof hit?.relevance === 'number' && hit.relevance < MIN_RELEVANCE) return null;
    const lng = hit?.center?.[0];
    const lat = hit?.center?.[1];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const region = hit?.context?.find((part) => part.id?.startsWith('region'))?.text;
    const emirate = region ? EMIRATE_BY_NAME[region.toLowerCase()] : undefined;
    if (!emirate) return null;
    // The match must be about what was asked: a name word of the query has to appear in the match's own name
    // ("Mall of the Emirates" -> a village in Ras Al Khaimah is refused, so the customer is asked for a pin).
    if (!namesTheQuery(text, hit?.place_name ?? '')) return null;
    // The customer's own words are the name shown back to them, never Mapbox's (sometimes Arabic) label.
    return { name: titleCase(text), lat, lng, emirate };
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
