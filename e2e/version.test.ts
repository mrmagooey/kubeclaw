/**
 * End-to-End tests for GET /version
 *
 * Story 61 — GET /version reports build version and config summary.
 *
 * Namespace: kubeclaw-e2e-version  Port: 14144
 *
 * These tests start a real HttpChannel on port 14144 and make live HTTP
 * requests to verify the /version endpoint behaviour end-to-end.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';

const VERSION_PORT = 14144;

function createOpts(): HttpChannelOpts {
  return {
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({}),
  };
}

function createChannel(): HttpChannel {
  return new HttpChannel(
    { port: VERSION_PORT, users: { testuser: 'testpass' } },
    createOpts(),
  );
}

describe('GET /version (e2e)', () => {
  let channel: HttpChannel | null = null;

  beforeAll(async () => {
    channel = createChannel();
    await channel.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  // ── AC1: 200, application/json, required keys ──────────────────────────────

  it('AC1: returns 200 with Content-Type application/json', async () => {
    const res = await fetch(`http://localhost:${VERSION_PORT}/version`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  }, 5000);

  it('AC1+AC5: response parses as JSON and has all 4 required keys', async () => {
    const res = await fetch(`http://localhost:${VERSION_PORT}/version`);
    const body = await res.json() as Record<string, unknown>;

    // AC5: all 4 keys must be present (value may be null but not omitted)
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('model');
    expect(body).toHaveProperty('rateLimitWindowMs');
    expect(body).toHaveProperty('toolJobsRetentionDays');
  }, 5000);

  it('AC1: does not require authentication', async () => {
    // No Authorization header — should still return 200
    const res = await fetch(`http://localhost:${VERSION_PORT}/version`);
    expect(res.status).toBe(200);
  }, 5000);

  // ── AC2: version sourced from KUBECLAW_VERSION env var ────────────────────

  it('AC2: version field is "dev" when KUBECLAW_VERSION is not set', async () => {
    // In dev/test the env var is absent, so "dev" is expected
    const saved = process.env.KUBECLAW_VERSION;
    delete process.env.KUBECLAW_VERSION;
    try {
      const res = await fetch(`http://localhost:${VERSION_PORT}/version`);
      const body = await res.json() as Record<string, unknown>;
      // The channel was already started; buildVersionPayload reads env at
      // call time, so unsetting here verifies the "dev" fallback path in a
      // fresh request.  (If a prior test set KUBECLAW_VERSION, it was
      // deleted above, so we can assert "dev".)
      expect(body.version).toBe('dev');
    } finally {
      if (saved !== undefined) process.env.KUBECLAW_VERSION = saved;
    }
  }, 5000);

  // ── AC3: model is the default direct-LLM model id ─────────────────────────

  it('AC3: model field is a non-empty string or null', async () => {
    const res = await fetch(`http://localhost:${VERSION_PORT}/version`);
    const body = await res.json() as Record<string, unknown>;
    // model must be a non-empty string or null (never omitted)
    expect(
      body.model === null || (typeof body.model === 'string' && body.model.length > 0),
    ).toBe(true);
  }, 5000);

  // ── AC4: POST /version → 405 with Allow: GET, HEAD ───────────────────────

  it('AC4: POST /version returns 405 with Allow: GET, HEAD', async () => {
    const res = await fetch(`http://localhost:${VERSION_PORT}/version`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  }, 5000);

  it('AC4: HEAD /version returns same headers as GET with no body', async () => {
    const [getRes, headRes] = await Promise.all([
      fetch(`http://localhost:${VERSION_PORT}/version`),
      fetch(`http://localhost:${VERSION_PORT}/version`, { method: 'HEAD' }),
    ]);

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('application/json');

    // HEAD must not return a body
    const headBody = await headRes.text();
    expect(headBody).toBe('');

    // GET returns a body
    const getBody = await getRes.text();
    expect(getBody.length).toBeGreaterThan(0);

    // Content-Length should match
    expect(headRes.headers.get('content-length')).toBe(
      getRes.headers.get('content-length'),
    );
  }, 5000);
});
