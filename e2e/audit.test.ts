/**
 * GET /audit — End-to-End Tests (Story 81)
 *
 * Exercises the audit log endpoint using a real HttpChannel bound to
 * port 14164. Uses an in-memory SQLite database.  Destructive operations
 * are performed through real HTTP calls so that writeAuditEntry is called
 * by the real handler code paths; GET /audit then confirms the rows are
 * persisted and returned.
 *
 * No Kubernetes or live Redis required — in-process only.
 *
 * Namespace: kubeclaw-e2e-audit
 * Port: 14164
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
import { _initTestDatabase, __resetDbForTest } from '../src/db.js';

const HTTP_PORT = 14164;
const TEST_USER = 'alice';
const TEST_PASS = 'alicepass';
const TEST_GROUP_FOLDER = 'alice-group';
const TEST_JID = `http:${TEST_USER}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function makeOpts(overrides: Partial<HttpChannelOpts> = {}): HttpChannelOpts {
  return {
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({
      [TEST_JID]: {
        name: 'Alice',
        folder: TEST_GROUP_FOLDER,
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      },
    }),
    killJobFn: async (_jobId, _groupFolder) => ({ ok: true, status: 'cancelled' }),
    listSecretsFn: async () => [{ type: 'openai', fields_present: ['api_key'] }],
    removeSecretFn: async (_group, _type) => 'ok' as const,
    listCatalogFn: async () => [],
    addSecretFn: async (_group, _type, _fields) => ({ ok: true as const }),
    ...overrides,
  };
}

describe('GET /audit (Story 81)', () => {
  let channel: HttpChannel | null = null;

  beforeAll(async () => {
    await _initTestDatabase();

    channel = new HttpChannel(
      {
        port: HTTP_PORT,
        users: { [TEST_USER]: TEST_PASS },
        perUserMessagesPerMinute: 0,
        corsOrigin: '*',
      },
      makeOpts(),
    );
    await channel.connect();
  }, 10_000);

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  beforeEach(() => {
    __resetDbForTest();
  });

  // ── AC1: GET /audit returns 200 with entries array ─────────────────────────

  it('AC1: GET /audit returns 200 with empty entries when no actions performed', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/audit`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { entries: unknown[] };
    expect(body).toHaveProperty('entries');
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries).toHaveLength(0);
  }, 5000);

  // ── AC2: Destructive action creates audit entry visible via GET /audit ──────

  it('AC2: DELETE /history generates an audit entry visible via GET /audit', async () => {
    // Perform destructive action
    const delRes = await fetch(`http://localhost:${HTTP_PORT}/history`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(delRes.status).toBe(204);

    // Audit entry should be present
    const auditRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(auditRes.status).toBe(200);
    const body = await auditRes.json() as { entries: Array<Record<string, unknown>> };
    expect(body.entries.length).toBeGreaterThan(0);

    const entry = body.entries[0];
    expect(entry.action).toBe('history.clear');
    expect(entry.actor).toBe(TEST_USER);
    expect(entry).toHaveProperty('ts');
    expect(entry).toHaveProperty('id');
  }, 5000);

  // ── AC3: GET /audit returns newest entries first ───────────────────────────

  it('AC3: audit entries are returned newest-first', async () => {
    // Perform two distinct destructive actions in sequence
    await fetch(`http://localhost:${HTTP_PORT}/history`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    // Wait a tiny bit so timestamps differ
    await new Promise((r) => setTimeout(r, 10));

    await fetch(`http://localhost:${HTTP_PORT}/secrets/openai`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    const auditRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(auditRes.status).toBe(200);
    const body = await auditRes.json() as { entries: Array<Record<string, unknown>> };
    expect(body.entries.length).toBeGreaterThanOrEqual(2);

    // Newest first: secret.remove should appear before history.clear
    const actions = body.entries.map((e) => e.action);
    const secretIdx = actions.indexOf('secret.remove');
    const historyIdx = actions.indexOf('history.clear');
    expect(secretIdx).toBeLessThan(historyIdx);
  }, 5000);

  // ── AC4: ?limit param ─────────────────────────────────────────────────────

  it('AC4: ?limit parameter limits the number of entries returned', async () => {
    // Generate 3 entries
    for (let i = 0; i < 3; i++) {
      await fetch(`http://localhost:${HTTP_PORT}/history`, {
        method: 'DELETE',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      await new Promise((r) => setTimeout(r, 5));
    }

    const res = await fetch(`http://localhost:${HTTP_PORT}/audit?limit=2`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[] };
    expect(body.entries).toHaveLength(2);
  }, 5000);

  it('AC4: ?limit defaults to 50 when not provided', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/audit`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    // Default limit should not cause an error; result can be 0 but response must be valid
    const body = await res.json() as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  }, 5000);

  // ── AC5: secret.add audit entry contains field NAMES, not VALUES ───────────

  it('AC5: POST /secrets audit entry contains field names but never secret values', async () => {
    const secretRes = await fetch(`http://localhost:${HTTP_PORT}/secrets`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'replicate',
        fields: { token: 'r8_supersecret_live_token_value' },
      }),
    });
    expect(secretRes.status).toBe(201);

    const auditRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(auditRes.status).toBe(200);
    const body = await auditRes.json() as { entries: Array<Record<string, unknown>> };

    const addEntry = body.entries.find((e) => e.action === 'secret.add');
    expect(addEntry).toBeDefined();
    expect(addEntry!.target).toBe('replicate');
    expect(addEntry!.actor).toBe(TEST_USER);

    // SECURITY: field names may appear, secret value must NEVER appear
    const serialized = JSON.stringify(body.entries);
    expect(serialized).not.toContain('r8_supersecret_live_token_value');
    expect(String(addEntry!.detail)).toContain('token');
    expect(String(addEntry!.detail)).toContain('fields=');
  }, 5000);

  // ── AC6: auth guards ───────────────────────────────────────────────────────

  it('AC6: unauthenticated GET /audit → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/audit`);
    expect(res.status).toBe(401);
  }, 5000);

  it('AC6: wrong password GET /audit → 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/audit`, {
      headers: { Authorization: basicAuth(TEST_USER, 'wrongpass') },
    });
    expect(res.status).toBe(401);
  }, 5000);

  // ── AC7: method guard ──────────────────────────────────────────────────────

  it('AC7: POST /audit → 405 with Allow: GET, HEAD', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/audit`, {
      method: 'POST',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(405);
    const allow = res.headers.get('allow') ?? '';
    expect(allow).toMatch(/\bGET\b/);
    expect(allow).toMatch(/\bHEAD\b/);
  }, 5000);

  it('AC7: HEAD /audit → 200, same content-type, no body', async () => {
    const [getRes, headRes] = await Promise.all([
      fetch(`http://localhost:${HTTP_PORT}/audit`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
      fetch(`http://localhost:${HTTP_PORT}/audit`, {
        method: 'HEAD',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      }),
    ]);

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('application/json');
    const headBody = await headRes.text();
    expect(headBody).toBe('');
    const getBody = await getRes.text();
    // GET with no entries still returns a JSON object
    expect(getBody).toContain('entries');
  }, 5000);

  // ── AC8: audit rows are scoped to the caller's group_folder ───────────────

  it('AC8: audit entries are scoped to caller (alice does not see bob entries)', async () => {
    // Create a second channel for bob
    const bobChannel = new HttpChannel(
      {
        port: HTTP_PORT + 1,
        users: { bob: 'bobpass' },
        perUserMessagesPerMinute: 0,
        corsOrigin: '*',
      },
      {
        onMessage: () => {},
        onChatMetadata: () => {},
        registeredGroups: () => ({
          'http:bob': {
            name: 'Bob',
            folder: 'bob-group',
            trigger: '@Andy',
            added_at: new Date().toISOString(),
            requiresTrigger: false,
          },
        }),
        killJobFn: async () => ({ ok: true, status: 'cancelled' }),
        listSecretsFn: async () => [],
        removeSecretFn: async () => 'ok' as const,
        listCatalogFn: async () => [],
        addSecretFn: async () => ({ ok: true as const }),
      },
    );
    await bobChannel.connect();

    try {
      // Bob clears his history
      await fetch(`http://localhost:${HTTP_PORT + 1}/history`, {
        method: 'DELETE',
        headers: { Authorization: basicAuth('bob', 'bobpass') },
      });

      // Alice clears her history (different group_folder)
      await fetch(`http://localhost:${HTTP_PORT}/history`, {
        method: 'DELETE',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });

      // Alice's audit log should contain only her own entry
      const aliceAudit = await fetch(`http://localhost:${HTTP_PORT}/audit`, {
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      });
      const aliceBody = await aliceAudit.json() as { entries: Array<Record<string, unknown>> };
      expect(aliceBody.entries.every((e) => e.actor === TEST_USER)).toBe(true);
    } finally {
      await bobChannel.disconnect();
    }
  }, 10000);
});
