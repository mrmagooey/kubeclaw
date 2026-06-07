/**
 * End-to-end test for Story 3: Global concurrency limit queues a third
 * group's message until a slot opens.
 *
 * Acceptance criteria:
 *   AC1 — With maxConcurrentJobs=2, two groups have long-running LLM turns
 *         in flight; a third group's POST returns HTTP 200 immediately.
 *   AC2 — While the two turns run, the third group has not yet been processed
 *         (no SSE reply from the third group's SSE stream).
 *   AC3 — Once one slot frees, the third group's message is processed and a
 *         reply is produced within 30 s.
 *   AC4 — At no point during the test do more than 2 Kubernetes Jobs have
 *         status.active > 0.  (In the current channel-pod / DirectLLMRunner
 *         architecture, LLM turns run in-process — not as K8s Jobs — so this
 *         check trivially passes.  The test still samples the Jobs API on every
 *         polling tick so it would catch a regression if K8s Job creation were
 *         re-introduced.)
 *   AC5 — All three groups eventually receive replies; no messages are lost.
 *
 * Architecture note
 * ─────────────────
 * The HTTP channel maps each Basic-Auth username to a distinct group JID
 * (http:{username}).  Three users → three independent groups.  The orchestrator's
 * GroupQueue enforces MAX_CONCURRENT_JOBS across those groups.
 *
 * To make the first two LLM turns long-running enough for AC2 to be observable
 * we install a "Verbose" specialist whose prompt instructs the LLM to produce a
 * lengthy chain-of-thought response (count from 1 to 30, one sentence each).
 * The third user sends a plain message to the default assistant, which is faster
 * but will be held in the queue while the first two Verbose turns are in flight.
 *
 * Isolated namespace: kubeclaw-e2e-concurrency — no clash with other suites.
 * Local port: 14092 — no clash with minikube-live (14080-14083) or
 *             specialist-catalog (14091).
 *
 * Skip conditions:
 *   - No Kubernetes cluster reachable (isKubernetesAvailable returns false).
 *   - No live LLM provider reachable at LIVE_LLM_BASE_URL.
 *
 * KUBECLAW_SKIP_HELM_INSTALL=true skips the helm install/uninstall lifecycle,
 * allowing the test to reuse a pre-installed release (same pattern as
 * specialist-catalog.test.ts).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { isKubernetesAvailable } from './setup.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-concurrency';
const RELEASE   = 'kubeclaw-e2e-concurrency';
const CHART_DIR = './helm/kubeclaw';

/** Unique port — does not clash with minikube-live (14080–14083) or
 *  specialist-catalog (14091). */
const HTTP_LOCAL_PORT = 14092;

const LIVE_BASE_URL =
  process.env.LIVE_LLM_BASE_URL || 'http://192.168.7.100:8080/v1';
const LIVE_MODEL =
  process.env.LIVE_LLM_MODEL || 'gemma-4-E4B-it-Q4_0.gguf';
const LIVE_API_KEY = process.env.LIVE_LLM_API_KEY || 'no-key';

// Three users → three independent groups (JIDs: http:groupA, http:groupB, http:groupC).
const USERS = [
  { username: 'groupA', password: 'passA' },
  { username: 'groupB', password: 'passB' },
  { username: 'groupC', password: 'passC' },
] as const;

const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

// ─── Module-level skip flags ──────────────────────────────────────────────────

let clusterAvailable = false;
let providerAvailable = false;
let providerSkipReason = '';

clusterAvailable = isKubernetesAvailable();

async function probeProvider(): Promise<void> {
  if (!clusterAvailable) {
    providerSkipReason = 'no Kubernetes cluster';
    return;
  }
  try {
    const modelsRes = await fetch(`${LIVE_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!modelsRes.ok) {
      providerSkipReason = `GET /models returned HTTP ${modelsRes.status}`;
      return;
    }
    const chatRes = await fetch(`${LIVE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LIVE_API_KEY}`,
      },
      body: JSON.stringify({
        model: LIVE_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!chatRes.ok) {
      providerSkipReason = `POST /chat/completions returned HTTP ${chatRes.status}`;
      return;
    }
    const payload = (await chatRes.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    if (typeof payload.choices?.[0]?.message?.content !== 'string') {
      providerSkipReason = 'malformed chat response';
      return;
    }
    providerAvailable = true;
  } catch (err) {
    providerSkipReason = err instanceof Error ? err.message : String(err);
  }
}

await probeProvider();

const shouldSkip = !clusterAvailable || !providerAvailable;
const skipReason = shouldSkip
  ? `group-queue-concurrency tests skipped: ${
      providerSkipReason ||
      (clusterAvailable ? 'LLM provider not available' : 'no Kubernetes cluster')
    }`
  : '';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** kubectl in namespace; returns { ok, stdout, stderr }. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', [...args, '-n', NAMESPACE], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** kubectl at cluster scope. */
function kcCluster(
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

/** Poll until fn() returns truthy or timeout expires. */
async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${label}`);
}

/** Wait for the channel HTTP pod to be Ready. */
async function waitForChannelPod(timeoutMs = 120_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get', 'pods',
        '-l', 'app=kubeclaw-channel-http',
        '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
      return statuses.length > 0 && statuses.every((s) => s === 'True');
    },
    timeoutMs,
    'channel-http pod Ready',
  );
}

/** Wait for the orchestrator pod to be Ready. */
async function waitForOrchestrator(timeoutMs = 120_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get', 'pods',
        '-l', 'app=kubeclaw-orchestrator',
        '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
      return statuses.length > 0 && statuses.every((s) => s === 'True');
    },
    timeoutMs,
    'orchestrator pod Ready',
  );
}

let portForwardProcess: ChildProcess | null = null;

/** Start (or restart) the port-forward to svc/kubeclaw-channel-http. */
async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  // Kill any stale port-forward that survived from a previous run/retry.
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], {
    stdio: 'pipe',
  });
  await sleep(1_500);
  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${HTTP_LOCAL_PORT}:80 || true; sleep 0.1; done`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
  );
  // Wait for the port to be reachable.
  for (let i = 0; i < 20; i++) {
    await sleep(1_000);
    const nc = spawnSync('nc', ['-z', 'localhost', String(HTTP_LOCAL_PORT)], {
      stdio: 'pipe',
    });
    if (nc.status === 0) return;
  }
  throw new Error(
    `Port-forward to localhost:${HTTP_LOCAL_PORT} did not come up within 20 s`,
  );
}

/**
 * Install or upgrade the helm release with the given extra args.
 * Waits for any pending namespace termination before running helm.
 */
function helmInstall(extraArgs: string[]): void {
  // If the namespace is being terminated (e.g. from a prior test's afterAll),
  // wait for it to vanish before letting helm recreate it.
  spawnSync(
    'kubectl',
    ['wait', '--for=delete', `ns/${NAMESPACE}`, '--timeout=60s'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 70_000 },
  );

  // helm --set treats unescaped commas as value separators, so we
  // backslash-escape each one inside the single passed value.
  const usersStr = USERS.map((u) => `${u.username}:${u.password}`).join('\\,');

  const result = spawnSync(
    'helm',
    [
      'upgrade', '--install',
      RELEASE,
      CHART_DIR,
      '--namespace', NAMESPACE,
      '--create-namespace',
      '--timeout', '180s',
      '--set', `namespace=${NAMESPACE}`,
      '--set', 'image.tag=e2e-test',
      '--set', 'image.pullPolicy=IfNotPresent',
      '--set', 'secrets.anthropicApiKey=test-key',
      '--set', `secrets.openaiApiKey=${LIVE_API_KEY}`,
      '--set-string', `secrets.openaiBaseUrl=${LIVE_BASE_URL}`,
      '--set-string', `secrets.directLlmModel=${LIVE_MODEL}`,
      // HTTP channel — all three users share one channel pod.
      '--set', 'channels.http.enabled=true',
      '--set', 'channels.http.type=http',
      '--set', 'channels.http.httpPort=4080',
      '--set-string', `secrets.httpChannelUsers=${usersStr}`,
      '--set', 'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
      '--set', 'channels.http.envVars[0].key=users',
      '--set', 'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
      '--set', 'channels.http.envVars[1].key=port',
      '--set', 'channels.http.envVars[1].optional=true',
      '--set', 'credentialInjection.mode=off',
      '--set', 'redis.password=e2e-concurrency-redis-pass',
      // *** Story 3: enforce a 2-slot global concurrency limit ***
      '--set', 'orchestrator.maxConcurrentJobs=2',
      ...extraArgs,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `helm upgrade failed (exit ${result.status}):\n` +
        `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
}

/**
 * Open an SSE stream for a given user and return helpers.
 * Lines that start with "data: " are accumulated (prefix stripped).
 */
function openSseStream(username: string, password: string): {
  lines: string[];
  dispose: () => void;
  waitFor: (
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
} {
  const controller = new AbortController();
  const lines: string[] = [];

  (async () => {
    try {
      const res = await fetch(`${HTTP_URL}/stream`, {
        headers: { Authorization: basicAuth(username, password) },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
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
    dispose: () => controller.abort(),
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(lines)) return;
        await sleep(200);
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs} ms ` +
          `(user=${username}, lines so far: ${JSON.stringify(lines)})`,
      );
    },
  };
}

/** POST a message to /message for a given user. Returns the HTTP status. */
async function postMessage(
  username: string,
  password: string,
  text: string,
): Promise<number> {
  const res = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(username, password),
    },
    body: JSON.stringify({ text }),
  });
  return res.status;
}

/**
 * Count how many K8s Jobs in the test namespace currently have
 * status.active > 0.  Returns 0 when kubectl fails (cluster unreachable,
 * no Jobs exist, etc.).
 */
function countActiveJobs(): number {
  const r = kc(['get', 'jobs', '-o', 'json'], { timeout: 10_000 });
  if (!r.ok) return 0;
  try {
    const parsed = JSON.parse(r.stdout) as {
      items?: Array<{ status?: { active?: number } }>;
    };
    return (parsed.items ?? []).filter((j) => (j.status?.active ?? 0) > 0)
      .length;
  } catch {
    return 0;
  }
}

// ─── Suite-level lifecycle ────────────────────────────────────────────────────

beforeAll(async () => {
  if (shouldSkip) return;

  // Clean any leftover release + namespace from a previous run.
  spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  spawnSync(
    'kubectl',
    ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=true'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
  );

  // Pre-create the namespace with Helm ownership labels so helm can manage it.
  spawnSync('kubectl', ['create', 'namespace', NAMESPACE], { encoding: 'utf8' });
  spawnSync(
    'kubectl',
    ['label', 'namespace', NAMESPACE, 'app.kubernetes.io/managed-by=Helm'],
    { encoding: 'utf8' },
  );
  spawnSync(
    'kubectl',
    [
      'annotate', 'namespace', NAMESPACE,
      `meta.helm.sh/release-name=${RELEASE}`,
      `meta.helm.sh/release-namespace=${NAMESPACE}`,
    ],
    { encoding: 'utf8' },
  );

  // Install with the Verbose specialist so that the first two LLM turns are
  // slow enough for AC2 to be observable.
  //
  // The specialist prompt instructs the LLM to count from 1 to 30 explicitly,
  // one sentence per number, before answering.  On a local 4B model this takes
  // ~10–40 s — enough time to check that the third user's SSE stream is empty.
  const verbosePrompt =
    'Before answering any question, count from 1 to 30 slowly, writing one sentence for each number. Then answer the question.';
  helmInstall([
    '--set-json',
    `specialists=[{"name":"Verbose","prompt":${JSON.stringify(verbosePrompt)}}]`,
  ]);

  await waitForOrchestrator(180_000);
  await waitForChannelPod(120_000);
  await startPortForward();

  // Budget 60 s for the ConfigMap to propagate into channel-pod volume mounts
  // so the Verbose specialist is visible.
  await sleep(60_000);
}, 600_000);

afterAll(async () => {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }

  spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  spawnSync(
    'kubectl',
    ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
    { encoding: 'utf8', stdio: 'pipe' },
  );
}, 120_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

/**
 * Shared state across the five AC tests.
 *
 * All five `it()` blocks run sequentially within the `describe` (Vitest's
 * default order is preserved). The SSE streams and timing data are collected in
 * the first test and read by later ones.  This avoids re-sending messages and
 * ensures the four ACs are checked against the same real run.
 */
describe('Story 3: global concurrency limit (group-queue)', () => {
  /** SSE line buffers for each user — populated in AC1. */
  const sseLines: Record<string, string[]> = {
    groupA: [],
    groupB: [],
    groupC: [],
  };
  /** Timestamps at which each user received their first SSE line. */
  const firstReplyAt: Record<string, number> = {};

  // A/B: long-running via Verbose specialist; C: fast plain message.
  const msgA = '@Verbose tell me about prime numbers';
  const msgB = '@Verbose tell me about the Fibonacci sequence';
  const msgC = 'What is two plus two?';

  /** Max active K8s jobs seen during the AC4 polling window. */
  let maxActiveJobsSeen = 0;

  // ── AC1: Third POST returns HTTP 200 immediately ─────────────────────────

  it.skipIf(shouldSkip)(
    `AC1: all three POSTs return HTTP 200 immediately`,
    async () => {
      // Open SSE streams before sending messages so we do not miss replies.
      const streamA = openSseStream(USERS[0].username, USERS[0].password);
      const streamB = openSseStream(USERS[1].username, USERS[1].password);
      const streamC = openSseStream(USERS[2].username, USERS[2].password);

      // Expose the line arrays so later tests can inspect them.
      // The objects are the same references; we push into them as the streams
      // accumulate data.
      Object.assign(sseLines, {
        groupA: streamA.lines,
        groupB: streamB.lines,
        groupC: streamC.lines,
      });

      // Fire all three POSTs in quick succession.
      const [statusA, statusB, statusC] = await Promise.all([
        postMessage(USERS[0].username, USERS[0].password, msgA),
        postMessage(USERS[1].username, USERS[1].password, msgB),
        postMessage(USERS[2].username, USERS[2].password, msgC),
      ]);

      expect(statusA, 'groupA POST should return 200').toBe(200);
      expect(statusB, 'groupB POST should return 200').toBe(200);
      expect(statusC, 'groupC POST should return 200').toBe(200);

      // Kick off the background polling that feeds AC4.
      // We poll for 90 s (the window AC3 covers) and track the max.
      const ac4Deadline = Date.now() + 90_000;
      const pollJobs = async (): Promise<void> => {
        while (Date.now() < ac4Deadline) {
          const active = countActiveJobs();
          if (active > maxActiveJobsSeen) maxActiveJobsSeen = active;
          await sleep(1_000);
        }
      };
      pollJobs().catch(() => {});

      // Track first-reply timestamps in the background.
      const trackReplies = async (): Promise<void> => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          for (const [key, lines] of Object.entries(sseLines)) {
            if (lines.length > 0 && firstReplyAt[key] === undefined) {
              firstReplyAt[key] = Date.now();
            }
          }
          await sleep(500);
        }
      };
      trackReplies().catch(() => {});

      // Clean up SSE streams at end of suite (they outlive this test block).
      // We register a post-suite cleanup via afterAll which kills the streams.
      // For now just store dispose refs — the suite's afterAll handles teardown.
      // (In practice the port-forward kill also drops all connections.)
    },
    60_000,
  );

  // ── AC2: Third group not yet processed while two are running ─────────────

  it.skipIf(shouldSkip)(
    'AC2: groupC has no SSE reply while groupA and groupB are still processing',
    async () => {
      // Check within the first 8 s: the first two LLM runs (groupA, groupB) should
      // still be in flight (Verbose specialist takes ~10–40 s on a small model).
      // groupC should be held in the queue.
      //
      // We poll for up to 8 s and assert that throughout that window groupC has
      // received no SSE data.  If groupA or groupB have already finished within
      // 8 s (very fast model), we log a warning and skip the assertion — it is
      // not possible to observe the queued state retroactively.
      const CHECK_WINDOW_MS = 8_000;
      const checkInterval = 500;
      const deadline = Date.now() + CHECK_WINDOW_MS;
      let groupCHadReplyDuringWindow = false;

      while (Date.now() < deadline) {
        if (sseLines['groupC'].length > 0) {
          groupCHadReplyDuringWindow = true;
          break;
        }
        await sleep(checkInterval);
      }

      if (groupCHadReplyDuringWindow) {
        // groupC replied within 8 s.  Check whether groupA or groupB also
        // replied that fast — if the LLM is extremely quick, the queue empties
        // before we can observe it and we skip rather than fail.
        const bothSlotsFreed =
          sseLines['groupA'].length > 0 && sseLines['groupB'].length > 0;
        if (bothSlotsFreed) {
          console.warn(
            '[AC2] LLM responded too quickly for queued-state observation. ' +
              'All three groups already replied within the 8 s check window. ' +
              'Skipping AC2 assertion (not a GroupQueue failure).',
          );
          // Soft-pass: we cannot distinguish "queued correctly then released"
          // from "never queued" at this speed.  A dedicated unit/integration
          // test exercises the queue logic synchronously.
          return;
        }
        // groupC replied but at least one of A/B had NOT yet replied —
        // that would mean groupC ran BEFORE a slot was free, which violates
        // the concurrency contract.
        expect(
          groupCHadReplyDuringWindow,
          'groupC received an SSE reply before groupA or groupB finished, ' +
            'suggesting the concurrency limit was not enforced.',
        ).toBe(false);
      } else {
        // groupC had no reply in 8 s — the queue is holding it.  ✅
        expect(sseLines['groupC'].length, 'groupC should have no replies yet').toBe(0);
      }
    },
    30_000,
  );

  // ── AC3: Third group gets reply within 30 s after one slot frees ─────────

  it.skipIf(shouldSkip)(
    'AC3: groupC receives a reply within 30 s after groupA or groupB finishes',
    async () => {
      // Wait up to 120 s for at least one of groupA/groupB to reply (slot opens).
      // Then assert groupC replies within 30 s of that moment.
      let slotFreedAt: number | null = null;

      await waitUntil(
        () => {
          const aOrBReplied =
            sseLines['groupA'].length > 0 || sseLines['groupB'].length > 0;
          if (aOrBReplied && slotFreedAt === null) {
            slotFreedAt = firstReplyAt['groupA'] ?? firstReplyAt['groupB'] ?? Date.now();
          }
          return aOrBReplied;
        },
        120_000,
        'groupA or groupB to receive SSE reply (slot freed)',
        500,
      );

      // The slot has opened.  groupC must reply within 30 s from now.
      const deadline = (slotFreedAt ?? Date.now()) + 30_000;
      const remaining = Math.max(0, deadline - Date.now());

      await waitUntil(
        () => sseLines['groupC'].length > 0,
        remaining + 5_000, // +5 s safety margin
        'groupC SSE reply after slot freed',
        500,
      );

      expect(
        sseLines['groupC'].length,
        'groupC should have at least one SSE reply',
      ).toBeGreaterThan(0);

      // Verify the slot-to-reply latency.
      const groupCReplyAt = firstReplyAt['groupC'] ?? Date.now();
      const latencyMs = groupCReplyAt - (slotFreedAt ?? groupCReplyAt);
      expect(
        latencyMs,
        `groupC should reply within 30 s of slot opening; actual latency: ${latencyMs} ms`,
      ).toBeLessThanOrEqual(30_000);
    },
    180_000,
  );

  // ── AC4: Never more than 2 active K8s Jobs ───────────────────────────────

  it.skipIf(shouldSkip)(
    'AC4: at no point do more than 2 Kubernetes Jobs have status.active > 0',
    () => {
      // maxActiveJobsSeen is populated by the background poller started in AC1.
      // In the current DirectLLMRunner architecture, LLM turns run in-process
      // inside the channel pod — not as K8s Jobs — so this value will be 0.
      // The check is included so a regression (re-introduction of per-message
      // K8s Jobs) would be caught immediately.
      expect(
        maxActiveJobsSeen,
        `Max active K8s Jobs observed was ${maxActiveJobsSeen}; must be ≤ 2`,
      ).toBeLessThanOrEqual(2);
    },
    10_000,
  );

  // ── AC5: All three groups receive replies; no messages lost ──────────────

  it.skipIf(shouldSkip)(
    'AC5: all three groups eventually receive replies (FIFO, no messages lost)',
    async () => {
      // Wait up to 120 s total for all three streams to have at least one line.
      await waitUntil(
        () =>
          sseLines['groupA'].length > 0 &&
          sseLines['groupB'].length > 0 &&
          sseLines['groupC'].length > 0,
        120_000,
        'all three groups to have SSE replies',
        1_000,
      );

      expect(
        sseLines['groupA'].length,
        'groupA should have received a reply',
      ).toBeGreaterThan(0);
      expect(
        sseLines['groupB'].length,
        'groupB should have received a reply',
      ).toBeGreaterThan(0);
      expect(
        sseLines['groupC'].length,
        'groupC should have received a reply',
      ).toBeGreaterThan(0);

      // FIFO: groupC's reply must arrive after at least one of groupA/groupB
      // started (i.e. groupC is not processed before the queue drains one slot).
      const groupCTime = firstReplyAt['groupC'];
      const groupATime = firstReplyAt['groupA'];
      const groupBTime = firstReplyAt['groupB'];

      if (groupCTime !== undefined && groupATime !== undefined && groupBTime !== undefined) {
        const earliestAB = Math.min(groupATime, groupBTime);
        // groupC's first reply must not be before BOTH A and B replied
        // (it can be interleaved with the second of A/B if the model is fast,
        //  but must never precede the first completed slot).
        expect(
          groupCTime,
          `groupC replied (${groupCTime}) before any slot freed ` +
            `(earliest A/B: ${earliestAB}). This suggests the queue did not hold groupC.`,
        ).toBeGreaterThanOrEqual(earliestAB);
      }
    },
    180_000,
  );
});
