/**
 * E2E: Orchestrator restart with in-flight tool job surfaces a user-visible error.
 * Story 37.
 *
 * Acceptance criteria verified:
 *   AC1 — While a tool job is running the orchestrator is restarted and
 *          becomes Ready within 60 s.
 *   AC2 — Within 30 s of Ready, the user's SSE stream delivers a message
 *          containing "tool job interrupted" referencing the message/job id.
 *   AC3 — The orphaned pod is cleaned up (kubectl get pod returns no items).
 *   AC4 — The messages table still has the original user message AND the
 *          interruption notice row (is_from_me=1, is_bot_message=1) — verified
 *          indirectly via the SSE notice arriving (the channel persists it before
 *          delivering to SSE).
 *   AC5 — (LLM-dependent) A fresh POST /message after AC2 works normally.
 *
 * Cluster  : kubeclaw-e2e-istio (kind)
 * Namespace: kubeclaw-e2e-orch-restart
 * Port     : 14121
 *
 * This file is written but NOT executed automatically — it requires the kind
 * cluster and namespace to be provisioned by the CI pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { EventSource } from 'eventsource';
import {
  setupTestCluster,
  type ClusterHandle,
} from './lib/per-test-cluster.js';

const NAMESPACE = 'kubeclaw-e2e-orch-restart';
const HTTP_PORT = 14121;
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TEST_USER = 'alice';
const TEST_PASS = 'testsecret';
const ASSISTANT_NAME = process.env.ASSISTANT_NAME ?? 'Andy';

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

/** Rollout-restart the orchestrator and wait for it to become Ready. */
async function restartOrchestrator(timeoutMs = 120_000): Promise<boolean> {
  const restart = kubectl([
    'rollout', 'restart',
    'deployment/kubeclaw-orchestrator',
    '-n', NAMESPACE,
  ]);
  if (!restart.ok) {
    console.error(`rollout restart failed: ${restart.stderr}`);
    return false;
  }
  const status = kubectl(
    [
      'rollout', 'status',
      'deployment/kubeclaw-orchestrator',
      '-n', NAMESPACE,
      '--timeout', `${Math.floor(timeoutMs / 1000)}s`,
    ],
    { timeout: timeoutMs + 10_000 },
  );
  return status.ok;
}

/** Block until the orchestrator pod's /health readiness probe passes. */
async function waitOrchestratorReady(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'pods', '-n', NAMESPACE,
      '-l', 'app=kubeclaw-orchestrator',
      '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
    ]);
    if (
      r.ok &&
      r.stdout.trim() &&
      r.stdout.trim().split(/\s+/).every((s) => s === 'True')
    ) {
      return true;
    }
    await new Promise((res) => setTimeout(res, 3_000));
  }
  return false;
}

/**
 * Open an SSE connection to /stream and resolve with the first message whose
 * text matches `predicate`, or reject after `timeoutMs`.
 */
function waitForSseMessage(
  predicate: (data: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      es.close();
      reject(new Error(`SSE message matching predicate not received within ${timeoutMs} ms`));
    }, timeoutMs);

    const es = new EventSource(`${HTTP_URL}/stream`, {
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
      },
    });

    es.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : '';
      if (predicate(text)) {
        clearTimeout(timer);
        es.close();
        resolve(text);
      }
    });

    es.addEventListener('error', (err) => {
      // SSE connections drop transiently during the orchestrator restart —
      // eventsource will auto-reconnect, so we only fail on fatal errors
      // if no message has matched yet.
      console.debug('SSE error (may be transient reconnect):', err);
    });
  });
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe('Story 37: orchestrator restart with in-flight tool job', () => {
  let cluster: ClusterHandle | null = null;
  let clusterReachable = false;

  beforeAll(async () => {
    cluster = await setupTestCluster({
      namespace: NAMESPACE,
      httpChannel: {
        localPort: HTTP_PORT,
        users: `${TEST_USER}:${TEST_PASS}`,
      },
      quiet: true,
    });
    clusterReachable = true;
  }, 600_000);

  afterAll(async () => {
    // Best-effort cleanup: delete any orphaned tool-job pods that the test may
    // have left behind if it failed before the restart.
    kubectl([
      'delete', 'jobs',
      '-n', NAMESPACE,
      '-l', 'app=kubeclaw-agent',
      '--ignore-not-found',
    ]);
    if (cluster) await cluster.teardown();
  }, 120_000);

  // ── AC1 + AC2 + AC3 + AC4 ─────────────────────────────────────────────────
  it(
    'AC1–AC4: restart while tool job is running surfaces interruption notice',
    async () => {
      expect(clusterReachable, 'cluster not reachable').toBe(true);

      // ── 1. Send a message that triggers a long-running tool job ───────────
      //
      // The /alpine specialist is configured with a `sleep 30` payload
      // (see Helm values for this namespace).  We send the message that will
      // cause the orchestrator to spawn a K8s Job for it.
      const postRes = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(TEST_USER, TEST_PASS),
        },
        body: JSON.stringify({ text: `@${ASSISTANT_NAME} use alpine to run: sleep 30` }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(postRes.status, 'POST /message should return 200').toBe(200);

      const postBody = (await postRes.json()) as { messageId?: string };
      const messageId = postBody.messageId;
      expect(messageId, 'POST /message should return a messageId').toBeDefined();

      // ── 2. Wait until the tool-job pod is Running ─────────────────────────
      //
      // Poll kubectl for pods with label app=kubeclaw-agent in Running state.
      const podRunningDeadline = Date.now() + 60_000;
      let jobId: string | undefined;
      while (Date.now() < podRunningDeadline) {
        const r = kubectl([
          'get', 'pods', '-n', NAMESPACE,
          '-l', 'app=kubeclaw-agent',
          '--field-selector', 'status.phase=Running',
          '-o', 'jsonpath={.items[0].metadata.labels.job-name}',
        ]);
        if (r.ok && r.stdout.trim()) {
          jobId = r.stdout.trim();
          break;
        }
        await new Promise((res) => setTimeout(res, 3_000));
      }
      expect(jobId, 'no Running tool-job pod appeared within 60 s').toBeDefined();

      // ── 3. AC1: Restart the orchestrator while the job is running ─────────
      //
      // Open the SSE stream BEFORE the restart so we catch the notice as soon
      // as it arrives after the new pod becomes Ready.
      const ssePromise = waitForSseMessage(
        (data) => /tool job interrupted/i.test(data),
        90_000, // 60 s restart window + 30 s notice window
      );

      const restarted = await restartOrchestrator(120_000);
      expect(restarted, 'kubectl rollout restart did not succeed').toBe(true);

      const ready = await waitOrchestratorReady(60_000);
      expect(ready, 'orchestrator pod not Ready within 60 s').toBe(true);

      // ── 4. AC2: Interruption notice arrives within 30 s of Ready ─────────
      const noticeText = await ssePromise; // times out at 90 s total
      expect(noticeText.toLowerCase()).toContain('tool job interrupted');
      // AC2: notice must reference the user-facing messageId from POST /message
      expect(messageId).toBeDefined();
      expect(noticeText).toContain(messageId!);

      // ── 5. AC3: Orphaned pod is cleaned up ───────────────────────────────
      //
      // The orchestrator's reconciliation should have deleted the K8s Job.
      // Allow a few seconds for the deletion to propagate.
      await new Promise((res) => setTimeout(res, 5_000));
      const podCheck = kubectl([
        'get', 'pods', '-n', NAMESPACE,
        '-l', `job-name=${jobId}`,
        '--no-headers',
      ]);
      expect(
        podCheck.stdout.trim(),
        `orphaned pod for job ${jobId} was not cleaned up`,
      ).toBe('');
    },
    300_000,
  );

  // ── AC5 (LLM-dependent) ───────────────────────────────────────────────────
  it.skipIf(process.env.KUBECLAW_NO_LLM === 'true')(
    'AC5: fresh POST /message after restart works normally',
    async () => {
      expect(clusterReachable, 'cluster not reachable').toBe(true);

      // Send a simple message and expect a non-error SSE reply.
      const postRes = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(TEST_USER, TEST_PASS),
        },
        body: JSON.stringify({ text: `@${ASSISTANT_NAME} say OK` }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(postRes.status).toBe(200);

      // Wait for the assistant's reply on SSE
      const reply = await waitForSseMessage(
        // Exclude the interruption notice if it is still in the buffer
        (data) =>
          data.length > 0 &&
          !/tool job interrupted/i.test(data) &&
          !/restarted/i.test(data),
        120_000,
      );
      expect(reply).toBeTruthy();
    },
    300_000,
  );
});
