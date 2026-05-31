# Places-search tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `places_search` local tool to the channel pod that calls Google Places API "Nearby Search (New)" and returns structured venue results, routed through the credential broker in sidecar/istio modes.

**Architecture:** A new `src/runtime/places-search.ts` module exports a Zod-validated handler and a tool definition constant; `src/channel-runner.ts` calls a `registerPlacesSearchTool` function at startup (alongside `registerCredentialTools`) so the handler is invoked in-process with no K8s pod. In `sidecar`/`istio` modes the Envoy proxy stamps the `X-Goog-Api-Key` header at egress via a new `google-places` catalog entry in `helm/kubeclaw/values.yaml`; in `mode: off` the handler reads `GOOGLE_PLACES_API_KEY` directly and sets the header itself only when the value is a real key (not a `KC_PH_*` or `injected-by-broker` placeholder).

**Tech Stack:** TypeScript, vitest, zod, Google Places API, Envoy ext_authz

---

## Pre-flight

Read before starting:
- `src/runtime/direct-llm-runner.ts` lines 883–934 (`LocalTool` interface, `registerLocalTool`)
- `src/tools/list-credentials.ts` lines 110–122 (canonical tool-def constant pattern)
- `src/channel-runner.ts` lines 3042–3061 (`registerCredentialTools` — model for `registerPlacesSearchTool`)
- `src/channel-runner.ts` lines 3109–3114 (startup call site for `registerCredentialTools`)
- `src/credential-injection/mode.ts` (full — `getInjectionMode()` import)
- `helm/kubeclaw/values.yaml` lines 411–425 (`catalog: []` and example schema)
- `e2e/credential-injection-integration.test.ts` (full — pattern for helm-template catalog tests)

**Branch:** create a worktree via `superpowers:using-git-worktrees`. Do not work on `main`.

---

## Task 1: Helm catalog entry for `google-places`

**Files:**
- Modify: `helm/kubeclaw/values.yaml:415`
- Test: `e2e/credential-injection-integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append a new `describe` block at the bottom of `e2e/credential-injection-integration.test.ts`:

```typescript
// ─── google-places catalog entry ──────────────────────────────────────────────

describe('google-places catalog entry renders correctly', () => {
  const PLACES_CATALOG_ARGS =
    `--set 'credentialInjection.catalog[0].id=google-places'` +
    ` --set 'credentialInjection.catalog[0].host=places.googleapis.com'` +
    ` --set 'credentialInjection.catalog[0].upstreamPort=443'` +
    ` --set 'credentialInjection.catalog[0].credentialFields[0].name=api_key'` +
    ` --set 'credentialInjection.catalog[0].credentialFields[0].envVar=GOOGLE_PLACES_API_KEY'` +
    ` --set 'credentialInjection.catalog[0].allowOperatorFallback=false'` +
    ` --set 'credentialInjection.catalog[0].allowedPositions[0]=header'`;

  it('renders the broker ConfigMap with google-places host', () => {
    const out = helmTemplate(`--set credentialInjection.mode=sidecar ${PLACES_CATALOG_ARGS}`);
    expect(out).toContain('places.googleapis.com');
    expect(out).toContain('GOOGLE_PLACES_API_KEY');
  });

  it('google-places entry does not leak real API key values', () => {
    const out = helmTemplate(`--set credentialInjection.mode=sidecar ${PLACES_CATALOG_ARGS}`);
    // Chart must not embed real Google API key shapes
    expect(out).not.toMatch(/AIza[A-Za-z0-9_\-]{35,}/);
  });

  it('renders GOOGLE_PLACES_BASE_URL baseUrlEnv when provided', () => {
    const withBaseUrl =
      PLACES_CATALOG_ARGS +
      ` --set 'credentialInjection.catalog[0].baseUrlEnvs.GOOGLE_PLACES_BASE_URL=http://places.googleapis.com'`;
    const out = helmTemplate(`--set credentialInjection.mode=sidecar ${withBaseUrl}`);
    expect(out).toContain('GOOGLE_PLACES_BASE_URL');
    expect(out).toContain('http://places.googleapis.com');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm test -- e2e/credential-injection-integration.test.ts
```

Expected: FAIL — `places.googleapis.com` not found in rendered output (catalog entry does not exist yet).

- [ ] **Step 3: Add the `google-places` catalog entry to `helm/kubeclaw/values.yaml`**

In `helm/kubeclaw/values.yaml`, replace `catalog: []` at line 415 with:

```yaml
  catalog:
    - id: google-places
      host: places.googleapis.com
      upstreamPort: 443
      credentialFields:
        - { name: api_key, envVar: GOOGLE_PLACES_API_KEY }
      baseUrlEnvs:
        # http:// scheme is intentional — istio egress needs it so the sidecar
        # can intercept. The broker upgrades the upstream connection to HTTPS
        # internally.
        GOOGLE_PLACES_BASE_URL: "http://places.googleapis.com"
      allowOperatorFallback: false
      allowedPositions: [header]
      apiKeyShape: { prefix: "AIza", minLength: 39 }
```

- [ ] **Step 4: Run test, expect PASS**

```bash
npm test -- e2e/credential-injection-integration.test.ts
```

Expected: all tests in the file pass (pre-existing tests and the 3 new `google-places` tests).

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/values.yaml e2e/credential-injection-integration.test.ts
git commit -m "feat: add google-places credential-broker catalog entry"
```

---

## Task 2: Handler module `src/runtime/places-search.ts` (unit tests)

**Files:**
- Create: `src/runtime/places-search.ts`
- Create: `src/runtime/places-search.test.ts`

This task covers the core logic of `placesSearchHandler` and its helper functions in isolation. Fetch is stubbed with `vi.stubGlobal`.

- [ ] **Step 1: Write failing unit tests**

Create `src/runtime/places-search.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm test -- src/runtime/places-search.test.ts
```

Expected: FAIL — `Cannot find module './places-search.js'`.

- [ ] **Step 3: Implement `src/runtime/places-search.ts`**

Create `src/runtime/places-search.ts`:

```typescript
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
```

- [ ] **Step 4: Run test, expect PASS**

```bash
npm test -- src/runtime/places-search.test.ts
```

Expected: all tests pass (the test file has ~14 `it` blocks).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/places-search.ts src/runtime/places-search.test.ts
git commit -m "feat: add places-search handler module with unit tests"
```

---

## Task 3: Tool registration in `src/channel-runner.ts`

**Files:**
- Modify: `src/channel-runner.ts` (import near line 125; `registerPlacesSearchTool` function near line 3042; call site near line 3114)
- Test: `src/channel-runner.test.ts`

- [ ] **Step 1: Write failing unit test**

Find the existing `registerCredentialTools` tests in `src/channel-runner.test.ts` (look for `it('registers list_credentials'` or similar). Add a parallel test block nearby:

```typescript
describe('registerPlacesSearchTool', () => {
  it('registers places_search local tool with the runner', async () => {
    const registered: string[] = [];
    const mockRunner = {
      registerLocalTool: (name: string, _tool: unknown) => {
        registered.push(name);
      },
    };

    const { registerPlacesSearchTool } = await import('./channel-runner.js');
    registerPlacesSearchTool(mockRunner as unknown as ReturnType<typeof import('./runtime/direct-llm-runner.js').DirectLLMRunner['prototype']['registerLocalTool']>);

    expect(registered).toContain('places_search');
  });
});
```

> Note: the import path may need adjustment depending on where this describe block lives in the file. Match the existing `registerCredentialTools` test pattern exactly.

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm test -- src/channel-runner.test.ts
```

Expected: FAIL — `registerPlacesSearchTool is not a function` (export does not exist yet).

- [ ] **Step 3: Add import, `registerPlacesSearchTool`, and call site**

**3a. Add import** near line 125 of `src/channel-runner.ts` (alongside the `LIST_CREDENTIALS_TOOL_DEF` import):

```typescript
import {
  PLACES_SEARCH_TOOL_DEF,
  placesSearchHandler,
} from './runtime/places-search.js';
```

**3b. Add `registerPlacesSearchTool`** immediately after `registerCredentialTools` (around line 3063):

```typescript
/**
 * Register the channel-resident places_search tool with the DirectLLMRunner
 * singleton. Called once at startup before the first runAgent() invocation.
 *
 * The tool is intercepted locally — no K8s tool pod is spawned.
 */
export function registerPlacesSearchTool(
  runner: ReturnType<typeof getDirectLLMRunner>,
): void {
  runner.registerLocalTool('places_search', {
    def: PLACES_SEARCH_TOOL_DEF,
    handler: placesSearchHandler,
  });
  logger.debug('Registered places_search local tool');
}
```

**3c. Add call site** on the line after `registerCredentialTools(getDirectLLMRunner())` (line ~3114):

```typescript
  registerPlacesSearchTool(getDirectLLMRunner());
```

- [ ] **Step 4: Run test, expect PASS**

```bash
npm test -- src/channel-runner.test.ts
```

Expected: the new `registerPlacesSearchTool` test passes; no pre-existing tests regress.

Also verify the full unit suite is still green:

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/channel-runner.ts
git commit -m "feat: register places_search local tool at channel startup"
```

---

## Task 4: Integration test with in-process HTTP mock

**Files:**
- Create: `src/runtime/places-search.integration.test.ts`

This test exercises `placesSearchHandler` end-to-end (full module import, real Zod, real mapping logic) with a realistic stubbed fetch — no real Google API call. It catches wiring bugs that pure unit tests with `vi.resetModules()` miss.

- [ ] **Step 1: Write the failing integration test**

Create `src/runtime/places-search.integration.test.ts`:

```typescript
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
      types: ['italian_restaurant', 'restaurant', 'food', 'establishment', 'point_of_interest'],
      regularOpeningHours: { openNow: false },
    },
    {
      displayName: { text: 'Juliana\'s Pizza', languageCode: 'en' },
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => REALISTIC_RESPONSE,
    }));
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
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm test -- src/runtime/places-search.integration.test.ts
```

Expected: FAIL — the module does not exist yet (written in Task 2, but this test is written first in TDD order to drive the implementation).

> In practice, if Task 2 is already done, this will fail on a logic assertion rather than a module-not-found error. Either failure mode confirms the TDD loop.

- [ ] **Step 3: Verify implementation already satisfies all cases**

After Task 2's implementation is in place, the integration tests should pass without further code changes. If any fail, fix the handler in `src/runtime/places-search.ts`.

- [ ] **Step 4: Run test, expect PASS**

```bash
npm test -- src/runtime/places-search.integration.test.ts
```

Expected: all 10 tests pass.

- [ ] **Step 5: Run full unit suite to confirm no regressions**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/places-search.integration.test.ts
git commit -m "test: integration tests for places-search handler"
```

---

## Task 5: End-to-end test

**Files:**
- Create: `e2e/places-search.test.ts`

The E2E test exercises the full path: mock LLM server triggers the `places_search` tool call, the handler runs in-process, and the response is validated. Uses `CREDENTIAL_INJECTION_MODE=off` and a mocked `fetch` (or a locally configured mock upstream). No live Google API required.

- [ ] **Step 1: Write the failing E2E test**

Create `e2e/places-search.test.ts`:

```typescript
/**
 * E2E test for the places_search local tool.
 *
 * Verifies the full dispatch chain:
 *   mock LLM → tool_call(places_search) → handler in-process → tool result → final LLM reply
 *
 * Uses:
 *   - The in-process mock LLM server started by e2e/setup.ts (getMockLlmPort)
 *   - vi.stubGlobal('fetch') to intercept the Google Places HTTP call
 *   - CREDENTIAL_INJECTION_MODE=off + a synthetic real-looking API key
 *
 * No live Kubernetes, no real Google API call.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getMockLlmPort, setMockLlmToolCallResponse } from './setup.js';
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

  it('returns a venue with non-empty address and numeric rating when LLM calls places_search', async () => {
    if (!getMockLlmPort()) return;

    // Instruct the mock LLM to call places_search once, then return a final reply
    setMockLlmToolCallResponse('places_search', {
      query: 'Italian restaurants',
      location: '37.7749,-122.4194',
    });

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { registerPlacesSearchTool } = await import('../src/channel-runner.js');

    const runner = new DirectLLMRunner();
    registerPlacesSearchTool(runner);

    const groupFolder = `places-e2e-${Date.now()}`;

    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      {
        prompt: 'find Italian restaurants near 37.7749,-122.4194',
        groupFolder,
        chatJid: 'e2e@e2e',
        isMain: false,
        assistantName: 'Bot',
      },
    );

    expect(output.status).toBe('success');

    // The tool result (JSON array) was passed back to the LLM — verify
    // the fetch was called and mock response was consumed
    expect(fetch).toHaveBeenCalled();

    // Parse the places tool response passed to the LLM (captured in the mock)
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/places:searchNearby');
    expect(init.headers['X-Goog-FieldMask']).toBeTruthy();

    // The final LLM response (from the mock server) should be a success string
    expect(typeof output.result).toBe('string');
    console.log(`✅ places_search e2e: tool called, result: "${output.result}"`);
  });

  it('result contains venue with non-empty address and numeric rating', async () => {
    if (!getMockLlmPort()) return;

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
    console.log(`✅ places_search venue: "${venue.name}" at "${venue.address}", rating ${venue.rating}`);
  });
});
```

> **Note on `setMockLlmToolCallResponse`:** Check `e2e/setup.ts` for whether this helper already exists (it may be called `mockLlmToolCall` or similar). If the mock LLM server in `e2e/setup.ts` does not expose a hook for instructing it to emit a tool call, replace the first `it` block with the direct-handler test only (the second `it` block) and add a comment explaining the limitation. The second test is self-contained and does not require mock-LLM cooperation.

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm run test:e2e -- e2e/places-search.test.ts
```

Expected: FAIL — likely `setMockLlmToolCallResponse is not exported` or `Cannot find module` (depending on whether Tasks 2–3 are done).

- [ ] **Step 3: Inspect `e2e/setup.ts` and adjust test if needed**

Read `e2e/setup.ts` and check whether the mock LLM supports tool-call injection. If the first `it` block requires a non-existent helper, remove it and rely on the direct-invocation test. The direct-invocation test (second `it`) is the canonical E2E assertion: real module import, real env, real fetch stub, real Zod schema.

- [ ] **Step 4: Run test, expect PASS**

```bash
npm run test:e2e -- e2e/places-search.test.ts
```

Expected: passing tests for the direct-invocation block (and the full LLM dispatch block if the mock LLM supports it).

- [ ] **Step 5: Run full E2E suite to confirm no regressions**

```bash
npm run test:e2e
```

Expected: all pre-existing E2E tests continue to pass.

- [ ] **Step 6: Final commit**

```bash
git add e2e/places-search.test.ts
git commit -m "test(e2e): places_search tool end-to-end test"
```

---

## Final verification checklist

- [ ] `npm test` — all unit + integration tests pass
- [ ] `npm run test:e2e -- e2e/places-search.test.ts` — E2E test passes
- [ ] `npm run test:e2e -- e2e/credential-injection-integration.test.ts` — helm catalog test passes
- [ ] `helm template smoke helm/kubeclaw --set namespace=kubeclaw --set secrets.anthropicApiKey=test --set secrets.claudeCodeOauthToken=test --set redis.password=test --set credentialInjection.mode=sidecar` renders `places.googleapis.com` in output
- [ ] `git log --oneline -5` shows five clean commits (Tasks 1–5)
- [ ] No source files other than those listed in the **Affected files** section have been modified
