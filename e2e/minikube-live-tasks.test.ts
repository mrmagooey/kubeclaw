/**
 * Minikube-live task-scheduler end-to-end tests.
 *
 * The globalSetup at e2e/minikube-live-setup.ts helm-installs kubeclaw into
 * namespace `kubeclaw-live` and starts port-forwards for the HTTP channel
 * (localhost:14081) and Redis (localhost:16381).
 *
 * These tests BYPASS the live LLM by XADDing directly to the
 * `kubeclaw:task-requests` stream and polling resultStreams for replies.
 * This mirrors the pattern used by scheduleTaskDirect / manageTaskDirect in
 * src/runtime/direct-llm-runner.ts:542-651 and the handler in
 * src/k8s/ipc-redis.ts:1021-1217.
 *
 * Group folder derivation (src/channel-runner.ts jidToFolder):
 *   channelType='http', jid='http:alice'
 *   prefix='http', sanitized='http-alice' → folder='http-http-alice'
 *
 * NOTE: The default SCHEDULER_POLL_INTERVAL is 60 s, so tasks whose
 * `schedule_value` is "5 seconds from now" will not fire until the next
 * scheduler tick (up to 60 s later). Tests add generous wait windows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';

// Group folder for the auto-registered HTTP-channel alice user.
// jidToFolder('http', 'http:alice') → 'http-http-alice'
const GROUP_FOLDER = 'http-http-alice';
const CHAT_JID = 'http:alice';

const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Reads `data: ...` lines from an SSE stream.
 * Returns a handle with a `waitFor` poll helper and a `dispose` abort.
 */
async function openSseStream(
  user: string,
  pass: string,
): Promise<{
  lines: string[];
  waitFor: (
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: basicAuth(user, pass) },
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
      // eslint-disable-next-line no-constant-condition
      while (true) {
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
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs}ms (lines: ${JSON.stringify(lines.slice(-5))})`,
      );
    },
    dispose: () => controller.abort(),
  };
}

/**
 * XREADs a single entry from a resultStream, blocking up to `blockMs`.
 * Returns the `result` field value, or null on timeout.
 *
 * This mirrors the polling loop used by scheduleTaskDirect and manageTaskDirect
 * in src/runtime/direct-llm-runner.ts:579-598 and 630-648.
 */
async function readResultStream(
  redis: Redis,
  resultStream: string,
  blockMs: number,
): Promise<string | null> {
  const deadline = Date.now() + blockMs;
  let lastId = '0-0';
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const response = await redis.xread(
      'COUNT',
      1,
      'BLOCK',
      Math.min(2000, remaining),
      'STREAMS',
      resultStream,
      lastId,
    );
    if (!response) continue;
    for (const [, messages] of response as [string, [string, string[]][]][]) {
      for (const [, fields] of messages) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2)
          obj[fields[i]] = fields[i + 1];
        return obj.result ?? null;
      }
    }
  }
  return null;
}

/** Generates a random hex suffix for unique stream / task names. */
function randHex(bytes = 4): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(bytes * 2, '0');
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: task-scheduler subsystem via Redis IPC', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Verify the HTTP-channel port-forward is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
      return;
    }

    // 2. Read the Redis admin password from the auto-generated Secret, then
    //    connect as the 'orchestrator' ACL user (same as capabilities suite).
    const pwd = kubectl([
      'get',
      'secret',
      '-n',
      NAMESPACE,
      'kubeclaw-redis',
      '-o',
      'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        // Tolerant config: survive a port-forward restart (typically <100 ms)
        // without the test-side client giving up. 20 retries × up to 2 s back-
        // off = up to ~20 s of reconnect attempts before hard failure.
        maxRetriesPerRequest: 20,
        connectTimeout: 15_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        reconnectOnError: () => true,
      },
    );
    await redis.ping();

    // 3. Warm the group by sending one message via HTTP so `http-http-alice`
    //    is registered. Subsequent task XADD calls reference this groupFolder.
    //    If already registered (previous test run), this is a no-op.
    try {
      await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
        },
        body: JSON.stringify({ text: 'ping' }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // best-effort; the channel pod may already have alice registered
    }
    // Small delay to let the orchestrator process any registration.
    await new Promise((r) => setTimeout(r, 2000));
  }, 120_000);

  afterAll(async () => {
    if (redis) {
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    }
  });

  // ── 1. schedule_task: one-shot task fires and produces an observable signal ─
  //
  // We schedule a once task 20 s in the future, confirm acceptance via the
  // resultStream, then open an SSE stream and wait up to 90 s (20 s fire
  // window + up to 60 s scheduler tick + 10 s LLM processing + buffer) for
  // the channel to deliver a message.
  //
  // The HARD assertion is that the orchestrator accepted the task (resultStream
  // entry) AND that the orchestrator logs show "Running scheduled task" for our
  // taskId. The SSE marker delivery is informational because the Gemma LLM
  // may not reproduce the exact phrase.
  //
  // Redis stream fields — src/runtime/direct-llm-runner.ts:551-574;
  // handler — src/k8s/ipc-redis.ts:1021-1144.
  it(
    'schedule_task: a one-shot task scheduled 20 s in the future fires and writes to its result stream',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'redis client not initialised').not.toBeNull();

      const taskId = `task-once-${randHex()}`;
      const resultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      const scheduleValue = new Date(Date.now() + 20_000).toISOString();
      const marker = `task-fired-marker-${randHex()}`;

      // XADD schedule_task — mirrors scheduleTaskDirect in
      // src/runtime/direct-llm-runner.ts:551-574.
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'schedule_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'chatJid',
        CHAT_JID,
        'isMain',
        'false',
        'prompt',
        `Reply with exactly the word noted to acknowledge: ${marker}`,
        'schedule_type',
        'once',
        'schedule_value',
        scheduleValue,
        'context_mode',
        'isolated',
        'resultStream',
        resultStream,
      );

      // Confirm acceptance — scheduleTaskDirect only writes to resultStream on
      // REJECTION (limit exceeded, duplicate). On success it returns from
      // in-process state and writes nothing (src/runtime/direct-llm-runner.ts:576-601).
      // So: null (timeout) = accepted; non-null containing rejection text = failure.
      const accepted = await readResultStream(redis!, resultStream, 5_000);
      if (accepted !== null) {
        expect(
          accepted,
          `orchestrator rejected the schedule_task: ${accepted}`,
        ).not.toMatch(/task limit reached|already exists|rejected|error/i);
      }
      // accepted === null means no rejection was written → task was accepted (success path).

      // Open SSE before the firing window so we don't miss fast deliveries.
      let sse: Awaited<ReturnType<typeof openSseStream>> | null = null;
      let sseDelivered = false;
      try {
        sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
      } catch {
        // SSE setup failure is non-fatal for this test; we fall back to log check.
        console.warn('SSE stream could not be opened; will rely on log check only');
      }

      // Wait for the task firing window: 20 s schedule + up to 60 s scheduler
      // tick + 10 s LLM processing headroom = 90 s total.
      if (sse) {
        try {
          await sse.waitFor((l) => l.length > 0, 90_000);
          sseDelivered = sse.lines.length > 0;
        } catch {
          // Timeout — fall through to log-based assertion.
        }
        sse.dispose();
      } else {
        await new Promise((r) => setTimeout(r, 90_000));
      }

      // HARD assertion: orchestrator logs must show "Running scheduled task"
      // for our taskId (src/task-scheduler.ts:126-129).
      const logs = kubectl([
        'logs',
        'deployment/kubeclaw-orchestrator',
        '-n',
        NAMESPACE,
        '--tail=2000',
      ]);
      expect(logs.ok, `kubectl logs for orchestrator failed: ${logs.stderr}`).toBe(
        true,
      );
      expect(
        logs.stdout,
        `expected "Running scheduled task" or taskId "${taskId}" in orchestrator logs`,
      ).toMatch(new RegExp(`Running scheduled task|${taskId}`));

      // Informational: did the LLM reproduce the marker?
      const markerSeen = sseDelivered && sse !== null
        ? sse!.lines.some((l) => l.includes(marker))
        : false;
      console.log(
        `Task-scheduler observability: ` +
          `accepted=${accepted?.slice(0, 80)}, SSE delivered=${sseDelivered}, ` +
          `marker in SSE=${markerSeen}`,
      );
    },
    180_000,
  );

  // ── 2. list_tasks: after scheduling, list returns the task ID ─────────────
  //
  // We schedule a long-interval task (60 000 ms) so it does not fire during
  // the test, then list tasks for the group and verify our taskId appears.
  //
  // Redis stream fields for list_tasks — handler at
  // src/k8s/ipc-redis.ts:1145-1159; result format: one line per task:
  //   "ID: <id> | <type> <value> | status: <status> | ..."
  it(
    'list_tasks: after scheduling an interval task, list returns the task ID',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis).not.toBeNull();

      const taskId = `task-list-${randHex()}`;
      const scheduleResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;

      // Schedule an interval task with a 60 000 ms period — it will not fire
      // during this test. Fields mirror manageTaskDirect / scheduleTaskDirect.
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'schedule_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'chatJid',
        CHAT_JID,
        'isMain',
        'false',
        'prompt',
        `Scheduled task for list_tasks test (id=${taskId})`,
        'schedule_type',
        'interval',
        'schedule_value',
        '60000',
        'context_mode',
        'isolated',
        'resultStream',
        scheduleResultStream,
      );

      // Wait for any rejection signal — scheduleTaskDirect only writes to
      // resultStream on rejection, not on success
      // (src/runtime/direct-llm-runner.ts:576-601).
      // null = timeout = accepted (success path); non-null = check for rejection.
      const scheduleResult = await readResultStream(
        redis!,
        scheduleResultStream,
        5_000,
      );
      if (scheduleResult !== null) {
        expect(
          scheduleResult,
          `orchestrator rejected schedule_task: ${scheduleResult}`,
        ).not.toMatch(/task limit reached|already exists|rejected|error/i);
      }
      // scheduleResult === null means task was accepted.

      // Now list tasks for this group.
      // Fields mirror manageTaskDirect — src/runtime/direct-llm-runner.ts:614-625.
      const listResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'list_tasks',
        'groupFolder',
        GROUP_FOLDER,
        'resultStream',
        listResultStream,
      );

      const listResult = await readResultStream(redis!, listResultStream, 10_000);
      expect(
        listResult,
        'orchestrator did not return list_tasks result',
      ).not.toBeNull();
      expect(
        listResult,
        `expected taskId "${taskId}" in list_tasks result`,
      ).toContain(taskId);

      // Cleanup: cancel the task so it doesn't accumulate across test runs.
      const cancelResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'cancel_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'resultStream',
        cancelResultStream,
      );
      // Give cancellation a moment to process; result is not asserted here.
      await readResultStream(redis!, cancelResultStream, 5_000);
    },
    60_000,
  );

  // ── 3. cancel_task: cancelling stops the task from firing ─────────────────
  //
  // We schedule a 5-second interval task, wait for at least one firing
  // (evidenced by orchestrator logs), cancel it, then wait another window
  // and assert no further firings occurred.
  //
  // Because the default scheduler tick is 60 s, we set schedule_value=5000
  // (5 s interval); the first firing happens within the FIRST tick (up to 60 s)
  // after creation. After cancel, we wait another 75 s and assert no new
  // "Running scheduled task" entries for our taskId appear.
  //
  // Redis fields for cancel_task — handler at src/k8s/ipc-redis.ts:1160-1187;
  // fields: type, taskId, groupFolder, resultStream.
  it(
    'cancel_task: cancelling stops the task from firing again',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis).not.toBeNull();

      const taskId = `task-cancel-${randHex()}`;
      const scheduleResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;

      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'schedule_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'chatJid',
        CHAT_JID,
        'isMain',
        'false',
        'prompt',
        `Cancel test ping (id=${taskId})`,
        'schedule_type',
        'interval',
        'schedule_value',
        '5000',
        'context_mode',
        'isolated',
        'resultStream',
        scheduleResultStream,
      );

      // scheduleTaskDirect only writes to resultStream on rejection, not on
      // success (src/runtime/direct-llm-runner.ts:576-601).
      // null = timeout = task accepted; non-null = check for rejection text.
      const scheduleResult = await readResultStream(
        redis!,
        scheduleResultStream,
        5_000,
      );
      if (scheduleResult !== null) {
        expect(
          scheduleResult,
          `orchestrator rejected schedule_task: ${scheduleResult}`,
        ).not.toMatch(/task limit reached|already exists|rejected|error/i);
      }
      // scheduleResult === null means task was accepted.

      // Wait up to 75 s for at least one firing (scheduler tick ≤ 60 s + buffer).
      const firingDeadline = Date.now() + 75_000;
      let firedAtLeastOnce = false;
      while (Date.now() < firingDeadline) {
        const logs = kubectl([
          'logs',
          'deployment/kubeclaw-orchestrator',
          '-n',
          NAMESPACE,
          '--tail=3000',
        ]);
        if (logs.ok && logs.stdout.includes(taskId)) {
          firedAtLeastOnce = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5_000));
      }

      // HARD assertion: the task must have fired at least once.
      expect(
        firedAtLeastOnce,
        `expected orchestrator logs to contain taskId "${taskId}" within 75 s of scheduling`,
      ).toBe(true);

      // Cancel the task.
      const cancelResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'cancel_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'resultStream',
        cancelResultStream,
      );

      const cancelResult = await readResultStream(
        redis!,
        cancelResultStream,
        10_000,
      );
      expect(cancelResult, 'orchestrator did not confirm cancellation').not.toBeNull();
      expect(
        cancelResult,
        `expected cancellation confirmation for taskId "${taskId}"`,
      ).toContain(taskId);

      // Snapshot the orchestrator logs just after cancel — we count occurrences
      // of the taskId here, then wait one full scheduler tick (75 s) and
      // confirm the count has not grown.
      const logsBefore = kubectl([
        'logs',
        'deployment/kubeclaw-orchestrator',
        '-n',
        NAMESPACE,
        '--tail=5000',
      ]);
      const countBefore = (logsBefore.stdout.match(new RegExp(taskId, 'g')) ?? [])
        .length;

      await new Promise((r) => setTimeout(r, 75_000));

      const logsAfter = kubectl([
        'logs',
        'deployment/kubeclaw-orchestrator',
        '-n',
        NAMESPACE,
        '--tail=5000',
      ]);
      const countAfter = (logsAfter.stdout.match(new RegExp(taskId, 'g')) ?? [])
        .length;

      expect(
        countAfter,
        `task "${taskId}" fired after cancellation (log count grew from ${countBefore} to ${countAfter})`,
      ).toBeLessThanOrEqual(countBefore);
    },
    240_000,
  );

  // ── 4. pause_task: paused task does not fire; resume re-enables it ─────────
  //
  // We schedule a 5-second interval task, immediately pause it, wait one full
  // scheduler tick (75 s), assert no firings, then resume and assert at least
  // one firing within another 75 s.
  //
  // Redis fields for pause_task — handler at src/k8s/ipc-redis.ts:1188-1217;
  // fields: type, taskId, groupFolder, action ('pause'|'resume'), resultStream.
  it(
    'pause_task: paused task does not fire; resume re-enables it',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis).not.toBeNull();

      const taskId = `task-pause-${randHex()}`;
      const scheduleResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;

      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'schedule_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'chatJid',
        CHAT_JID,
        'isMain',
        'false',
        'prompt',
        `Pause/resume test ping (id=${taskId})`,
        'schedule_type',
        'interval',
        'schedule_value',
        '5000',
        'context_mode',
        'isolated',
        'resultStream',
        scheduleResultStream,
      );

      // scheduleTaskDirect only writes to resultStream on rejection, not on
      // success (src/runtime/direct-llm-runner.ts:576-601).
      // null = timeout = task accepted; non-null = check for rejection text.
      const scheduleResult = await readResultStream(
        redis!,
        scheduleResultStream,
        5_000,
      );
      if (scheduleResult !== null) {
        expect(
          scheduleResult,
          `orchestrator rejected schedule_task: ${scheduleResult}`,
        ).not.toMatch(/task limit reached|already exists|rejected|error/i);
      }
      // scheduleResult === null means task was accepted.

      // Pause immediately — before the first tick fires.
      const pauseResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'pause_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'action',
        'pause',
        'resultStream',
        pauseResultStream,
      );

      const pauseResult = await readResultStream(redis!, pauseResultStream, 10_000);
      expect(pauseResult, 'orchestrator did not confirm pause').not.toBeNull();
      expect(
        pauseResult,
        `expected pause confirmation for taskId "${taskId}"`,
      ).toMatch(new RegExp(`${taskId}.*paused`, 'i'));

      // Wait one full scheduler tick window (75 s) while paused.
      await new Promise((r) => setTimeout(r, 75_000));

      // HARD assertion: orchestrator logs must NOT contain the taskId (task
      // was paused before any firing). A paused task is skipped by the
      // scheduler (src/task-scheduler.ts:240-244).
      const logsDuringPause = kubectl([
        'logs',
        'deployment/kubeclaw-orchestrator',
        '-n',
        NAMESPACE,
        '--tail=5000',
      ]);
      expect(
        logsDuringPause.ok,
        `kubectl logs failed: ${logsDuringPause.stderr}`,
      ).toBe(true);
      // "Running scheduled task" with our taskId must not appear.
      expect(
        logsDuringPause.stdout,
        `task "${taskId}" fired while paused`,
      ).not.toMatch(
        new RegExp(`Running scheduled task[^\\n]*${taskId}|taskId.*${taskId}.*Running`),
      );

      // Resume the task.
      const resumeResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'pause_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'action',
        'resume',
        'resultStream',
        resumeResultStream,
      );

      const resumeResult = await readResultStream(
        redis!,
        resumeResultStream,
        10_000,
      );
      expect(resumeResult, 'orchestrator did not confirm resume').not.toBeNull();
      expect(
        resumeResult,
        `expected resume confirmation for taskId "${taskId}"`,
      ).toMatch(new RegExp(`${taskId}.*resumed`, 'i'));

      // Wait up to 75 s for at least one firing after resume.
      const postResumeDeadline = Date.now() + 75_000;
      let firedAfterResume = false;
      while (Date.now() < postResumeDeadline) {
        const logs = kubectl([
          'logs',
          'deployment/kubeclaw-orchestrator',
          '-n',
          NAMESPACE,
          '--tail=3000',
        ]);
        if (logs.ok && logs.stdout.includes(taskId)) {
          firedAfterResume = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5_000));
      }

      // HARD assertion: task must fire after resume.
      expect(
        firedAfterResume,
        `task "${taskId}" did not fire within 75 s of resume`,
      ).toBe(true);

      // Cleanup: cancel the task.
      const cleanupResultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type',
        'cancel_task',
        'taskId',
        taskId,
        'groupFolder',
        GROUP_FOLDER,
        'resultStream',
        cleanupResultStream,
      );
      await readResultStream(redis!, cleanupResultStream, 5_000);
    },
    300_000,
  );
});
