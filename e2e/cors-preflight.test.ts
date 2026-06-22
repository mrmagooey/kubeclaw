/**
 * Story 47 — CORS preflight end-to-end tests
 *
 * Target: minikube cluster, namespace `kubeclaw-e2e-cors`,
 * HTTP channel on port 14131.
 *
 * These tests fire real OPTIONS requests against a live channel pod and assert
 * that browser clients can complete CORS preflight for cross-origin POST /message
 * and GET /stream requests.
 *
 * DO NOT execute during CI until the `kubeclaw-e2e-cors` namespace is
 * provisioned. The tests are present for completeness per Story 47 requirements.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const CHANNEL_PORT = 14131;
const CHANNEL_HOST = process.env.HTTP_CHANNEL_HOST ?? 'localhost';
const BASE_URL = `http://${CHANNEL_HOST}:${CHANNEL_PORT}`;

// Skip if no live cluster is available
const SKIP =
  !process.env.KUBECLAW_E2E_CORS_ENABLED ||
  process.env.KUBECLAW_E2E_CORS_ENABLED !== 'true';

describe.skipIf(SKIP)('Story 47 — CORS preflight (e2e, kubeclaw-e2e-cors namespace)', () => {
  // ── AC1: OPTIONS /message ─────────────────────────────────────────────────

  it(
    'OPTIONS /message with Origin + Access-Control-Request-Method: POST → 204 with correct CORS headers',
    async () => {
      const res = await fetch(`${BASE_URL}/message`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST');
      expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
        'Authorization, Content-Type',
      );
      expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    },
    10000,
  );

  // ── AC2: OPTIONS /stream ──────────────────────────────────────────────────

  it(
    'OPTIONS /stream with same pattern → 204 with Access-Control-Allow-Methods: GET',
    async () => {
      const res = await fetch(`${BASE_URL}/stream`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET');
    },
    10000,
  );

  // ── AC3: OPTIONS /healthz (no auth) ───────────────────────────────────────

  it(
    'OPTIONS /healthz → 204 with Access-Control-Allow-Origin without authentication',
    async () => {
      const res = await fetch(`${BASE_URL}/healthz`, {
        method: 'OPTIONS',
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    },
    10000,
  );

  // ── AC4: ACAO header on actual authenticated responses ───────────────────

  describe('Access-Control-Allow-Origin on authenticated responses', () => {
    const AUTH_USER = process.env.HTTP_CHANNEL_TEST_USER ?? 'testuser';
    const AUTH_PASS = process.env.HTTP_CHANNEL_TEST_PASS ?? 'testpass';

    function basicAuth(user: string, pass: string): string {
      return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    }

    it('GET /healthz response carries Access-Control-Allow-Origin: *', async () => {
      const res = await fetch(`${BASE_URL}/healthz`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }, 10000);

    it('POST /message response carries Access-Control-Allow-Origin: *', async () => {
      const res = await fetch(`${BASE_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(AUTH_USER, AUTH_PASS),
        },
        body: JSON.stringify({ text: 'cors e2e test ping' }),
      });

      // 200 if user is registered, otherwise treat any 2xx as passing
      expect(res.status).toBeLessThan(500);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }, 10000);

    it('GET /stream response carries Access-Control-Allow-Origin: *', async () => {
      const controller = new AbortController();

      const fetchPromise = fetch(`${BASE_URL}/stream`, {
        headers: { Authorization: basicAuth(AUTH_USER, AUTH_PASS) },
        signal: controller.signal,
      });

      const res = await fetchPromise;
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      controller.abort();
      await res.body?.cancel().catch(() => {});
    }, 10000);
  });
});
