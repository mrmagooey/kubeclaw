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

import {
  setupTestCluster,
  type ClusterHandle,
} from './lib/per-test-cluster.js';

const NAMESPACE = 'kubeclaw-e2e-cancel';
const HTTP_PORT = 14133;
const MOCK_LLM_CTRL_PORT = 14200;
const HTTP_BASE = `http://127.0.0.1:${HTTP_PORT}`;
const MOCK_LLM_CTRL_BASE = `http://127.0.0.1:${MOCK_LLM_CTRL_PORT}`;
const HTTP_USER = 'testuser';
const HTTP_PASS = 'testpass';

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
 * Open a persistent SSE connection (GET /stream) and accumulate `data:` lines.
 *
 * The HTTP channel delivers all user-facing replies — agent output, the
 * "Cancelled" notice, "No active job" — over GET /stream, NOT in the
 * POST /message response. `data` collects every payload; `ready` resolves once
 * the response has begun so callers can sequence a message after the stream is
 * live; `abort` closes the connection.
 */
function openSse(): {
  data: string[];
  abort: () => void;
  ready: Promise<void>;
} {
  const data: string[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  const req = http.request(
    {
      host: '127.0.0.1',
      port: HTTP_PORT,
      path: '/stream',
      method: 'GET',
      headers: {
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
        Accept: 'text/event-stream',
      },
    },
    (res) => {
      resolveReady();
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
        }
      });
      res.on('error', () => {});
    },
  );
  req.on('error', () => {});
  req.end();

  return { data, abort: () => req.destroy(), ready };
}

/**
 * POST a text message to the HTTP channel. Returns the HTTP status code.
 * The channel's contract is `{ text }` (NOT `{ content }`); the reply arrives
 * asynchronously over the SSE stream, so we don't read the POST body here.
 */
async function postMessage(text: string): Promise<number> {
  const res = await fetch(`${HTTP_BASE}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(HTTP_USER, HTTP_PASS),
    },
    body: JSON.stringify({ text }),
  });
  return res.status;
}

/** True once any collected SSE line matches the regex. */
function sseHas(lines: string[], re: RegExp): boolean {
  return lines.some((l) => re.test(l));
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

async function waitForPortOpen(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
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

  beforeAll(
    async () => {
      // Bring up an isolated kubeclaw cluster with the mock LLM as the OpenAI endpoint.
      clusterHandle = await setupTestCluster({
        namespace: NAMESPACE,
        httpChannel: {
          localPort: HTTP_PORT,
          users: `${HTTP_USER}:${HTTP_PASS}`,
        },
        extraSet: [
          `secrets.openaiBaseUrl=http://kubeclaw-mock-llm.${NAMESPACE}.svc:11434/v1`,
          // The in-cluster mock LLM is not a kubeclaw-role pod, so the default
          // channel egress NetworkPolicy blocks the channel→mock connection.
          // Disable network policies for this suite. (Safe: the chart renders the
          // channel Service independently of networkPolicy.enabled.)
          `networkPolicy.enabled=false`,
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
          const r = kubectl(
            [
              'get',
              'pod',
              '-l',
              'app=kubeclaw-mock-llm',
              '-o',
              'jsonpath={.items[0].status.phase}',
            ],
            { allowFailure: true },
          );
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
        [
          'port-forward',
          '-n',
          NAMESPACE,
          'svc/kubeclaw-mock-llm',
          `${MOCK_LLM_CTRL_PORT}:11434`,
        ],
        { stdio: 'ignore', detached: false },
      );
      await waitForPortOpen('127.0.0.1', MOCK_LLM_CTRL_PORT, 30_000);
    },
    10 * 60 * 1000,
  );

  afterAll(async () => {
    if (mockLLMPortForward) {
      try {
        mockLLMPortForward.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      mockLLMPortForward = null;
    }
    if (clusterHandle) {
      await clusterHandle.teardown();
    }
  });

  /** Number of Running agent pods in the namespace. */
  function runningAgentPods(): number {
    const r = kubectl(
      [
        'get',
        'pods',
        '-l',
        'app=kubeclaw-agent',
        '--field-selector=status.phase=Running',
        '--no-headers',
      ],
      { allowFailure: true },
    );
    return r.stdout.trim() === '' ? 0 : r.stdout.trim().split('\n').length;
  }

  it('AC1 — /cancel while a job is running returns SSE "Cancelled" within 5 s', async () => {
    // Open the SSE stream BEFORE triggering so it catches the orchestrator's
    // "Cancelled" notice.
    const sse = openSse();
    await sse.ready;
    await new Promise((r) => setTimeout(r, 300));

    try {
      // Queue one execute_agent tool call so the trigger dispatches a K8s job.
      await fetch(`${MOCK_LLM_CTRL_BASE}/control/clear`, { method: 'POST' });
      await fetch(`${MOCK_LLM_CTRL_BASE}/control/queue-tool-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'execute_agent',
          arguments: { task: 'sleep 300' },
        }),
      });

      // Trigger: channel calls mock LLM → tool_call → dispatches K8s agent job.
      expect(await postMessage('run a slow background task please')).toBe(200);

      // Wait for the agent pod to reach Running.
      const podRunning = await waitUntil(
        () => runningAgentPods() > 0,
        30_000,
        2000,
      );
      expect(podRunning).toBe(true);

      // Send /cancel while the job runs. With out-of-band handling this is
      // actioned immediately even though the message loop is blocked in the
      // execute_agent turn.
      expect(await postMessage('/cancel')).toBe(200);

      // "Cancelled" must arrive on the stream within 5 s.
      const cancelled = await waitUntil(
        () => sseHas(sse.data, /cancelled/i),
        5_000,
        250,
      );
      expect(cancelled, `SSE lines: ${JSON.stringify(sse.data)}`).toBe(true);
    } finally {
      sse.abort();
    }
  }, 60_000);

  it('AC2 — within 30 s of cancel, the agent pod is gone', async () => {
    const gone = await waitUntil(() => runningAgentPods() === 0, 30_000, 2000);
    expect(gone).toBe(true);
  }, 45_000);

  it('AC3 — after cancel, a subsequent /message dispatches normally', async () => {
    // The message loop must have unblocked after the cancel. A plain message
    // (no queued tool call) drives one mock completion whose text streams back.
    await fetch(`${MOCK_LLM_CTRL_BASE}/control/clear`, { method: 'POST' });

    const sse = openSse();
    await sse.ready;
    await new Promise((r) => setTimeout(r, 300));

    try {
      expect(await postMessage('hello after cancel')).toBe(200);
      const gotReply = await waitUntil(
        () => sse.data.some((l) => l.trim().length > 0),
        20_000,
        500,
      );
      expect(gotReply, `SSE lines: ${JSON.stringify(sse.data)}`).toBe(true);
    } finally {
      sse.abort();
    }
  }, 40_000);

  it('AC4 — /cancel with no active job returns "No active job"', async () => {
    // Ensure nothing is running.
    await waitUntil(() => runningAgentPods() === 0, 15_000, 1000);

    const sse = openSse();
    await sse.ready;
    await new Promise((r) => setTimeout(r, 300));

    try {
      expect(await postMessage('/cancel')).toBe(200);
      const noJob = await waitUntil(
        () => sseHas(sse.data, /no active job/i),
        5_000,
        250,
      );
      expect(noJob, `SSE lines: ${JSON.stringify(sse.data)}`).toBe(true);
    } finally {
      sse.abort();
    }
  }, 30_000);
});
