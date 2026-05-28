/**
 * places-search — Google Places API "Nearby Search (New)" local tool handler.
 *
 * In sidecar/istio credential-injection modes the Envoy proxy stamps
 * X-Goog-Api-Key at egress via ext_authz; this module must NOT set the
 * header in those modes. In mode=off the header is set directly, but only
 * when the env-var holds a real key (not a KC_PH_* or injected-by-broker
 * placeholder).
 */

import { z } from 'zod';
import type { ContainerInput } from './types.js';
import { getInjectionMode } from '../credential-injection/mode.js';

// ── Food-type allow-list ─────────────────────────────────────────────────────

/**
 * Google Places types[] values that represent cuisine or food categories.
 * Only entries in this set are surfaced as `cuisines` in the result.
 */
const FOOD_TYPES = new Set([
  'african_restaurant',
  'american_restaurant',
  'bagel_shop',
  'bakery',
  'bar',
  'barbecue_restaurant',
  'brazilian_restaurant',
  'breakfast_restaurant',
  'brunch_restaurant',
  'cafe',
  'chinese_restaurant',
  'coffee_shop',
  'fast_food_restaurant',
  'french_restaurant',
  'greek_restaurant',
  'hamburger_restaurant',
  'ice_cream_shop',
  'indian_restaurant',
  'indonesian_restaurant',
  'italian_restaurant',
  'japanese_restaurant',
  'korean_restaurant',
  'lebanese_restaurant',
  'mediterranean_restaurant',
  'mexican_restaurant',
  'middle_eastern_restaurant',
  'pizza_restaurant',
  'ramen_restaurant',
  'sandwich_shop',
  'seafood_restaurant',
  'spanish_restaurant',
  'steak_house',
  'sushi_restaurant',
  'thai_restaurant',
  'turkish_restaurant',
  'vegan_restaurant',
  'vegetarian_restaurant',
  'vietnamese_restaurant',
]);

// ── priceLevel enum mapping ──────────────────────────────────────────────────

const PRICE_LEVEL_MAP: Record<string, number | null> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
  PRICE_LEVEL_UNSPECIFIED: null,
};

function mapPriceLevel(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  if (raw in PRICE_LEVEL_MAP) return PRICE_LEVEL_MAP[raw];
  return null;
}

// ── Result schema ─────────────────────────────────────────────────────────────

export const PlacesResultSchema = z.object({
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  rating: z.number().nullable(),
  price_tier: z.number().nullable(),
  cuisines: z.array(z.string()),
  open_now: z.boolean().nullable(),
});

export type PlacesResult = z.infer<typeof PlacesResultSchema>;

// ── Args schema ───────────────────────────────────────────────────────────────

const PLACES_SEARCH_RADIUS_METERS = 1500;

// ── Helper: should we set the API key header ourselves? ──────────────────────

function shouldSetApiKeyHeader(key: string | undefined): key is string {
  if (!key) return false;
  if (key.startsWith('KC_PH_')) return false;
  if (key === 'injected-by-broker') return false;
  return true;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function placesSearchHandler(
  args: Record<string, unknown>,
  _input: ContainerInput,
): Promise<string> {
  const query = String(args.query ?? '');
  const locationStr = String(args.location ?? '');
  const openNow = args.open_now === true ? true : undefined;
  const priceRange = Array.isArray(args.price_range)
    ? (args.price_range as number[])
    : undefined;

  // Parse lat,lng
  const parts = locationStr.split(',');
  if (parts.length !== 2) {
    return `places_search error: invalid location "${locationStr}" — expected "lat,lng" format`;
  }
  const lat = parseFloat(parts[0].trim());
  const lng = parseFloat(parts[1].trim());
  if (isNaN(lat) || isNaN(lng)) {
    return `places_search error: invalid location "${locationStr}" — expected "lat,lng" format`;
  }

  const baseUrl =
    process.env.GOOGLE_PLACES_BASE_URL ?? 'https://places.googleapis.com';
  const url = `${baseUrl}/v1/places:searchNearby`;

  const body: Record<string, unknown> = {
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: PLACES_SEARCH_RADIUS_METERS,
      },
    },
  };

  // Add query as textQuery if provided
  if (query) {
    body.textQuery = query;
  }

  if (openNow !== undefined) {
    body.openNow = openNow;
  }

  if (priceRange && priceRange.length > 0) {
    // Google Places v1 accepts priceLevels as an array of enum strings
    const priceLevelEnums = ['PRICE_LEVEL_FREE', 'PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'];
    body.priceLevels = priceRange
      .filter((p) => p >= 0 && p <= 4)
      .map((p) => priceLevelEnums[p]);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Goog-FieldMask':
      'places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.types,places.regularOpeningHours.openNow',
  };

  // Only stamp the key directly in mode=off with a real (non-placeholder) key.
  // In sidecar/istio the Envoy proxy does this via ext_authz.
  const injectionMode = getInjectionMode();
  if (injectionMode === 'off') {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (shouldSetApiKeyHeader(apiKey)) {
      headers['X-Goog-Api-Key'] = apiKey;
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return `places_search error: fetch failed — ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!response.ok) {
    const text = await response.text();
    return `places_search error: HTTP ${response.status} — ${text}`;
  }

  const data = await response.json();
  const places: unknown[] = data.places ?? [];

  const results: PlacesResult[] = places.map((p: unknown) => {
    const place = p as Record<string, unknown>;
    const displayName = place.displayName as { text?: string } | undefined;
    const location = place.location as { latitude?: number; longitude?: number } | undefined;
    const openingHours = place.regularOpeningHours as { openNow?: boolean } | undefined;
    const types = Array.isArray(place.types) ? (place.types as string[]) : [];

    return {
      name: displayName?.text ?? '',
      address: String(place.formattedAddress ?? ''),
      lat: location?.latitude ?? 0,
      lng: location?.longitude ?? 0,
      rating: typeof place.rating === 'number' ? place.rating : null,
      price_tier: mapPriceLevel(place.priceLevel as string | undefined),
      cuisines: types.filter((t) => FOOD_TYPES.has(t)),
      open_now: openingHours?.openNow ?? null,
    };
  });

  return JSON.stringify(results);
}

// ── Tool definition (for registration in DirectLLMRunner) ────────────────────

export const PLACES_SEARCH_TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'places_search',
    description:
      'Search for nearby venues (restaurants, cafes, shops) using the Google Places API. Returns structured results with names, addresses, ratings, price tiers, and cuisine types.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for, e.g. "Italian restaurant", "coffee shop"',
        },
        location: {
          type: 'string',
          description: 'Centre of the search area as "latitude,longitude", e.g. "37.7749,-122.4194"',
        },
        open_now: {
          type: 'boolean',
          description: 'When true, only return venues that are currently open',
        },
        price_range: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 4 },
          description:
            'Filter by price tier(s): 0=free, 1=inexpensive, 2=moderate, 3=expensive, 4=very expensive',
        },
      },
      required: ['query', 'location'],
    },
  },
};
