/**
 * Minikube-live: bootstrap an oauth-webchat channel end-to-end (full lifecycle).
 *
 * This test exercises the bootstrap subsystem all the way from
 * `bootstrap_channel_from_skill('bootstrap-oauth-webchat')` through
 * `commit_channel_config` to a running steady-state channel Deployment that
 * exposes an HTTP port (httpPort: 4080) and passes an OIDC authentication flow.
 *
 * The bootstrap skill asks ONE combined question for all six OIDC settings.
 * The test answers with a single structured reply that the skill parses into:
 *   OAUTH_WEBCHAT_PUBLIC_URL, OAUTH_WEBCHAT_OIDC_ISSUER, OAUTH_WEBCHAT_CLIENT_ID,
 *   OAUTH_WEBCHAT_CLIENT_SECRET, OAUTH_WEBCHAT_ALLOWED_EMAILS, OAUTH_WEBCHAT_COOKIE_SECRET
 *
 * After bootstrap, the test:
 *   - Verifies the steady-state Deployment has channel-runner shape + httpPort additions
 *   - Verifies the Service and ingress NetworkPolicy were created
 *   - Waits for the channel pod to reach Ready
 *   - Polls /readyz via the port-forward (proves Service + NetworkPolicy foundation)
 *   - Runs the OIDC Authorization Code flow and asserts a session cookie
 *   - Sends a chat message and asserts it reaches the channel pod (informational)
 *
 * AC coverage:
 *   AC1 [HARD]: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL=bootstrap-oauth-webchat
 *   AC1b [HARD]: bootstrap dialogue completes (Job condition Complete=True) after the single combined answer
 *   AC3 [HARD]: steady-state Deployment with node dist/channel-runner.js + groups/store/sessions mounts
 *               + container port 4080 + readinessProbe /readyz + Service + ingress NetworkPolicy + pod Ready
 *   AC4 [HARD]: /readyz returns 200 via port-forward; GET /login returns 200; /login/start returns 302 to OIDC; full OIDC flow yields session cookie
 *   AC4-message [INFORMATIONAL]: POST /message with session cookie triggers inbound processing
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
  KUBECLAW_LIVE_OAUTH_WEBCHAT_LOCAL_PORT,
  KUBECLAW_LIVE_TEST_OAUTH_LOCAL_PORT,
  KUBECLAW_LIVE_OAUTH_WEBCHAT_USER,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;
const OAUTH_URL = `http://127.0.0.1:${KUBECLAW_LIVE_OAUTH_WEBCHAT_LOCAL_PORT}`;
const TEST_OIDC_URL = `http://127.0.0.1:${KUBECLAW_LIVE_TEST_OAUTH_LOCAL_PORT}`;
const INSTANCE_NAME = 'e2e-oauth';

// OIDC bootstrap answer — sent as a single combined reply.
const BOOTSTRAP_ANSWER =
  'public_url=http://127.0.0.1:14082 ' +
  'issuer=http://kubeclaw-capability-test-oauth:8080 ' +
  'client_id=test-client ' +
  'client_secret=test-secret ' +
  `allowed_emails=${KUBECLAW_LIVE_OAUTH_WEBCHAT_USER} ` +
  'cookie_secret=kubeclaw-live-e2e-oauth-cookie-secret-32bytes!';

// ── Shared helpers (copied verbatim from minikube-live-channel-irc-bootstrap.test.ts) ──

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function kubectl(
  args: string[],
  opts: { timeout?: number; allowFail?: boolean; input?: string } = {},
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
    'get',
    'pods',
    '-n',
    NAMESPACE,
    '-l',
    labelSelector,
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]);
  const name = r.ok ? r.stdout.trim() : '';
  return name || null;
}

/**
 * POST a chat message to the admin shell and open an SSE stream. Returns the
 * first assistant text reply if one arrives within timeoutMs, or null if none
 * arrives (acceptable — cluster state is the load-bearing signal). Throws only
 * on hard errors (non-202 from /chat, non-200 from /events).
 */
async function postChatAndCollectReply(
  authHeader: string,
  text: string,
  timeoutMs: number,
): Promise<string | null> {
  const eventsController = new AbortController();
  const eventsRes = await fetch(`${ADMIN_URL}/events`, {
    headers: { Authorization: authHeader, Accept: 'text/event-stream' },
    signal: eventsController.signal,
  });
  if (eventsRes.status !== 200) {
    throw new Error(`SSE /events returned ${eventsRes.status}`);
  }

  // The admin /chat endpoint serializes per user: while a previous turn is
  // still running it returns 429 ("Previous request still in progress"). That
  // is transient — back off and retry rather than failing the test (the
  // bootstrap-trigger turn can still be settling when the next post arrives).
  let chatRes: Response | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    chatRes = await fetch(`${ADMIN_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (chatRes.status !== 429) break;
    await sleep(2000);
  }
  if (!chatRes || chatRes.status !== 202) {
    eventsController.abort();
    throw new Error(`POST /chat returned ${chatRes?.status}`);
  }

  const reader = eventsRes.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const readTimeout = Math.min(5000, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        sleep(readTimeout).then(() => ({ value: undefined, done: false })),
      ]);
      if (result.done) break;
      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const payload = JSON.parse(line.slice(5).trim()) as {
              type?: string;
              text?: string;
            };
            if (payload.type === 'assistant' && payload.text) {
              return payload.text;
            }
          } catch {
            // not JSON
          }
        }
      }
    }
  } finally {
    eventsController.abort();
  }

  return null;
}

/**
 * Poll for the bootstrap Job to appear in the cluster. Resolves with the Job's
 * YAML when it appears, or rejects after timeoutMs. Uses 2s poll interval.
 */
async function waitForBootstrapJob(
  instanceName: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get',
      'job',
      `kubeclaw-bootstrap-${instanceName}`,
      '-n',
      NAMESPACE,
      '-o',
      'yaml',
    ]);
    if (r.ok && r.stdout) {
      return r.stdout;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(2000, remaining));
  }
  throw new Error(
    `bootstrap Job kubeclaw-bootstrap-${instanceName} did not appear within ${timeoutMs}ms`,
  );
}

// ── OAuth helpers (adapted from minikube-live-oauth-webchat.test.ts) ──────────

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
 *   2. GET /authorize (on test-oauth provider via local port-forward)
 *      The provider immediately 302s back to the channel's /callback with code+state.
 *   3. GET /callback?code=...&state=... with state cookie → 302 to / + session cookie
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

describe('Minikube-live: bootstrap oauth-webchat channel end-to-end (full lifecycle)', () => {
  let provisioned = false;
  let adminPass = '';
  let authHeader = '';

  beforeAll(async () => {
    // Fetch admin password from the cluster secret.
    const pwdResult = kubectl([
      'get',
      'secret',
      '-n',
      NAMESPACE,
      'kubeclaw-secrets',
      '-o',
      'jsonpath={.data.admin-http-password}',
    ]);
    if (pwdResult.ok && pwdResult.stdout) {
      adminPass = Buffer.from(pwdResult.stdout, 'base64').toString('utf8');
      authHeader = basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass);
    }

    // Verify the admin port-forward is up (10 retries × 1s).
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${ADMIN_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        // retry
      }
      await sleep(1000);
    }
    if (!provisioned) {
      console.warn(`⚠️  Admin port-forward to ${ADMIN_URL} not reachable — skipping all assertions.`);
    }
  }, 60_000);

  afterAll(() => {
    // Cleanup: all operations are idempotent (--ignore-not-found).
    const resources: [string, string][] = [
      ['job', `kubeclaw-bootstrap-${INSTANCE_NAME}`],
      ['pvc', `kubeclaw-channel-${INSTANCE_NAME}-runtime`],
      ['deployment', `kubeclaw-channel-${INSTANCE_NAME}`],
      ['secret', `kubeclaw-channel-${INSTANCE_NAME}-credentials`],
      ['service', `kubeclaw-channel-${INSTANCE_NAME}`],
      ['networkpolicy', `kubeclaw-channel-${INSTANCE_NAME}-ingress`],
    ];
    for (const [kind, name] of resources) {
      kubectl(
        ['delete', kind, name, '-n', NAMESPACE, '--ignore-not-found=true'],
        { allowFail: true, timeout: 10_000 },
      );
    }
  });

  // ── AC1: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL env set ───────

  it('bootstrap_channel_from_skill creates a bootstrap Job with KUBECLAW_BOOTSTRAP_SKILL set (AC1) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    const prompt =
      `Please bootstrap a new channel using the bootstrap-oauth-webchat skill. ` +
      `The channel type is oauth-webchat and the instance name is ${INSTANCE_NAME}.`;

    // Race: accept EITHER an assistant text reply OR the bootstrap Job
    // appearing in the cluster — whichever comes first. The contract is "the
    // tool fired", evidenced by the Job existing in the cluster.
    const RACE_TIMEOUT_MS = 60_000;
    const chatReplyPromise = postChatAndCollectReply(
      authHeader,
      prompt,
      RACE_TIMEOUT_MS,
    );
    const jobAppearedPromise = waitForBootstrapJob(INSTANCE_NAME, RACE_TIMEOUT_MS);

    let jobYaml = '';
    const raceResult = await Promise.race([
      chatReplyPromise.then((reply) => ({ kind: 'reply' as const, reply })),
      jobAppearedPromise.then((yaml) => ({ kind: 'job' as const, yaml })),
    ]);

    if (raceResult.kind === 'job') {
      jobYaml = raceResult.yaml;
    } else {
      jobYaml = await jobAppearedPromise;
    }

    expect(jobYaml, 'bootstrap Job not found within 60s').toContain(
      'KUBECLAW_BOOTSTRAP_SKILL',
    );
    expect(jobYaml).toContain('bootstrap-oauth-webchat');
    expect(jobYaml).toContain('KUBECLAW_BOOTSTRAP_INSTANCE');
    expect(jobYaml).toContain(INSTANCE_NAME);

    // Let the trigger /chat turn fully settle so the admin's per-user
    // inProgress guard clears before AC1b posts the dialogue answer (the
    // poster also retries on 429, but settling here avoids the wasted round).
    await chatReplyPromise.catch(() => undefined);
  }, 90_000);

  // ── AC1b: bootstrap dialogue completes (admin answers the single combined question) ─

  it('bootstrap dialogue completes after answering the single combined OIDC question (AC1b) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    // The skill asks ONE combined question for all six OIDC settings.
    // Detect the distinctive "OIDC settings" phrasing in the bootstrap Job logs.
    let askAppeared = false;
    for (let i = 0; i < 40; i++) {
      const logs = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        `job/kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '--tail=300',
      ]);
      if (logs.ok && /OIDC settings/i.test(logs.stdout)) {
        askAppeared = true;
        break;
      }
      await sleep(3000);
    }
    expect(
      askAppeared,
      'bootstrap pod did not ask for OIDC settings within 120s',
    ).toBe(true);

    // Answer all six settings in one structured reply (matches the skill's
    // key=value example), so the agent parses them in a single turn and commits.
    await postChatAndCollectReply(
      authHeader,
      BOOTSTRAP_ANSWER,
      60_000,
    );

    // Wait for the bootstrap Job to complete. The commit is near-instant but
    // the bootstrap pod then runs one more LLM turn before exiting. Budget
    // generously against the live model.
    let complete = false;
    for (let i = 0; i < 60; i++) {
      const r = kubectl([
        'get',
        'job',
        `kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '-n',
        NAMESPACE,
        '-o',
        'jsonpath={.status.conditions[?(@.type=="Complete")].status}',
      ]);
      if (r.ok && r.stdout.trim() === 'True') {
        complete = true;
        break;
      }
      await sleep(3000);
    }
    expect(complete, 'bootstrap Job did not Complete within 180s').toBe(true);
  }, 360_000);

  // ── AC3: steady-state Deployment uses channel-runner + httpPort additions ────
  //
  // The oauth-webchat manifest has hostMode: "channel-runner" and httpPort: 4080.
  // commit_channel_config must stamp the Deployment with:
  //   containers[0].command: ["node", "dist/channel-runner.js"]
  //   containers[0].ports: [{containerPort: 4080}]
  //   readinessProbe targeting /readyz
  // and mount groups/store/sessions PVCs.
  // Additionally, a Service and ingress NetworkPolicy must be created.

  it('commit_channel_config produces a Deployment with channel-runner + httpPort additions + Service + NetworkPolicy + pod Ready (AC3) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    let deployYaml = '';
    for (let i = 0; i < 30; i++) {
      const r = kubectl([
        'get',
        'deployment',
        `kubeclaw-channel-${INSTANCE_NAME}`,
        '-n',
        NAMESPACE,
        '-o',
        'yaml',
      ]);
      if (r.ok && r.stdout) {
        deployYaml = r.stdout;
        break;
      }
      await sleep(2000);
    }
    expect(
      deployYaml,
      `steady-state Deployment kubeclaw-channel-${INSTANCE_NAME} not created within 60s — was commit_channel_config rejected?`,
    ).toContain(`kubeclaw-channel-${INSTANCE_NAME}`);

    // AC3 (host-selector proof): command must be channel-runner, not standalone.
    expect(
      deployYaml,
      'Deployment container command must be node dist/channel-runner.js (hostMode: channel-runner)',
    ).toContain('dist/channel-runner.js');
    expect(deployYaml).toMatch(/-\s+node/);

    // AC3 (PVC mounts): the channel-runner path mounts groups/store/sessions PVCs.
    const hasGroupsMount =
      deployYaml.includes('kubeclaw-groups') || deployYaml.includes('/groups');
    const hasStoreMount =
      deployYaml.includes('kubeclaw-store') || deployYaml.includes('/store');
    const hasSessionsMount =
      deployYaml.includes('kubeclaw-sessions') || deployYaml.includes('/sessions');
    expect(hasGroupsMount, 'Deployment must mount groups volume (channel-runner path)').toBe(true);
    expect(hasStoreMount, 'Deployment must mount store volume (channel-runner path)').toBe(true);
    expect(hasSessionsMount, 'Deployment must mount sessions volume (channel-runner path)').toBe(true);

    // AC3 (httpPort additions): container port 4080 must be declared.
    expect(
      deployYaml,
      'Deployment must declare container port 4080 (httpPort from manifest)',
    ).toContain('4080');

    // AC3 (readinessProbe): /readyz probe must be present.
    expect(
      deployYaml,
      'Deployment must include a readinessProbe on /readyz',
    ).toMatch(/readyz|\/readyz/);

    // AC3 (negative): the bootstrap-specific env must not be present in the
    // steady-state Deployment — this confirms commit produced a clean manifest.
    expect(deployYaml).not.toContain('KUBECLAW_BOOTSTRAP_SKILL');

    // AC3 (Service): the channel Service must have been created.
    const svcResult = kubectl([
      'get',
      'service',
      `kubeclaw-channel-${INSTANCE_NAME}`,
      '-n',
      NAMESPACE,
      '-o',
      'yaml',
    ]);
    expect(
      svcResult.ok,
      `Service kubeclaw-channel-${INSTANCE_NAME} not found: ${svcResult.stderr}`,
    ).toBe(true);
    const svcYaml = svcResult.stdout;
    expect(svcYaml, 'Service must have a ClusterIP').toMatch(/clusterIP:/);
    expect(svcYaml, 'Service must expose port 80').toContain('port: 80');

    // AC3 (ingress NetworkPolicy): the ingress NetworkPolicy must exist.
    const netpolResult = kubectl([
      'get',
      'networkpolicy',
      `kubeclaw-channel-${INSTANCE_NAME}-ingress`,
      '-n',
      NAMESPACE,
      '-o',
      'yaml',
    ]);
    expect(
      netpolResult.ok,
      `NetworkPolicy kubeclaw-channel-${INSTANCE_NAME}-ingress not found: ${netpolResult.stderr}`,
    ).toBe(true);
    const netpolYaml = netpolResult.stdout;
    expect(netpolYaml, 'NetworkPolicy must reference port 4080').toContain('4080');

    // Wait for the channel pod to be Ready.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const r = kubectl([
        'get',
        'pod',
        '-n',
        NAMESPACE,
        '-l',
        `kubeclaw.io/role=channel,kubeclaw/channel=${INSTANCE_NAME}`,
        '-o',
        'jsonpath={.items[0].status.conditions[?(@.type=="Ready")].status}',
      ]);
      if (r.ok && r.stdout.trim() === 'True') {
        ready = true;
        break;
      }
      await sleep(3000);
    }
    if (!ready) {
      // Diagnostic dump: the channel-runner pod isn't Ready (likely crashing).
      // Capture its logs (current + previous, all containers) and describe so the
      // crash reason is in the test output, since afterAll deletes the Deployment.
      const podName = kubectl([
        'get', 'pod', '-n', NAMESPACE,
        '-l', `kubeclaw.io/role=channel,kubeclaw/channel=${INSTANCE_NAME}`,
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]).stdout.trim();
      const logs = kubectl(['logs', '-n', NAMESPACE, podName, '--all-containers=true', '--tail=120']);
      const prev = kubectl(['logs', '-n', NAMESPACE, podName, '--all-containers=true', '--previous', '--tail=120']);
      const desc = kubectl(['describe', 'pod', '-n', NAMESPACE, podName]);
      console.error(
        `[AC3 channel pod not Ready] pod=${podName}\n` +
        `--- LOGS ---\n${logs.stdout}\n${logs.stderr}\n` +
        `--- PREVIOUS (crash) LOGS ---\n${prev.stdout}\n${prev.stderr}\n` +
        `--- DESCRIBE (tail) ---\n${desc.stdout.slice(-2500)}`,
      );
    }
    expect(ready, 'channel pod did not reach Ready within 90s').toBe(true);
  }, 180_000);

  // ── AC4: /readyz returns 200, GET /login returns 200, /login/start returns 302, full OIDC flow ──

  it('/readyz returns 200 via port-forward and full OIDC Authorization Code flow yields session cookie (AC4) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    // Poll until /readyz returns 200. The port-forward at :14082 was started as
    // fire-and-forget in global setup (it auto-retries since the Service doesn't
    // exist at start time). By the time we reach here the Service exists and the
    // pod is Ready, so the loop should connect quickly — 60s is ample.
    let readyzOk = false;
    const readyzDeadline = Date.now() + 60_000;
    while (Date.now() < readyzDeadline) {
      try {
        const res = await httpGet(`${OAUTH_URL}/readyz`);
        if (res.status === 200) {
          readyzOk = true;
          break;
        }
      } catch {
        // port-forward not yet live or readyz not ready — retry
      }
      await sleep(2000);
    }
    expect(
      readyzOk,
      `/readyz did not return 200 within 60s on ${OAUTH_URL}/readyz — ` +
      `check that the port-forward at :${KUBECLAW_LIVE_OAUTH_WEBCHAT_LOCAL_PORT} connected and the Service + NetworkPolicy exist`,
    ).toBe(true);

    // GET / unauthenticated redirects to /login [HARD]
    const rootUnauthedRes = await httpGet(`${OAUTH_URL}/`);
    expect(
      rootUnauthedRes.status,
      `GET / unauthenticated returned ${rootUnauthedRes.status} instead of 302`,
    ).toBe(302);
    expect(
      rootUnauthedRes.headers.location,
      'GET / unauthenticated must redirect to /login',
    ).toBe('/login');

    // GET /login returns 200 with HTML containing '/login/start' [HARD]
    const loginRes = await httpGet(`${OAUTH_URL}/login`);
    expect(
      loginRes.status,
      `GET /login returned ${loginRes.status} instead of 200`,
    ).toBe(200);
    expect(loginRes.body, "GET /login response must contain '/login/start'").toContain('/login/start');

    // GET /login/start returns 302 to OIDC authorize URL [HARD]
    // This proves the login redirect is configured and the OIDC issuer is wired.
    const startRes = await httpGet(`${OAUTH_URL}/login/start`);
    expect(
      startRes.status,
      `GET /login/start returned ${startRes.status} instead of 302`,
    ).toBe(302);
    const authorizeLocation = startRes.headers.location ?? '';
    expect(
      authorizeLocation,
      'GET /login/start must redirect to OIDC authorize URL (kubeclaw-capability-test-oauth)',
    ).toMatch(/kubeclaw-capability-test-oauth|authorize/i);

    // Full OIDC Authorization Code round-trip: /login/start → /authorize → /callback
    // The test-oauth provider always succeeds — this is deterministic.
    const sessionCookie = await performOauthFlow();
    expect(
      sessionCookie,
      'OIDC flow must yield an oauth-webchat-session= cookie',
    ).toMatch(/^oauth-webchat-session=/);

    // GET / with session cookie returns 200 and contains the authenticated user.
    const homeRes = await httpGet(`${OAUTH_URL}/`, sessionCookie);
    expect(
      homeRes.status,
      `GET / with session cookie returned ${homeRes.status} instead of 200`,
    ).toBe(200);
    expect(
      homeRes.body,
      `GET / with session cookie must contain '${KUBECLAW_LIVE_OAUTH_WEBCHAT_USER}'`,
    ).toContain(KUBECLAW_LIVE_OAUTH_WEBCHAT_USER);
  }, 180_000);

  // ── AC4-message: POST /message triggers inbound processing [INFORMATIONAL] ───
  //
  // A POST /message with a valid session cookie should trigger inbound message
  // processing. Whether the channel pod logs the marker within the window depends
  // on the runtime path — we log a warning but do not fail on timeout.

  it('POST /message with session cookie triggers inbound processing (AC4-message) [INFORMATIONAL]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    let sessionCookie: string;
    try {
      sessionCookie = await performOauthFlow();
    } catch (err) {
      console.warn(`[AC4-message] Could not obtain session cookie: ${err} — skipping`);
      return;
    }

    const marker = `oauth-webchat-e2e-${Date.now()}`;

    let msgStatus = 0;
    try {
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
      msgStatus = msgRes.status;
    } catch (err) {
      console.warn(`[AC4-message] POST /message failed: ${err} — skipping log poll`);
      return;
    }

    if (msgStatus !== 200) {
      console.warn(`[AC4-message] POST /message returned ${msgStatus} — skipping log poll`);
      return;
    }

    // Poll the channel pod's logs for evidence the marker was processed.
    const channelPodLabelSel = `kubeclaw.io/role=channel,kubeclaw/channel=${INSTANCE_NAME}`;
    let channelLogs = '';
    const deadline = Date.now() + 60_000;
    let markerAppeared = false;
    while (Date.now() < deadline) {
      const channelPod = getPodName(channelPodLabelSel);
      if (channelPod) {
        const r = kubectl(
          ['logs', '-n', NAMESPACE, channelPod, '--all-containers=true', '--tail=400'],
          { timeout: 8_000 },
        );
        channelLogs = r.ok ? r.stdout : '';
        if (channelLogs.includes(marker) || channelLogs.includes('oauth-webchat message stored')) {
          markerAppeared = true;
          break;
        }
      }
      await sleep(3000);
    }

    if (!markerAppeared) {
      console.warn(
        `[AC4-message] INFORMATIONAL: marker '${marker}' or 'oauth-webchat message stored' ` +
        `did not appear in channel pod logs within 60s. ` +
        `This may indicate an LLM or processing latency issue, not a structural failure. ` +
        `AC3 + AC4 (Deployment + OIDC flow) are the load-bearing assertions.\n` +
        `Last tail:\n${channelLogs.slice(-1500)}`,
      );
    }
    // No expect() — this is informational. The test always passes.
  }, 180_000);
});
