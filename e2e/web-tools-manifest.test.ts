/**
 * Cluster-self-gated manifest test: web_search (credentials → sidecar) + web_fetch (no credentials).
 *
 * Test strategy
 * ─────────────
 * The deployed orchestrator may predate this branch's changes, so we call
 * jobRunner.createSidecarToolPodJob() DIRECTLY against the live cluster API.
 * This creates a real K8s Job whose spec we read back and assert against,
 * without depending on the in-cluster watcher or LLM.
 *
 * Two sub-tests:
 *
 * 1. web_search (credentials: ['brave-search'], mode=sidecar)
 *    - credential-sidecar container present
 *    - user-tool env has BRAVE_API_KEY matching /^(KC_PH_|injected-by-broker)/
 *    - user-tool env has HTTPS_PROXY + SSL_CERT_FILE (sidecar proxy routing)
 *    - spec.template.spec.serviceAccountName == 'kubeclaw-tool-job'
 *    - pod-template annotation kubeclaw.io/owner-group == groupFolder
 *    - kubeclaw-tool-bridge container env has NO BRAVE_API_KEY / HTTPS_PROXY
 *    - volumes include envoy-config, broker-token, egress-ca
 *
 * 2. web_fetch (no credentials)
 *    - NO credential-sidecar container
 *    - user-tool env has NO BRAVE_API_KEY / HTTPS_PROXY
 *
 * Cluster gate
 * ────────────
 * If the orchestrator pod is not running/ready, all tests skip cleanly.
 * The test does NOT require the orchestrator to be on this branch — it calls
 * jobRunner directly, so the deployed orchestrator version does not matter.
 * Jobs only need to CREATE successfully; we assert the manifest, not a running pod.
 *
 * Run: npx vitest run e2e/web-tools-manifest.test.ts --config vitest.e2e.config.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const NAMESPACE = process.env.NAMESPACE || 'kubeclaw';

// jobRunner reads KUBECLAW_NAMESPACE from config.ts at module-load time.
// Set it here (before any dynamic import) so jobs land in the right namespace.
const _prevKubeclawNamespace = process.env.KUBECLAW_NAMESPACE;
if (!process.env.KUBECLAW_NAMESPACE) {
  process.env.KUBECLAW_NAMESPACE = NAMESPACE;
}

// getInjectionMode() in config.ts reads CREDENTIAL_INJECTION_MODE at import time.
// Set before any dynamic import so the sidecar path is exercised.
const _prevInjectionMode = process.env.CREDENTIAL_INJECTION_MODE;
process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';

// ── Cluster-gate helpers ──────────────────────────────────────────────────────

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

function isOrchestratorReady(): boolean {
  const result = kubectl([
    'get', 'pods', '-n', NAMESPACE,
    '-l', 'app=kubeclaw-orchestrator',
    '-o', 'json',
  ]);
  if (!result.ok) return false;
  try {
    const pods = JSON.parse(result.stdout) as {
      items: Array<{
        status: { phase: string; containerStatuses?: Array<{ ready: boolean }> };
      }>;
    };
    if (pods.items.length === 0) return false;
    const pod = pods.items[0];
    return (
      pod.status.phase === 'Running' &&
      (pod.status.containerStatuses?.every((c) => c.ready) ?? false)
    );
  } catch {
    return false;
  }
}

// ── K8s Job type (minimal shape for assertions) ───────────────────────────────

interface K8sContainer {
  name: string;
  image: string;
  command?: string[];
  env?: Array<{ name: string; value?: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; subPath?: string }>;
}

interface K8sJob {
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    template: {
      metadata?: {
        annotations?: Record<string, string>;
      };
      spec: {
        serviceAccountName?: string;
        containers: K8sContainer[];
        volumes?: Array<{
          name: string;
          emptyDir?: Record<string, unknown>;
          persistentVolumeClaim?: { claimName: string };
          configMap?: { name: string };
          secret?: { secretName: string };
          projected?: Record<string, unknown>;
        }>;
      };
    };
  };
}

function pollForJob(labelSelector: string, timeoutMs = 60_000): Promise<K8sJob> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const result = kubectl(
        ['get', 'jobs', '-n', NAMESPACE, '-l', labelSelector, '-o', 'json'],
        { timeout: 15_000 },
      );
      if (result.ok) {
        const items = (JSON.parse(result.stdout) as { items: K8sJob[] }).items;
        if (items.length > 0) return resolve(items[0]);
      }
      if (Date.now() >= deadline) {
        return reject(
          new Error(`Timed out waiting for job with label ${labelSelector}`),
        );
      }
      setTimeout(check, 3000);
    };
    check();
  });
}

async function deleteJobIfExists(jobName: string): Promise<void> {
  kubectl([
    'delete', 'job', '-n', NAMESPACE, jobName,
    '--ignore-not-found=true',
  ]);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('web_search credential-injection + web_fetch plain manifest assertions', () => {
  let orchestratorRunning = false;

  // Jobs created during tests; cleaned up in afterAll.
  const createdJobs: string[] = [];

  beforeAll(() => {
    orchestratorRunning = isOrchestratorReady();
    if (!orchestratorRunning) {
      console.warn(
        `[web-tools-manifest] Orchestrator not ready in namespace ${NAMESPACE} — all tests will skip`,
      );
    }
  });

  afterAll(async () => {
    for (const jobName of createdJobs) {
      await deleteJobIfExists(jobName);
    }
    // Restore env
    if (_prevKubeclawNamespace === undefined) delete process.env.KUBECLAW_NAMESPACE;
    else process.env.KUBECLAW_NAMESPACE = _prevKubeclawNamespace;

    if (_prevInjectionMode === undefined) delete process.env.CREDENTIAL_INJECTION_MODE;
    else process.env.CREDENTIAL_INJECTION_MODE = _prevInjectionMode;
  });

  // ── 1. web_search (credentials + sidecar) ───────────────────────────────────

  it(
    'web_search (credentials: brave-search, mode=sidecar): credential-sidecar present, envs injected on user-tool, bridge isolated',
    async (ctx) => {
      if (!orchestratorRunning) return ctx.skip();

      const { jobRunner } = await import('../src/k8s/job-runner.js');

      // Stub catalog + secret manager so brave-search resolves without a broker
      const BRAVE_ENTRY = {
        id: 'brave-search',
        host: 'api.search.brave.com',
        upstreamPort: 443,
        credentialFields: [{ name: 'api_key', envVar: 'BRAVE_API_KEY' }],
        baseUrlEnvs: {},
        allowOperatorFallback: true,
        allowedPositions: ['header', 'body'],
      };
      (jobRunner as any).catalog = { getCatalog: () => [BRAVE_ENTRY] };
      (jobRunner as any).secretManager = { getGroupPlaceholders: async () => ({}) };

      const agentJobId = `e2e-web-search-${Date.now()}`;
      const groupFolder = `e2e-web-search-${Date.now()}`;
      const toolName = 'web_search';

      const jobName = await jobRunner.createSidecarToolPodJob({
        agentJobId,
        groupFolder,
        toolName,
        toolSpec: {
          name: toolName,
          description: 'Search the web using Brave Search API',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
          image: 'curlimages/curl:latest',
          pattern: 'file',
          mount: 'none',
          credentials: ['brave-search'],
          run: 'curl -s "https://api.search.brave.com/res/v1/web/search?q=$(cat "$INPUT_DIR/query")"',
        },
        timeout: 60_000,
      });
      createdJobs.push(jobName);

      const job = await pollForJob(
        `app=kubeclaw-sidecar-tool,kubeclaw/agent-job=${agentJobId}`,
        60_000,
      );

      const containers = job.spec.template.spec.containers;
      const names = containers.map((c) => c.name);

      // ── credential-sidecar must be present ───────────────────────────────────
      expect(
        names,
        'credential-sidecar container must be present when credentials declared',
      ).toContain('credential-sidecar');

      // ── user-tool assertions ─────────────────────────────────────────────────
      const userTool = containers.find((c) => c.name === 'user-tool')!;
      expect(userTool).toBeDefined();

      const userEnvMap = Object.fromEntries(
        (userTool.env ?? []).map((e) => [e.name, e.value ?? '']),
      );

      // BRAVE_API_KEY must be a placeholder (fallback sentinel KC_PH_FALLBACK_ or injected-by-broker)
      expect(userEnvMap.BRAVE_API_KEY).toMatch(/^(KC_PH_|injected-by-broker)/);

      // Proxy + cert env must be present (sidecar mode adds them)
      expect(userEnvMap.HTTPS_PROXY).toBeDefined();
      expect(userEnvMap.SSL_CERT_FILE).toBeDefined();

      // ── service account ───────────────────────────────────────────────────────
      expect(job.spec.template.spec.serviceAccountName).toBe('kubeclaw-tool-job');

      // ── owner-group annotation ────────────────────────────────────────────────
      const podAnnotations = job.spec.template.metadata?.annotations ?? {};
      expect(podAnnotations['kubeclaw.io/owner-group']).toBe(groupFolder);

      // ── bridge isolation: no credential envs on bridge ────────────────────────
      const bridge = containers.find((c) => c.name === 'kubeclaw-tool-bridge')!;
      expect(bridge).toBeDefined();
      const bridgeEnvMap = Object.fromEntries(
        (bridge.env ?? []).map((e) => [e.name, e.value ?? '']),
      );
      expect(
        bridgeEnvMap.BRAVE_API_KEY,
        'kubeclaw-tool-bridge must not have BRAVE_API_KEY (bridge isolation)',
      ).toBeUndefined();
      expect(
        bridgeEnvMap.HTTPS_PROXY,
        'kubeclaw-tool-bridge must not have HTTPS_PROXY (bridge isolation)',
      ).toBeUndefined();

      // ── sidecar volumes present ──────────────────────────────────────────────
      const volumes = job.spec.template.spec.volumes ?? [];
      const volNames = volumes.map((v) => v.name);
      expect(volNames).toContain('envoy-config');
      expect(volNames).toContain('broker-token');
      expect(volNames).toContain('egress-ca');

      console.log(`web_search credential-sidecar job created: ${jobName}`);
    },
    90_000,
  );

  // ── 2. web_fetch (no credentials) ───────────────────────────────────────────

  it(
    'web_fetch (no credentials): no credential-sidecar, no credential envs on user-tool',
    async (ctx) => {
      if (!orchestratorRunning) return ctx.skip();

      const { jobRunner } = await import('../src/k8s/job-runner.js');

      // Stub catalog + secret manager (even though this tool has no credentials,
      // keep stubs in place for consistency)
      const BRAVE_ENTRY = {
        id: 'brave-search',
        host: 'api.search.brave.com',
        upstreamPort: 443,
        credentialFields: [{ name: 'api_key', envVar: 'BRAVE_API_KEY' }],
        baseUrlEnvs: {},
        allowOperatorFallback: true,
        allowedPositions: ['header', 'body'],
      };
      (jobRunner as any).catalog = { getCatalog: () => [BRAVE_ENTRY] };
      (jobRunner as any).secretManager = { getGroupPlaceholders: async () => ({}) };

      const agentJobId = `e2e-web-fetch-${Date.now()}`;
      const groupFolder = `e2e-web-fetch-${Date.now()}`;
      const toolName = 'web_fetch';

      const jobName = await jobRunner.createSidecarToolPodJob({
        agentJobId,
        groupFolder,
        toolName,
        toolSpec: {
          name: toolName,
          description: 'Fetch a URL and return its content',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
          image: 'curlimages/curl:latest',
          pattern: 'file',
          mount: 'none',
          run: 'curl -sL "$(cat "$INPUT_DIR/url")"',
          // NO credentials field
        },
        timeout: 60_000,
      });
      createdJobs.push(jobName);

      const job = await pollForJob(
        `app=kubeclaw-sidecar-tool,kubeclaw/agent-job=${agentJobId}`,
        60_000,
      );

      const containers = job.spec.template.spec.containers;
      const names = containers.map((c) => c.name);

      // ── NO credential-sidecar ────────────────────────────────────────────────
      expect(
        names,
        'credential-sidecar must NOT be present when no credentials declared',
      ).not.toContain('credential-sidecar');

      // ── user-tool: no credential envs ────────────────────────────────────────
      const userTool = containers.find((c) => c.name === 'user-tool')!;
      expect(userTool).toBeDefined();

      const userEnvMap = Object.fromEntries(
        (userTool.env ?? []).map((e) => [e.name, e.value ?? '']),
      );

      expect(
        userEnvMap.BRAVE_API_KEY,
        'BRAVE_API_KEY must not appear on user-tool for a plain web_fetch',
      ).toBeUndefined();
      expect(
        userEnvMap.HTTPS_PROXY,
        'HTTPS_PROXY must not appear on user-tool when no credentials declared',
      ).toBeUndefined();

      console.log(`web_fetch plain job created: ${jobName}`);
    },
    90_000,
  );
});
