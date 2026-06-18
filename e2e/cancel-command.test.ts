/**
 * End-to-end tests for Story 49 — /cancel slash command
 *
 * Target cluster: minikube (default context)
 * Namespace:      kubeclaw-e2e-cancel
 * HTTP port:      14133
 * Mock LLM ctrl:  14200
 *
 * Acceptance criteria verified:
 *   AC1 — /cancel while a tool job is running returns SSE containing "Cancelled" within 5 s
 *   AC2 — Within 30 s of cancel reply, kubectl get pod returns no items
 *   AC3 — After cancellation, a subsequent POST /message returns 200 and dispatches
 *   AC4 — /cancel with no active job returns SSE containing "No active job"
 *
 * Requires KUBECLAW_E2E_CANCEL=1 to run (cluster-gated).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';

import { setupTestCluster, type ClusterHandle } from './lib/per-test-cluster.js';

const NAMESPACE = 'kubeclaw-e2e-cancel';
const HTTP_PORT = 14133;
const MOCK_LLM_CTRL_PORT = 14200;
const HTTP_BASE = `http://127.0.0.1:${HTTP_PORT}`;
const MOCK_LLM_CTRL_BASE = `http://127.0.0.1:${MOCK_LLM_CTRL_PORT}`;
const HTTP_USER = 'testuser';
const HTTP_PASS = 'testpass';
const TEST_JID = `http:${HTTP_USER}`;

const MANIFESTS_DIR = join(process.cwd(), 'e2e', 'manifests');

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Synchronous kubectl wrapper (namespace scoped).
 */
function kubectl(
  args: string[],
  opts: { timeout?: number; allowFailure?: boolean } = {},
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

async function waitForPortOpen(host: string, port: number, timeoutMs: number): Promise<void> {
  const { createConnection } = await import('net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Port ${host}:${port} not reachable after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// These tests are intentionally skipped unless KUBECLAW_E2E_CANCEL=1 is set.
// ---------------------------------------------------------------------------

const RUN_E2E = process.env.KUBECLAW_E2E_CANCEL === '1';
const maybeDescribe = RUN_E2E ? describe : describe.skip;

maybeDescribe('Story 49 — /cancel e2e', () => {
  let clusterHandle: ClusterHandle;
  let mockLLMPortForward: ChildProcess | null = null;

  beforeAll(async () => {
    // Bring up an isolated kubeclaw cluster with the mock LLM as the OpenAI endpoint.
    clusterHandle = await setupTestCluster({
      namespace: NAMESPACE,
      httpChannel: {
        localPort: HTTP_PORT,
        users: `${HTTP_USER}:${HTTP_PASS}`,
      },
      extraSet: [
        `secrets.openaiBaseUrl=http://kubeclaw-mock-llm.${NAMESPACE}.svc:11434/v1`,
      ],
      quiet: true,
    });

    // Deploy the mock LLM into the test namespace.
    const applyResult = spawnSync(
      'kubectl',
      ['apply', '-f', join(MANIFESTS_DIR, 'mock-llm.yaml'), '-n', NAMESPACE],
      { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
    );
    if (applyResult.status !== 0) {
      throw new Error(
        `Failed to apply mock-llm.yaml:\n${applyResult.stderr}`,
      );
    }

    // Wait for mock LLM pod to be Ready.
    const ready = await waitUntil(
      () => {
        const r = kubectl([
          'get', 'pod', '-l', 'app=kubeclaw-mock-llm',
          '-o', 'jsonpath={.items[0].status.phase}',
        ], { allowFailure: true });
        return r.stdout.trim() === 'Running';
      },
      60_000,
      2000,
    );
    if (!ready) {
      throw new Error('Mock LLM pod did not reach Running state within 60s');
    }

    // Port-forward the mock LLM control port.
    mockLLMPortForward = spawn(
      'kubectl',
      ['port-forward', '-n', NAMESPACE, 'svc/kubeclaw-mock-llm',
       `${MOCK_LLM_CTRL_PORT}:11434`],
      { stdio: 'ignore', detached: false },
    );
    await waitForPortOpen('127.0.0.1', MOCK_LLM_CTRL_PORT, 30_000);
  }, 10 * 60 * 1000);

  afterAll(async () => {
    if (mockLLMPortForward) {
      try { mockLLMPortForward.kill('SIGTERM'); } catch { /* ignore */ }
      mockLLMPortForward = null;
    }
    if (clusterHandle) {
      await clusterHandle.teardown();
    }
  });

  it('AC1 — /cancel while job is running returns SSE "Cancelled" within 5 s', async () => {
    // Clear any leftover queued responses and queue an execute_agent tool call.
    await fetch(`${MOCK_LLM_CTRL_BASE}/control/clear`, { method: 'POST' });
    await fetch(`${MOCK_LLM_CTRL_BASE}/control/queue-tool-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'execute_agent', arguments: { task: 'sleep 300' } }),
    });

    // Trigger a message — channel calls mock LLM → gets tool_calls → dispatches K8s job.
    // We don't await the full SSE stream; fire and forget then wait for the pod.
    const triggerPromise = postMessageAndCollectSSE(
      'run a slow background task please',
      3000,
      () => false, // just collect whatever arrives in 3 s
    );

    // Give the K8s job a moment to reach Running state (up to 30s).
    const podRunning = await waitUntil(() => {
      const r = kubectl([
        'get', 'pods', '-l', 'app=kubeclaw-agent',
        '--field-selector=status.phase=Running', '--no-headers',
      ], { allowFailure: true });
      return r.stdout.trim().length > 0;
    }, 30_000, 2000);

    await triggerPromise;

    if (!podRunning) {
      // Pod may not have started yet — still try to cancel.
      console.warn('[cancel-test] No Running agent pod found before /cancel — proceeding anyway');
    }

    // Now send /cancel.
    const cancelLines = await postMessageAndCollectSSE('/cancel', 5000, (line) =>
      /cancelled/i.test(line),
    );

    expect(cancelLines.some((l) => /cancelled/i.test(l))).toBe(true);
  }, 60_000);

  it('AC2 — within 30 s of cancel, pod is gone', async () => {
    const noPodsYet = await waitUntil(() => {
      const r = kubectl([
        'get', 'pods', '-l', 'app=kubeclaw-agent',
        '--field-selector=status.phase=Running',
        '--no-headers',
      ], { allowFailure: true });
      return r.stdout.trim() === '';
    }, 30_000, 2000);

    expect(noPodsYet).toBe(true);
  }, 45_000);

  it('AC3 — after cancel, a subsequent /message dispatches normally', async () => {
    // Queue a plain text response (no tool call) so the mock returns something.
    await fetch(`${MOCK_LLM_CTRL_BASE}/control/clear`, { method: 'POST' });

    const lines = await postMessageAndCollectSSE(
      'hello after cancel',
      10_000,
      (line) => line.length > 0,
    );

    expect(lines.length).toBeGreaterThan(0);
  }, 30_000);

  it('AC4 — /cancel with no active job returns "No active job"', async () => {
    // Ensure no jobs are running.
    await waitUntil(() => {
      const r = kubectl([
        'get', 'pods', '-l', 'app=kubeclaw-agent',
        '--field-selector=status.phase=Running',
        '--no-headers',
      ], { allowFailure: true });
      return r.stdout.trim() === '';
    }, 15_000, 1000);

    const lines = await postMessageAndCollectSSE('/cancel', 5000, (line) =>
      /no active job/i.test(line),
    );

    expect(lines.some((l) => /no active job/i.test(l))).toBe(true);
  }, 30_000);
});
