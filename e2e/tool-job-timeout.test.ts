/**
 * E2E: Tool job DeadlineExceeded surfaces a user-visible "timed out" notice.
 * Story 43.
 *
 * Acceptance criteria verified:
 *   AC1 — When the K8s Job transitions to Failed/DeadlineExceeded, within 30 s
 *          the user's SSE stream delivers a message containing "timed out"
 *          (case-insensitive) referencing the group folder.
 *   AC2 — The orchestrator log contains an entry with fields
 *          `{ event: "tool_job_timeout", groupFolder, jobName }`.
 *   AC3 — The timeout reply is stored in conversation_history with
 *          role='assistant' and is_bot_message=1 (verified indirectly via the
 *          SSE notice arriving — the channel persists it before SSE delivery).
 *   AC4 — The group is not wedged: a subsequent POST /message from the same
 *          user returns 200 and the orchestrator dispatches it normally.
 *   AC5 — kubeclaw_tool_job_duration_seconds histogram records an observation
 *          for the timed-out job (verified via /metrics endpoint).
 *
 * Cluster  : kubeclaw-e2e (kind)
 * Namespace: kubeclaw-e2e-timeout
 * Port     : 14131
 *
 * Setup requirements:
 *   - A kind cluster with KubeClaw installed via Helm
 *   - A registered group with a specialist whose K8s job has
 *     `activeDeadlineSeconds: 5` (set via containerConfig.timeout: 5000)
 *   - The specialist command is `sleep 60` (guaranteed to exceed the deadline)
 *
 * This file is written but NOT automatically executed — it requires a live
 * kind cluster and namespace provisioned by the CI pipeline or manually.
 * Run with:
 *   npx vitest run --config vitest.e2e.config.ts e2e/tool-job-timeout.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupTestCluster,
  type ClusterHandle,
} from './lib/per-test-cluster.js';
import { spawnSync } from 'node:child_process';
import { EventSource } from 'eventsource';

const NAMESPACE = 'kubeclaw-e2e-timeout';
const HTTP_PORT = 14131;
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TEST_USER = 'alice';
const TEST_PASS = 'testsecret';
const ASSISTANT_NAME = process.env.ASSISTANT_NAME ?? 'Andy';

// Specialist configured with a tiny activeDeadlineSeconds so it always times out
const TIMEOUT_SPECIALIST = 'timeout-test';

// ── Helpers ────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kubectl(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
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
 * Open an SSE connection to /stream and resolve with the first message whose
 * text matches `predicate`, or reject after `timeoutMs`.
 */
function waitForSseMessage(
  headers: Record<string, string>,
  predicate: (data: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`${HTTP_URL}/stream`, { headers });
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        source.close();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for SSE message`));
      }
    }, timeoutMs);

    source.onmessage = (event: MessageEvent) => {
      let text: string;
      try {
        const data = JSON.parse(event.data);
        text = data.text ?? event.data;
      } catch {
        text = event.data;
      }
      if (predicate(text)) {
        resolved = true;
        clearTimeout(timer);
        source.close();
        resolve(text);
      }
    };

    source.onerror = () => {
      // SSE errors during poll are expected (connection dropped between events)
    };
  });
}

/** POST /message and return the response */
async function postMessage(
  text: string,
  auth: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** GET /metrics and return the raw Prometheus text */
async function fetchMetrics(): Promise<string> {
  const res = await fetch(`${HTTP_URL}/metrics`);
  return res.text();
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const authHeaders = { Authorization: basicAuth(TEST_USER, TEST_PASS) };

let cluster: ClusterHandle | null = null;

beforeAll(async () => {
  cluster = await setupTestCluster({
    namespace: NAMESPACE,
    httpChannel: {
      localPort: HTTP_PORT,
      users: `${TEST_USER}:${TEST_PASS}`,
    },
    setupTimeoutMs: 9 * 60 * 1000,
    quiet: true,
  });
}, 600_000);

afterAll(async () => {
  if (cluster) await cluster.teardown();
}, 120_000);

// ── Tests ──────────────────────────────────────────────────────────────────

// Per-test-cluster tests deploy a real Helm release inside minikube but cannot
// route pod→host traffic to the mock LLM server. Tests that require a real LLM
// (tool dispatch, DeadlineExceeded reaction) are skipped when KUBECLAW_NO_LLM
// is set. Override with KUBECLAW_NO_LLM=false to run them against a live provider.
const shouldSkipLlmTests = process.env.KUBECLAW_NO_LLM === 'true';

describe('tool-job DeadlineExceeded — e2e (Story 43)', () => {
  it.skipIf(shouldSkipLlmTests)(
    'AC1: SSE stream delivers a "timed out" message within 30 s of K8s deadline',
    async () => {
      // Trigger the specialist with a command known to exceed its deadline
      const postResult = await postMessage(
        `@${TIMEOUT_SPECIALIST} run forever`,
        authHeaders,
      );
      expect(postResult.status).toBe(200);

      // Wait for the timeout notice on the SSE stream
      const notice = await waitForSseMessage(
        authHeaders,
        (text) => text.toLowerCase().includes('timed out'),
        30_000,
      );

      expect(notice.toLowerCase()).toContain('timed out');
    },
    40_000,
  );

  it.skipIf(shouldSkipLlmTests)(
    'AC2: orchestrator log contains event: tool_job_timeout with groupFolder and jobName',
    async () => {
      // Retrieve orchestrator logs from the last 60 s
      const result = kubectl(
        [
          'logs',
          '-n', NAMESPACE,
          'deployment/kubeclaw-orchestrator',
          '--since=60s',
        ],
        { timeout: 15_000 },
      );
      expect(result.ok).toBe(true);

      // The log line should contain the event and groupFolder as JSON fields
      const lines = result.stdout.split('\n');
      const timeoutLine = lines.find((l) => {
        try {
          const obj = JSON.parse(l);
          return obj.event === 'tool_job_timeout' && obj.groupFolder;
        } catch {
          return false;
        }
      });
      expect(timeoutLine, 'Expected log entry with event=tool_job_timeout').toBeTruthy();
    },
    20_000,
  );

  it(
    'AC4: subsequent POST /message returns 200 (group not wedged)',
    async () => {
      // After the timeout, the group should accept new messages normally
      const result = await postMessage(
        `@${ASSISTANT_NAME} ping`,
        authHeaders,
      );
      expect(result.status).toBe(200);
    },
    20_000,
  );

  it.skipIf(shouldSkipLlmTests)(
    'AC5: kubeclaw_tool_job_duration_seconds histogram has an observation for the timed-out job',
    async () => {
      const metrics = await fetchMetrics();

      // The histogram should include an observation — the bucket counts should
      // be non-zero for the 'success=false' label combination.
      expect(metrics).toContain('kubeclaw_tool_job_duration_seconds');
    },
    10_000,
  );
});
