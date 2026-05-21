/**
 * Story 73: /secrets REST endpoints — list, delete, catalog
 *
 * End-to-End tests for the new REST endpoints:
 *   GET  /secrets           → list registered secrets (no values)
 *   DELETE /secrets/:type   → remove a secret by type
 *   GET  /secrets/catalog   → list credential catalog
 *   POST /secrets           → 405 Allow: GET, HEAD
 *   POST /secrets/:type     → 405 Allow: DELETE, HEAD
 *
 * Namespace: kubeclaw-e2e-secrets-http
 * Port: 14156
 *
 * Uses injectable callbacks (listSecretsFn, removeSecretFn, listCatalogFn)
 * to avoid Redis/K8s dependencies in the test environment.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import {
  HttpChannel,
  type HttpChannelOpts,
  type SecretListEntry,
  type CatalogListEntry,
} from '../src/channels/http.js';

const HTTP_PORT = 14156;
const TEST_USER = 'alice';
const TEST_PASS = 'testsecret2';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ── Fixture store for injectable callbacks ─────────────────────────────────

let secretStore: SecretListEntry[] = [];
let catalogStore: CatalogListEntry[] = [];
let removedTypes: string[] = [];

// ── Channel wiring ─────────────────────────────────────────────────────────

function createTestChannel(overrides?: Partial<HttpChannelOpts>): HttpChannel {
  const opts: HttpChannelOpts = {
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({
      [`http:${TEST_USER}`]: {
        name: TEST_USER,
        folder: `e2e-secrets-${TEST_USER}`,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      },
    }),
    listSecretsFn: async (_group: string): Promise<SecretListEntry[]> => {
      return secretStore;
    },
    removeSecretFn: async (
      _group: string,
      type: string,
    ): Promise<'ok' | 'not_found'> => {
      const exists = secretStore.some((e) => e.type === type);
      if (!exists) return 'not_found';
      secretStore = secretStore.filter((e) => e.type !== type);
      removedTypes.push(type);
      return 'ok';
    },
    listCatalogFn: async (): Promise<CatalogListEntry[]> => {
      return catalogStore;
    },
    ...overrides,
  };
  const config = { port: HTTP_PORT, users: { [TEST_USER]: TEST_PASS } };
  return new HttpChannel(config, opts);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Story 73: /secrets REST endpoints', () => {
  let channel: HttpChannel | null = null;

  beforeAll(async () => {
    channel = createTestChannel();
    await channel.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  beforeEach(() => {
    // Reset fixture state before each test
    secretStore = [
      { type: 'replicate', fields_present: ['token'] },
      { type: 'openai', fields_present: ['api_key', 'org_id'] },
    ];
    catalogStore = [
      {
        type: 'replicate',
        required_fields: ['token'],
        optional_fields: [],
        description: 'api.replicate.com',
      },
      {
        type: 'openai',
        required_fields: ['api_key'],
        optional_fields: ['org_id'],
        description: 'api.openai.com',
      },
    ];
    removedTypes = [];
  });

  // ── AC1: GET /secrets ───────────────────────────────────────────────────

  describe('GET /secrets', () => {
    it('returns 200 JSON array with type and fields_present', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = (await res.json()) as SecretListEntry[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);

      const replicate = body.find((e) => e.type === 'replicate');
      expect(replicate).toBeDefined();
      expect(replicate!.fields_present).toEqual(['token']);

      const openai = body.find((e) => e.type === 'openai');
      expect(openai).toBeDefined();
      expect(openai!.fields_present).toEqual(['api_key', 'org_id']);
    });

    it('returns 200 empty array when no secrets registered', async () => {
      secretStore = [];

      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it('SECURITY: response contains no secret values', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      const text = await res.text();
      // No common secret value patterns should leak
      expect(text).not.toMatch(/r8_[A-Za-z0-9]{10,}/);
      expect(text).not.toMatch(/KC_PH_/);
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      // Only the allowed keys should appear in the JSON
      const body = JSON.parse(text) as SecretListEntry[];
      for (const entry of body) {
        expect(Object.keys(entry).sort()).toEqual(
          ['fields_present', 'type'].sort(),
        );
      }
    });

    it('returns 401 without credentials', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`);
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong credentials', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        headers: { Authorization: basicAuth(TEST_USER, 'wrongpass') },
      });
      expect(res.status).toBe(401);
    });

    it('HEAD /secrets returns 200', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(200);
    });

    it('POST /secrets returns 405 with Allow: GET, HEAD', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, HEAD');
    });
  });

  // ── AC2: DELETE /secrets/:type ──────────────────────────────────────────

  describe('DELETE /secrets/:type', () => {
    it('returns 204 on successful delete', async () => {
      const res = await fetch(
        `http://localhost:${HTTP_PORT}/secrets/replicate`,
        {
          method: 'DELETE',
          headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
        },
      );
      expect(res.status).toBe(204);
    });

    it('after delete, type no longer appears in list', async () => {
      await fetch(`http://localhost:${HTTP_PORT}/secrets/replicate`, {
        method: 'DELETE',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      const listRes = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      const body = (await listRes.json()) as SecretListEntry[];
      const types = body.map((e) => e.type);
      expect(types).not.toContain('replicate');
    });

    it('returns 404 for unknown type', async () => {
      const res = await fetch(
        `http://localhost:${HTTP_PORT}/secrets/unknown-type`,
        {
          method: 'DELETE',
          headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
        },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Not found');
    });

    it('returns 404 with identical wording for cross-group type (security: indistinguishable from unknown)', async () => {
      // A type that belongs to another group should return the same 404 as unknown
      const res = await fetch(
        `http://localhost:${HTTP_PORT}/secrets/other-group-secret`,
        {
          method: 'DELETE',
          headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
        },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Not found');
    });

    it('returns 401 without credentials', async () => {
      const res = await fetch(
        `http://localhost:${HTTP_PORT}/secrets/replicate`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(401);
    });

    it('HEAD /secrets/:type returns 200', async () => {
      const res = await fetch(
        `http://localhost:${HTTP_PORT}/secrets/replicate`,
        {
          method: 'HEAD',
          headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
        },
      );
      expect(res.status).toBe(200);
    });

    it('POST /secrets/:type returns 405 with Allow: DELETE, HEAD', async () => {
      const res = await fetch(
        `http://localhost:${HTTP_PORT}/secrets/replicate`,
        {
          method: 'POST',
          headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
        },
      );
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('DELETE, HEAD');
    });
  });

  // ── AC3: GET /secrets/catalog ───────────────────────────────────────────

  describe('GET /secrets/catalog', () => {
    it('returns 200 JSON array of catalog entries with type, required_fields, optional_fields, description', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets/catalog`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = (await res.json()) as CatalogListEntry[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);

      const replicate = body.find((e) => e.type === 'replicate');
      expect(replicate).toBeDefined();
      expect(replicate!.required_fields).toEqual(['token']);
      expect(replicate!.optional_fields).toEqual([]);
      expect(replicate!.description).toBe('api.replicate.com');

      const openai = body.find((e) => e.type === 'openai');
      expect(openai).toBeDefined();
      expect(openai!.required_fields).toEqual(['api_key']);
      expect(openai!.optional_fields).toEqual(['org_id']);
    });

    it('returns 401 without credentials', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets/catalog`);
      expect(res.status).toBe(401);
    });

    it('SECURITY: catalog response contains no secret values', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets/catalog`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      const text = await res.text();
      const body = JSON.parse(text) as CatalogListEntry[];
      // Only the documented keys must appear
      for (const entry of body) {
        expect(Object.keys(entry).sort()).toEqual(
          ['description', 'optional_fields', 'required_fields', 'type'].sort(),
        );
      }
    });

    it('HEAD /secrets/catalog returns 200', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets/catalog`, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(200);
    });

    it('POST /secrets/catalog returns 405 with Allow: GET, HEAD', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets/catalog`, {
        method: 'POST',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, HEAD');
    });
  });
});
