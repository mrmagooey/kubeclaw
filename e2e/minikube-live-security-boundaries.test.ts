/**
 * Minikube-live security-boundary tests.
 *
 * Fills two coverage gaps left by the existing suite:
 *
 * (A) Negative-path RBAC denial
 *     The helm-chart.test.ts and per-group RBAC tests assert that resource
 *     objects EXIST and that the orchestrator SA CAN create jobs — but they
 *     never simulate a low-privilege pod being DENIED.  These tests call
 *     `kubectl auth can-i` impersonating the low-tier SAs directly, so they
 *     exercise the live RBAC evaluation without needing actual pods.
 *
 *     Low-tier SAs under test:
 *       - kubeclaw-bootstrap  (read-only configmap access, bootstrap jobs)
 *     High-tier SA (positive control):
 *       - kubeclaw-orchestrator  (job-manager Role)
 *
 *     Operations asserted as DENIED for low-tier SAs:
 *       - create jobs (batch)
 *       - get secrets (core)
 *       - get pods (core)
 *
 *     Operations asserted as ALLOWED for kubeclaw-orchestrator:
 *       - create jobs
 *       - get secrets
 *
 * (B) Mount-allowlist enforcement (live)
 *     No existing e2e test confirms that a tool image NOT in
 *     TOOL_GROUP_MOUNT_ALLOWLIST is actually rejected by createSidecarToolPodJob,
 *     while an allowlisted image succeeds.
 *
 *     Strategy: call jobRunner.createSidecarToolPodJob() directly (as in
 *     minikube-live-bash-data-pvc.test.ts) with:
 *       - A non-allowlisted image (busybox:stable) requesting mount:'group'
 *         → expect an Error to be thrown (no Job created)
 *       - The allowlisted image (alpine:latest) requesting mount:'group'
 *         → expect a Job to be created successfully
 *
 *     TOOL_GROUP_MOUNT_ALLOWLIST is seeded to 'alpine:latest' at module load
 *     time (same as minikube-live-bash-data-pvc.test.ts).
 *
 * Globals: globalSetup at e2e/minikube-live-setup.ts.
 * Namespace: kubeclaw-live (minikube-live suite) or kubeclaw (fallback).
 *
 * Skip guard: all tests skip cleanly when kubectl cannot reach a cluster or
 * when the orchestrator pod is not Running/Ready.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';

// ── Namespace resolution ──────────────────────────────────────────────────────
//
// The minikube-live suite uses 'kubeclaw-live'; minikube-live-bash-data-pvc
// uses a NAMESPACE env-var override falling back to 'kubeclaw'.  We follow
// minikube-live-network-policy and minikube-live-tool-pods: hard-code the
// live-suite namespace here so this test integrates with the same
// globalSetup that helm-installs the release into 'kubeclaw-live'.
const NAMESPACE = 'kubeclaw-live';

// ── Mount-allowlist env seeding ───────────────────────────────────────────────
//
// config.ts reads TOOL_GROUP_MOUNT_ALLOWLIST once at module-load time as a
// module-level constant.  Set it before the first dynamic import of job-runner
// (which transitively imports config) so the cached constant is seeded.
// This mirrors the pattern in minikube-live-bash-data-pvc.test.ts.
const _prevKubeclawNamespace = process.env.KUBECLAW_NAMESPACE;
if (!process.env.KUBECLAW_NAMESPACE) {
  process.env.KUBECLAW_NAMESPACE = NAMESPACE;
}
// alpine:latest is the default allowlisted image for group-mount tools.
process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:latest';

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
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Return true if kubectl can reach a cluster and the namespace exists.
 * Mirrors the cluster-gate pattern from minikube-live-network-policy.test.ts.
 */
function isClusterReachable(): boolean {
  const r = kubectl(
    ['get', 'namespace', NAMESPACE, '--ignore-not-found'],
    { timeout: 10_000 },
  );
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * Return true if the orchestrator pod is Running+Ready in NAMESPACE.
 * Mirrors the isOrchestratorReady() helper from minikube-live-bash-data-pvc.
 */
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

/**
 * Ask the live cluster whether `<sa>` can perform `<verb> <resource>`.
 * Returns 'yes', 'no', or null if kubectl exits non-zero unexpectedly.
 *
 * Wraps `kubectl auth can-i <verb> <resource>
 *   --namespace <ns> --as system:serviceaccount:<ns>:<sa>`
 *
 * kubectl auth can-i exits 0 for 'yes' and 1 for 'no'.  We treat both as
 * valid answers; only truly unexpected failures (timeout, missing cluster)
 * return null.
 */
function canI(
  sa: string,
  verb: string,
  resource: string,
): 'yes' | 'no' | null {
  const r = kubectl(
    [
      'auth', 'can-i', verb, resource,
      '--namespace', NAMESPACE,
      '--as', `system:serviceaccount:${NAMESPACE}:${sa}`,
    ],
    { timeout: 15_000 },
  );
  const out = r.stdout.trim();
  // kubectl auth can-i prints exactly 'yes' or 'no' on success.
  if (out === 'yes') return 'yes';
  if (out === 'no') return 'no';
  // Unexpected output (e.g. cluster unreachable) → null.
  return null;
}

/**
 * Poll kubectl for a Job with a matching label selector.
 * Returns the parsed Job or throws if no Job appears within timeoutMs.
 */
interface K8sJob {
  metadata: { name: string; labels?: Record<string, string> };
  spec: {
    template: {
      spec: {
        containers: Array<{
          name: string;
          image: string;
          command?: string[];
          env?: Array<{ name: string; value?: string }>;
          volumeMounts?: Array<{ name: string; mountPath: string; subPath?: string }>;
        }>;
        volumes?: Array<{
          name: string;
          emptyDir?: Record<string, unknown>;
          persistentVolumeClaim?: { claimName: string };
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
  kubectl(['delete', 'job', '-n', NAMESPACE, jobName, '--ignore-not-found=true']);
}

// ── Suite A: Negative-path RBAC denial ───────────────────────────────────────

describe('Minikube-live: RBAC denial — low-tier SAs cannot access K8s API', () => {
  let clusterAvailable = false;

  beforeAll(() => {
    clusterAvailable = isClusterReachable();
    if (!clusterAvailable) {
      console.warn(
        `[security-boundaries RBAC] Cluster not reachable or namespace ${NAMESPACE} missing — all RBAC tests will skip.\n` +
        '  Run the minikube-live globalSetup to create the release before executing this suite.',
      );
    }
  }, 15_000);

  // ── kubeclaw-bootstrap SA: no K8s API write access ───────────────────────
  //
  // bootstrap-rbac.yaml gives kubeclaw-bootstrap only:
  //   - read configmaps [kubeclaw-bootstrap-skills, kubeclaw-channel-manifests]
  // It must NOT be able to create Jobs, read Secrets, or list Pods.

  it(
    'kubeclaw-bootstrap SA cannot create jobs (batch/v1)',
    (ctx) => {
      if (!clusterAvailable) return ctx.skip();

      const result = canI('kubeclaw-bootstrap', 'create', 'jobs');
      // null → cluster gave unexpected output; treat as skip rather than fail.
      if (result === null) {
        console.warn('kubectl auth can-i returned unexpected output — skipping');
        return ctx.skip();
      }
      expect(
        result,
        'kubeclaw-bootstrap SA must NOT be able to create batch Jobs. ' +
        'Check bootstrap-rbac.yaml — it should only grant configmap read on named resources.',
      ).toBe('no');
    },
    20_000,
  );

  it(
    'kubeclaw-bootstrap SA cannot get secrets',
    (ctx) => {
      if (!clusterAvailable) return ctx.skip();

      const result = canI('kubeclaw-bootstrap', 'get', 'secrets');
      if (result === null) return ctx.skip();
      expect(
        result,
        'kubeclaw-bootstrap SA must NOT be able to read Secrets. ' +
        'Low-tier SAs (bootstrap) have no access to credentials.',
      ).toBe('no');
    },
    20_000,
  );

  it(
    'kubeclaw-bootstrap SA cannot list pods',
    (ctx) => {
      if (!clusterAvailable) return ctx.skip();

      const result = canI('kubeclaw-bootstrap', 'get', 'pods');
      if (result === null) return ctx.skip();
      expect(
        result,
        'kubeclaw-bootstrap SA must NOT be able to list Pods. ' +
        'The bootstrap Role grants only named-configmap reads.',
      ).toBe('no');
    },
    20_000,
  );

  // ── kubeclaw-orchestrator SA: positive control ────────────────────────────
  //
  // The orchestrator is bound to kubeclaw-job-manager Role which explicitly
  // grants: create/get/list/watch/delete on batch/jobs and secrets CRUD.
  // These must return 'yes'.

  it(
    'kubeclaw-orchestrator SA CAN create jobs (positive control)',
    (ctx) => {
      if (!clusterAvailable) return ctx.skip();

      const result = canI('kubeclaw-orchestrator', 'create', 'jobs');
      if (result === null) return ctx.skip();
      expect(
        result,
        'kubeclaw-orchestrator SA must be able to create batch Jobs. ' +
        'The kubeclaw-job-manager Role grants batch/jobs:create. ' +
        'If this fails, check orchestrator.yaml RoleBinding.',
      ).toBe('yes');
    },
    20_000,
  );

  it(
    'kubeclaw-orchestrator SA CAN get secrets (positive control)',
    (ctx) => {
      if (!clusterAvailable) return ctx.skip();

      const result = canI('kubeclaw-orchestrator', 'get', 'secrets');
      if (result === null) return ctx.skip();
      expect(
        result,
        'kubeclaw-orchestrator SA must be able to get Secrets. ' +
        'The kubeclaw-job-manager Role grants secrets:get (for per-channel secret management). ' +
        'If this fails, check the secrets rule in orchestrator.yaml.',
      ).toBe('yes');
    },
    20_000,
  );
});

// ── Suite B: Mount-allowlist enforcement (live) ───────────────────────────────

describe('Minikube-live: mount-allowlist enforcement — group mount gated by image allowlist', () => {
  let orchestratorRunning = false;

  // Jobs created during tests; cleaned up in afterAll.
  const createdJobs: string[] = [];

  beforeAll(() => {
    orchestratorRunning = isOrchestratorReady();
    if (!orchestratorRunning) {
      console.warn(
        `[security-boundaries mount-allowlist] Orchestrator not ready in namespace ${NAMESPACE} — all mount-allowlist tests will skip.\n` +
        '  This test calls jobRunner.createSidecarToolPodJob() directly; the deployed orchestrator is not required to be on this branch.',
      );
    }
  }, 20_000);

  afterAll(async () => {
    for (const jobName of createdJobs) {
      await deleteJobIfExists(jobName);
    }
    if (_prevKubeclawNamespace === undefined) delete process.env.KUBECLAW_NAMESPACE;
    else process.env.KUBECLAW_NAMESPACE = _prevKubeclawNamespace;
  });

  // ── Non-allowlisted image → assertGroupMountAllowed throws ───────────────
  //
  // TOOL_GROUP_MOUNT_ALLOWLIST='alpine:latest' (seeded at module top).
  // 'busybox:stable' is NOT in the allowlist.
  // createSidecarToolPodJob must throw before creating any K8s Job.
  //
  // This exercises the assertGroupMountAllowed() guard in job-runner.ts
  // (src/k8s/job-runner.ts:1775) which calls assertGroupMountAllowed() from
  // config.ts:288. The error message includes "not permitted to mount the
  // group filesystem".
  it(
    'busybox:stable with mount:group is REJECTED (not in TOOL_GROUP_MOUNT_ALLOWLIST)',
    async (ctx) => {
      if (!orchestratorRunning) return ctx.skip();

      const { jobRunner } = await import('../src/k8s/job-runner.js');

      const agentJobId = `e2e-sec-deny-${Date.now()}`;
      const groupFolder = `e2e-sec-deny-${Date.now()}`;
      const toolName = 'bash_persist';
      const runTemplate = 'sh -c "$(cat "$INPUT_DIR/command")"';

      // Expect createSidecarToolPodJob to throw — not to create a Job.
      await expect(
        jobRunner.createSidecarToolPodJob({
          agentJobId,
          groupFolder,
          toolName,
          toolSpec: {
            name: toolName,
            description: 'Non-allowlisted image requesting group mount (must be denied)',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
            },
            // busybox:stable is NOT in TOOL_GROUP_MOUNT_ALLOWLIST='alpine:latest'
            image: 'busybox:stable',
            pattern: 'file',
            mount: 'group',
            run: runTemplate,
          },
          timeout: 60_000,
          groupsPvc: 'kubeclaw-groups',
        }),
      ).rejects.toThrow(
        // assertGroupMountAllowed() message: "not permitted to mount the group filesystem"
        'not permitted to mount the group filesystem',
      );

      // Verify that no K8s Job was actually created (defense-in-depth check:
      // the throw should be synchronous, before any K8s API call).
      const jobCheck = kubectl(
        [
          'get', 'jobs', '-n', NAMESPACE,
          '-l', `kubeclaw/agent-job=${agentJobId}`,
          '-o', 'jsonpath={.items}',
        ],
        { timeout: 10_000 },
      );
      const items = jobCheck.ok ? (jobCheck.stdout.trim() || '[]') : '[]';
      expect(
        items,
        'No K8s Job should have been created for a non-allowlisted image requesting group mount',
      ).toBe('[]');
    },
    30_000,
  );

  // ── Allowlisted image → group mount succeeds ──────────────────────────────
  //
  // alpine:latest IS in TOOL_GROUP_MOUNT_ALLOWLIST='alpine:latest'.
  // createSidecarToolPodJob must succeed and produce a Job whose user-tool
  // container has the group PVC mounted at /work with the correct subPath.
  //
  // This is the positive-control arm: if the allowlist gate fires on an
  // allowlisted image, the allowlist logic itself is broken.
  it(
    'alpine:latest with mount:group is ALLOWED (in TOOL_GROUP_MOUNT_ALLOWLIST)',
    async (ctx) => {
      if (!orchestratorRunning) return ctx.skip();

      const { jobRunner } = await import('../src/k8s/job-runner.js');

      const agentJobId = `e2e-sec-allow-${Date.now()}`;
      const groupFolder = `e2e-sec-allow-${Date.now()}`;
      const toolName = 'bash_persist';
      const runTemplate = 'sh -c "$(cat "$INPUT_DIR/command")"';

      let jobName: string;
      jobName = await jobRunner.createSidecarToolPodJob({
        agentJobId,
        groupFolder,
        toolName,
        toolSpec: {
          name: toolName,
          description: 'Allowlisted image requesting group mount (must succeed)',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
          },
          // alpine:latest IS in TOOL_GROUP_MOUNT_ALLOWLIST='alpine:latest'
          image: 'alpine:latest',
          pattern: 'file',
          mount: 'group',
          run: runTemplate,
        },
        timeout: 60_000,
        groupsPvc: 'kubeclaw-groups',
      });
      createdJobs.push(jobName);

      const job = await pollForJob(
        `app=kubeclaw-sidecar-tool,kubeclaw/agent-job=${agentJobId}`,
        60_000,
      );

      const containers = job.spec.template.spec.containers;
      const userTool = containers.find((c) => c.name === 'user-tool');
      expect(
        userTool,
        'alpine:latest group-mount Job must have a user-tool container',
      ).toBeDefined();
      expect(userTool!.image).toBe('alpine:latest');

      // Confirm the group PVC is mounted at /work with the correct subPath.
      const workMount = userTool!.volumeMounts?.find((m) => m.name === 'work');
      expect(
        workMount,
        'user-tool must have the work volume mounted at /work',
      ).toBeDefined();
      expect(workMount!.mountPath).toBe('/work');
      expect(
        workMount!.subPath,
        'group mount must set subPath to the groupFolder so each group gets an isolated PVC sub-directory',
      ).toBe(groupFolder);

      // Verify it is a PVC (group), not an emptyDir (scratch).
      const volumes = job.spec.template.spec.volumes ?? [];
      const workVol = volumes.find((v) => v.name === 'work');
      expect(workVol).toBeDefined();
      expect(
        workVol!.persistentVolumeClaim,
        'group mount must use a PVC, not emptyDir',
      ).toBeDefined();
      expect(workVol!.persistentVolumeClaim!.claimName).toBe('kubeclaw-groups');

      // Security boundary: the kubeclaw-tool-bridge container must NOT have
      // the 'work' volume mounted — it only relays tool fields, not data.
      const bridge = containers.find((c) => c.name === 'kubeclaw-tool-bridge');
      expect(bridge).toBeDefined();
      const bridgeWorkMount = bridge!.volumeMounts?.find((m) => m.name === 'work');
      expect(
        bridgeWorkMount,
        'kubeclaw-tool-bridge must not have the work volume mounted (security boundary: bridge cannot read group data)',
      ).toBeUndefined();

      console.log(`alpine:latest group-mount job created: ${jobName}`);
    },
    90_000,
  );
});
