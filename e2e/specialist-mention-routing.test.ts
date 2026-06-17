/**
 * End-to-end tests for Story 13: Specialist @mention routing.
 *
 * Verifies that:
 *   AC1 – A single @Researcher mention routes to Researcher and the reply
 *          starts with [@Researcher].
 *   AC2 – Two concurrent @Researcher @Coder mentions produce two distinct
 *          SSE reply chunks, one prefixed [@Researcher] and one [@Coder].
 *   AC3 – @UnknownBot (no matching specialist) falls through to the default
 *          assistant path and no [@…] prefix appears in the reply.
 *   AC4 – Hot-reload: patching the ConfigMap to add @Fresh causes
 *          subsequent mentions to route to Fresh without a pod restart.
 *   AC5 – A specialist with memory.isolated=true sees no prior group history:
 *          the reply is prefixed [@IsolatedOne] and does not contain the
 *          secret word planted in an earlier non-mention message.
 *
 * Skip conditions
 * ───────────────
 * All five ACs are LLM-dependent. The suite detects the provider with the
 * same probe used by specialist-catalog.test.ts (GET /models, POST
 * /chat/completions with max_tokens=256). If the provider is unreachable or
 * the kind cluster `kubeclaw-e2e-istio` is absent the whole suite skips
 * cleanly via it.skipIf(shouldSkip).
 *
 * Cluster / namespace
 * ───────────────────
 *   Context   : kind-kubeclaw-e2e-istio
 *   Namespace : kubeclaw-e2e-specialist
 *   Release   : kubeclaw-e2e-specialist
 *   HTTP port : 14098 (unique, no clash with other e2e suites)
 *
 * Environment variables (all optional — sensible defaults apply)
 * ──────────────────────────────────────────────────────────────
 *   LIVE_LLM_BASE_URL   base URL for the OpenAI-compatible provider
 *   LIVE_LLM_MODEL      model name to request
 *   LIVE_LLM_API_KEY    bearer token / API key
 *
 * Run with
 *   KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run \
 *     --config vitest.e2e.config.ts specialist-mention-routing
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { LIVE_BASE_URL, LIVE_MODEL, LIVE_API_KEY, probeLiveLlm }
  from './lib/live-llm.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const NAMESPACE = 'kubeclaw-e2e-specialist';
const RELEASE = 'kubeclaw-e2e-specialist';
const CHART_DIR = './helm/kubeclaw';
const HTTP_LOCAL_PORT = 14098; // unique: specialist-mention-routing

// Extract the LLM port so we can open it in the NetworkPolicy egress allowlist.
// The channel NetworkPolicy (networkpolicies.yaml) only permits 53/UDP, 6379/TCP to
// Redis, 443/TCP, and 80/TCP by default.  Self-hosted models on non-standard ports
// (e.g. 8080) must be listed in networkPolicy.extraEgressPorts.
const LIVE_LLM_PORT = (() => {
  try {
    const u = new URL(LIVE_BASE_URL);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return '8080';
  }
})();

const HTTP_USER = 'alice';
const HTTP_PASS = 'alicepw';
const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

// ─── Cluster-availability probe ─────────────────────────────────────────────
// Synchronous — runs at module load time so it.skipIf() sees the value.

const clusterAvailable =
  spawnSync('kubectl', ['config', 'get-contexts', KUBE_CONTEXT], {
    stdio: 'pipe',
  }).status === 0;

// ─── LLM-provider probe ──────────────────────────────────────────────────────
// Top-level await is valid in ESM and executes before any describe/it body.

let providerAvailable = false;
let providerSkipReason = 'not yet probed';

async function probeProvider(): Promise<void> {
  if (!clusterAvailable) {
    providerSkipReason = 'kind cluster "kubeclaw-e2e-istio" not found in kubeconfig';
    return;
  }
  const result = await probeLiveLlm(async (baseUrl, apiKey) => {
    try {
      const chatRes = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: LIVE_MODEL,
          messages: [{ role: 'user', content: 'ping' }],
          // 256 tokens lets reasoning-style models (Nemotron, etc.) exhaust
          // their hidden reasoning chain and still emit non-null content.
          // Non-reasoning models stop at EOS far earlier, so this is harmless.
          max_tokens: 256,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!chatRes.ok) {
        return {
          ok: false,
          reason: `POST /chat/completions returned HTTP ${chatRes.status}`,
        };
      }
      const payload = (await chatRes.json()) as {
        choices?: {
          message?: {
            content?: string | null;
            reasoning?: string | null;
            reasoning_content?: string | null;
          };
        }[];
      };
      const msg = payload.choices?.[0]?.message;
      // Some reasoning models (e.g. Nemotron via OpenRouter) return the answer
      // in `reasoning` or `reasoning_content` when `content` is null. Accept any
      // non-empty string in any of these fields as a valid response.
      const hasContent =
        typeof msg?.content === 'string' ||
        typeof msg?.reasoning === 'string' ||
        typeof msg?.reasoning_content === 'string';
      if (!hasContent) {
        return { ok: false, reason: 'malformed chat response from provider (no content/reasoning field)' };
      }
      return { ok: true, reason: '' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  providerAvailable = result.ok;
  providerSkipReason = result.reason;
}

await probeProvider();
console.log(`[probe] clusterAvailable=${clusterAvailable} providerAvailable=${providerAvailable} reason=${providerSkipReason} model=${LIVE_MODEL} base=${LIVE_BASE_URL}`);

const shouldSkip = !clusterAvailable || !providerAvailable;
const skipReason = shouldSkip
  ? `specialist-mention-routing tests skipped: ${providerSkipReason}`
  : '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Run kubectl with the test context prepended; appends -n NAMESPACE. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, ...args, '-n', NAMESPACE],
    { encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout ?? 30_000 },
  );
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Run kubectl at cluster scope (no -n flag). */
function kcCluster(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, ...args],
    { encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout ?? 30_000 },
  );
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Poll fn() until truthy or timeout. */
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
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Wait for all channel-http pods to report Ready. */
async function waitForChannelPod(timeoutMs = 120_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get', 'pods',
        '-l', 'app=kubeclaw-channel-http',
        '-o',
        'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
      return statuses.length > 0 && statuses.every((s) => s === 'True');
    },
    timeoutMs,
    'channel-http pod Ready',
  );
}

/** Wait for all orchestrator pods to report Ready. */
async function waitForOrchestrator(timeoutMs = 120_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get', 'pods',
        '-l', 'app=kubeclaw-orchestrator',
        '-o',
        'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
      return statuses.length > 0 && statuses.every((s) => s === 'True');
    },
    timeoutMs,
    'orchestrator pod Ready',
  );
}

let portForwardProcess: ChildProcess | null = null;

/** (Re-)start a self-healing port-forward loop for the HTTP channel. */
async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  // Kill any stale kubectl port-forward that still holds the port.
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], {
    stdio: 'pipe',
  });
  await sleep(1_500);

  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl --context ${KUBE_CONTEXT} port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${HTTP_LOCAL_PORT}:80 || true; sleep 0.1; done`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
  );

  // Wait up to 15 s for the port to accept connections.
  for (let i = 0; i < 15; i++) {
    await sleep(1_000);
    const nc = spawnSync('nc', ['-z', 'localhost', String(HTTP_LOCAL_PORT)], {
      stdio: 'pipe',
    });
    if (nc.status === 0) return;
  }
  throw new Error(
    `Port-forward to localhost:${HTTP_LOCAL_PORT} did not come up within 15 s`,
  );
}

/**
 * Helm upgrade --install with caller-supplied extra args.
 * Waits for the previous namespace to be fully gone (it may still be
 * terminating from a prior test's teardown).
 */
function helmUpgrade(extraArgs: string[]): void {
  // Block until the namespace is gone so helm --create-namespace can recreate it.
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'wait', '--for=delete', `ns/${NAMESPACE}`, '--timeout=60s',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 70_000 },
  );

  const result = spawnSync(
    'helm',
    [
      '--kube-context', KUBE_CONTEXT,
      'upgrade', '--install',
      RELEASE,
      CHART_DIR,
      '--namespace', NAMESPACE,
      '--create-namespace',
      '--timeout', '180s',
      '--set', `namespace=${NAMESPACE}`,
      '--set', 'secrets.anthropicApiKey=test-key',
      '--set', `secrets.openaiApiKey=${LIVE_API_KEY}`,
      '--set-string', `secrets.openaiBaseUrl=${LIVE_BASE_URL}`,
      '--set-string', `secrets.directLlmModel=${LIVE_MODEL}`,
      '--set', 'channels.http.enabled=true',
      '--set', 'channels.http.type=http',
      '--set', 'channels.http.httpPort=4080',
      '--set-string', `secrets.httpChannelUsers=${HTTP_USER}:${HTTP_PASS}`,
      '--set', 'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
      '--set', 'channels.http.envVars[0].key=users',
      '--set', 'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
      '--set', 'channels.http.envVars[1].key=port',
      '--set', 'channels.http.envVars[1].optional=true',
      '--set', 'credentialInjection.mode=off',
      '--set', 'credentialInjection.broker.image=kubeclaw-orchestrator:e2e-test',
      '--set', 'image.tag=e2e-test',
      '--set', 'image.pullPolicy=IfNotPresent',
      '--set', 'orchestrator.replicas=1',
      '--set', 'redis.password=e2e-specialist-redis-pass',
      // Open the LLM port in the channel NetworkPolicy egress allowlist.
      // Default policies only allow 53/UDP, 6379/TCP (Redis), 443/TCP, 80/TCP.
      // Self-hosted models on non-standard ports (e.g. 8080) need this.
      '--set', `networkPolicy.extraEgressPorts[0]=${LIVE_LLM_PORT}`,
      ...extraArgs,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `helm upgrade failed (exit ${result.status}):\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
}

/**
 * Patch the kubeclaw-specialists ConfigMap with a new catalog JSON.
 * Returns true if the patch succeeded.
 */
function patchSpecialistCatalog(catalogObj: {
  version: number;
  generation: number;
  specialists: Array<{
    name: string;
    prompt: string;
    memory?: { isolated: boolean };
  }>;
}): boolean {
  const catalogJson = JSON.stringify(catalogObj);
  const result = kcCluster(
    [
      'patch', 'configmap', 'kubeclaw-specialists',
      '-n', NAMESPACE,
      '--type=merge',
      '-p', JSON.stringify({ data: { 'specialists.json': catalogJson } }),
    ],
    { timeout: 15_000 },
  );
  if (!result.ok) {
    console.warn(`[patchSpecialistCatalog] warning: ${result.stderr}`);
  }
  return result.ok;
}

/**
 * Open an SSE stream from the HTTP channel and return a handle with
 * accumulated data lines and a `waitFor` poll helper.
 */
async function openSseStream(): Promise<{
  lines: string[];
  waitFor: (
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
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
      for (;;) {
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
      // aborted — expected on dispose()
    }
  })().catch(() => {});

  return {
    lines,
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(lines)) return;
        await sleep(200);
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs}ms (lines so far: ${JSON.stringify(lines)})`,
      );
    },
    dispose: () => controller.abort(),
  };
}

/** POST a message to the HTTP channel. */
async function postMessage(text: string): Promise<void> {
  const res = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(HTTP_USER, HTTP_PASS),
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`POST /message returned HTTP ${res.status}`);
  }
}

/**
 * Send a message, collect SSE lines until the predicate is satisfied,
 * return the accumulated lines.
 */
async function sendAndCollect(
  text: string,
  predicate: (lines: string[]) => boolean,
  timeoutMs = 90_000,
): Promise<string[]> {
  const sse = await openSseStream();
  try {
    await postMessage(text);
    await sse.waitFor(predicate, timeoutMs);
    return [...sse.lines];
  } finally {
    sse.dispose();
  }
}

// ─── Suite lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (shouldSkip) return;

  // Clean up any leftover release / namespace from a previous run.
  spawnSync(
    'helm',
    ['--kube-context', KUBE_CONTEXT, 'uninstall', RELEASE, '--namespace', NAMESPACE],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'delete', 'namespace', NAMESPACE,
      '--ignore-not-found', '--wait=true',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
  );

  // Pre-create namespace with Helm ownership labels so helm upgrade
  // --create-namespace doesn't skip labelling.
  spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, 'create', 'namespace', NAMESPACE],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'label', 'namespace', NAMESPACE,
      'app.kubernetes.io/managed-by=Helm',
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'annotate', 'namespace', NAMESPACE,
      `meta.helm.sh/release-name=${RELEASE}`,
      `meta.helm.sh/release-namespace=${NAMESPACE}`,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  // Initial install with empty specialist list.
  // Each AC test upgrades with its own specialist set via patchSpecialistCatalog.
  helmUpgrade(['--set-json', 'specialists=[]']);
  await waitForOrchestrator();
}, 300_000);

afterAll(async () => {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  spawnSync(
    'helm',
    ['--kube-context', KUBE_CONTEXT, 'uninstall', RELEASE, '--namespace', NAMESPACE],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'delete', 'namespace', NAMESPACE,
      '--ignore-not-found', '--timeout=60s',
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
}, 120_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('specialist @mention routing (Story 13)', () => {
  /**
   * AC1 — Single @Researcher mention routes to the Researcher specialist.
   *
   * The specialist's prompt instructs the LLM to begin its reply with the
   * fixed token "RESEARCH:" so the test can assert both the [@Researcher]
   * prefix (injected by channel-runner) and the token (confirming the
   * correct system prompt was used).
   */
  it.skipIf(shouldSkip)(
    'AC1: @Researcher mention routes reply with [@Researcher] prefix',
    async () => {
      if (shouldSkip) return; // belt-and-suspenders guard for type narrowing

      patchSpecialistCatalog({
        version: 1,
        generation: 1,
        specialists: [
          {
            name: 'Researcher',
            prompt:
              'You are a research assistant. Always begin your reply with the exact token "RESEARCH:" followed by a brief answer.',
          },
        ],
      });

      await waitForChannelPod();
      await startPortForward();

      // Wait for kubelet to propagate the ConfigMap update into the channel
      // pod's volume mount (typically <30 s on kind; budget 60 s).
      await sleep(60_000);

      const lines = await sendAndCollect(
        '@Researcher what is the speed of light?',
        (ls) => ls.some((l) => l.includes('[@Researcher]')),
        90_000,
      );

      const reply = lines.find((l) => l.includes('[@Researcher]'));
      expect(reply, `No [@Researcher] line in SSE output: ${JSON.stringify(lines)}`).toBeDefined();
      expect(reply).toMatch(/\[@Researcher\]/);
    },
    // 60s ConfigMap propagation + 90s LLM + margin
    200_000,
  );

  /**
   * AC2 — Two concurrent @mentions produce two distinct, prefixed replies.
   *
   * Both Researcher and Coder specialists use deterministic fixed tokens so
   * the test can identify each reply without relying on open-ended content.
   * The order of replies may vary (parallel dispatch).
   */
  it.skipIf(shouldSkip)(
    'AC2: @Researcher @Coder produces two prefixed replies',
    async () => {
      patchSpecialistCatalog({
        version: 1,
        generation: 2,
        specialists: [
          {
            name: 'Researcher',
            prompt:
              'You are a research assistant. Always begin your reply with the exact token "RESEARCH:" followed by a brief answer.',
          },
          {
            name: 'Coder',
            prompt:
              'You are a coding assistant. Always begin your reply with the exact token "CODE:" followed by a brief answer.',
          },
        ],
      });

      await waitForChannelPod();
      await startPortForward();
      await sleep(60_000); // ConfigMap propagation

      const lines = await sendAndCollect(
        '@Researcher @Coder what is a binary tree?',
        (ls) =>
          ls.some((l) => l.includes('[@Researcher]')) &&
          ls.some((l) => l.includes('[@Coder]')),
        90_000,
      );

      const researcherReply = lines.find((l) => l.includes('[@Researcher]'));
      const coderReply = lines.find((l) => l.includes('[@Coder]'));

      expect(
        researcherReply,
        `No [@Researcher] line in SSE output: ${JSON.stringify(lines)}`,
      ).toBeDefined();
      expect(
        coderReply,
        `No [@Coder] line in SSE output: ${JSON.stringify(lines)}`,
      ).toBeDefined();

      // Both replies must carry their respective prefix.
      expect(researcherReply).toMatch(/\[@Researcher\]/);
      expect(coderReply).toMatch(/\[@Coder\]/);
    },
    // 60s ConfigMap propagation + 90s LLM (2 parallel specialists) + margin
    220_000,
  );

  /**
   * AC3 — @UnknownBot falls through to the default assistant path.
   *
   * The ConfigMap has no specialist named "UnknownBot". The channel should
   * route the message via the default assistant and the reply must not
   * contain a [@…] prefix.
   */
  it.skipIf(shouldSkip)(
    'AC3: @UnknownBot falls through to default assistant with no [@…] prefix',
    async () => {
      // Ensure the catalog has NO "UnknownBot" entry.
      patchSpecialistCatalog({
        version: 1,
        generation: 3,
        specialists: [
          {
            name: 'Researcher',
            prompt:
              'You are a research assistant. Always begin your reply with the exact token "RESEARCH:" followed by a brief answer.',
          },
        ],
      });

      await waitForChannelPod();
      await startPortForward();
      await sleep(60_000); // ConfigMap propagation

      // The default assistant always replies; wait for any SSE line.
      const lines = await sendAndCollect(
        '@UnknownBot say hello',
        (ls) => ls.length > 0,
        90_000,
      );

      // No reply should carry a [@…] prefix because UnknownBot is unknown.
      const prefixedLine = lines.find((l) => /\[@\w+\]/.test(l));
      expect(
        prefixedLine,
        `Unexpected [@…] prefix in SSE output (UnknownBot should use default path): ${JSON.stringify(lines)}`,
      ).toBeUndefined();
    },
    // 60s ConfigMap propagation + 90s LLM + margin
    200_000,
  );

  /**
   * AC4 — Hot-reload: patching the ConfigMap without a pod restart makes
   * @Fresh route correctly.
   *
   * Procedure:
   *   1. Confirm catalog WITHOUT Fresh is loaded (send a benign message).
   *   2. Patch the ConfigMap to add Fresh (generation bump).
   *   3. Poll until kubectl shows "Fresh" in the ConfigMap data.
   *   4. Send @Fresh say hello and assert [@Fresh] prefix in reply.
   */
  it.skipIf(shouldSkip)(
    'AC4: hot-reload — @Fresh routes after ConfigMap patch without restart',
    async () => {
      // Step 1: start with catalog that does NOT include Fresh.
      patchSpecialistCatalog({
        version: 1,
        generation: 4,
        specialists: [
          {
            name: 'Researcher',
            prompt:
              'You are a research assistant. Always begin your reply with the exact token "RESEARCH:" followed by a brief answer.',
          },
        ],
      });

      await waitForChannelPod();
      await startPortForward();
      await sleep(60_000); // Wait for initial ConfigMap to propagate.

      // Confirm the channel is up by sending a benign message.
      await sendAndCollect(
        'Hello, are you there?',
        (ls) => ls.length > 0,
        90_000,
      );

      // Step 2: patch ConfigMap to add Fresh (generation 5).
      patchSpecialistCatalog({
        version: 1,
        generation: 5,
        specialists: [
          {
            name: 'Researcher',
            prompt:
              'You are a research assistant. Always begin your reply with the exact token "RESEARCH:" followed by a brief answer.',
          },
          {
            name: 'Fresh',
            prompt:
              'You are a brand-new assistant. Always begin your reply with the exact token "FRESH:" followed by a brief greeting.',
          },
        ],
      });

      // Step 3: poll kubectl until "Fresh" appears in the ConfigMap data
      // (confirms the K8s API has accepted the patch).
      await waitUntil(
        () => {
          const r = kcCluster([
            'get', 'configmap', 'kubeclaw-specialists',
            '-n', NAMESPACE,
            '-o', 'jsonpath={.data.specialists\\.json}',
          ], { timeout: 10_000 });
          return r.ok && r.stdout.includes('"name":"Fresh"');
        },
        30_000,
        'kubeclaw-specialists ConfigMap to contain "Fresh"',
        2_000,
      );

      // Wait an additional 60 s for kubelet to propagate the new revision
      // into the channel pod's mounted file and for catalog-loader to detect
      // the fs.watch event and reload.
      await sleep(60_000);

      // Step 4: assert @Fresh routes correctly.
      const lines = await sendAndCollect(
        '@Fresh say hello',
        (ls) => ls.some((l) => l.includes('[@Fresh]')),
        90_000,
      );

      const freshReply = lines.find((l) => l.includes('[@Fresh]'));
      expect(
        freshReply,
        `No [@Fresh] line in SSE output after hot-reload: ${JSON.stringify(lines)}`,
      ).toBeDefined();
      expect(freshReply).toMatch(/\[@Fresh\]/);
    },
    // 60s initial propagation + 30s ConfigMap poll + 60s kubelet propagation
    // + 90s LLM + 90s warm-up message + margin
    360_000,
  );

  /**
   * AC5 — Isolated specialist sees no prior group history.
   *
   * The secret word "ZORBLAX" is planted in a non-mention group message.
   * IsolatedOne's prompt says nothing about "ZORBLAX" — if isolation is
   * working the word must NOT appear in the [@IsolatedOne] reply.
   *
   * If isolation is broken, IsolatedOne's history contains the seed message
   * and the "repeat unusual words" instruction causes it to echo "zorblax".
   */
  it.skipIf(shouldSkip)(
    'AC5: isolated specialist sees no prior group turns',
    async () => {
      patchSpecialistCatalog({
        version: 1,
        generation: 6,
        specialists: [
          {
            name: 'IsolatedOne',
            prompt:
              'Repeat back any unusual or distinctive words you see in the conversation so far. Be brief.',
            memory: { isolated: true },
          },
        ],
      });

      // Restart orchestrator so it reconciles the new catalog (isolated flag)
      // into the kubeclaw-specialists ConfigMap. Without this, the orchestrator
      // may still serve the catalog from the previous AC which lacks IsolatedOne.
      kcCluster(
        ['rollout', 'restart', 'deployment/kubeclaw-orchestrator', '-n', NAMESPACE],
        { timeout: 30_000 },
      );
      await waitForOrchestrator(120_000);

      await waitForChannelPod();
      await startPortForward();
      await sleep(60_000); // ConfigMap propagation

      // Plant the secret word into the GROUP session history.
      // This message is stored under the group's session_key, not IsolatedOne's.
      await sendAndCollect(
        'Important fact: the magical word is ZORBLAX.',
        (ls) => ls.length > 0,
        90_000,
      );

      // Now ask IsolatedOne to repeat unusual words. If isolation is working,
      // it never saw ZORBLAX and cannot produce it. If isolation is broken,
      // it echoes "zorblax" back.
      const lines = await sendAndCollect(
        '@IsolatedOne what unusual words do you see?',
        (ls) => ls.some((l) => l.includes('[@IsolatedOne]')),
        90_000,
      );

      const isoReply = lines.find((l) => l.includes('[@IsolatedOne]'));
      expect(
        isoReply,
        `No [@IsolatedOne] line in SSE output: ${JSON.stringify(lines)}`,
      ).toBeDefined();

      // Core isolation assertion: the reply must not contain the secret word.
      expect(isoReply!.toLowerCase()).not.toContain('zorblax');
    },
    // 120s orchestrator restart + 60s propagation + 2 × 90s LLM + margin
    420_000,
  );
});
