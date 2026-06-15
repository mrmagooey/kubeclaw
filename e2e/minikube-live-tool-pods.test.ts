/**
 * Minikube-live tool-pod end-to-end tests.
 *
 * Validates that the orchestrator correctly spawns tool pods for:
 *   1. The `execution` category (`bash` tool) via the spawn-tool-pod Redis stream.
 *   2. Full agent jobs (`execute_agent`) via the spawn-agent-job Redis stream.
 *
 * Both tests BYPASS the LLM by writing tool-call streams directly — the same
 * pattern used in e2e/alpine-tool-execution.test.ts. This avoids Gemma-4-E4B's
 * unreliable tool-calling path while still exercising the full orchestrator
 * → K8s → Redis IPC infrastructure.
 *
 * Stream key conventions (src/k8s/redis-client.ts):
 *   getToolCallsStream(agentJobId, category)    → kubeclaw:toolcalls:<id>:<cat>
 *   getToolResultsStream(agentJobId, category)  → kubeclaw:toolresults:<id>:<cat>
 *   getSpawnToolPodStream()                     → kubeclaw:spawn-tool-pod
 *   getSpawnToolJobStream()                     → kubeclaw:spawn-agent-job
 *   getToolJobResultStream(jobId)               → kubeclaw:agent-job-result:<jobId>
 *
 * Tool-pod labels (src/k8s/job-runner.ts — createSidecarToolPodJob):
 *   Job metadata: app=kubeclaw-sidecar-tool, kubeclaw/category=<category>, kubeclaw/group, kubeclaw/agent-job
 *   Pod template:  app=kubeclaw-sidecar-tool  ← kubeclaw/category and kubeclaw/agent-job are NOT on the pod template
 *
 * Tool-job labels (src/k8s/job-runner.ts:167, 789-801):
 *   Job metadata: app=kubeclaw-agent, kubeclaw/group=<groupFolder>, kubeclaw/chat-jid=<sanitised>
 *   Pod template: app=kubeclaw-agent
 *
 * Catalog category routing (src/runtime/direct-llm-runner.ts):
 *   bash → execution
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

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
 * Poll kubectl for a pod matching `labelSelector` that was created at or after
 * `sinceMs` (with 2 s clock-skew slop). Returns the pod name or null on timeout.
 *
 * Copied from minikube-live-browser.test.ts — inlined per task instructions.
 */
async function waitForToolPod(
  labelSelector: string,
  timeoutMs: number,
  sinceMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', labelSelector,
      '--sort-by=.metadata.creationTimestamp',
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.creationTimestamp}{"\\n"}{end}',
    ]);
    if (r.ok && r.stdout.trim()) {
      const lines = r.stdout.trim().split('\n').reverse(); // newest first
      for (const line of lines) {
        const [name, ts] = line.split('\t');
        if (!name || !ts) continue;
        if (Date.parse(ts) + 2000 >= sinceMs) {
          return name;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

/**
 * Poll kubectl for a K8s Job matching `labelSelector` that was created at or
 * after `sinceMs`. Returns the job name or null on timeout.
 */
async function waitForJob(
  labelSelector: string,
  timeoutMs: number,
  sinceMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'jobs', '-n', NAMESPACE, '-l', labelSelector,
      '--sort-by=.metadata.creationTimestamp',
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.creationTimestamp}{"\\n"}{end}',
    ]);
    if (r.ok && r.stdout.trim()) {
      const lines = r.stdout.trim().split('\n').reverse(); // newest first
      for (const line of lines) {
        const [name, ts] = line.split('\t');
        if (!name || !ts) continue;
        if (Date.parse(ts) + 2000 >= sinceMs) {
          return name;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}

/**
 * Poll a Redis stream for an entry matching `requestId` (field name
 * "requestId"). Returns the parsed field map or throws on timeout.
 */
async function pollToolResult(
  redis: Redis,
  stream: string,
  requestId: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const entries = await redis.xrange(stream, '-', '+');
        for (const [, fields] of entries) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          if (obj.requestId === requestId) return resolve(obj);
        }
      } catch {
        // stream may not exist yet
      }
      if (Date.now() >= deadline) {
        return reject(
          new Error(`Timed out waiting for tool result on ${stream} (requestId=${requestId})`),
        );
      }
      setTimeout(check, 2000);
    };
    void check();
  });
}

/**
 * Poll a Redis stream for any entry after `lastId`. Returns the first field map
 * found or throws on timeout.
 */
async function pollJobResult(
  redis: Redis,
  stream: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const entries = await redis.xrange(stream, '-', '+');
        if (entries.length > 0) {
          const [, fields] = entries[entries.length - 1];
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          return resolve(obj);
        }
      } catch {
        // stream may not exist yet
      }
      if (Date.now() >= deadline) {
        return reject(
          new Error(`Timed out waiting for job result on ${stream}`),
        );
      }
      setTimeout(check, 4000);
    };
    void check();
  });
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Minikube-live: tool pod and tool job spawning via Redis IPC (direct bypass)', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Sanity check: the HTTP channel port-forward must be live.
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

    // 2. Connect to Redis using the orchestrator ACL password from the secret
    //    (same pattern as minikube-live-capabilities.test.ts beforeAll).
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

  // ── 1. bash → execution-category tool pod spawn via Redis IPC ────────────

  it(
    'execution-category tool pod spawn via Redis IPC (bash)',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `direct-test-bash-${Date.now()}-${rand}`;
      const requestId = `${agentJobId}-req`;
      const category = 'execution';

      // Stream keys — kubeclaw:toolcalls:<agentJobId>:execution
      //              kubeclaw:toolresults:<agentJobId>:execution
      // (src/k8s/redis-client.ts:118-130)
      const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const toolResultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      // Brief pause so the spawn watcher has settled past its initial startup.
      await new Promise((r) => setTimeout(r, 1000));

      // Write the tool call BEFORE spawning the pod so the tool server picks it
      // up with lastId='0-0' (same ordering rule as alpine-tool-execution.test.ts).
      await redis!.xadd(
        toolCallsStream,
        '*',
        'requestId', requestId,
        'tool', 'bash',
        'input', JSON.stringify({ command: 'echo kubeclaw-bash-e2e-marker' }),
      );

      const testStartMs = Date.now();

      // Spawn the tool pod via the orchestrator's spawn-tool-pod stream.
      // Stream key: kubeclaw:spawn-tool-pod (src/k8s/redis-client.ts:132-134)
      await redis!.xadd(
        'kubeclaw:spawn-tool-pod',
        '*',
        'agentJobId', agentJobId,
        'groupFolder', 'http-http-alice',
        'category', category,
        'timeout', '120000',
        'channel', 'http',
      );

      console.log(`Waiting for execution tool pod (agentJobId=${agentJobId})...`);

      // Hard assertion: a pod with the expected label must appear within 90 s.
      //
      // Label layout (job-runner.ts — createSidecarToolPodJob):
      //   Job metadata labels: app=kubeclaw-sidecar-tool, kubeclaw/category, kubeclaw/group,
      //                        kubeclaw/agent-job
      //   Pod TEMPLATE labels: app=kubeclaw-sidecar-tool
      //
      // kubeclaw/agent-job is on the Job metadata only, not propagated to the pod
      // template. kubectl get pods -l with a compound selector including
      // kubeclaw/agent-job will never match. Use app=kubeclaw-sidecar-tool alone
      // and rely on the sinceMs timestamp filter to exclude pods from prior tests.
      const podSelector = 'app=kubeclaw-sidecar-tool';
      const podName = await waitForToolPod(podSelector, 90_000, testStartMs);
      expect(
        podName,
        `No tool pod with selector "${podSelector}" appeared within 90 s`,
      ).not.toBeNull();
      console.log(`Tool pod appeared: ${podName}`);

      // Hard assertion: result stream entry must contain the marker string.
      const result = await pollToolResult(redis!, toolResultsStream, requestId, 60_000);

      expect(
        result.requestId,
        'result entry missing requestId field',
      ).toBe(requestId);

      const resultText = result.result ?? '';
      expect(
        resultText,
        'result field must be non-empty',
      ).toBeTruthy();
      expect(
        resultText,
        'bash output must contain kubeclaw-bash-e2e-marker',
      ).toContain('kubeclaw-bash-e2e-marker');

      console.log(`Tool pod result: ${resultText.trim()}`);
    },
    180_000,
  );

  // ── 2. execute_agent full tool-job spawn via Redis IPC ───────────────────

  it(
    'execute_agent full tool-job spawn via Redis IPC',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `direct-test-agent-${Date.now()}-${rand}`;

      // Result stream key: kubeclaw:agent-job-result:<agentJobId>
      // (src/k8s/redis-client.ts:140-142)
      const resultStream = `kubeclaw:agent-job-result:${agentJobId}`;

      const testStartMs = Date.now();

      // XADD to the spawn-agent-job stream (getSpawnToolJobStream() value:
      // 'kubeclaw:spawn-agent-job', src/k8s/redis-client.ts:136-138).
      // Fields mirror executeToolJob() in src/runtime/direct-llm-runner.ts:454-468.
      await redis!.xadd(
        'kubeclaw:spawn-agent-job',
        '*',
        'agentJobId', agentJobId,
        'groupFolder', 'http-http-alice',
        'chatJid', 'http:alice',
        'prompt', 'Echo the word: done',
        'timeout', '300000',
        'channel', 'http',
      );

      console.log(`Waiting for tool job (agentJobId=${agentJobId})...`);

      // Hard assertion: a K8s Job with the expected labels must appear.
      // Label layout (job-runner.ts:167, 789-801):
      //   Job metadata: { app: 'kubeclaw-agent', 'kubeclaw/group': groupFolder,
      //                   'kubeclaw/chat-jid': chatJid-sanitised }
      //   Pod template: { app: 'kubeclaw-agent' }
      // Include kubeclaw/group= to avoid matching concurrent tests' jobs that
      // also carry app=kubeclaw-agent.  groupFolder is 'http-http-alice',
      // which the orchestrator copies verbatim into the kubeclaw/group label
      // (job-runner.ts:791).
      const jobSelector = 'app=kubeclaw-agent,kubeclaw/group=http-http-alice';
      const jobName = await waitForJob(jobSelector, 240_000, testStartMs);
      expect(
        jobName,
        `No K8s Job with selector "${jobSelector}" appeared within 240 s`,
      ).not.toBeNull();
      console.log(`Tool job appeared: ${jobName}`);

      // Hard assertion: result stream must receive an entry.
      // The orchestrator writes to kubeclaw:agent-job-result:<agentJobId> on
      // completion (src/k8s/ipc-redis.ts startToolJobSpawnWatcher, after
      // jobRunner.runToolJob resolves — mirrors direct-llm-runner.ts:487-496).
      const result = await pollJobResult(redis!, resultStream, 240_000);

      const resultText = result.result ?? '';
      // The small LLM (Gemma-4-E4B) may produce unexpected text but the
      // infrastructure path must complete with a non-empty result or error string.
      expect.soft(
        resultText,
        'job result field must be non-empty',
      ).toBeTruthy();

      console.log(`Tool job result (first 200 chars): ${resultText.slice(0, 200)}`);

      // Tool jobs have backoffLimit=0 and TTL — self-cleaning, no explicit teardown needed.
      // (src/k8s/job-runner.ts:798, ttlSecondsAfterFinished on all job specs)
    },
    360_000,
  );
});
