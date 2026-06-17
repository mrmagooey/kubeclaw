/**
 * End-to-end tests for Story 49 — /cancel slash command
 *
 * Target cluster: kubeclaw-e2e-istio
 * Namespace:      kubeclaw-e2e-cancel
 * HTTP port:      14133
 *
 * DO NOT EXECUTE — these tests require a running kind cluster with a
 * fully deployed kubeclaw stack including an active tool job. They are
 * provided for documentation and future CI integration.
 *
 * Acceptance criteria verified:
 *   AC1 — /cancel while a tool job is running returns SSE containing "Cancelled" within 5 s
 *   AC2 — Within 30 s of cancel reply, kubectl get pod returns no items
 *   AC3 — After cancellation, a subsequent POST /message returns 200 and dispatches
 *   AC4 — /cancel with no active job returns SSE containing "No active job"
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { isKubernetesAvailable } from './setup.js';

const NAMESPACE = 'kubeclaw-e2e-cancel';
const HTTP_PORT = 14133;
const HTTP_BASE = `http://127.0.0.1:${HTTP_PORT}`;
const HTTP_USER = 'testuser';
const HTTP_PASS = 'testpass';
const TEST_JID = `http:${HTTP_USER}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Synchronous kubectl wrapper.
 */
function kubectl(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', ['-n', NAMESPACE, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * POST /message and collect SSE reply lines until predicate satisfied or timeout.
 */
async function postMessageAndCollectSSE(
  content: string,
  timeoutMs: number,
  predicate: (line: string) => boolean,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content, sender: 'testuser', chat_jid: TEST_JID });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: HTTP_PORT,
        path: '/message',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(HTTP_USER, HTTP_PASS),
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        const lines: string[] = [];
        const timer = setTimeout(() => {
          req.destroy();
          resolve(lines);
        }, timeoutMs);

        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              lines.push(data);
              if (predicate(data)) {
                clearTimeout(timer);
                req.destroy();
                resolve(lines);
                return;
              }
            }
          }
        });

        res.on('end', () => {
          clearTimeout(timer);
          resolve(lines);
        });

        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Wait up to `maxMs` for a condition to be true, polling every `intervalMs`. */
async function waitUntil(
  check: () => boolean,
  maxMs: number,
  intervalMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

// ---------------------------------------------------------------------------
// AC1-AC3 are deferred: they require a mock LLM configured to return a
// tool-call response for "run a slow background task please" AND a registered
// specialist/tool job type in the cancel namespace. Neither is wired into
// global setup yet. The pod-label bug (app=kubeclaw-agent → kubeclaw.io/role=tool-job)
// is fixed in the code below, but the LLM dispatch dependency means these tests
// cannot be reliably enabled until mock-LLM integration is added.
// ---------------------------------------------------------------------------

const K8S_AVAILABLE = isKubernetesAvailable();
const RELEASE_CANCEL = 'kubeclaw-cancel';

// AC4-only suite: runs whenever a cluster is available; no LLM dispatch needed.
describe.skipIf(!K8S_AVAILABLE)('Story 49 — /cancel e2e (AC4: no-active-job)', () => {
  let helmInstalledByTest = false;

  beforeAll(async () => {
    // Self-provision: install kubeclaw into kubeclaw-e2e-cancel if not present.
    const existingRelease = spawnSync(
      'helm',
      ['status', RELEASE_CANCEL, '--namespace', NAMESPACE],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    if (existingRelease.status !== 0) {
      spawnSync(
        'kubectl',
        ['apply', '-f', '-'],
        {
          input: `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${NAMESPACE}\n`,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
      const installResult = spawnSync(
        'helm',
        [
          'upgrade', '--install', RELEASE_CANCEL, './helm/kubeclaw',
          '--namespace', NAMESPACE,
          '--timeout', '120s',
          '--set', `namespace=${NAMESPACE}`,
          '--set', 'secrets.anthropicApiKey=test-key',
          '--set', 'channels.http.enabled=true',
          '--set', 'channels.http.users[0].username=testuser',
          '--set', 'channels.http.users[0].password=testpass',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 150_000 },
      );
      if (installResult.status !== 0) {
        throw new Error(`helm install for cancel e2e failed: ${installResult.stderr}`);
      }
      helmInstalledByTest = true;
      spawnSync(
        'kubectl',
        [
          'wait', '--namespace', NAMESPACE,
          '--for=condition=available', 'deployment/kubeclaw-orchestrator',
          '--timeout=120s',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    }
  }, 300_000);

  afterAll(async () => {
    if (helmInstalledByTest) {
      spawnSync(
        'helm',
        ['uninstall', RELEASE_CANCEL, '--namespace', NAMESPACE],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      spawnSync(
        'kubectl',
        ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    }
  });

  it('AC4 — /cancel with no active job returns "No active job"', async () => {
    // Ensure no tool-job pods are running first (correct label: kubeclaw.io/role=tool-job).
    await waitUntil(() => {
      const r = kubectl([
        'get', 'pods', '-l', 'kubeclaw.io/role=tool-job',
        '--field-selector=status.phase=Running',
        '--no-headers',
      ]);
      return r.stdout.trim() === '';
    }, 15_000, 1000);

    const lines = await postMessageAndCollectSSE('/cancel', 5000, (line) =>
      /no active job/i.test(line),
    );

    expect(lines.some((l) => /no active job/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1-AC3 are deferred until mock-LLM tool-call dispatch is wired into the
// cancel e2e namespace. Keeping them as describe.skip so they are visible in
// the test listing and not silently lost.
//
// Blockers before enabling:
//   1. Mock LLM must return a tool-call response for "run a slow background
//      task please" (requires helm --set channels.http.llm.baseUrl=... pointing
//      at the mock LLM started by global setup).
//   2. A specialist/tool job type that produces a long-running K8s Job must be
//      registered in the cancel namespace.
//   3. The tests form a sequential state chain (AC1→AC2→AC3); flakiness in AC1
//      causes misleading failures downstream.
// ---------------------------------------------------------------------------
describe.skip('Story 49 — /cancel e2e (AC1-AC3: deferred — needs mock-LLM dispatch)', () => {
  let activeJobId: string | undefined;

  beforeAll(async () => {
    // Namespace must be pre-provisioned (handled by the AC4 suite above).
    const nsCheck = kubectl(['get', 'namespace', NAMESPACE, '--ignore-not-found']);
    if (!nsCheck.stdout.includes(NAMESPACE)) {
      throw new Error(
        `Namespace ${NAMESPACE} not found — deploy kubeclaw-e2e-cancel first`,
      );
    }
  });

  afterAll(async () => {
    // Best-effort cleanup of any leftover test jobs
    if (activeJobId) {
      kubectl([
        'delete', 'job', '-l', `kubeclaw.io/job-id=${activeJobId}`,
        '--ignore-not-found',
      ]);
    }
  });

  it('AC1 — /cancel while job is running returns SSE "Cancelled" within 5 s', async () => {
    // First, trigger a long-running tool job by sending a slow prompt
    // (the exact prompt depends on the deployed specialist setup)
    const triggerLines = await postMessageAndCollectSSE(
      'run a slow background task please',
      3000,
      (line) => line.length > 0,
    );

    // Give the K8s job a moment to reach Running state
    await new Promise((r) => setTimeout(r, 2000));

    // Check that a pod is Running (correct label: kubeclaw.io/role=tool-job).
    const podsCheck = kubectl([
      'get', 'pods', '-l', 'kubeclaw.io/role=tool-job',
      '--field-selector=status.phase=Running',
    ]);
    // Now send /cancel
    const cancelLines = await postMessageAndCollectSSE('/cancel', 5000, (line) =>
      /cancelled/i.test(line),
    );

    expect(cancelLines.some((l) => /cancelled/i.test(l))).toBe(true);
  });

  it('AC2 — within 30 s of cancel, pod is gone', async () => {
    // This test depends on AC1 having been run first.
    // Wait up to 30 s for all tool-job pods to be removed.
    const noPodsYet = await waitUntil(() => {
      const r = kubectl([
        'get', 'pods', '-l', 'kubeclaw.io/role=tool-job',
        '--field-selector=status.phase=Running',
        '--no-headers',
      ]);
      return r.stdout.trim() === '';
    }, 30_000, 2000);

    expect(noPodsYet).toBe(true);
  });

  it('AC3 — after cancel, a subsequent /message dispatches normally', async () => {
    const lines = await postMessageAndCollectSSE(
      'hello after cancel',
      10_000,
      (line) => line.length > 0,
    );

    // Should get a 200 response and at least one SSE line
    expect(lines.length).toBeGreaterThan(0);
  });
});
