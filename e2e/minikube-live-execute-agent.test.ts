/**
 * Minikube-live e2e: Story 170 — execute_agent spawns a nested pi-agent-core sub-agent.
 *
 * The globalSetup at e2e/minikube-live-setup.ts has helm-installed kubeclaw
 * into namespace `kubeclaw-live` and port-forwarded:
 *   svc/kubeclaw-channel-http → localhost:14081
 *   svc/kubeclaw-redis        → localhost:16381
 *
 * Background — what execute_agent does
 * ──────────────────────────────────────
 * execute_agent is the only tool that escalates from a tool pod to a full K8s Job.
 * The flow:
 *   1. DirectLLMRunner.executeToolJob() publishes to kubeclaw:spawn-agent-job.
 *   2. The orchestrator's ipc-redis.ts watcher picks it up, calls
 *      jobRunner.runToolJob(), and creates a kubeclaw-agent Job.
 *   3. The agent-runner pod (container/agent-runner/) uses pi-agent-core and
 *      fans out its own tool calls over kubeclaw:toolcalls:<jobId>:execution.
 *   4. On completion the agent pod writes to kubeclaw:agent-job-result:<jobId>.
 *   5. DirectLLMRunner unblocks from xread and feeds the result to the outer LLM.
 *
 * Test strategy
 * ─────────────
 * This test uses the Redis bypass (same pattern as minikube-live-tool-pods.test.ts
 * sub-test 2) to avoid dependency on the outer LLM picking execute_agent reliably.
 * The bypass writes directly to kubeclaw:spawn-agent-job, then asserts:
 *   - A kubeclaw-agent Job and Pod appear within 240 s (AC2 proxy).
 *   - The job-result stream receives a non-empty entry within 300 s (AC5 proxy).
 *
 * An additional LLM-driven sub-test (informational) fires the directive prompt
 * through the HTTP channel to exercise the full outer-LLM → tool-dispatch path
 * for AC1, but only asserts on HTTP 200 (not the K8s Job or SSE content, which
 * are non-deterministic for large tasks on small models). The directive uses a
 * simple echo task so the agent converges quickly.
 *
 * Hard assertions:
 *   - kubeclaw-agent K8s Job appears within 240 s after spawn request.
 *   - The agent-job-result stream receives a non-empty entry within 300 s.
 *
 * Informational:
 *   - SSE reply from the LLM-driven path (AC5) — console.log only.
 *   - Whether the result contains any task summary text.
 *
 * ACs not fully coverable:
 *   AC1 (outer LLM emits execute_agent call) — covered informally via the
 *       directive sub-test. Small models may pick bash instead; the Redis
 *       bypass sub-test gives deterministic coverage of the dispatch path.
 *   AC2 (three pods: agent-runner + execution sidekick + optional browser) —
 *       the execution sidekick only appears if the agent invokes bash. The echo
 *       task used here may not trigger it. The comment in user_stories.md notes
 *       "assert its presence only if any kubeclaw:toolcalls:<jobId>:execution
 *       record was written". We assert the main agent Job; the sidekick assertion
 *       is informational.
 *   AC3 (Redis stream introspection for bash calls) — inspected via redis.xlen;
 *       only asserted informally because the echo task may complete without bash.
 *   AC4 (PVC effects after job — type annotations in /data/util.py) — requires
 *       seeding /data/util.py via filesystem MCP (not deployed in default helm
 *       values) and a real coding task; out-of-scope for this test.
 *   AC5 (Prometheus histogram) — requires a metrics port-forward not set up
 *       by the global setup; out-of-scope.
 *
 * Run: npm run test:minikube-live -- minikube-live-execute-agent
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
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function postMessage(
  text: string,
  user = KUBECLAW_LIVE_USER,
  pass = KUBECLAW_LIVE_PASS,
): Promise<Response> {
  return fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user, pass),
    },
    body: JSON.stringify({ text }),
  });
}

/**
 * Poll kubectl for a K8s Job matching `labelSelector` created at or after `sinceMs`.
 * Returns the job name or null on timeout.
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
      const jobLines = r.stdout.trim().split('\n').reverse();
      for (const jobLine of jobLines) {
        const [name, ts] = jobLine.split('\t');
        if (!name || !ts) continue;
        if (Date.parse(ts) + 2000 >= sinceMs) return name;
      }
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  return null;
}

/**
 * Poll a Redis stream for any entry. Returns the last entry's field map or throws on timeout.
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
      } catch { /* stream may not exist yet */ }
      if (Date.now() >= deadline) {
        return reject(new Error(`Timed out waiting for job result on ${stream}`));
      }
      setTimeout(check, 4000);
    };
    void check();
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: Story 170 — execute_agent spawns nested pi-agent-core sub-agent', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Verify the HTTP channel port-forward is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, { signal: AbortSignal.timeout(2000) });
        if (res.status > 0) { provisioned = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(`Port-forward to ${HTTP_URL} not reachable — globalSetup may have failed.`);
      return;
    }

    // 2. Connect to Redis using the orchestrator ACL password from the Secret.
    const pwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`Failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
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
      try { await redis.quit(); } catch { /* ignore */ }
    }
  });

  // ── 1. Redis bypass: spawn-agent-job → kubeclaw-agent K8s Job → result ──────
  //
  // This is the primary, deterministic assertion for AC2 and AC5.
  // It bypasses the outer LLM so the test does not depend on small-model
  // tool-selection reliability.

  it(
    'execute_agent Redis bypass → kubeclaw-agent Job spawned and result returned (Story 170 AC2/AC5)',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `direct-test-agent-170-${Date.now()}-${rand}`;

      // Result stream key: kubeclaw:agent-job-result:<agentJobId>
      // (src/k8s/redis-client.ts: getToolJobResultStream)
      const resultStream = `kubeclaw:agent-job-result:${agentJobId}`;

      const testStartMs = Date.now();

      // XADD to the spawn-agent-job stream.
      // Fields mirror executeToolJob() in src/runtime/direct-llm-runner.ts:524-546.
      // Stream key: getSpawnToolJobStream() = 'kubeclaw:spawn-agent-job'
      //
      // We use a minimal prompt ("Echo the word: done") so the agent-runner
      // converges quickly even on small/quantised models, and we don't need
      // to pre-seed any PVC files.
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

      console.log(`Waiting for kubeclaw-agent Job (agentJobId=${agentJobId})...`);

      // AC2 proxy: a K8s Job with app=kubeclaw-agent must appear within 240 s.
      // Label layout (src/k8s/job-runner.ts):
      //   Job metadata: { app: 'kubeclaw-agent', 'kubeclaw/group': groupFolder }
      //   Pod template: { app: 'kubeclaw-agent' }
      // Include kubeclaw/group= to avoid collisions with concurrent tests.
      const jobSelector = 'app=kubeclaw-agent,kubeclaw/group=http-http-alice';
      const jobName = await waitForJob(jobSelector, 240_000, testStartMs);
      expect(
        jobName,
        `No kubeclaw-agent Job with selector "${jobSelector}" appeared within 240 s (Story 170 AC2)`,
      ).not.toBeNull();
      console.log(`kubeclaw-agent Job appeared: ${jobName}`);

      // AC2 proxy: verify the Job's pod exists with app=kubeclaw-agent.
      // (The agent pod template label matches the Job selector.)
      const podCheck = kubectl([
        'get', 'pods', '-n', NAMESPACE,
        '-l', `app=kubeclaw-agent,kubeclaw/group=http-http-alice`,
        '--sort-by=.metadata.creationTimestamp',
        '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ]);
      console.log(
        `kubeclaw-agent pods: ${podCheck.stdout.trim() || '(none yet — may be Pending)'}`,
      );

      // AC3 (informational): check whether the execution toolcalls stream has entries.
      // The agent may or may not use bash for the "echo" prompt.
      const executionCallsStream = `kubeclaw:toolcalls:${agentJobId}:execution`;
      try {
        const execLen = await redis!.xlen(executionCallsStream);
        console.log(
          `execute_agent (Story 170): execution toolcalls stream length=${execLen} ` +
          `(0 = agent chose a pure-LLM path; ≥1 = bash/execution tool used)`,
        );
      } catch {
        console.log(`execute_agent (Story 170): execution toolcalls stream not yet created`);
      }

      // AC5 proxy: result stream must receive a non-empty entry within 300 s.
      // The orchestrator writes to kubeclaw:agent-job-result:<agentJobId> on
      // job completion (src/k8s/ipc-redis.ts startToolJobSpawnWatcher).
      const result = await pollJobResult(redis!, resultStream, 300_000);
      const resultText = result.result ?? '';
      // Use expect.soft so partial success is still visible in the report.
      expect.soft(
        resultText,
        'agent-job result field must be non-empty (Story 170 AC5)',
      ).toBeTruthy();
      console.log(`execute_agent result (first 200 chars): ${resultText.slice(0, 200)}`);
    },
    // Total budget: 240 s Job wait + 300 s result wait + headroom.
    600_000,
  );

  // ── 2. LLM-driven: directive prompt → execute_agent tool call (AC1 proxy) ───
  //
  // This sub-test fires through the full HTTP channel / LLM / tool-dispatch path.
  // Only POST /message returning 200 is a hard assertion; the K8s Job and SSE
  // content are informational because small models may not pick execute_agent.
  //
  // The prompt uses explicit tool-name naming to maximise the chance of success,
  // but we accept that the small model (Gemma-4-E4B-Q4) may pick bash instead.

  it(
    'execute_agent LLM-directive → POST /message returns 200 (Story 170 AC1 proxy)',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Open SSE before posting.
      const controller = new AbortController();
      const sseLines: string[] = [];
      let sseDelivered = false;

      const ssePromise = (async () => {
        try {
          const sseRes = await fetch(`${HTTP_URL}/stream`, {
            headers: { Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS) },
            signal: controller.signal,
          });
          if (!sseRes.ok || !sseRes.body) return;
          const reader = sseRes.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (line.startsWith('data: ')) sseLines.push(line.slice(6));
            }
          }
        } catch {
          // aborted or disconnected
        }
      })();

      try {
        // Directive prompt: name execute_agent explicitly so the LLM picks it.
        // The task is intentionally trivial so the agent converges quickly.
        const res = await postMessage(
          'You MUST call the execute_agent tool with task="Echo the phrase: execute_agent_e2e_ok". ' +
          'Do not call any other tool. Do not respond with text — only call execute_agent right now.',
        );

        // Hard assertion: the channel pod must accept the POST.
        expect(res.status, 'POST /message returned unexpected status (Story 170 AC1)').toBe(200);

        // Informational: wait up to 60 s for SSE data.
        const sseDeadline = Date.now() + 60_000;
        while (Date.now() < sseDeadline && sseLines.length === 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
        sseDelivered = sseLines.length > 0;

        const sseHasExecuteAgent = sseLines.some((l) =>
          /execute.?agent|e2e_ok|execute_agent_e2e_ok/i.test(l),
        );
        console.log(
          `execute_agent (LLM-driven, Story 170 AC1): SSE delivered=${sseDelivered}, ` +
          `SSE contains task indicator=${sseHasExecuteAgent}`,
        );
        if (!sseDelivered) {
          console.warn(
            'execute_agent (LLM-driven): SSE stream delivered no data within 60 s. ' +
            'Small model may not have responded yet — informational only.',
          );
        }
      } finally {
        controller.abort();
        await ssePromise.catch(() => {});
      }
    },
    // Shorter budget for the LLM-driven test — we don't wait for the full agent loop.
    180_000,
  );
});
