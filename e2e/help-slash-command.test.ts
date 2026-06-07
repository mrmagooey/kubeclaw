/**
 * End-to-end tests for the /help slash command (Story 17).
 *
 * Acceptance criteria:
 *   AC1 — /help reply mentions /search, /skills, /secret, /clear, /compact, /summary.
 *   AC2 — reply arrives in < 5 s (no LLM call).
 *   AC3 — /help foobar produces the same reply (trailing args ignored).
 *   AC4 — /HELP does NOT trigger (case-sensitive).
 *   AC5 — subsequent non-slash messages do not produce help text.
 *
 * Infrastructure:
 *   - kind cluster: kubeclaw-e2e-istio
 *   - namespace:    kubeclaw-e2e-help
 *   - HTTP channel port-forwarded to localhost:14102
 *   - Helm installs with a placeholder LLM key (no real LLM needed for AC1-4;
 *     AC5 asserts only the *absence* of help text, valid regardless of whether
 *     the LLM replies).
 *
 * Run after building and loading the image:
 *   docker build -t kubeclaw-orchestrator:e2e-test . && \
 *   docker save kubeclaw-orchestrator:e2e-test | kind load image-archive /dev/stdin --name kubeclaw-e2e-istio
 *
 *   kubectl --context kind-kubeclaw-e2e-istio \
 *     delete namespace kubeclaw-e2e-help --ignore-not-found --timeout=60s
 *
 *   KUBECLAW_SKIP_HELM_INSTALL=true \
 *   npx vitest run --config vitest.e2e.config.ts help-slash-command
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { isKubernetesAvailable } from './setup.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-help';
const RELEASE = 'kubeclaw-e2e-help';
const CHART_DIR = './helm/kubeclaw';
const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const HTTP_LOCAL_PORT = 14102;

const HTTP_USER = 'alice';
const HTTP_PASS = 'helptestpass';
const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

/** Commands that AC1 requires to appear in /help output. */
const EXPECTED_COMMANDS = [
  '/search',
  '/skills',
  '/secret',
  '/clear',
  '/compact',
  '/summary',
];

// ─── Skip guard ───────────────────────────────────────────────────────────────

const clusterAvailable = isKubernetesAvailable();
const shouldSkip = !clusterAvailable;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Run kubectl with the test context and namespace. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, '-n', NAMESPACE, ...args],
    { encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout ?? 30_000 },
  );
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Poll until fn() returns truthy or timeout expires. */
async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Wait for the HTTP channel pod to be Ready. */
async function waitForChannelPod(timeoutMs = 180_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get',
        'pods',
        '-l',
        'app=kubeclaw-channel-http',
        '-o',
        'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
      return statuses.length > 0 && statuses.every((s) => s === 'True');
    },
    timeoutMs,
    'channel-http pod Ready',
  );
}

let portForwardProcess: ChildProcess | null = null;

/** Start (or restart) the port-forward to svc/kubeclaw-channel-http. */
async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  // Kill any leftover port-forward from a prior test run.
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], {
    stdio: 'pipe',
  });
  await sleep(1500);

  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl --context ${KUBE_CONTEXT} port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${HTTP_LOCAL_PORT}:80 || true; sleep 0.1; done`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
  );

  // Wait for the port to be reachable (up to 15 s).
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const nc = spawnSync('nc', ['-z', 'localhost', String(HTTP_LOCAL_PORT)], {
      stdio: 'pipe',
    });
    if (nc.status === 0) return;
  }
  throw new Error(
    `Port-forward to localhost:${HTTP_LOCAL_PORT} did not come up within 15s`,
  );
}

/** POST a message to the HTTP channel and return the HTTP status code. */
async function postMessage(text: string): Promise<number> {
  const res = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(HTTP_USER, HTTP_PASS),
    },
    body: JSON.stringify({ text }),
  });
  return res.status;
}

/**
 * Open an SSE stream, POST `text`, then wait until `predicate(lines)` is
 * satisfied or `timeoutMs` elapses.  Returns the accumulated SSE data lines
 * and the elapsed time (ms) from POST to predicate being met.
 *
 * The SSE stream is opened *before* the POST so we never miss a fast reply.
 */
async function roundtrip(
  text: string,
  predicate: (lines: string[]) => boolean,
  timeoutMs = 10_000,
): Promise<{ lines: string[]; elapsedMs: number }> {
  const controller = new AbortController();
  const sseRes = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
    signal: controller.signal,
  });
  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`SSE connect failed: HTTP ${sseRes.status}`);
  }

  const lines: string[] = [];
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const reading = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('data: ')) lines.push(line.slice(6));
        }
      }
    } catch {
      // AbortError — expected on controller.abort()
    }
  })();

  // Give the SSE connection a moment to register server-side.
  await sleep(300);

  const t0 = Date.now();
  await postMessage(text);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(lines)) break;
    await sleep(100);
  }

  const elapsedMs = Date.now() - t0;
  controller.abort();
  await reading.catch(() => {});
  return { lines, elapsedMs };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkip)(
  '/help slash command e2e (Story 17)',
  { timeout: 30 * 60 * 1000 },
  () => {
    let installed = false;

    beforeAll(async () => {
      // Tear down any leftover namespace from a prior run.
      spawnSync(
        'kubectl',
        [
          '--context',
          KUBE_CONTEXT,
          'delete',
          'namespace',
          NAMESPACE,
          '--ignore-not-found',
          '--timeout=60s',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
      );
      spawnSync(
        'kubectl',
        [
          '--context',
          KUBE_CONTEXT,
          'wait',
          '--for=delete',
          `ns/${NAMESPACE}`,
          '--timeout=60s',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
      );

      // Pre-create namespace with Helm ownership labels/annotations.
      for (const cmd of [
        ['create', 'namespace', NAMESPACE],
        ['label', 'namespace', NAMESPACE, 'app.kubernetes.io/managed-by=Helm'],
        [
          'annotate',
          'namespace',
          NAMESPACE,
          `meta.helm.sh/release-name=${RELEASE}`,
          `meta.helm.sh/release-namespace=${NAMESPACE}`,
        ],
      ]) {
        spawnSync('kubectl', ['--context', KUBE_CONTEXT, ...cmd], {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      }

      const installResult = spawnSync(
        'helm',
        [
          'upgrade',
          '--install',
          RELEASE,
          CHART_DIR,
          '--kube-context',
          KUBE_CONTEXT,
          '--namespace',
          NAMESPACE,
          '--create-namespace',
          '--timeout',
          '5m',
          '--set',
          `namespace=${NAMESPACE}`,
          '--set',
          'secrets.anthropicApiKey=placeholder-key',
          // HTTP channel with a single user (alice).
          '--set',
          'channels.http.enabled=true',
          '--set',
          'channels.http.type=http',
          '--set',
          'channels.http.httpPort=4080',
          '--set-string',
          `secrets.httpChannelUsers=${HTTP_USER}:${HTTP_PASS}`,
          '--set',
          'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
          '--set',
          'channels.http.envVars[0].key=users',
          '--set',
          'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
          '--set',
          'channels.http.envVars[1].key=port',
          '--set',
          'channels.http.envVars[1].optional=true',
          '--set',
          'credentialInjection.mode=off',
          '--set',
          'redis.password=e2e-help-redis-pass',
          // Use the image built and loaded by the outer shell wrapper.
          '--set',
          'image.tag=e2e-test',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 360_000 },
      );

      if (installResult.status !== 0) {
        throw new Error(
          `helm upgrade failed (exit ${installResult.status}):\n` +
            `stderr: ${installResult.stderr}\nstdout: ${installResult.stdout}`,
        );
      }

      installed = true;
      await waitForChannelPod();
      await startPortForward();
    }, 15 * 60 * 1000);

    afterAll(() => {
      if (portForwardProcess) {
        portForwardProcess.kill();
        portForwardProcess = null;
      }
      if (!installed) return;
      spawnSync(
        'helm',
        [
          'uninstall',
          RELEASE,
          '--kube-context',
          KUBE_CONTEXT,
          '--namespace',
          NAMESPACE,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      spawnSync(
        'kubectl',
        [
          '--context',
          KUBE_CONTEXT,
          'delete',
          'namespace',
          NAMESPACE,
          '--ignore-not-found',
          '--wait=false',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    }, 60_000);

    // ── AC1: /help lists all required commands ─────────────────────────────
    it(
      'AC1: /help reply mentions /search, /skills, /secret, /clear, /compact, /summary',
      async () => {
        const { lines } = await roundtrip(
          '/help',
          (ls) => ls.some((l) => l.includes('/search')),
          8000,
        );
        const combined = lines.join('\n');
        for (const cmd of EXPECTED_COMMANDS) {
          expect(combined, `Expected ${cmd} in /help output`).toContain(cmd);
        }
      },
      15_000,
    );

    // ── AC2: reply arrives in < 5 s (no LLM call) ─────────────────────────
    it(
      'AC2: /help reply arrives in under 5 seconds (no LLM call)',
      async () => {
        const { elapsedMs } = await roundtrip(
          '/help',
          (ls) => ls.some((l) => l.includes('/search')),
          8000,
        );
        expect(elapsedMs).toBeLessThan(5000);
      },
      15_000,
    );

    // ── AC3: /help foobar produces same response (trailing args ignored) ───
    it(
      'AC3: /help foobar produces the same help response (trailing args ignored)',
      async () => {
        const { lines } = await roundtrip(
          '/help foobar',
          (ls) => ls.some((l) => l.includes('/search')),
          8000,
        );
        const combined = lines.join('\n');
        for (const cmd of EXPECTED_COMMANDS) {
          expect(
            combined,
            `Expected ${cmd} in /help foobar output`,
          ).toContain(cmd);
        }
      },
      15_000,
    );

    // ── AC4: /HELP does NOT trigger (case-sensitive) ───────────────────────
    it(
      'AC4: /HELP (uppercase) does NOT return help text',
      async () => {
        // Wait 4 s — enough for a fast intercept to fire, short enough to not
        // block on LLM. We expect no help-listing lines to appear.
        const { lines } = await roundtrip(
          '/HELP',
          (ls) => ls.some((l) => l.includes('/search')),
          4000,
        );
        const combined = lines.join('\n');
        // None of the help command names should appear from a /HELP trigger.
        expect(combined).not.toContain('Available slash commands:');
        expect(combined).not.toContain('/skills');
      },
      15_000,
    );

    // ── AC5: subsequent non-slash messages do not produce help text ────────
    //
    // After a /help message, send a plain message.  The reply — whether empty
    // (placeholder LLM key) or from a real LLM — must not contain the help
    // listing.  Asserting *absence* is LLM-independent.
    it(
      'AC5: subsequent non-slash messages do not produce help text',
      async () => {
        // Prime the session.
        await roundtrip(
          '/help',
          (ls) => ls.some((l) => l.includes('/search')),
          8000,
        );

        // Send a plain message and collect whatever reply arrives within 5 s.
        const { lines } = await roundtrip(
          'hello there',
          (ls) => ls.length > 0,
          5000,
        );

        const combined = lines.join('\n');
        // Help listing must NOT appear in response to a plain message.
        expect(combined).not.toContain('Available slash commands:');
        // No help-command names should be echoed in the help-listing format.
        expect(combined).not.toMatch(/^\s+\/search\s+—/m);
      },
      20_000,
    );
  },
);
