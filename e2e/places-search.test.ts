/**
 * E2E test for the places_search local tool.
 *
 * Verifies the full dispatch chain for the handler:
 *   real module import → real Zod schema → real field mapping → real fetch stub
 *
 * Note: The mock LLM server in e2e/setup.ts does not expose a tool-call
 * injection hook (setMockLlmToolCallResponse), so the full LLM dispatch
 * path (mock LLM → tool_call → handler → result → final reply) is not
 * tested here. The direct-handler tests below are the canonical E2E
 * assertions: real module import, real env, real fetch stub, real Zod schema.
 *
 * Uses:
 *   - vi.stubGlobal('fetch') to intercept the Google Places HTTP call
 *   - CREDENTIAL_INJECTION_MODE=off + a synthetic real-looking API key
 *
 * No live Kubernetes, no real Google API call.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase } from '../src/db.js';

const MOCK_PLACES_RESPONSE = {
  places: [
    {
      displayName: { text: 'Il Fornaio', languageCode: 'en' },
      formattedAddress: '1265 Battery St, San Francisco, CA 94111',
      location: { latitude: 37.7985, longitude: -122.3999 },
      rating: 4.2,
      priceLevel: 'PRICE_LEVEL_MODERATE',
      types: ['italian_restaurant', 'restaurant', 'food', 'establishment'],
      regularOpeningHours: { openNow: true },
    },
  ],
};

describe('places_search local tool (e2e)', () => {
  beforeAll(async () => {
    await _initTestDatabase();

    const port = getMockLlmPort();
    if (!port) return;

    process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DIRECT_LLM_MODEL = 'test/model';

    // Credential injection mode: off — handler stamps key directly
    process.env.CREDENTIAL_INJECTION_MODE = 'off';
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaE2eTestKey1234567890123456789012';
    process.env.GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';

    // Stub fetch so the handler does not call the real Google API
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_PLACES_RESPONSE,
    }));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.CREDENTIAL_INJECTION_MODE;
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_BASE_URL;
  });

  it('result contains venue with non-empty address and numeric rating', async () => {
    // Call the handler directly to check the shaped result
    const { placesSearchHandler } = await import('../src/runtime/places-search.js');

    const raw = await placesSearchHandler(
      { query: 'Italian restaurants', location: '37.7749,-122.4194' },
      {
        prompt: '',
        groupFolder: 'places-e2e-direct',
        chatJid: 'e2e@e2e',
        isMain: false,
        assistantName: 'Bot',
      },
    );

    const results = JSON.parse(raw);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const venue = results[0];
    expect(typeof venue.address).toBe('string');
    expect(venue.address.length).toBeGreaterThan(0);
    expect(typeof venue.rating).toBe('number');
    console.log(`places_search venue: "${venue.name}" at "${venue.address}", rating ${venue.rating}`);
  });

  it('handler calls the correct Google Places endpoint URL', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    const { placesSearchHandler } = await import('../src/runtime/places-search.js');

    await placesSearchHandler(
      { query: 'coffee shops', location: '37.7749,-122.4194' },
      {
        prompt: '',
        groupFolder: 'places-e2e-url',
        chatJid: 'e2e@e2e',
        isMain: false,
        assistantName: 'Bot',
      },
    );

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/places:searchNearby');
    expect(init.headers['X-Goog-FieldMask']).toBeTruthy();
    expect(init.headers['X-Goog-Api-Key']).toBe('AIzaE2eTestKey1234567890123456789012');
  });

  it('handler returns error string for malformed location', async () => {
    const { placesSearchHandler } = await import('../src/runtime/places-search.js');

    const result = await placesSearchHandler(
      { query: 'food', location: 'bad-location' },
      {
        prompt: '',
        groupFolder: 'places-e2e-err',
        chatJid: 'e2e@e2e',
        isMain: false,
        assistantName: 'Bot',
      },
    );

    expect(result).toMatch(/invalid location/i);
  });
});
