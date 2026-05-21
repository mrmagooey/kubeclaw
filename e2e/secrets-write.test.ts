/**
 * Story 76: POST /secrets REST endpoint — provision credentials via REST
 *
 * End-to-End tests for the POST /secrets endpoint.
 *   POST /secrets  → 201 { status: 'ok', type: '<id>' } on success
 *                  → 400 on missing/invalid fields or type
 *                  → 401 without credentials
 *                  → 405 for PUT/PATCH/DELETE (Allow: GET, HEAD, POST)
 *                  → 413 body > 64 KiB
 *                  → 502 IPC error reply
 *                  → 504 IPC timeout
 *
 * SECURITY:
 *   - Secret VALUES must never appear in any response body.
 *   - Cross-group isolation: group is derived from auth, not client body.
 *
 * Namespace: kubeclaw-e2e-secrets-write
 * Port: 14159
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  HttpChannel,
  type HttpChannelOpts,
  type SecretListEntry,
  type CatalogListEntry,
  type AddSecretFn,
} from '../src/channels/http.js';

const HTTP_PORT = 14159;
const TEST_USER = 'alice';
const TEST_PASS = 'testsecret3';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ── Fixture store ──────────────────────────────────────────────────────────

let addedSecrets: Array<{ group: string; type: string; fields: Record<string, string> }> = [];
let addSecretShouldFail = false;
let addSecretShouldTimeout = false;
let addSecretErrorMessage = '';

// ── Channel wiring ─────────────────────────────────────────────────────────

function createTestChannel(overrides?: Partial<HttpChannelOpts>): HttpChannel {
  const addSecretFn: AddSecretFn = async (group, type, fields) => {
    if (addSecretShouldTimeout) {
      return { ok: false, error: 'timeout' };
    }
    if (addSecretShouldFail) {
      return { ok: false, error: addSecretErrorMessage || 'storage_error' };
    }
    addedSecrets.push({ group, type, fields });
    return { ok: true };
  };

  const opts: HttpChannelOpts = {
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({
      [`http:${TEST_USER}`]: {
        name: TEST_USER,
        folder: `e2e-secrets-write-${TEST_USER}`,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      },
    }),
    listSecretsFn: async (_group: string): Promise<SecretListEntry[]> => [],
    removeSecretFn: async (): Promise<'ok' | 'not_found'> => 'ok',
    listCatalogFn: async (): Promise<CatalogListEntry[]> => [],
    addSecretFn,
    ...overrides,
  };

  const config = { port: HTTP_PORT, users: { [TEST_USER]: TEST_PASS } };
  return new HttpChannel(config, opts);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Story 76: POST /secrets', () => {
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
    addedSecrets = [];
    addSecretShouldFail = false;
    addSecretShouldTimeout = false;
    addSecretErrorMessage = '';
  });

  // ── AC1: 201 success ───────────────────────────────────────────────────

  describe('AC1: success path', () => {
    it('returns 201 { status: ok, type: <id> } on valid request', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'openai',
          fields: { api_key: 'sk-test-value-1234' },
        }),
      });

      expect(res.status).toBe(201);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = (await res.json()) as { status: string; type: string };
      expect(body.status).toBe('ok');
      expect(body.type).toBe('openai');
    });

    it('addSecretFn receives group from auth session, not client body', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'replicate',
          fields: { token: 'r8_faketoken123' },
          // group param in body must be IGNORED
          group: 'malicious-group',
        }),
      });

      expect(res.status).toBe(201);

      // The group stored must be from auth, not from the body
      expect(addedSecrets).toHaveLength(1);
      expect(addedSecrets[0].group).toBe(`e2e-secrets-write-${TEST_USER}`);
      expect(addedSecrets[0].group).not.toBe('malicious-group');
    });

    it('SECURITY: 201 response body never contains the secret value', async () => {
      const secretValue = 'sk-secretvalue-should-not-appear-12345';
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'openai',
          fields: { api_key: secretValue },
        }),
      });

      expect(res.status).toBe(201);
      const text = await res.text();
      expect(text).not.toContain(secretValue);
    });
  });

  // ── AC2: validation errors ─────────────────────────────────────────────

  describe('AC2: validation errors → 400', () => {
    it('returns 400 when fields is missing', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeDefined();
    });

    it('returns 400 when fields is null', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai', fields: null }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when fields is an array', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai', fields: ['api_key', 'value'] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when type is missing', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: { api_key: 'sk-x' } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when type is not a string', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 42, fields: { api_key: 'sk-x' } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON body', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: 'not-valid-json',
      });

      expect(res.status).toBe(400);
    });
  });

  // ── AC3: IPC error paths ───────────────────────────────────────────────

  describe('AC3: IPC error paths', () => {
    it('returns 504 when IPC returns timeout error', async () => {
      addSecretShouldTimeout = true;

      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-x' } }),
      });

      expect(res.status).toBe(504);
    });

    it('returns 502 when IPC returns non-timeout error', async () => {
      addSecretShouldFail = true;
      addSecretErrorMessage = 'k8s_unavailable';

      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-x' } }),
      });

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeDefined();
    });

    it('SECURITY: 502 error body never contains submitted secret values', async () => {
      const secretValue = 'r8_secretvalue-must-not-appear-123456';
      addSecretShouldFail = true;
      addSecretErrorMessage = `storage failed for ${secretValue}`;

      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'replicate', fields: { token: secretValue } }),
      });

      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain(secretValue);
    });
  });

  // ── AC4: auth ──────────────────────────────────────────────────────────

  describe('AC4: authentication', () => {
    it('returns 401 without credentials', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-x' } }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong password', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, 'wrongpass'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-x' } }),
      });

      expect(res.status).toBe(401);
    });
  });

  // ── AC5: CORS and method ───────────────────────────────────────────────

  describe('AC5: CORS/method (PUT → 405 Allow: GET, HEAD, POST)', () => {
    it('PUT /secrets returns 405 with Allow: GET, HEAD, POST', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'PUT',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-x' } }),
      });

      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, HEAD, POST');
    });

    it('PATCH /secrets returns 405', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'PATCH',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai', fields: { api_key: 'sk-x' } }),
      });

      expect(res.status).toBe(405);
    });

    it('GET /secrets still works after adding POST', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'GET',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      expect(res.status).toBe(200);
    });

    it('HEAD /secrets still works', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      expect(res.status).toBe(200);
    });
  });

  // ── AC5: body size cap ─────────────────────────────────────────────────

  describe('AC5: body size cap (64 KiB)', () => {
    it('returns 413 when body exceeds 64 KiB', async () => {
      const bigValue = 'x'.repeat(70 * 1024); // 70 KiB
      const res = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(TEST_USER, TEST_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'openai', fields: { api_key: bigValue } }),
      });

      expect(res.status).toBe(413);
    });
  });
});
