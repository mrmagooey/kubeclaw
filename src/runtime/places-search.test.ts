/**
 * Unit tests for places-search handler.
 *
 * All external fetch calls are stubbed. No K8s, no Redis, no real HTTP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- module-under-test (imported after env setup) ----

// Google Places "Nearby Search (New)" response fixture
function makePlacesResponse(overrides: Record<string, unknown> = {}) {
  return {
    places: [
      {
        displayName: { text: 'La Trattoria', languageCode: 'en' },
        formattedAddress: '123 Main St, San Francisco, CA 94102',
        location: { latitude: 37.7749, longitude: -122.4194 },
        rating: 4.5,
        priceLevel: 'PRICE_LEVEL_MODERATE',
        types: ['italian_restaurant', 'restaurant', 'food', 'establishment'],
        regularOpeningHours: { openNow: true },
        ...overrides,
      },
    ],
  };
}

describe('placesSearchHandler', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_BASE_URL;
    delete process.env.CREDENTIAL_INJECTION_MODE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── mode: off, real key ──────────────────────────────────────────────────────

  it('sets X-Goog-Api-Key header when mode=off and key is real', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makePlacesResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    await placesSearchHandler(
      { query: 'Italian', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-Goog-Api-Key']).toBe('AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01');
  });

  // ── mode: off, placeholder key — must NOT set header ────────────────────────

  it('omits X-Goog-Api-Key header when key starts with KC_PH_', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'KC_PH_FALLBACK_google-places';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makePlacesResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    await placesSearchHandler(
      { query: 'Italian', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-Goog-Api-Key']).toBeUndefined();
  });

  it('omits X-Goog-Api-Key header when key equals injected-by-broker', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'injected-by-broker';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makePlacesResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    await placesSearchHandler(
      { query: 'Italian', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-Goog-Api-Key']).toBeUndefined();
  });

  // ── request body construction ────────────────────────────────────────────────

  it('sets X-Goog-FieldMask header on every call', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makePlacesResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    await placesSearchHandler(
      { query: 'pizza', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-Goog-FieldMask']).toBe(
      'places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.types,places.regularOpeningHours.openNow',
    );
  });

  it('builds correct locationRestriction from lat,lng string', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makePlacesResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    await placesSearchHandler(
      { query: 'sushi', location: '51.5074,-0.1278' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.locationRestriction.circle.center.latitude).toBe(51.5074);
    expect(body.locationRestriction.circle.center.longitude).toBe(-0.1278);
  });

  it('forwards open_now=true as a body field', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makePlacesResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    await placesSearchHandler(
      { query: 'tacos', location: '37.7749,-122.4194', open_now: true },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.openNow).toBe(true);
  });

  // ── priceLevel mapping ───────────────────────────────────────────────────────

  it.each([
    ['PRICE_LEVEL_FREE', 0],
    ['PRICE_LEVEL_INEXPENSIVE', 1],
    ['PRICE_LEVEL_MODERATE', 2],
    ['PRICE_LEVEL_EXPENSIVE', 3],
    ['PRICE_LEVEL_VERY_EXPENSIVE', 4],
    ['PRICE_LEVEL_UNSPECIFIED', null],
    ['UNKNOWN_VALUE', null],
    [undefined, null],
  ])('maps priceLevel "%s" to price_tier %s', async (priceLevel, expectedTier) => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        makePlacesResponse(
          priceLevel !== undefined ? { priceLevel } : { priceLevel: undefined },
        ),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    const raw = await placesSearchHandler(
      { query: 'food', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const result = JSON.parse(raw);
    expect(result[0]?.price_tier).toBe(expectedTier);
  });

  // ── cuisines extraction ──────────────────────────────────────────────────────

  it('extracts cuisine label from food types[]', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        makePlacesResponse({
          types: ['japanese_restaurant', 'restaurant', 'food', 'establishment'],
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    const raw = await placesSearchHandler(
      { query: 'sushi', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const result = JSON.parse(raw);
    expect(result[0]?.cuisines).toContain('japanese_restaurant');
  });

  it('returns empty cuisines array when types[] contains no food types', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        makePlacesResponse({
          types: ['establishment', 'point_of_interest'],
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    const raw = await placesSearchHandler(
      { query: 'places', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const result = JSON.parse(raw);
    expect(result[0]?.cuisines).toEqual([]);
  });

  // ── error path ───────────────────────────────────────────────────────────────

  it('returns an error string on non-ok HTTP response', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'API key not authorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    const result = await placesSearchHandler(
      { query: 'food', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    expect(result).toContain('403');
  });

  it('returns an error string when location string is malformed', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    vi.stubGlobal('fetch', vi.fn());

    const { placesSearchHandler } = await import('./places-search.js');
    const result = await placesSearchHandler(
      { query: 'food', location: 'not-valid' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    expect(result).toMatch(/invalid location/i);
  });

  // ── result schema ────────────────────────────────────────────────────────────

  it('returns JSON array with expected fields on success', async () => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaTestKeyAbcdefghijklmnopqrstuvwxyz01';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makePlacesResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { placesSearchHandler } = await import('./places-search.js');
    const raw = await placesSearchHandler(
      { query: 'Italian', location: '37.7749,-122.4194' },
      { prompt: '', groupFolder: 'test', chatJid: 'x@x', isMain: false, assistantName: 'Bot' },
    );

    const result = JSON.parse(raw);
    expect(Array.isArray(result)).toBe(true);
    const venue = result[0];
    expect(venue).toHaveProperty('name');
    expect(venue).toHaveProperty('address');
    expect(venue).toHaveProperty('lat');
    expect(venue).toHaveProperty('lng');
    expect(venue).toHaveProperty('rating');
    expect(venue).toHaveProperty('price_tier');
    expect(venue).toHaveProperty('cuisines');
    expect(venue).toHaveProperty('open_now');
    expect(venue.name).toBe('La Trattoria');
    expect(venue.lat).toBe(37.7749);
    expect(typeof venue.rating).toBe('number');
    expect(venue.open_now).toBe(true);
  });
});
