/**
 * Integration tests for places-search handler.
 *
 * Uses vi.stubGlobal('fetch') with a realistic Google Places JSON fixture.
 * Imports the module once (no vi.resetModules) so the full module graph is
 * exercised. Tests cover field mapping, open_now forwarding, and 4xx handling.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { placesSearchHandler } from './places-search.js';

// Realistic multi-result fixture
const REALISTIC_RESPONSE = {
  places: [
    {
      displayName: { text: 'Osteria Morini', languageCode: 'en' },
      formattedAddress: '218 Lafayette St, New York, NY 10012',
      location: { latitude: 40.7241, longitude: -74.0003 },
      rating: 4.3,
      priceLevel: 'PRICE_LEVEL_EXPENSIVE',
      types: [
        'italian_restaurant',
        'restaurant',
        'food',
        'establishment',
        'point_of_interest',
      ],
      regularOpeningHours: { openNow: false },
    },
    {
      displayName: { text: "Juliana's Pizza", languageCode: 'en' },
      formattedAddress: '1 Front St, Brooklyn, NY 11201',
      location: { latitude: 40.7025, longitude: -73.9934 },
      rating: 4.7,
      priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
      types: ['pizza_restaurant', 'restaurant', 'food', 'establishment'],
      regularOpeningHours: { openNow: true },
    },
    {
      displayName: { text: 'No-Type Venue', languageCode: 'en' },
      formattedAddress: '5 Test Ave, New York, NY 10001',
      location: { latitude: 40.7128, longitude: -74.006 },
      rating: null,
      // priceLevel absent
      types: ['establishment', 'point_of_interest'],
      // regularOpeningHours absent
    },
  ],
};

const BASE_INPUT = {
  prompt: '',
  groupFolder: 'integration-test',
  chatJid: 'test@test',
  isMain: false,
  assistantName: 'Bot',
};

describe('places-search integration', () => {
  beforeAll(() => {
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaIntegrationTestKey123456789012345';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => REALISTIC_RESPONSE,
      }),
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.CREDENTIAL_INJECTION_MODE;
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_BASE_URL;
  });

  it('returns a JSON array of the expected length', async () => {
    const raw = await placesSearchHandler(
      { query: 'Italian', location: '40.7128,-74.006' },
      BASE_INPUT,
    );
    const results = JSON.parse(raw);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(3);
  });

  it('first result has correct name, address, lat, lng', async () => {
    const raw = await placesSearchHandler(
      { query: 'Italian', location: '40.7128,-74.006' },
      BASE_INPUT,
    );
    const results = JSON.parse(raw);
    expect(results[0].name).toBe('Osteria Morini');
    expect(results[0].address).toBe('218 Lafayette St, New York, NY 10012');
    expect(results[0].lat).toBe(40.7241);
    expect(results[0].lng).toBe(-74.0003);
  });

  it('maps PRICE_LEVEL_EXPENSIVE to price_tier 3', async () => {
    const raw = await placesSearchHandler(
      { query: 'Italian', location: '40.7128,-74.006' },
      BASE_INPUT,
    );
    const results = JSON.parse(raw);
    expect(results[0].price_tier).toBe(3);
  });

  it('maps PRICE_LEVEL_INEXPENSIVE to price_tier 1 on second result', async () => {
    const raw = await placesSearchHandler(
      { query: 'Italian', location: '40.7128,-74.006' },
      BASE_INPUT,
    );
    const results = JSON.parse(raw);
    expect(results[1].price_tier).toBe(1);
  });

  it('forwards open_now correctly (false on first result)', async () => {
    const raw = await placesSearchHandler(
      { query: 'Italian', location: '40.7128,-74.006' },
      BASE_INPUT,
    );
    const results = JSON.parse(raw);
    expect(results[0].open_now).toBe(false);
    expect(results[1].open_now).toBe(true);
  });

  it('third result has null rating, null price_tier, empty cuisines, null open_now', async () => {
    const raw = await placesSearchHandler(
      { query: 'Italian', location: '40.7128,-74.006' },
      BASE_INPUT,
    );
    const results = JSON.parse(raw);
    expect(results[2].rating).toBeNull();
    expect(results[2].price_tier).toBeNull();
    expect(results[2].cuisines).toEqual([]);
    expect(results[2].open_now).toBeNull();
  });

  it('extracts correct cuisines for pizza_restaurant', async () => {
    const raw = await placesSearchHandler(
      { query: 'pizza', location: '40.7128,-74.006' },
      BASE_INPUT,
    );
    const results = JSON.parse(raw);
    expect(results[1].cuisines).toEqual(['pizza_restaurant']);
  });

  it('sends open_now=true in request body when arg is true', async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockClear();

    await placesSearchHandler(
      { query: 'pizza', location: '40.7128,-74.006', open_now: true },
      BASE_INPUT,
    );

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.openNow).toBe(true);
  });

  it('handles 4xx error response gracefully', async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Quota exceeded',
    });

    const result = await placesSearchHandler(
      { query: 'food', location: '40.7128,-74.006' },
      BASE_INPUT,
    );

    expect(result).toContain('429');
    expect(result).toContain('Quota exceeded');
  });

  it('handles empty places array without error', async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ places: [] }),
    });

    const raw = await placesSearchHandler(
      { query: 'obscure query with no results', location: '40.7128,-74.006' },
      BASE_INPUT,
    );

    const results = JSON.parse(raw);
    expect(results).toEqual([]);
  });
});
