/**
 * E2E: remove_channel admin shell tool
 *
 * Tests that the remove_channel tool in admin-shell.ts correctly removes
 * a channel's Deployment, Secret, and PersistentVolumeClaims, and that
 * setup_channel stamps the kubeclaw-channel=<instance> label on all
 * created resources so AC5 label-selector cleanup verification works.
 *
 * Requires: kind cluster `kubeclaw-e2e-istio` with kubeclaw installed
 *   (kubectl context = kind-kubeclaw-e2e-istio, namespace = kubeclaw).
 *   Image `kubeclaw-orchestrator:e2e-test` must be pre-loaded into kind.
 * Does NOT require a live LLM — calls executeTool() directly via kubectl exec.
 *
 * Run:
 *   docker build -t kubeclaw-orchestrator:e2e-test .
 *   docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch.tar
 *   kind load image-archive /tmp/orch.tar --name kubeclaw-e2e-istio
 *   kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw --ignore-not-found --timeout=60s
 *   kubectl config use-context kind-kubeclaw-e2e-istio
 *   KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run --config vitest.e2e.config.ts remove-channel
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';

// ── Constants ──────────────────────────────────────────────────────────────────

const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const NAMESPACE = 'kubeclaw';
const CHART_DIR = './helm/kubeclaw';
const RELEASE = 'kubeclaw';

// Use a unique instance name per test run to avoid Deployment selector
// immutability conflicts if the namespace is not wiped between runs.
const INSTANCE_SUFFIX = Math.random().toString(36).slice(2, 7);
const INSTANCE_NAME = `http-removetest-${INSTANCE_SUFFIX}`;
const DEPLOYMENT_NAME = `kubeclaw-channel-${INSTANCE_NAME}`;
const SECRET_NAME = `kubeclaw-${INSTANCE_NAME}-secrets`;
const PVC_NAMES = [
  `kubeclaw-channel-${INSTANCE_NAME}-groups`,
  `kubeclaw-channel-${INSTANCE_NAME}-store`,
  `kubeclaw-channel-${INSTANCE_NAME}-sessions`,
];

const RESOURCE_READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

// ── Skip guard ──────────────────────────────────────────────────────────────────
// Skip the whole suite if the kind cluster context is not present.

const contextAvailable =
  spawnSync('kubectl', ['config', 'get-contexts', KUBE_CONTEXT], {
    stdio: 'pipe',
  }).status === 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run kubectl with --context=KUBE_CONTEXT and return result. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
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
 * Call executeTool inside the orchestrator pod via kubectl exec.
 * Uses dynamic import of the compiled admin-shell.js — no LLM needed.
 * The script runs as an ES module (`--input-type=module`) so dynamic
 * import() works without transpilation.
 */
function runAdminTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  // Build the inline ESM script.  JSON.stringify is safe for embedding in
  // the double-quoted node -e argument because it produces only ASCII
  // printable characters and does not include unescaped quotes.
  const script = `import('/app/dist/admin-shell.js').then(async m => {
  const result = await m.executeTool(${JSON.stringify(toolName)}, ${JSON.stringify(input)});
  process.stdout.write(result + '\\n');
}).catch(e => {
  process.stderr.write(String(e) + '\\n');
  process.exit(1);
});`;

  const r = spawnSync(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      '-n',
      NAMESPACE,
      'exec',
      'deployment/kubeclaw-orchestrator',
      '-c',
      'orchestrator',
      '--',
      'node',
      '--input-type=module',
      '-e',
      script,
    ],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: opts.timeout ?? 60_000,
    },
  );
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Poll condition until it returns true, or throw on timeout. */
async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ── Suite setup / teardown ─────────────────────────────────────────────────────

beforeAll(async () => {
  if (!contextAvailable) return; // suite is skipped — nothing to set up

  // Check if kubeclaw is already installed in the kind cluster.
  const helmStatus = spawnSync(
    'helm',
    ['--kube-context', KUBE_CONTEXT, 'status', RELEASE, '--namespace', NAMESPACE],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  if (helmStatus.status !== 0) {
    // Install kubeclaw.  The caller must have pre-loaded
    // kubeclaw-orchestrator:e2e-test into the kind cluster with:
    //   docker build -t kubeclaw-orchestrator:e2e-test .
    //   docker save ... | kind load image-archive ...
    console.log(`Installing kubeclaw into ${KUBE_CONTEXT}...`);
    kc(['create', 'namespace', NAMESPACE]);
    const install = spawnSync(
      'helm',
      [
        '--kube-context', KUBE_CONTEXT,
        'upgrade', '--install',
        RELEASE, CHART_DIR,
        '--namespace', NAMESPACE,
        '--timeout', '120s',
        '--set', `namespace=${NAMESPACE}`,
        '--set', 'secrets.anthropicApiKey=test-key',
        '--set', 'redis.password=e2e-test-pass',
        '--set', 'image.tag=e2e-test',
        '--set', 'image.pullPolicy=Never',
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 180_000 },
    );
    if (install.status !== 0) {
      throw new Error(
        `helm install failed:\nstdout: ${install.stdout}\nstderr: ${install.stderr}`,
      );
    }
  }

  // Wait for orchestrator pod to be Ready (up to 120s).
  console.log('Waiting for kubeclaw-orchestrator to be Ready...');
  await waitUntil(
    () => {
      const r = kc([
        'get', 'deployment', 'kubeclaw-orchestrator',
        '-n', NAMESPACE,
        '-o', 'jsonpath={.status.readyReplicas}',
      ]);
      return r.ok && r.stdout.trim() === '1';
    },
    120_000,
    'kubeclaw-orchestrator readyReplicas=1',
  );
  console.log('kubeclaw-orchestrator is Ready');
}, 180_000);

afterAll(() => {
  if (!contextAvailable) return;
  // Best-effort cleanup of any test channel resources left by a failed run.
  kc(['delete', 'deployment', DEPLOYMENT_NAME, '-n', NAMESPACE, '--ignore-not-found']);
  kc(['delete', 'secret', SECRET_NAME, '-n', NAMESPACE, '--ignore-not-found']);
  for (const pvc of PVC_NAMES) {
    kc(['delete', 'pvc', pvc, '-n', NAMESPACE, '--ignore-not-found']);
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe.skipIf(!contextAvailable)(
  `remove_channel admin shell tool (instance: ${INSTANCE_NAME})`,
  () => {
    it(
      'setup_channel creates Deployment, Secret, and PVCs',
      async () => {
        const result = runAdminTool(
          'setup_channel',
          {
            type: 'http',
            instanceName: INSTANCE_NAME,
            httpUsers: 'testuser:testpass',
            httpPort: 4080,
          },
          { timeout: 90_000 },
        );

        expect(
          result.ok,
          `setup_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        ).toBe(true);
        expect(result.stdout).toMatch(/Created|Updated/);

        // Wait for the Deployment to appear (K8s API may lag slightly).
        await waitUntil(
          () => kc(['get', 'deployment', DEPLOYMENT_NAME, '-n', NAMESPACE]).ok,
          RESOURCE_READY_TIMEOUT_MS,
          `Deployment ${DEPLOYMENT_NAME} to exist`,
        );

        // Secret must exist.
        const secretCheck = kc(['get', 'secret', SECRET_NAME, '-n', NAMESPACE]);
        expect(
          secretCheck.ok,
          `Secret ${SECRET_NAME} not found:\n${secretCheck.stderr}`,
        ).toBe(true);

        // All 3 PVCs must exist.
        for (const pvc of PVC_NAMES) {
          const pvcCheck = kc(['get', 'pvc', pvc, '-n', NAMESPACE]);
          expect(
            pvcCheck.ok,
            `PVC ${pvc} not found:\n${pvcCheck.stderr}`,
          ).toBe(true);
        }
      },
      RESOURCE_READY_TIMEOUT_MS + 30_000,
    );

    it(
      'channel Deployment becomes Ready',
      async () => {
        await waitUntil(
          () => {
            const r = kc([
              'get', 'deployment', DEPLOYMENT_NAME,
              '-n', NAMESPACE,
              '-o', 'jsonpath={.status.readyReplicas}',
            ]);
            return r.ok && r.stdout.trim() === '1';
          },
          RESOURCE_READY_TIMEOUT_MS,
          `Deployment ${DEPLOYMENT_NAME} readyReplicas=1`,
        );
      },
      RESOURCE_READY_TIMEOUT_MS + 10_000,
    );

    it(
      'AC1/AC2: remove_channel tool exists and deletes Deployment, Secret, and PVCs',
      async () => {
        const result = runAdminTool(
          'remove_channel',
          { instanceName: INSTANCE_NAME },
          { timeout: 60_000 },
        );

        expect(
          result.ok,
          `remove_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        ).toBe(true);

        const output = result.stdout;
        expect(output, 'Expected "Deleted:" in output').toContain('Deleted:');
        expect(output).toContain(DEPLOYMENT_NAME);
        expect(output).toContain(SECRET_NAME);
        for (const pvc of PVC_NAMES) {
          expect(output, `Expected PVC ${pvc} in output`).toContain(pvc);
        }

        // Wait for ALL resources (Deployment + PVCs) to be fully gone from the
        // API server.  PVCs with the pvc-protection finalizer may linger in
        // Terminating state while a pod still holds a reference; we must wait
        // for them to fully disappear so AC3 (idempotent check) sees 404s,
        // not a successful delete on a still-terminating PVC.
        await waitUntil(
          () => {
            const labelCheck = kc([
              'get', 'deployment,secret,pvc',
              '-n', NAMESPACE,
              '-l', `kubeclaw-channel=${INSTANCE_NAME}`,
              '--ignore-not-found',
              '-o', 'name',
            ]);
            return labelCheck.ok && labelCheck.stdout.trim() === '';
          },
          60_000,
          'all kubeclaw-channel resources to be fully absent after first remove_channel',
        );
      },
      90_000,
    );

    it(
      'AC3: idempotent — second remove_channel call succeeds with already-absent summary',
      () => {
        const result = runAdminTool(
          'remove_channel',
          { instanceName: INSTANCE_NAME },
          { timeout: 30_000 },
        );

        expect(
          result.ok,
          `second remove_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        ).toBe(true);

        const output = result.stdout;
        expect(output, 'Expected "Already absent:" in output').toContain('Already absent:');
        // Must NOT report any deletions (the "Deleted:\n" line is absent;
        // "Nothing deleted." is the marker when deleted=[] in summary).
        expect(output, 'Should not contain "Deleted:" on second call').not.toMatch(
          /^Deleted:/m,
        );
      },
      30_000,
    );

    it(
      'AC5: kubectl label selector finds no resources after remove',
      async () => {
        // PVCs with the pvc-protection finalizer enter Terminating state when
        // a pod still held a reference.  Poll until the label selector returns
        // nothing (all resources fully gone, not just marked for deletion).
        await waitUntil(
          () => {
            const result = kc([
              'get', 'deployment,secret,pvc',
              '-n', NAMESPACE,
              '-l', `kubeclaw-channel=${INSTANCE_NAME}`,
              '--ignore-not-found',
              '-o', 'name',
            ]);
            return result.ok && result.stdout.trim() === '';
          },
          30_000,
          `all kubeclaw-channel=${INSTANCE_NAME} resources to be absent`,
        );
      },
      35_000,
    );
  },
);
