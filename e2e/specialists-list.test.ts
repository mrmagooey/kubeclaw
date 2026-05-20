/**
 * E2E tests for the /specialists list slash command (Story 38).
 *
 * Installs KubeClaw into an isolated namespace (kubeclaw-e2e-spec-list) on the
 * target kind cluster, drives the deployed HTTP channel via POST /message + SSE
 * /stream, and verifies the /specialists list command behaviour.
 *
 * Port: 14122 (does not clash with other e2e suites)
 * Cluster: kubeclaw-e2e-istio
 * Namespace: kubeclaw-e2e-spec-list
 *
 * Acceptance criteria covered:
 *   AC1 — /specialists list returns SSE reply listing name + description
 *   AC2 — Zero specialists → "No specialists configured" (case-insensitive)
 *   AC3 — After ConfigMap patch adding @Tester, subsequent /specialists list
 *          shows @Tester (hot-reload path from Story 13)
 *   AC4 — Reply arrives in under 2 s (no IPC round-trip)
 *   AC5 — /specialists foobar returns "Usage: /specialists list", no stack trace
 *
 * Skip conditions:
 *   - No Kubernetes cluster reachable (isKubernetesAvailable returns false).
 *   - KUBECLAW_SKIP_HELM_INSTALL=1 (used by parallel e2e agents sharing the cluster).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { isKubernetesAvailable } from './setup.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-spec-list';
const RELEASE = 'kubeclaw-e2e-spec-list';
const CHART_DIR = './helm/kubeclaw';
const HTTP_LOCAL_PORT = 14122;
const HTTP_USER = 'testuser';
const HTTP_PASS = 'testpass';
const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

// ─── Skip flags ───────────────────────────────────────────────────────────────

const clusterAvailable = isKubernetesAvailable();
const skipHelmInstall = process.env.KUBECLAW_SKIP_HELM_INSTALL === '1';
const shouldSkip = !clusterAvailable;
const skipReason = shouldSkip ? 'no Kubernetes cluster available' : '';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', [...args, '-n', NAMESPACE], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function kcCluster(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

async function waitForChannelPod(timeoutMs = 120_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get', 'pods',
        '-l', 'app=kubeclaw-channel-http',
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

async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], {
    stdio: 'pipe',
  });
  await sleep(1500);
  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${HTTP_LOCAL_PORT}:80 || true; sleep 0.1; done`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
  );
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

function helmInstall(extraArgs: string[]): void {
  spawnSync(
    'kubectl',
    ['wait', '--for=delete', `ns/${NAMESPACE}`, '--timeout=60s'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 70_000 },
  );

  const result = spawnSync(
    'helm',
    [
      'upgrade', '--install',
      RELEASE,
      CHART_DIR,
      '--namespace', NAMESPACE,
      '--create-namespace',
      '--timeout', '180s',
      '--set', `namespace=${NAMESPACE}`,
      '--set', 'secrets.anthropicApiKey=test-key',
      '--set', 'secrets.claudeCodeOauthToken=test-token',
      '--set', 'secrets.openaiApiKey=no-key',
      '--set-string', 'secrets.openaiBaseUrl=http://127.0.0.1:9999/v1',
      '--set-string', 'secrets.directLlmModel=dummy-model',
      '--set', 'channels.http.enabled=true',
      '--set', 'channels.http.type=http',
      '--set', 'channels.http.httpPort=4080',
      '--set-string', `secrets.httpChannelUsers=${HTTP_USER}:${HTTP_PASS}`,
      '--set', 'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
      '--set', 'channels.http.envVars[0].key=users',
      '--set', 'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
      '--set', 'channels.http.envVars[1].key=port',
      '--set', 'channels.http.envVars[1].optional=true',
      '--set', 'credentialInjection.mode=off',
      '--set', 'redis.password=e2e-spec-list-redis-pass',
      ...extraArgs,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `helm upgrade failed (exit ${result.status}):\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
}

/**
 * Open an SSE stream and return handle with accumulated data lines.
 */
async function openSseStream(): Promise<{
  lines: string[];
  waitFor: (
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  }
  const lines: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  (async () => {
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
      // aborted
    }
  })().catch(() => {});

  return {
    lines,
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(lines)) return;
        await sleep(200);
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs}ms (lines: ${JSON.stringify(lines)})`,
      );
    },
    dispose: () => controller.abort(),
  };
}

async function postMessage(text: string): Promise<void> {
  const res = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(HTTP_USER, HTTP_PASS),
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`POST /message returned HTTP ${res.status}`);
  }
}

/**
 * Send text and collect SSE lines until predicate satisfied.
 * Returns elapsed milliseconds alongside the lines.
 */
async function sendAndCollect(
  text: string,
  predicate: (lines: string[]) => boolean,
  timeoutMs = 30_000,
): Promise<{ lines: string[]; elapsedMs: number }> {
  const sse = await openSseStream();
  const start = Date.now();
  try {
    await postMessage(text);
    await sse.waitFor(predicate, timeoutMs);
    return { lines: [...sse.lines], elapsedMs: Date.now() - start };
  } finally {
    sse.dispose();
  }
}

// ─── Suite lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (shouldSkip) return;
  if (skipHelmInstall) {
    // Assume an already-deployed namespace — just start port-forward.
    await startPortForward();
    return;
  }

  // Clean up any leftover namespace.
  spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    encoding: 'utf8', stdio: 'pipe',
  });
  spawnSync('kubectl', ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=true'], {
    encoding: 'utf8', stdio: 'pipe', timeout: 90_000,
  });

  // Install with a couple of test specialists.
  helmInstall([
    '--set-json',
    'specialists=[{"name":"Echo","prompt":"Reply with the user message verbatim."},{"name":"Summariser","prompt":"Produce a concise one-sentence summary of the user message."}]',
  ]);

  await waitForChannelPod();
  await startPortForward();

  // Allow ConfigMap volume mount to propagate.
  await sleep(60_000);
}, 300_000);

afterAll(async () => {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  if (!skipHelmInstall) {
    spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
      encoding: 'utf8', stdio: 'pipe',
    });
    spawnSync('kubectl', ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'], {
      encoding: 'utf8', stdio: 'pipe',
    });
  }
}, 120_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/specialists list e2e (Story 38)', () => {
  /**
   * AC1 — /specialists list returns SSE reply listing name + description for
   * each specialist in the kubeclaw-specialists ConfigMap.
   */
  it.skipIf(shouldSkip)(
    'AC1: /specialists list returns name and description for each specialist',
    async () => {
      const { lines } = await sendAndCollect(
        '/specialists list',
        (ls) => ls.some((l) => l.includes('@Echo')),
        10_000,
      );

      const combined = lines.join('\n');
      // Both specialists registered at install time must appear.
      expect(combined).toContain('@Echo');
      expect(combined).toContain('@Summariser');
      // Each line should contain a description separator.
      expect(combined).toMatch(/@Echo\s*—/);
      expect(combined).toMatch(/@Summariser\s*—/);
    },
    30_000,
  );

  /**
   * AC4 — The reply arrives in under 2 s (no IPC round-trip).
   */
  it.skipIf(shouldSkip)(
    'AC4: /specialists list reply arrives in under 2 s (no IPC)',
    async () => {
      const { elapsedMs } = await sendAndCollect(
        '/specialists list',
        (ls) => ls.length > 0,
        10_000,
      );
      expect(elapsedMs).toBeLessThan(2000);
    },
    15_000,
  );

  /**
   * AC5 — /specialists foobar returns "Usage: /specialists list" with no
   * stack trace.
   */
  it.skipIf(shouldSkip)(
    'AC5: /specialists foobar returns usage hint without stack trace',
    async () => {
      const { lines } = await sendAndCollect(
        '/specialists foobar',
        (ls) => ls.some((l) => /usage/i.test(l)),
        10_000,
      );

      const combined = lines.join('\n');
      expect(combined.toLowerCase()).toContain('usage');
      expect(combined).toContain('/specialists list');
      // No stack trace markers.
      expect(combined).not.toMatch(/Error:/);
      expect(combined).not.toMatch(/\bat\s+\w/);
    },
    15_000,
  );

  /**
   * AC2 — When zero specialists are configured, /specialists list returns
   * "No specialists configured" (case-insensitive) and does not error.
   */
  it.skipIf(shouldSkip)(
    'AC2: zero specialists → "No specialists configured"',
    async () => {
      // Patch the ConfigMap to an empty specialist list.
      const emptyJson = JSON.stringify({
        version: 1,
        generation: 99,
        specialists: [],
      });
      const patch = kcCluster([
        'patch', 'configmap', 'kubeclaw-specialists',
        '-n', NAMESPACE,
        '--type=merge',
        '-p', JSON.stringify({ data: { 'specialists.json': emptyJson } }),
      ]);
      expect(patch.ok, `ConfigMap patch failed: ${patch.stderr}`).toBe(true);

      // Allow kubelet to propagate the ConfigMap update to the volume mount.
      await sleep(65_000);

      const { lines } = await sendAndCollect(
        '/specialists list',
        (ls) => ls.some((l) => /no specialists/i.test(l)),
        10_000,
      );

      const combined = lines.join('\n');
      expect(combined.toLowerCase()).toContain('no specialists configured');
    },
    90_000,
  );

  /**
   * AC3 — After patching the ConfigMap to add @Tester, a subsequent
   * /specialists list shows @Tester — confirming hot-reload.
   */
  it.skipIf(shouldSkip)(
    'AC3: after ConfigMap patch adds @Tester, /specialists list shows @Tester',
    async () => {
      const withTesterJson = JSON.stringify({
        version: 1,
        generation: 100,
        specialists: [
          {
            name: 'Tester',
            prompt: 'Run automated regression tests and report results.',
          },
        ],
      });
      const patch = kcCluster([
        'patch', 'configmap', 'kubeclaw-specialists',
        '-n', NAMESPACE,
        '--type=merge',
        '-p', JSON.stringify({ data: { 'specialists.json': withTesterJson } }),
      ]);
      expect(patch.ok, `ConfigMap patch failed: ${patch.stderr}`).toBe(true);

      // Allow kubelet ConfigMap propagation.
      await sleep(65_000);

      // Poll /specialists list until @Tester appears (confirm hot-reload).
      let combined = '';
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const { lines } = await sendAndCollect(
          '/specialists list',
          (ls) => ls.length > 0,
          10_000,
        );
        combined = lines.join('\n');
        if (combined.includes('@Tester')) break;
        await sleep(3000);
      }

      expect(combined).toContain('@Tester');
    },
    120_000,
  );
});
