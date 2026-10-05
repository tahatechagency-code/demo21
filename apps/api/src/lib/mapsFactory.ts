import type { MapsProvider } from '@ai-concierge/ai';
import type { ApiEnv } from '../env.js';
import { GoogleMapsProvider } from './googleMapsProvider.js';
import { MapboxProvider } from './mapboxProvider.js';
import { OsrmProvider } from './osrmProvider.js';

type MapsConfig = Pick<ApiEnv, 'MAPBOX_ACCESS_TOKEN' | 'GOOGLE_MAPS_API_KEY' | 'OSRM_BASE_URL'>;

/**
 * The one place that decides which maps service measures delivery distances: Mapbox when its token is set,
 * else Google Maps when its key is set, else an OSRM server when its URL is set. With none of them the
 * delivery rule uses the built-in gazetteer's coordinates (shown to the customer as "about N km").
 */
export function createMapsProvider(config: MapsConfig): MapsProvider | undefined {
  if (config.MAPBOX_ACCESS_TOKEN) return new MapboxProvider(config.MAPBOX_ACCESS_TOKEN);
  if (config.GOOGLE_MAPS_API_KEY) return new GoogleMapsProvider(config.GOOGLE_MAPS_API_KEY);
  if (config.OSRM_BASE_URL) return new OsrmProvider(config.OSRM_BASE_URL);
  return undefined;
}
