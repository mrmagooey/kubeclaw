/**
 * e2e test: remove_channel story 1 — admin-shell tool
 *
 * Story: As a KubeClaw operator I want to remove a channel (Deployment + K8s
 * Secret + PVC) through the admin shell in a single command so that I can
 * cleanly decommission a channel without manually running multiple kubectl
 * delete commands.
 *
 * Acceptance criteria tested here:
 *   AC1 — admin shell exposes a `remove_channel` tool that accepts instanceName
 *   AC2 — removes Deployment, Secret, and PVC created by setup_channel
 *   AC3 — calling a second time is idempotent (no error)
 *   AC4 — tool reply lists which resources were deleted vs already absent
 *   AC5 — after remove, label selector kubeclaw-channel=<instance> is empty
 *
 * Expected initial failure: step 3 ("AC1/2/5") fails with the executeTool
 * result containing "Unknown tool: remove_channel", because the tool does not
 * yet exist in admin-shell.ts.
 *
 * The test calls executeTool() directly inside the orchestrator pod via
 * kubectl exec so no LLM is needed (deterministic, no model required).
 *
 * Prerequisites:
 *   - A Kubernetes cluster is reachable via the default kubectl context.
 *   - The image kubeclaw-orchestrator:e2e-test is loaded into the cluster.
 *   - helm 3.x on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-rc-test';
const RELEASE = 'kubeclaw-rc-test';
const CHART_DIR = './helm/kubeclaw';
const ADMIN_LOCAL_PORT = 19091; // unique — does not clash with other suites

// Random suffix so back-to-back runs don't conflict on stale PVC names.
const RUN_ID = Math.random().toString(36).slice(2, 7);
const INSTANCE_NAME = `http-removetest-${RUN_ID}`;

// Minimal HTTP user credentials — just need something so setup_channel accepts
// the 'http' type (HTTP_CHANNEL_USERS is a required credential field).
const HTTP_USERS = `testuser:testpass`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run kubectl with -n NAMESPACE; returns { ok, stdout, stderr }. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r: SpawnSyncReturns<string> = spawnSync(
    'kubectl',
    [...args, '-n', NAMESPACE],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: opts.timeout ?? 30_000,
    },
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
  const r: SpawnSyncReturns<string> = spawnSync('kubectl', args, {
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

/** Poll until fn() returns true or timeoutMs elapses. */
async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Wait for the orchestrator Deployment to have at least one Ready pod. */
async function waitForOrchestrator(timeoutMs = 180_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get',
        'pods',
        '-l',
        'app=kubeclaw-orchestrator',
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

/**
 * Call executeTool(toolName, args) directly inside the orchestrator container
 * via kubectl exec.  Returns the string output that executeTool() resolves to.
 *
 * The admin-shell module has a top-level `kc.loadFromCluster()` call and lazy
 * K8s client creation; calling executeTool() from inside the pod is safe.
 * The `KUBERNETES_SERVICE_HOST` guard lives only inside `main()` and does not
 * block the named export.
 */
function execAdminTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
  opts: { timeout?: number } = {},
): { ok: boolean; output: string; stderr: string } {
  const argsJson = JSON.stringify(JSON.stringify(toolArgs));
  // We use a dynamic import so the module-level side effects (KubeConfig.loadFromCluster)
  // execute after the NODE_PATH is set and inside the real cluster environment.
  const script = `
    (async () => {
      try {
        const { executeTool } = await import('/app/dist/admin-shell.js');
        const result = await executeTool(${JSON.stringify(toolName)}, ${argsJson});
        process.stdout.write(result);
        process.exit(0);
      } catch (err) {
        process.stderr.write('exec-error: ' + (err instanceof Error ? err.message + '\\n' + err.stack : String(err)));
        process.exit(1);
      }
    })();
  `;

  const r: SpawnSyncReturns<string> = spawnSync(
    'kubectl',
    [
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
    output: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

/**
 * Return true if a K8s resource exists in the test namespace.
 * kind examples: 'deployment', 'secret', 'persistentvolumeclaim'
 */
function resourceExists(kind: string, name: string): boolean {
  const r = kc(['get', kind, name, '--ignore-not-found', '-o', 'name']);
  return r.stdout.trim().length > 0;
}

/**
 * Wait for the channel Deployment to have a Ready pod.
 */
async function waitForChannelDeployment(
  deploymentName: string,
  timeoutMs = 120_000,
): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get',
        'deployment',
        deploymentName,
        '--ignore-not-found',
        '-o',
        'jsonpath={.status.readyReplicas}',
      ]);
      return r.ok && r.stdout.trim() === '1';
    },
    timeoutMs,
    `channel Deployment ${deploymentName} Ready`,
  );
}

// ─── Install / teardown ───────────────────────────────────────────────────────

/**
 * Install kubeclaw into NAMESPACE with default values.
 * No --wait so we control readiness ourselves.
 */
function helmInstall(): void {
  // Wait for any prior namespace termination to complete.
  spawnSync(
    'kubectl',
    ['wait', '--for=delete', `ns/${NAMESPACE}`, '--timeout=60s'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 70_000 },
  );

  // Ensure namespace does not linger (belt-and-suspenders).
  spawnSync(
    'kubectl',
    ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=true'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
  );

  // Pre-create namespace with Helm ownership metadata (mirrors specialist-catalog pattern).
  spawnSync('kubectl', ['create', 'namespace', NAMESPACE], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  spawnSync(
    'kubectl',
    ['label', 'namespace', NAMESPACE, 'app.kubernetes.io/managed-by=Helm'],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  spawnSync(
    'kubectl',
    [
      'annotate',
      'namespace',
      NAMESPACE,
      `meta.helm.sh/release-name=${RELEASE}`,
      `meta.helm.sh/release-namespace=${NAMESPACE}`,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  const result: SpawnSyncReturns<string> = spawnSync(
    'helm',
    [
      'upgrade',
      '--install',
      RELEASE,
      CHART_DIR,
      '--namespace',
      NAMESPACE,
      '--create-namespace',
      '--timeout',
      '180s',
      '--set',
      `namespace=${NAMESPACE}`,
      '--set',
      'secrets.anthropicApiKey=test-key',
      '--set',
      'secrets.claudeCodeOauthToken=test-token',
      // Use a placeholder OpenAI key — the admin shell itself needs a model
      // to run its REPL, but we call executeTool() directly (no LLM turn).
      '--set',
      'secrets.openaiApiKey=test-key',
      '--set',
      'credentialInjection.mode=off',
      '--set',
      'redis.password=e2e-rc-redis-pass',
      '--set',
      `image.tag=e2e-test`,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `helm upgrade --install failed (exit ${result.status}):\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('remove_channel admin-shell tool (Story 1)', { timeout: 600_000 }, () => {
  // Derived resource names matching the naming convention in channel-setup.ts.
  const deploymentName = `kubeclaw-channel-${INSTANCE_NAME}`;
  const secretName = `kubeclaw-${INSTANCE_NAME}-secrets`;
  const pvcGroups = `kubeclaw-channel-${INSTANCE_NAME}-groups`;
  const pvcStore = `kubeclaw-channel-${INSTANCE_NAME}-store`;
  const pvcSessions = `kubeclaw-channel-${INSTANCE_NAME}-sessions`;

  beforeAll(async () => {
    // Install kubeclaw if not already present in the test namespace.
    // We always ensure a clean slate rather than reusing a potentially dirty one.
    helmInstall();

    // Wait for the orchestrator to be Ready before exercising admin tools.
    await waitForOrchestrator(180_000);
  }, 300_000);

  afterAll(() => {
    // Clean up channel resources if the test left them behind (e.g. on failure).
    for (const resource of [
      `deployment/${deploymentName}`,
      `secret/${secretName}`,
      `persistentvolumeclaim/${pvcGroups}`,
      `persistentvolumeclaim/${pvcStore}`,
      `persistentvolumeclaim/${pvcSessions}`,
    ]) {
      kc(['delete', resource, '--ignore-not-found', '--wait=false'], {
        timeout: 10_000,
      });
    }

    // Uninstall the helm release and delete the namespace.
    spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    spawnSync(
      'kubectl',
      [
        'delete',
        'namespace',
        NAMESPACE,
        '--ignore-not-found',
        '--timeout=60s',
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
    );
  }, 120_000);

  // ── Step 1: set up a channel via setup_channel ───────────────────────────────
  it(
    'setup_channel creates Deployment, Secret, and PVCs for the test instance',
    async () => {
      const result = execAdminTool(
        'setup_channel',
        {
          type: 'http',
          instanceName: INSTANCE_NAME,
          httpUsers: HTTP_USERS,
          httpPort: 4080,
        },
        { timeout: 60_000 },
      );

      expect(
        result.ok,
        `setup_channel exec failed:\nstdout: ${result.output}\nstderr: ${result.stderr}`,
      ).toBe(true);

      // setup_channel returns log lines; success means no "failed" keyword.
      expect(result.output.toLowerCase()).not.toContain('failed');

      // Verify Deployment was created.
      expect(
        resourceExists('deployment', deploymentName),
        `Deployment ${deploymentName} not found after setup_channel`,
      ).toBe(true);

      // Verify Secret was created.
      expect(
        resourceExists('secret', secretName),
        `Secret ${secretName} not found after setup_channel`,
      ).toBe(true);

      // Verify PVCs were created.
      for (const pvc of [pvcGroups, pvcStore, pvcSessions]) {
        expect(
          resourceExists('persistentvolumeclaim', pvc),
          `PVC ${pvc} not found after setup_channel`,
        ).toBe(true);
      }
    },
    90_000,
  );

  // ── Step 2: wait for the channel Deployment to be Ready ─────────────────────
  it(
    'channel Deployment becomes Ready after setup_channel',
    async () => {
      // The Deployment is created; wait for at least one pod to be Ready.
      // On a kind cluster with a local image this is typically 30-60s.
      await waitForChannelDeployment(deploymentName, 120_000);

      const r = kc([
        'get',
        'deployment',
        deploymentName,
        '-o',
        'jsonpath={.status.readyReplicas}',
      ]);
      expect(r.stdout.trim()).toBe('1');
    },
    150_000,
  );

  // ── Step 3: call remove_channel — AC1, AC2, AC4, AC5 ─────────────────────────
  //
  // EXPECTED FAILURE (initial): executeTool('remove_channel', ...) returns
  // "Unknown tool: remove_channel" because the tool is not yet implemented.
  // The assertions below will therefore fail, signalling the implementer.
  it(
    'AC1/AC2: remove_channel tool exists and deletes Deployment, Secret, and PVCs',
    async () => {
      const result = execAdminTool(
        'remove_channel',
        { instanceName: INSTANCE_NAME },
        { timeout: 60_000 },
      );

      // AC1: the tool must be recognised (not returned as "Unknown tool: ...").
      // On the first run this assertion fails because remove_channel is not
      // implemented — that failure is the intended contract signal.
      expect(
        result.output,
        `remove_channel returned an error (tool may not exist yet):\n` +
          `output: ${result.output}\nstderr: ${result.stderr}`,
      ).not.toMatch(/unknown tool/i);

      // AC2: Deployment must be gone.
      expect(
        resourceExists('deployment', deploymentName),
        `Deployment ${deploymentName} still exists after remove_channel`,
      ).toBe(false);

      // AC2: Secret must be gone.
      expect(
        resourceExists('secret', secretName),
        `Secret ${secretName} still exists after remove_channel`,
      ).toBe(false);

      // AC2: PVCs must be gone.
      for (const pvc of [pvcGroups, pvcStore, pvcSessions]) {
        expect(
          resourceExists('persistentvolumeclaim', pvc),
          `PVC ${pvc} still exists after remove_channel`,
        ).toBe(false);
      }

      // AC4: the reply text must mention each resource kind that was deleted.
      const lower = result.output.toLowerCase();
      expect(
        lower,
        `remove_channel reply does not mention "deployment":\n${result.output}`,
      ).toMatch(/deployment/);
      expect(
        lower,
        `remove_channel reply does not mention "secret":\n${result.output}`,
      ).toMatch(/secret/);
      expect(
        lower,
        `remove_channel reply does not mention "pvc" or "persistentvolumeclaim":\n${result.output}`,
      ).toMatch(/pvc|persistentvolumeclaim/);
    },
    90_000,
  );

  // ── Step 4: AC5 — label selector returns no resources ────────────────────────
  it(
    'AC5: label selector kubeclaw-channel=<instance> returns no resources after removal',
    () => {
      // AC5: kubectl get deployment,secret,pvc -l kubeclaw-channel=<instance>
      // must return nothing (empty list).
      // This also validates that setup_channel stamps the label and that
      // remove_channel cleans up labelled resources.
      const r = kc([
        'get',
        'deployment,secret,persistentvolumeclaim',
        '-l',
        `kubeclaw-channel=${INSTANCE_NAME}`,
        '--ignore-not-found',
        '-o',
        'name',
      ]);

      expect(
        r.stdout.trim(),
        `Label selector kubeclaw-channel=${INSTANCE_NAME} still matches resources:\n${r.stdout}`,
      ).toBe('');
    },
  );

  // ── Step 5: AC3 — second call is idempotent ───────────────────────────────────
  it(
    'AC3: calling remove_channel a second time succeeds (idempotent)',
    async () => {
      const result = execAdminTool(
        'remove_channel',
        { instanceName: INSTANCE_NAME },
        { timeout: 60_000 },
      );

      // The tool must not error out when resources are already absent.
      expect(
        result.output,
        `Second remove_channel call errored:\noutput: ${result.output}\nstderr: ${result.stderr}`,
      ).not.toMatch(/unknown tool/i);

      // AC4 (second call): reply must indicate the resources were already absent.
      const lower = result.output.toLowerCase();
      expect(
        lower,
        `Second remove_channel call does not indicate resources were absent:\n${result.output}`,
      ).toMatch(/absent|not found|already|did not exist|missing|none/);
    },
    90_000,
  );
});
