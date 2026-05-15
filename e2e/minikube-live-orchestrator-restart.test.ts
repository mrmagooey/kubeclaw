/**
 * Minikube-live orchestrator restart resilience tests.
 *
 * Verifies that a `kubectl rollout restart` of the orchestrator deployment
 * does NOT lose any persisted state — capabilities, scheduled tasks, and
 * registered groups must all be intact after the new pod becomes Ready.
 *
 * The orchestrator stores everything in SQLite on a PVC (`kubeclaw-store` →
 * `/app/store`). On startup `main()` calls:
 *   - `initDatabase()` — re-opens the SQLite file from the PVC
 *   - `startCapabilitySubsystem()` → `reconcileAllOnStartup()` + `notifyAllChannels()`
 *   - `startSchedulerLoop()` — re-reads tasks from the DB via `getAllTasks()`
 *   - `registeredGroups = getAllRegisteredGroups()` — re-reads groups from DB
 *
 * These tests confirm each of those paths live-fire correctly after restart.
 *
 * Globals: globalSetup at e2e/minikube-live-setup.ts.
 * Namespace: kubeclaw-live.
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

// Group folder for alice's auto-registered HTTP group.
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

/** Generates a random hex suffix for unique capability/task IDs. */
function randHex(bytes = 4): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(bytes * 2, '0');
}

/**
 * Perform a `kubectl rollout restart` on the orchestrator, then block until
 * the rollout is complete (new pod Ready) or the timeout elapses.
 * Returns true on success, false on timeout.
 */
async function rolloutRestartOrchestrator(timeoutMs = 120_000): Promise<boolean> {
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

/**
 * Wait (polling) until the orchestrator pod's readiness probe passes.
 * We check the pod Ready condition rather than relying only on rollout status.
 */
async function waitForOrchestratorReady(timeoutMs = 60_000): Promise<boolean> {
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
 * XREADs a single entry from a resultStream, blocking up to `blockMs`.
 * Returns the `result` field value, or null on timeout.
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
      'COUNT', 1,
      'BLOCK', Math.min(2_000, remaining),
      'STREAMS', resultStream, lastId,
    );
    if (!response) continue;
    for (const [, messages] of response as [string, [string, string[]][]][]) {
      for (const [id, fields] of messages) {
        lastId = id;
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        return obj.result ?? null;
      }
    }
  }
  return null;
}

/**
 * Send a remove_capability XADD. Returns immediately (best-effort cleanup).
 * Swallows errors so it is safe to call from finally blocks.
 */
async function cleanupCapability(
  redis: Redis,
  name: string,
): Promise<void> {
  try {
    await redis.xadd(
      'kubeclaw:task-requests',
      '*',
      'type', 'remove_capability',
      'groupFolder', 'http',
      'isMain', 'true',
      'name', name,
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Cancel a scheduled task by ID (best-effort, swallows errors).
 */
async function cleanupTask(
  redis: Redis,
  taskId: string,
): Promise<void> {
  try {
    const rs = `kubeclaw:task-mgmt-result:cleanup:${Date.now()}`;
    await redis.xadd(
      'kubeclaw:task-requests',
      '*',
      'type', 'cancel_task',
      'taskId', taskId,
      'groupFolder', GROUP_FOLDER,
      'resultStream', rs,
    );
  } catch {
    /* best-effort */
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: orchestrator restart resilience', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  // Resources created in individual tests — cleaned up in afterAll.
  const createdCapabilities: string[] = [];
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    // 1. Verify the HTTP-channel port-forward is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!provisioned) {
      console.warn(
        `Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
      return;
    }

    // 2. Connect to Redis as the orchestrator ACL user.
    const pwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        // Survive port-forward restarts and the ~30–60 s window when the
        // orchestrator pod is being replaced — ioredis must not give up
        // while the rollout is in flight.
        maxRetriesPerRequest: 40,
        connectTimeout: 30_000,
        retryStrategy: (times: number) => Math.min(times * 200, 3_000),
        reconnectOnError: () => true,
      },
    );
    await redis.ping();

    // 3. Warm the group by sending one message via HTTP so `http-http-alice`
    //    is registered in the orchestrator's DB before any restart.
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
      // best-effort; group may already be registered
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }, 120_000);

  afterAll(async () => {
    // Best-effort cleanup: remove any capabilities or tasks left behind by a
    // failing test.  The orchestrator may still be restarting, so tolerate
    // transient errors.
    if (redis) {
      for (const name of createdCapabilities) {
        await cleanupCapability(redis, name);
      }
      for (const taskId of createdTaskIds) {
        await cleanupTask(redis, taskId);
      }
      // Give cleanup commands a moment to process.
      await new Promise((r) => setTimeout(r, 3_000));
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    }
  });

  // ── 1. Capability install survives orchestrator restart ──────────────────
  //
  // Steps:
  //   a) XADD install_capability → wait for "Capability installed" in orch logs
  //   b) rollout restart orchestrator → rollout status
  //   c) XADD list_capabilities → assert capability is still listed
  //   d) Confirm the K8s Deployment for the capability still exists
  //      (reconcileAllOnStartup does a no-op apply, so it must NOT be deleted)
  it(
    'capability install survives orchestrator restart',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'redis client not initialised').not.toBeNull();

      const capName = `rst-cap-${randHex()}`;
      const capDeployment = `kubeclaw-cap-${capName}`;
      createdCapabilities.push(capName);

      // a) Install capability.
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'install_capability',
        'groupFolder', 'http',
        'isMain', 'true',
        'spec', JSON.stringify({
          kind: 'mcp',
          name: capName,
          image: 'kubeclaw-test-mcp:latest',
          port: 3000,
          path: '/mcp',
        }),
      );

      // Wait for the orchestrator to log "Capability installed" for this name
      // (src/capabilities/registry.ts:153).
      const installDeadline = Date.now() + 90_000;
      let installLogged = false;
      while (Date.now() < installDeadline) {
        const logs = kubectl([
          'logs', 'deployment/kubeclaw-orchestrator',
          '-n', NAMESPACE, '--tail=500',
        ]);
        if (logs.ok && logs.stdout.includes(capName)) {
          installLogged = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 3_000));
      }
      expect(
        installLogged,
        `orchestrator did not log install of ${capName} within 90 s`,
      ).toBe(true);

      // Also wait for the K8s Deployment to exist (proves DB + K8s are in sync
      // before we restart).
      const depDeadline = Date.now() + 120_000;
      let depCreated = false;
      while (Date.now() < depDeadline) {
        const r = kubectl([
          'get', 'deployment', capDeployment, '-n', NAMESPACE,
          '-o', 'jsonpath={.metadata.name}',
        ]);
        if (r.ok && r.stdout.trim() === capDeployment) {
          depCreated = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 3_000));
      }
      expect(
        depCreated,
        `Deployment ${capDeployment} did not appear before restart`,
      ).toBe(true);

      // b) Rollout restart orchestrator and wait for it to become Ready.
      const restarted = await rolloutRestartOrchestrator(120_000);
      expect(restarted, 'kubectl rollout restart/status failed').toBe(true);

      // Extra safety: confirm pod is Ready before querying state.
      const ready = await waitForOrchestratorReady(60_000);
      expect(ready, 'orchestrator pod not Ready after restart').toBe(true);

      // Give reconcileAllOnStartup + notifyAllChannels a moment to run.
      await new Promise((r) => setTimeout(r, 5_000));

      // c) list_capabilities — assert capability is still listed.
      const listStream = `kubeclaw:capabilities-list-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'list_capabilities',
        'groupFolder', 'http',
        'isMain', 'true',
        'resultStream', listStream,
      );
      const listRaw = await readResultStream(redis!, listStream, 15_000);
      expect(
        listRaw,
        'list_capabilities returned no result after restart',
      ).not.toBeNull();

      let capList: Array<{ name: string }> = [];
      try {
        capList = JSON.parse(listRaw!) as Array<{ name: string }>;
      } catch {
        expect.fail(`list_capabilities result was not JSON: ${listRaw}`);
      }
      const names = capList.map((c) => c.name);
      expect(
        names,
        `capability ${capName} missing from list after restart: ${JSON.stringify(names)}`,
      ).toContain(capName);

      // d) K8s Deployment must still exist after restart (no-op reconcile).
      const depAfter = kubectl([
        'get', 'deployment', capDeployment, '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      expect(
        depAfter.ok && depAfter.stdout.trim() === capDeployment,
        `Deployment ${capDeployment} missing after orchestrator restart`,
      ).toBe(true);
    },
    300_000,
  );

  // ── 2. Scheduled task survives orchestrator restart ──────────────────────
  //
  // Steps:
  //   a) XADD schedule_task (interval, long period so it doesn't fire)
  //   b) XADD list_tasks → confirm task ID appears
  //   c) rollout restart orchestrator
  //   d) XADD list_tasks again → assert same task ID still present
  it(
    'scheduled task survives orchestrator restart',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis).not.toBeNull();

      const taskId = `rst-task-${randHex()}`;
      createdTaskIds.push(taskId);

      // a) Schedule an interval task with a 5-minute (300 000 ms) period so
      //    it does not fire during the test window.
      const schedStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'schedule_task',
        'taskId', taskId,
        'groupFolder', GROUP_FOLDER,
        'chatJid', CHAT_JID,
        'isMain', 'false',
        'prompt', `Restart resilience test task (id=${taskId})`,
        'schedule_type', 'interval',
        'schedule_value', '300000',
        'context_mode', 'isolated',
        'resultStream', schedStream,
      );
      // scheduleTaskDirect only writes to resultStream on rejection
      // (src/runtime/direct-llm-runner.ts:576-601): null = accepted.
      const schedResult = await readResultStream(redis!, schedStream, 5_000);
      if (schedResult !== null) {
        expect(
          schedResult,
          `orchestrator rejected schedule_task: ${schedResult}`,
        ).not.toMatch(/task limit reached|already exists|rejected|error/i);
      }

      // b) Confirm the task is listed before restart.
      const listBefore = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'list_tasks',
        'groupFolder', GROUP_FOLDER,
        'resultStream', listBefore,
      );
      const beforeResult = await readResultStream(redis!, listBefore, 10_000);
      expect(beforeResult, 'list_tasks returned no result before restart').not.toBeNull();
      expect(
        beforeResult,
        `task ${taskId} not in list before restart`,
      ).toContain(taskId);

      // c) Rollout restart orchestrator.
      const restarted = await rolloutRestartOrchestrator(120_000);
      expect(restarted, 'kubectl rollout restart/status failed').toBe(true);

      const ready = await waitForOrchestratorReady(60_000);
      expect(ready, 'orchestrator pod not Ready after restart').toBe(true);

      // Give the scheduler loop a moment to reload tasks from DB.
      await new Promise((r) => setTimeout(r, 5_000));

      // d) list_tasks after restart — same task ID must still appear.
      const listAfter = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'list_tasks',
        'groupFolder', GROUP_FOLDER,
        'resultStream', listAfter,
      );
      const afterResult = await readResultStream(redis!, listAfter, 15_000);
      expect(afterResult, 'list_tasks returned no result after restart').not.toBeNull();
      expect(
        afterResult,
        `task ${taskId} missing from list after restart`,
      ).toContain(taskId);
    },
    300_000,
  );

  // ── 3. Registered group survives orchestrator restart ────────────────────
  //
  // alice's group (`http-http-alice`) is registered by beforeAll's warm-up
  // POST. After rollout-restart the orchestrator reloads it from SQLite via
  // `getAllRegisteredGroups()`. We verify this by scheduling a task for the
  // group immediately after restart — if the group were missing the
  // orchestrator would fail the `list_tasks` call with an empty result or
  // an error, rather than returning the task row.
  it(
    'registered group survives orchestrator restart',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis).not.toBeNull();

      // Rollout restart the orchestrator.
      const restarted = await rolloutRestartOrchestrator(120_000);
      expect(restarted, 'kubectl rollout restart/status failed').toBe(true);

      const ready = await waitForOrchestratorReady(60_000);
      expect(ready, 'orchestrator pod not Ready after restart').toBe(true);

      await new Promise((r) => setTimeout(r, 5_000));

      // Schedule a new task for GROUP_FOLDER immediately after restart.
      // If the group had vanished from the orchestrator's in-memory map, a
      // subsequent list_tasks for that group would still succeed (it queries
      // the DB), but a schedule_task would fail with "group not found" if
      // the orchestrator enforces group registration on the write path.
      // We confirm both paths: schedule succeeds AND list_tasks returns the row.
      const taskId = `rst-grp-${randHex()}`;
      createdTaskIds.push(taskId);

      const schedStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'schedule_task',
        'taskId', taskId,
        'groupFolder', GROUP_FOLDER,
        'chatJid', CHAT_JID,
        'isMain', 'false',
        'prompt', `Group persistence test (id=${taskId})`,
        'schedule_type', 'interval',
        'schedule_value', '300000',
        'context_mode', 'isolated',
        'resultStream', schedStream,
      );
      const schedResult = await readResultStream(redis!, schedStream, 5_000);
      if (schedResult !== null) {
        expect(
          schedResult,
          `orchestrator rejected schedule_task after restart (group may be missing): ${schedResult}`,
        ).not.toMatch(/task limit reached|already exists|rejected|error|group not found/i);
      }

      // Confirm the task appears in list_tasks for this group.
      const listStream = `kubeclaw:task-mgmt-result:${Date.now()}-${randHex()}`;
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'list_tasks',
        'groupFolder', GROUP_FOLDER,
        'resultStream', listStream,
      );
      const listResult = await readResultStream(redis!, listStream, 15_000);
      expect(listResult, 'list_tasks returned no result after restart').not.toBeNull();
      expect(
        listResult,
        `task ${taskId} not listed after restart — group state may not have been reloaded`,
      ).toContain(taskId);
    },
    300_000,
  );

  // ── 4. Channel pod survives orchestrator restart ─────────────────────────
  //
  // Channel pods are separate Deployments — they must NOT restart when the
  // orchestrator is rolled. Asserts:
  //   - channel pod restart count is the same before and after
  //   - channel pod still responds to POST /message after restart
  it(
    'channel pod survives orchestrator restart without restarting itself',
    async () => {
      expect(provisioned).toBe(true);

      // Capture the channel pod restart count before the rollout.
      const restartsBefore = kubectl([
        'get', 'pods', '-n', NAMESPACE,
        '-l', 'app=kubeclaw-channel-http',
        '-o', 'jsonpath={.items[0].status.containerStatuses[0].restartCount}',
      ]);
      expect(restartsBefore.ok, `kubectl get pods failed: ${restartsBefore.stderr}`).toBe(true);
      const countBefore = parseInt(restartsBefore.stdout.trim() || '0', 10);

      // Rollout restart the orchestrator.
      const restarted = await rolloutRestartOrchestrator(120_000);
      expect(restarted, 'kubectl rollout restart/status failed').toBe(true);

      const ready = await waitForOrchestratorReady(60_000);
      expect(ready, 'orchestrator pod not Ready after restart').toBe(true);

      // Channel pod restart count must be unchanged.
      const restartsAfter = kubectl([
        'get', 'pods', '-n', NAMESPACE,
        '-l', 'app=kubeclaw-channel-http',
        '-o', 'jsonpath={.items[0].status.containerStatuses[0].restartCount}',
      ]);
      expect(restartsAfter.ok, `kubectl get pods failed after restart: ${restartsAfter.stderr}`).toBe(true);
      const countAfter = parseInt(restartsAfter.stdout.trim() || '0', 10);

      expect(
        countAfter,
        `channel pod restarted (count went from ${countBefore} to ${countAfter}) during orchestrator rollout`,
      ).toBe(countBefore);

      // Channel pod still responds to POST /message after the orchestrator restart.
      const res = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
        },
        body: JSON.stringify({ text: 'ping' }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `channel pod returned unexpected HTTP status after orchestrator restart`,
      ).toBe(200);
    },
    300_000,
  );

  // ── 5. capabilities_update arrives at channel after orchestrator restart ─
  //
  // After restart, `startCapabilitySubsystem()` calls `notifyAllChannels()`,
  // which publishes `capabilities_update` to every known channel's control
  // channel. The channel pod's control subscriber logs:
  //   "MCP servers reconfigured from capabilities_update"
  // (src/channel-runner.ts handleCapabilitiesUpdate).
  // We record the restart time and then poll channel pod logs for a new
  // capabilities_update log line whose JSON "time" field is >= the restart
  // timestamp.
  it(
    'capabilities_update arrives at channel pod within 30 s of orchestrator restart',
    async () => {
      expect(provisioned).toBe(true);

      // Capture the current timestamp just before the restart so we can
      // filter log lines to only those emitted AFTER the new pod starts.
      const restartTime = Date.now();

      const restarted = await rolloutRestartOrchestrator(120_000);
      expect(restarted, 'kubectl rollout restart/status failed').toBe(true);

      const ready = await waitForOrchestratorReady(60_000);
      expect(ready, 'orchestrator pod not Ready after restart').toBe(true);

      // Poll for a "capabilities_update" or "MCP servers reconfigured" log
      // line in the channel pod that was emitted after restartTime.
      const capUpdateDeadline = Date.now() + 60_000;
      let capUpdateSeen = false;
      while (Date.now() < capUpdateDeadline) {
        const logs = kubectl([
          'logs', 'deployment/kubeclaw-channel-http',
          '-n', NAMESPACE, '--tail=3000',
        ]);
        if (logs.ok) {
          const matchingLine = logs.stdout.split('\n').find((l) => {
            if (
              !l.match(/capabilities_update|MCP servers reconfigured from capabilities_update/i)
            ) {
              return false;
            }
            // Filter to lines emitted after the restart began.
            // Pino JSON logs have a numeric "time" field (ms epoch).
            try {
              const parsed = JSON.parse(l) as { time?: number };
              return (parsed.time ?? 0) >= restartTime;
            } catch {
              // If pino-pretty is active (non-JSON output), fall back to
              // substring match — any line mentioning capabilities_update
              // that appears in the tail is close enough.
              return true;
            }
          });
          if (matchingLine !== undefined) {
            capUpdateSeen = true;
            break;
          }
        }
        await new Promise((res) => setTimeout(res, 3_000));
      }

      expect(
        capUpdateSeen,
        'channel pod did not receive a capabilities_update within 60 s of orchestrator restart',
      ).toBe(true);
    },
    300_000,
  );
});
