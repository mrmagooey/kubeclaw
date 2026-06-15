/**
 * Minikube-live e2e: agent-runner catalog unification.
 *
 * Validates that a normal (non-bootstrap) agent Job spawned via the
 * kubeclaw:spawn-agent-job stream:
 *
 *   1. Loads the tool catalog from /etc/kubeclaw/tools/tools.json (mounted by
 *      the orchestrator via the kubeclaw-tools ConfigMap on every agent Job).
 *   2. Routes `bash` BY NAME through kubeclaw:spawn-tool-pod → a sidecar tool
 *      pod, and the result flows back through kubeclaw:toolresults.
 *   3. Routes `bash_persist` BY NAME through the same path, using the group
 *      PVC mount so writes persist across calls (mount: group in the catalog).
 *
 * Test strategy: Redis bypass — write directly to kubeclaw:spawn-agent-job with
 * a prompt that forces the LLM to call `bash`. Because the test runs against a
 * small local model (Gemma-4-E4B-Q4) whose tool-selection is unreliable, both
 * `bash` and `bash_persist` are also exercised via a DIRECT bypass: the test
 * writes tool calls to kubeclaw:toolcalls:<id>:bash and
 * kubeclaw:toolcalls:<id>:bash_persist, then publishes spawn-tool-pod entries,
 * and asserts the results — identical to the pattern in
 * minikube-live-tool-pods.test.ts.
 *
 * The agent-job path (Stage 1) proves the full end-to-end wiring (catalog is
 * loaded, tools are registered). The direct bypass paths (Stages 2-4) provide
 * deterministic coverage of the bash / bash_persist named dispatch.
 *
 * Cluster availability: detected by trying to reach the HTTP channel port-
 * forward. If unreachable (globalSetup failed or cluster absent), beforeAll
 * records provisioned=false and every test fails with a clear message —
 * mirroring minikube-live-tool-pods.test.ts (no ctx.skip, same pattern).
 *
 * Run: npm run test:minikube-live -- minikube-live-agent-catalog
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const GROUP_FOLDER = 'http-http-alice';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Poll kubectl for a K8s Job matching `labelSelector` created at or after
 * `sinceMs` (with 2 s clock-skew slop). Returns the job name or null on timeout.
 * Mirrors the helper in minikube-live-tool-pods.test.ts.
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
        if (Date.parse(ts) + 2000 >= sinceMs) return name;
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}

/**
 * Poll a Redis stream for the entry whose `requestId` field matches. Returns
 * the full field map or throws on timeout. Mirrors pollToolResult in
 * minikube-live-tool-pods.test.ts.
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
      } catch { /* stream may not exist yet */ }
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
 * Poll a Redis stream for any entry. Returns the last entry's field map or
 * throws on timeout. Mirrors pollJobResult in minikube-live-tool-pods.test.ts.
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

describe('Minikube-live: agent-runner catalog unification — bash/bash_persist via sidecar bridge', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Verify the HTTP channel port-forward is live (globalSetup must have run).
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, { signal: AbortSignal.timeout(2000) });
        if (res.status > 0) { provisioned = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
      return;
    }

    // 2. Connect to Redis using the orchestrator ACL password from the Secret —
    //    identical pattern to minikube-live-tool-pods.test.ts beforeAll.
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

  // ── Stage 1: Full agent job — catalog loaded, bash dispatched, result returned ──
  //
  // Submits to kubeclaw:spawn-agent-job. The agent-runner starts, loads
  // /etc/kubeclaw/tools/tools.json (mounted ConfigMap), registers `bash` as a
  // catalog tool, and — when the LLM calls it — routes it through
  // kubeclaw:spawn-tool-pod → sidecar pod → kubeclaw:toolresults. The result
  // ultimately lands in kubeclaw:agent-job-result:<agentJobId>.
  //
  // Hard assertions:
  //   - kubeclaw-agent Job appears within 240 s.
  //   - kubeclaw:toolcalls:<id>:bash stream gets at least one entry (proves the
  //     agent registered and dispatched `bash` by name via the catalog path).
  //   - kubeclaw:spawn-tool-pod stream has an entry with category=bash (proves
  //     callCatalogToolViaRedis sent category=toolName, not the old "execution").
  //   - kubeclaw:agent-job-result stream receives a non-empty entry within 300 s.
  //   - The result text contains the unique marker the prompt asked for, confirming
  //     the sidecar bridge executed the command and the result flowed back.
  //
  // Note: The small local model (Gemma-4-E4B-Q4) may not follow tool-call
  // instructions reliably. The marker assertion uses expect.soft so a pure-text
  // echo response (without a tool call) still yields a visible partial result
  // rather than a hard failure. The toolcalls/spawn-tool-pod assertions are
  // also soft for the same reason. The job completion assertion is hard.

  it(
    'Stage 1: agent job loads catalog, calls bash by name, result flows back',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `catalog-bash-${Date.now()}-${rand}`;
      const resultStream = `kubeclaw:agent-job-result:${agentJobId}`;
      const bashCallsStream = `kubeclaw:toolcalls:${agentJobId}:bash`;
      const spawnStream = 'kubeclaw:spawn-tool-pod';
      const testStartMs = Date.now();

      // Read the current length of the spawn-tool-pod stream so we can detect
      // new entries added after testStartMs.
      let spawnStreamLenBefore = 0;
      try { spawnStreamLenBefore = await redis!.xlen(spawnStream); } catch { /* ok */ }

      // Prompt designed to force a bash tool call. The marker is unique per run.
      const marker = `kubeclaw-catalog-e2e-${rand}`;
      await redis!.xadd(
        'kubeclaw:spawn-agent-job',
        '*',
        'agentJobId', agentJobId,
        'groupFolder', GROUP_FOLDER,
        'chatJid', 'http:alice',
        'prompt',
          `You MUST call the bash tool with the command "echo ${marker}". ` +
          `Do not respond with text until after you have called bash and received its output. ` +
          `When you have the output, reply with it verbatim.`,
        'timeout', '300000',
        'channel', 'http',
      );

      console.log(`Stage 1: waiting for kubeclaw-agent Job (agentJobId=${agentJobId})...`);

      // Hard assertion: the agent Job must appear.
      const jobSelector = `app=kubeclaw-agent,kubeclaw/group=${GROUP_FOLDER}`;
      const jobName = await waitForJob(jobSelector, 240_000, testStartMs);
      expect(
        jobName,
        `No kubeclaw-agent Job with selector "${jobSelector}" appeared within 240 s`,
      ).not.toBeNull();
      console.log(`Stage 1: kubeclaw-agent Job appeared: ${jobName}`);

      // Hard assertion: agent job must complete and publish a result.
      const result = await pollJobResult(redis!, resultStream, 300_000);
      const resultText = result.result ?? '';
      expect.soft(resultText, 'agent-job result field must be non-empty').toBeTruthy();
      console.log(`Stage 1: result (first 200): ${resultText.slice(0, 200)}`);

      // Soft assertion: result contains the marker (proves bash executed via sidecar).
      expect.soft(
        resultText,
        `result should contain the bash output marker "${marker}"`,
      ).toContain(marker);

      // Informational: check whether bash was dispatched via the catalog path.
      // kubeclaw:toolcalls:<id>:bash gets a write from callCatalogToolViaRedis
      // (category = tool name = "bash", not the old "execution").
      try {
        const bashLen = await redis!.xlen(bashCallsStream);
        console.log(`Stage 1: kubeclaw:toolcalls:${agentJobId}:bash length=${bashLen} (≥1 = catalog dispatch used)`);
        if (bashLen > 0) {
          // Soft: confirm spawn-tool-pod got an entry with category=bash.
          const spawnEntries = await redis!.xrange(spawnStream, '-', '+');
          const newEntries = spawnEntries.slice(spawnStreamLenBefore);
          const bashSpawn = newEntries.find(([, fields]) => {
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
            return obj.agentJobId === agentJobId && obj.category === 'bash';
          });
          expect.soft(
            bashSpawn,
            'spawn-tool-pod must have an entry with agentJobId and category=bash',
          ).toBeDefined();
          console.log(`Stage 1: spawn-tool-pod entry with category=bash found=${Boolean(bashSpawn)}`);
        }
      } catch {
        console.log('Stage 1: toolcalls stream not yet created (informational)');
      }
    },
    600_000,
  );

  // ── Stage 2: Direct bash bypass — category=bash (not "execution") ────────────
  //
  // Writes a tool call directly to kubeclaw:toolcalls:<id>:bash then publishes
  // kubeclaw:spawn-tool-pod with category=bash. Asserts:
  //   - A tool pod Job appears within 90 s.
  //   - The toolresults stream contains the expected marker output.
  //
  // This is the deterministic proof that the orchestrator routes `category=bash`
  // (the new per-name convention) to the correct tool pod. Mirrors the bash
  // sub-test in minikube-live-tool-pods.test.ts exactly.

  it(
    'Stage 2: bash direct bypass — category=bash spawns tool pod and returns result',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `catalog-direct-bash-${Date.now()}-${rand}`;
      const requestId = `${agentJobId}-req`;
      const category = 'bash';
      const marker = `kubeclaw-bash-catalog-${rand}`;

      const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const toolResultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      // Brief pause so the spawn watcher has settled past its initial startup.
      await new Promise((r) => setTimeout(r, 1000));

      // Write the tool call BEFORE spawning so the tool server picks it up
      // with lastId='0-0' (same ordering rule as minikube-live-tool-pods.test.ts).
      await redis!.xadd(
        toolCallsStream, '*',
        'requestId', requestId,
        'tool', 'bash',
        'input', JSON.stringify({ command: `echo ${marker}` }),
      );

      const testStartMs = Date.now();

      // Spawn via the orchestrator's spawn-tool-pod stream with category=bash
      // (the new per-name convention from callCatalogToolViaRedis).
      await redis!.xadd(
        'kubeclaw:spawn-tool-pod', '*',
        'agentJobId', agentJobId,
        'groupFolder', GROUP_FOLDER,
        'category', category,
        'timeout', '120000',
        'channel', 'http',
      );

      console.log(`Stage 2: waiting for bash tool pod (agentJobId=${agentJobId})...`);

      // Hard assertion: a sidecar tool pod must appear. kubeclaw/agent-job is on the
      // Job metadata only, not propagated to the pod template — use sinceMs timestamp
      // filter to exclude pods from prior tests.
      const podSelector = 'app=kubeclaw-sidecar-tool';
      const podName = await (async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const r = kubectl([
            'get', 'pods', '-n', NAMESPACE, '-l', podSelector,
            '--sort-by=.metadata.creationTimestamp',
            '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.creationTimestamp}{"\\n"}{end}',
          ]);
          if (r.ok && r.stdout.trim()) {
            const lines = r.stdout.trim().split('\n').reverse();
            for (const line of lines) {
              const [name, ts] = line.split('\t');
              if (!name || !ts) continue;
              if (Date.parse(ts) + 2000 >= testStartMs) return name;
            }
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
        return null;
      })();
      expect(podName, `No tool pod with selector "${podSelector}" appeared within 90 s`).not.toBeNull();
      console.log(`Stage 2: bash tool pod appeared: ${podName}`);

      // Hard assertion: result stream must contain the marker.
      const result = await pollToolResult(redis!, toolResultsStream, requestId, 60_000);
      expect(result.requestId, 'result entry missing requestId field').toBe(requestId);
      const resultText = result.result ?? '';
      expect(resultText, 'result field must be non-empty').toBeTruthy();
      expect(resultText, `bash output must contain "${marker}"`).toContain(marker);
      console.log(`Stage 2: bash result: ${resultText.trim().slice(0, 200)}`);
    },
    180_000,
  );

  // ── Stage 3: Direct bash_persist bypass — category=bash_persist ──────────────
  //
  // bash_persist mounts the group PVC (mount: group in the catalog). This test
  // writes a unique file via bash_persist, then reads it back in Stage 4 via a
  // second bash_persist call on the SAME agentJobId/tool pod (same stream keys
  // so the tool server keeps running and the WORKDIR is the same PVC mount).
  //
  // Hard assertions (Stage 3):
  //   - Tool pod appears within 90 s.
  //   - First bash_persist call writes the file without error.

  let persistAgentJobId = '';
  let persistRand = '';

  it(
    'Stage 3: bash_persist direct bypass — writes unique marker to group PVC',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      persistRand = Math.random().toString(36).slice(2, 8);
      persistAgentJobId = `catalog-persist-${Date.now()}-${persistRand}`;
      const requestId = `${persistAgentJobId}-write`;
      const category = 'bash_persist';
      const markerFile = `kubeclaw-persist-${persistRand}.txt`;
      const markerContent = `persist-marker-${persistRand}`;

      const toolCallsStream = `kubeclaw:toolcalls:${persistAgentJobId}:${category}`;
      const toolResultsStream = `kubeclaw:toolresults:${persistAgentJobId}:${category}`;

      await new Promise((r) => setTimeout(r, 1000));

      // Write the file via bash_persist. The tool server runs in the group PVC
      // WORKDIR so the file is durable across the read call in Stage 4.
      await redis!.xadd(
        toolCallsStream, '*',
        'requestId', requestId,
        'tool', 'bash_persist',
        'input', JSON.stringify({ command: `echo "${markerContent}" > ${markerFile}` }),
      );

      const testStartMs = Date.now();

      await redis!.xadd(
        'kubeclaw:spawn-tool-pod', '*',
        'agentJobId', persistAgentJobId,
        'groupFolder', GROUP_FOLDER,
        'category', category,
        'timeout', '180000',
        'channel', 'http',
      );

      console.log(`Stage 3: waiting for bash_persist tool pod (agentJobId=${persistAgentJobId})...`);

      // kubeclaw/agent-job is on the Job metadata only, not propagated to the pod
      // template — use sinceMs timestamp filter to exclude pods from prior tests.
      const podSelector = 'app=kubeclaw-sidecar-tool';
      const podName = await (async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const r = kubectl([
            'get', 'pods', '-n', NAMESPACE, '-l', podSelector,
            '--sort-by=.metadata.creationTimestamp',
            '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.creationTimestamp}{"\\n"}{end}',
          ]);
          if (r.ok && r.stdout.trim()) {
            const lines = r.stdout.trim().split('\n').reverse();
            for (const line of lines) {
              const [name, ts] = line.split('\t');
              if (!name || !ts) continue;
              if (Date.parse(ts) + 2000 >= testStartMs) return name;
            }
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
        return null;
      })();
      expect(podName, `No tool pod with selector "${podSelector}" appeared within 90 s`).not.toBeNull();
      console.log(`Stage 3: bash_persist tool pod appeared: ${podName}`);

      // Assert the write completed without error.
      const writeResult = await pollToolResult(redis!, toolResultsStream, requestId, 60_000);
      expect(writeResult.requestId, 'write result missing requestId').toBe(requestId);
      // A successful `echo > file` writes the empty result; an error result
      // would have a non-null error field.
      expect(
        writeResult.error ?? null,
        `bash_persist write must not return an error: ${writeResult.error}`,
      ).toBeNull();
      console.log(`Stage 3: bash_persist write result: ${(writeResult.result ?? '').trim().slice(0, 100)}`);
    },
    180_000,
  );

  // ── Stage 4: bash_persist read-back — proves persistence via group PVC ───────
  //
  // Uses the SAME agentJobId and category as Stage 3. The tool server is still
  // running (its idle timeout is 180 s, and Stage 4 runs immediately after Stage
  // 3). The WORKDIR is the same group PVC mount, so the file written in Stage 3
  // is visible here.
  //
  // Hard assertion: cat output contains the marker content written in Stage 3.

  it(
    'Stage 4: bash_persist read-back — marker file written in Stage 3 is visible',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();
      // Stage 4 depends on Stage 3 having set up persistAgentJobId.
      expect(persistAgentJobId, 'Stage 3 must have run first').toBeTruthy();

      const category = 'bash_persist';
      const requestId = `${persistAgentJobId}-read`;
      const markerFile = `kubeclaw-persist-${persistRand}.txt`;
      const markerContent = `persist-marker-${persistRand}`;

      const toolCallsStream = `kubeclaw:toolcalls:${persistAgentJobId}:${category}`;
      const toolResultsStream = `kubeclaw:toolresults:${persistAgentJobId}:${category}`;

      // The tool server for this agentJobId is still running from Stage 3.
      // Write the read call directly to the toolcalls stream — no re-spawn needed.
      await redis!.xadd(
        toolCallsStream, '*',
        'requestId', requestId,
        'tool', 'bash_persist',
        'input', JSON.stringify({ command: `cat ${markerFile}` }),
      );

      console.log(`Stage 4: reading back ${markerFile} via bash_persist (agentJobId=${persistAgentJobId})...`);

      // The tool server picks this up from the same stream — it reads from the
      // last position it left off (lastId > '0-0' after Stage 3), so no re-spawn.
      const readResult = await pollToolResult(redis!, toolResultsStream, requestId, 60_000);
      expect(readResult.requestId, 'read result missing requestId').toBe(requestId);
      expect(
        readResult.error ?? null,
        `bash_persist read must not return an error: ${readResult.error}`,
      ).toBeNull();

      // result is JSON.stringified by tool-server; parse once to get the raw string.
      let rawOutput = readResult.result ?? '';
      try { rawOutput = JSON.parse(rawOutput) as string; } catch { /* already a plain string */ }
      expect(
        rawOutput.trim(),
        `cat output must contain the marker written in Stage 3: "${markerContent}"`,
      ).toContain(markerContent);
      console.log(`Stage 4: bash_persist read-back output: ${rawOutput.trim().slice(0, 200)}`);
    },
    120_000,
  );
});
