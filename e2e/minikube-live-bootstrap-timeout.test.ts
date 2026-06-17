/**
 * Minikube-live: bootstrap timeout cleanup (Story 175).
 *
 * Tests the end-to-end path when the bootstrap Job's activeDeadlineSeconds fires
 * because the admin abandoned the dialogue without responding.
 *
 * Strategy:
 *   - Per-invocation timeout_seconds=25 is passed via the prompt; no special deployment config needed.
 *   - Call bootstrap_channel_from_skill via the admin shell HTTP API.
 *   - Subscribe to the admin SSE stream and wait for the first bootstrap dialogue
 *     prompt (confirms the Job started).
 *   - Do NOT respond — let the 60 s deadline fire.
 *   - Assert the SSE stream delivers a message containing "timed out; nothing was installed".
 *   - Assert via kubectl that no PVC named kubeclaw-channel-<instance>-runtime exists.
 *   - Assert via kubectl that no Job named kubeclaw-bootstrap-<instance> exists.
 *   - Assert bootstrap_channel_from_skill with the same instance name returns a fresh
 *     bootstrapJobId rather than "already in progress".
 *
 * AC coverage:
 *   AC1: K8s resources deleted (Job + PVC; Secret defensively)
 *   AC2: SSE timeout notice delivered
 *   AC3: instance freed; retry succeeds
 *   AC5: timeout_seconds=25 per-invocation parameter governs both Job deadline and orchestrator poll
 *
 * AC4 (orphan reconcile restart idempotency) is covered at integration level in
 * bootstrap-runner.integration.test.ts — minikube restart is too expensive for e2e.
 *
 * Prerequisites:
 *   - minikube-live global setup (e2e/minikube-live-setup.ts)
 *   - kubeclaw deployed with BOOTSTRAP_SKILL_TIMEOUT_SECONDS=60 (60-second deadline)
 *   - admin port-forward running on KUBECLAW_LIVE_ADMIN_LOCAL_PORT
 *
 * Run with:
 *   npx vitest run --config vitest.minikube-live.config.ts \
 *     e2e/minikube-live-bootstrap-timeout.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;
const INSTANCE_NAME = 'e2e-timeout-tg';
// Per-invocation timeout passed via the LLM prompt (timeout_seconds=25).
// No deployment config needed — the parameter is sent with each call.
const BOOTSTRAP_TIMEOUT_SECONDS = 25;
// How long the test waits for the timeout SSE + cleanup to complete.
// The Job fires at BOOTSTRAP_TIMEOUT_SECONDS; give 60 s overhead for
// K8s condition propagation + orchestrator cleanup round-trip.
const TEST_TIMEOUT_MS = (BOOTSTRAP_TIMEOUT_SECONDS + 60) * 1000;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kubectl(
  args: string[],
  opts: { timeout?: number; allowFail?: boolean } = {},
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Open the admin /events SSE stream and buffer incoming messages.
 * Returns a `waitFor` poller that checks the buffer, and a `dispose`
 * function that aborts the stream.
 *
 * Call this BEFORE triggering any operation whose SSE event you want to
 * capture — opening the stream first eliminates the race between "event
 * emitted" and "connection established".
 */
async function openAdminSseStream(
  adminUrl: string,
  authHeader: string,
): Promise<{
  texts: string[];
  waitFor: (predicate: (text: string) => boolean, timeoutMs: number) => Promise<string>;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`${adminUrl}/events`, {
    headers: { Authorization: authHeader, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (res.status !== 200 || !res.body) {
    throw new Error(`SSE /events returned ${res.status}`);
  }

  const texts: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            try {
              const payload = JSON.parse(raw) as { type?: string; text?: string };
              texts.push(payload.text ?? '');
            } catch {
              texts.push(raw);
            }
          }
        }
      }
    } catch {
      // aborted — expected on dispose()
    }
  })().catch(() => {});

  return {
    texts,
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = texts.find(predicate);
        if (match !== undefined) return match;
        await new Promise<void>((r) => setTimeout(r, 300));
      }
      throw new Error(`No matching SSE message within ${timeoutMs}ms`);
    },
    dispose: () => controller.abort(),
  };
}

/**
 * Call bootstrap_channel_from_skill via the admin shell /chat endpoint.
 * Returns a confirmation string once the bootstrap Job appears in the cluster,
 * or throws if the Job does not appear within 60s.
 *
 * We do NOT wait for the LLM assistant reply — LLM latency can exceed the
 * test budget. The real outcome (Job created) is verified via kubectl.
 */
async function callBootstrapChannelFromSkill(
  adminUrl: string,
  authHeader: string,
  instanceName: string,
): Promise<string> {
  // Fire the chat POST.
  const res = await fetch(`${adminUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({
      text: `Call bootstrap_channel_from_skill with skill_name="bootstrap-telegram", channel_type="telegram", instance_name="${instanceName}", timeout_seconds=25`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status !== 202) {
    throw new Error(`POST /chat returned ${res.status}`);
  }

  // Poll kubectl for the bootstrap Job to appear.
  const jobName = `kubeclaw-bootstrap-${instanceName}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = kubectl(
      ['get', 'job', jobName, '-n', NAMESPACE, '--ignore-not-found=true', '-o', 'jsonpath={.metadata.name}'],
    );
    if (r.ok && r.stdout.trim() === jobName) {
      // Verify the Job got the per-invocation deadline.
      const deadlineResult = kubectl([
        'get', 'job', jobName, '-n', NAMESPACE,
        '-o', 'jsonpath={.spec.activeDeadlineSeconds}',
      ]);
      if (!deadlineResult.ok) {
        throw new Error(
          `kubectl get job activeDeadlineSeconds failed: ${deadlineResult.stderr}`,
        );
      }
      if (deadlineResult.stdout.trim() !== '25') {
        throw new Error(
          `Expected activeDeadlineSeconds=25 but got ${deadlineResult.stdout.trim()}; LLM may have ignored timeout_seconds param`,
        );
      }
      return `Bootstrap started: Job ${jobName} exists in cluster (deadline=25s verified)`;
    }
    await sleep(2000);
  }
  throw new Error(`Bootstrap Job ${jobName} did not appear within 60s`);
}

describe(
  'Minikube-live: bootstrap timeout cleanup (Story 175)',
  () => {
    let adminPass = '';
    let authHeader = '';
    let provisioned = false;

    beforeAll(async () => {
      // Read admin password from cluster Secret.
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
      }
      authHeader = basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass);

      // Wait for admin port-forward to be reachable.
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
          // not ready yet
        }
        await sleep(2000);
      }

      // Pre-test cleanup: remove any stale bootstrap Job or runtime PVC from a
      // prior run so the test observes a FRESH Job created by this invocation.
      // --ignore-not-found suppresses errors when the resource is absent.
      kubectl(
        [
          'delete',
          'job',
          '-n',
          NAMESPACE,
          `kubeclaw-bootstrap-${INSTANCE_NAME}`,
          '--ignore-not-found',
        ],
        { allowFail: true },
      );
      kubectl(
        [
          'delete',
          'pvc',
          '-n',
          NAMESPACE,
          `kubeclaw-channel-${INSTANCE_NAME}-runtime`,
          '--ignore-not-found',
        ],
        { allowFail: true },
      );
    }, 30_000);

    afterAll(() => {
      // Best-effort cleanup — delete any leftover resources regardless of test outcome.
      kubectl(
        [
          'delete',
          'job',
          '-n',
          NAMESPACE,
          `kubeclaw-bootstrap-${INSTANCE_NAME}`,
          '--ignore-not-found',
        ],
        { allowFail: true },
      );
      kubectl(
        [
          'delete',
          'pvc',
          '-n',
          NAMESPACE,
          `kubeclaw-channel-${INSTANCE_NAME}-runtime`,
          '--ignore-not-found',
        ],
        { allowFail: true },
      );
      kubectl(
        [
          'delete',
          'secret',
          '-n',
          NAMESPACE,
          `kubeclaw-channel-${INSTANCE_NAME}-credentials`,
          '--ignore-not-found',
        ],
        { allowFail: true },
      );
    });

    it(
      'timeout SSE message delivered, K8s resources cleaned up, instance freed for retry',
      async () => {
        if (!provisioned) {
          console.warn('Skipping: minikube-live admin not reachable');
          return;
        }

        // SSE stream is opened BEFORE triggering the bootstrap, so any timeout
        // event emitted after Job creation is guaranteed to be captured regardless
        // of how quickly the 25s deadline fires.
        const sse = await openAdminSseStream(ADMIN_URL, authHeader);
        try {
          // Step 1: Call bootstrap_channel_from_skill — expect "Bootstrap started successfully".
          const bootstrapReply = await callBootstrapChannelFromSkill(
            ADMIN_URL,
            authHeader,
            INSTANCE_NAME,
          );
          expect(bootstrapReply).toContain('Bootstrap started');

          // Step 2: Wait for the timeout SSE message (type=timeout).
          // The Job's activeDeadlineSeconds=BOOTSTRAP_TIMEOUT_SECONDS will fire.
          // The orchestrator observes DeadlineExceeded and calls cleanupBootstrapResources.
          const timeoutMsg = await sse.waitFor(
            (text) =>
              text.includes('timed out; nothing was installed') ||
              text.includes('timed out'),
            TEST_TIMEOUT_MS,
          );

          expect(timeoutMsg).toContain('timed out');
          expect(timeoutMsg).toContain('nothing was installed');

          // Wait a moment for cleanup to settle before querying K8s.
          await sleep(5_000);

          // Step 3: Assert no PVC remains.
          const pvcResult = kubectl(
            [
              'get',
              'pvc',
              '-n',
              NAMESPACE,
              `kubeclaw-channel-${INSTANCE_NAME}-runtime`,
            ],
            { allowFail: true },
          );
          expect(pvcResult.ok).toBe(false); // 404 → kubectl exits non-zero

          // Step 4: Assert no Job remains.
          const jobResult = kubectl(
            [
              'get',
              'job',
              '-n',
              NAMESPACE,
              `kubeclaw-bootstrap-${INSTANCE_NAME}`,
            ],
            { allowFail: true },
          );
          expect(jobResult.ok).toBe(false); // 404 → kubectl exits non-zero

          // Step 5: Assert retry with the same instance name succeeds (not "already in progress").
          const retryReply = await callBootstrapChannelFromSkill(
            ADMIN_URL,
            authHeader,
            INSTANCE_NAME,
          );
          expect(retryReply).not.toContain('already in progress');
          expect(retryReply).toContain('Bootstrap started');

          // Cleanup: delete the retry Job immediately so afterAll has less to do.
          kubectl(
            [
              'delete',
              'job',
              '-n',
              NAMESPACE,
              `kubeclaw-bootstrap-${INSTANCE_NAME}`,
              '--ignore-not-found',
            ],
            { allowFail: true },
          );
        } finally {
          sse.dispose();
        }
      },
      // Overall test timeout: Job deadline + grace + buffer
      TEST_TIMEOUT_MS + 30_000,
    );
  },
);
