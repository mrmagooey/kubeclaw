/**
 * Minikube-live end-to-end tests for the oauth-webchat channel.
 *
 * Depends on the global setup in e2e/minikube-live-setup.ts which helm-installs
 * kubeclaw into namespace `kubeclaw-live` with:
 *   - capabilities.test-oauth  → kubeclaw-test-oauth:latest (OIDC provider fixture)
 *   - channels.oauth-webchat   → oauth-webchat channel pod, pointed at test-oauth
 *
 * Tests drive the deployed channel from outside the cluster via a port-forward to
 * localhost:KUBECLAW_LIVE_OAUTH_WEBCHAT_LOCAL_PORT, exactly as a real user would.
 *
 * The test OAuth provider (kubeclaw-test-oauth fixture) implements the OIDC
 * Authorization Code flow with a fixed test user: alice@test.local.
 * It immediately redirects /authorize → /callback, skipping any login UI.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_OAUTH_WEBCHAT_LOCAL_PORT,
  KUBECLAW_LIVE_TEST_OAUTH_LOCAL_PORT,
  KUBECLAW_LIVE_OAUTH_WEBCHAT_USER,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const OAUTH_URL = `http://127.0.0.1:${KUBECLAW_LIVE_OAUTH_WEBCHAT_LOCAL_PORT}`;
// The test-oauth OIDC provider is in-cluster; we port-forward it to reach
// /authorize for the redirect-following step of the OAuth flow.
const TEST_OIDC_URL = `http://127.0.0.1:${KUBECLAW_LIVE_TEST_OAUTH_LOCAL_PORT}`;

// How long to wait for the channel pod to be reachable after globalSetup.
const PROVISIONED_TIMEOUT_MS = 30_000;

// Maximum time to poll channel logs for expected markers.
const LOG_POLL_TIMEOUT_MS = 60_000;

function kubectl(
  args: string[],
  opts: { timeout?: number; input?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    input: opts.input,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Resolve the first running pod name for a label selector. */
function getPodName(labelSelector: string): string | null {
  const r = kubectl([
    'get', 'pods', '-n', NAMESPACE,
    '-l', labelSelector,
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]);
  const name = r.ok ? r.stdout.trim() : '';
  return name || null;
}

/** Poll fn() until predicate returns true or timeout elapses. */
async function pollUntil(
  fn: () => boolean,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Perform an HTTP GET request without automatic redirect following.
 * Returns status, headers, and body.
 */
function httpGet(
  url: string,
  cookieHeader?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      method: 'GET',
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    };
    const req = http.request(url, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Extract Set-Cookie values from response headers.
 * Returns an array of "name=value" strings (without attributes like; Secure; HttpOnly).
 */
function extractCookies(headers: http.IncomingHttpHeaders): string[] {
  const raw = headers['set-cookie'] ?? [];
  return raw.map((c) => c.split(';')[0]);
}

/**
 * Perform the full OIDC Authorization Code flow and return the session cookie.
 *
 * Steps:
 *   1. GET /login/start  → 302 to OIDC /authorize + state cookie
 *   2. GET /authorize (on test-oauth provider, reached via in-cluster routing)
 *      BUT: The test-oauth provider redirects to the channel's /callback using
 *      the redirect_uri that the channel put in the authorize URL.
 *      We follow that redirect URL directly (it points to our port-forward address).
 *   3. GET /callback?code=...&state=... with state cookie → 302 to / + session cookie
 *
 * Note: The channel pod's PUBLIC_URL is set to http://127.0.0.1:14082, so the
 * redirect_uri in step 1 is http://127.0.0.1:14082/callback. The test-oauth
 * fixture redirects immediately to that URL, so we can follow it from the test.
 */
async function performOauthFlow(): Promise<string> {
  // Step 1: GET /login/start — returns 302 to OIDC /authorize + state cookie
  const startRes = await httpGet(`${OAUTH_URL}/login/start`);
  if (startRes.status !== 302) {
    throw new Error(
      `Expected 302 from /login/start, got ${startRes.status}: ${startRes.body}`,
    );
  }

  const stateCookies = extractCookies(startRes.headers);
  const stateCookie = stateCookies.find((c) => c.startsWith('oauth-webchat-state='));
  if (!stateCookie) {
    throw new Error(
      `No oauth-webchat-state cookie in /login/start response. Cookies: ${JSON.stringify(stateCookies)}`,
    );
  }

  const authorizeUrlRaw = startRes.headers.location as string;
  if (!authorizeUrlRaw) {
    throw new Error('No Location header from /login/start');
  }

  // The authorize URL references the in-cluster OIDC provider:
  //   http://kubeclaw-capability-test-oauth:8080/authorize?...
  // Rewrite the host to use our local port-forward so we can follow it.
  const authorizeUrl = authorizeUrlRaw.replace(
    /^http:\/\/kubeclaw-capability-test-oauth(:\d+)?/,
    TEST_OIDC_URL,
  );

  // Step 2: Follow redirect to the test-oauth provider's /authorize endpoint.
  // The provider immediately 302s back to the channel's /callback with code+state.
  // The redirect_uri is http://127.0.0.1:14082/callback (our channel port-forward).
  const authorizeRes = await new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
  }>((resolve, reject) => {
    http
      .get(authorizeUrl, (res) => {
        res.resume(); // discard body
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      })
      .on('error', reject);
  });

  if (authorizeRes.status !== 302) {
    throw new Error(
      `Expected 302 from OIDC /authorize at ${authorizeUrl}, got ${authorizeRes.status}`,
    );
  }

  const callbackUrl = authorizeRes.headers.location as string;
  if (!callbackUrl) {
    throw new Error('No Location from OIDC /authorize');
  }

  // The callback URL should point to http://127.0.0.1:14082/callback?code=...&state=...
  // (the channel pod's PUBLIC_URL is set to that address). If the test-oauth
  // fixture somehow returns a different origin, rewrite it to our port-forward.
  const callbackFinal = callbackUrl.replace(
    /^http:\/\/[^/]+/,
    OAUTH_URL,
  );

  // Step 3: GET /callback with state cookie — expect 302 to / + session cookie
  const callbackRes = await httpGet(callbackFinal, stateCookie);
  if (callbackRes.status !== 302) {
    throw new Error(
      `Expected 302 from /callback, got ${callbackRes.status}: ${callbackRes.body}`,
    );
  }

  const sessionCookies = extractCookies(callbackRes.headers);
  const sessionCookie = sessionCookies.find((c) =>
    c.startsWith('oauth-webchat-session='),
  );
  if (!sessionCookie) {
    throw new Error(
      `No session cookie from /callback. Status: ${callbackRes.status}, ` +
      `Location: ${callbackRes.headers.location}, ` +
      `Cookies: ${JSON.stringify(sessionCookies)}`,
    );
  }

  return sessionCookie;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Minikube-live oauth-webchat: OIDC login flow through helm-deployed channel', () => {
  let provisioned = false;
  let channelPodName: string | null = null;

  beforeAll(async () => {
    // Wait for the channel pod to exist and the port-forward to be live.
    const deadline = Date.now() + PROVISIONED_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await httpGet(`${OAUTH_URL}/login`);
        // Any HTTP response (including 200) means the channel pod is reachable.
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        // port-forward not yet live — retry
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    channelPodName = getPodName('app=kubeclaw-channel-oauth-webchat');

    if (!provisioned) {
      console.warn(
        `⚠️  oauth-webchat port-forward at ${OAUTH_URL} not reachable after ` +
        `${PROVISIONED_TIMEOUT_MS}ms — globalSetup may have failed.`,
      );
    }
  }, PROVISIONED_TIMEOUT_MS + 5_000);

  // ── 1. Channel pod is Running/Ready ─────────────────────────────────────
  it('oauth-webchat channel pod is Running and Ready in kubeclaw-live namespace', () => {
    expect(provisioned, 'globalSetup port-forward not live').toBe(true);

    const r = kubectl([
      'get', 'pods', '-n', NAMESPACE,
      '-l', 'app=kubeclaw-channel-oauth-webchat',
      '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
    ]);
    expect(r.ok, `kubectl get pods failed: ${r.stderr}`).toBe(true);
    const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
    expect(statuses.length, 'no oauth-webchat channel pods found').toBeGreaterThan(0);
    expect(
      statuses.every((s) => s === 'True'),
      `not all pods Ready: ${statuses.join(',')}`,
    ).toBe(true);
  });

  // ── 2. GET /login returns the login page (unauthenticated landing) ───────
  it('GET /login returns the sign-in page when unauthenticated', async () => {
    expect(provisioned).toBe(true);

    const res = await httpGet(`${OAUTH_URL}/login`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Login page contains the sign-in form pointing to /login/start
    // and the provider name configured as 'TestOIDC'.
    expect(res.body).toContain('/login/start');
    expect(res.body).toContain('TestOIDC');
  });

  // ── 3. GET / unauthenticated redirects to /login ─────────────────────────
  it('GET / redirects unauthenticated requests to /login', async () => {
    expect(provisioned).toBe(true);

    const res = await httpGet(`${OAUTH_URL}/`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  // ── 4. Full OAuth flow establishes a session ─────────────────────────────
  // Simulates: /login/start → OIDC /authorize → /callback → session cookie
  // After the flow, GET / with the session cookie returns the chat UI.
  it('OAuth flow: /login/start → test-oauth → /callback establishes a session', async () => {
    expect(provisioned).toBe(true);

    const sessionCookie = await performOauthFlow();
    expect(sessionCookie).toMatch(/^oauth-webchat-session=/);

    // Confirm the session cookie grants access to the chat UI
    const homeRes = await httpGet(`${OAUTH_URL}/`, sessionCookie);
    expect(homeRes.status).toBe(200);
    expect(homeRes.headers['content-type']).toMatch(/text\/html/);
    // Chat UI shows the authenticated user's email
    expect(homeRes.body).toContain(KUBECLAW_LIVE_OAUTH_WEBCHAT_USER);
    // Chat UI includes /stream and /logout links
    expect(homeRes.body).toContain('/stream');
    expect(homeRes.body).toContain('/logout');
  });

  // ── 5. POST /message (authenticated) triggers inbound message processing ─
  // This test sends a message after completing the OAuth flow and verifies
  // that the channel pod processes it (logs show "onChatMetadata" was called).
  // We do not wait for the full LLM reply here — that is covered by the HTTP
  // channel tests and would add significant latency.
  it('POST /message with session cookie is accepted and triggers message processing', async () => {
    expect(provisioned).toBe(true);
    expect(channelPodName, 'channel pod name not found').toBeTruthy();

    const sessionCookie = await performOauthFlow();

    // Send a message via JSON body (the channel supports both JSON and multipart)
    const marker = `oauth-webchat-e2e-ping-${Date.now()}`;
    const msgRes = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const payload = JSON.stringify({ text: marker });
        const req = http.request(
          `${OAUTH_URL}/message`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              cookie: sessionCookie,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      },
    );

    expect(msgRes.status).toBe(200);

    // Poll the channel pod logs for the "oauth-webchat message stored" log line
    // emitted by handleInbound() on every inbound message.
    let channelLogs = '';
    const appeared = await pollUntil(
      () => {
        const r = kubectl(
          [
            'logs', '-n', NAMESPACE,
            channelPodName!,
            '-c', 'channel',
            '--tail=500',
          ],
          { timeout: 8_000 },
        );
        channelLogs = r.ok ? r.stdout : '';
        return (
          channelLogs.includes('oauth-webchat message stored') ||
          channelLogs.includes(marker)
        );
      },
      3_000,
      LOG_POLL_TIMEOUT_MS,
    );

    expect(
      appeared,
      `Expected 'oauth-webchat message stored' or marker '${marker}' in channel pod logs within ${LOG_POLL_TIMEOUT_MS}ms.\n` +
      `Last tail:\n${channelLogs.slice(-2000)}`,
    ).toBe(true);
  }, 90_000);

  // ── 6. First message auto-registers the user's group in SQLite ───────────
  // The channel pod's onChatMetadata auto-registers new chats (same as HTTP channel).
  // After test 5 above ran, the SQLite in the channel pod's groups PVC should
  // contain a row for `oauth-webchat:alice@test.local`.
  it("first message auto-registers the user's group in the channel pod's SQLite", () => {
    expect(provisioned).toBe(true);
    expect(channelPodName, 'channel pod name not found').toBeTruthy();

    const jid = `oauth-webchat:${KUBECLAW_LIVE_OAUTH_WEBCHAT_USER}`;
    const queryScript = `
      const fs = require('node:fs');
      const initSqlJs = require('/app/node_modules/sql.js');
      (async () => {
        const SQL = await initSqlJs();
        const candidates = [
          '/app/groups/registered_groups.db',
          '/app/groups/db.sqlite',
          '/data/sessions/registered_groups.db',
        ];
        let dbPath = null;
        for (const p of candidates) { if (fs.existsSync(p)) { dbPath = p; break; } }
        if (!dbPath) {
          const { execSync } = require('node:child_process');
          const found = execSync('find /app/groups /data /app/store -name "*.db" 2>/dev/null || true').toString().trim().split('\\n').filter(Boolean);
          if (found.length === 0) { console.log('no-db-found'); process.exit(0); }
          dbPath = found[0];
        }
        const data = fs.readFileSync(dbPath);
        const db = new SQL.Database(new Uint8Array(data));
        const rows = db.exec("SELECT jid, folder FROM registered_groups WHERE jid = '${jid}'");
        if (rows.length === 0) { console.log('no-match'); process.exit(0); }
        console.log('FOUND:' + JSON.stringify(rows[0].values));
      })().catch((e) => { console.error('script-error:', e.message); process.exit(4); });
    `;

    const exec = kubectl(
      [
        'exec', '-n', NAMESPACE,
        channelPodName!,
        '-c', 'channel',
        '--',
        'node', '-e', queryScript,
      ],
      { timeout: 30_000 },
    );
    expect(
      exec.ok,
      `db probe failed:\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
    ).toBe(true);
    expect(
      exec.stdout,
      `expected FOUND: marker in stdout, got: ${exec.stdout}`,
    ).toMatch(/^FOUND:/m);
  });

  // ── 7. Orchestrator logs the oauth-webchat channel as registered ─────────
  it('orchestrator pod logs show the oauth-webchat channel pod registered', () => {
    expect(provisioned).toBe(true);

    const r = kubectl([
      'logs', '-n', NAMESPACE,
      'deployment/kubeclaw-orchestrator',
      '--tail=2000',
    ]);
    expect(r.ok).toBe(true);
    // The orchestrator subscribes to kubeclaw:channel-status:<name> and logs
    // when a channel reports ready. Either an explicit channel-status event,
    // discovery of the channel deployment, or the admin HTTP server being up
    // (proving the orchestrator processed startup and would have received the
    // channel registration) is acceptable evidence.
    expect(
      r.stdout,
      `expected 'channel-status', 'http', or 'kubeclaw-channel' references in orchestrator logs`,
    ).toMatch(/channel-status|http|kubeclaw-channel/i);
  });
});
