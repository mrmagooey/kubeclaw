/**
 * Minikube-live e2e: bash / bash_persist catalog tools — file-bridge + mounts.
 *
 * Prior version (Story 169) tested the old execution-category dispatch path
 * (app=kubeclaw-tool-pod, category=execution, tool-server.js) which is being
 * replaced by the file-bridge + catalog form introduced in feat/tool-mounts-bash.
 * Those execution-category assertions have been removed and replaced here.
 *
 * Test strategy
 * ─────────────
 * The deployed orchestrator may predate this branch's changes, so we call
 * jobRunner.createSidecarToolPodJob() DIRECTLY against the live cluster API
 * (the same pattern used by the requestMapping test in tool-pod-spawn.test.ts).
 * This creates a real K8s Job whose spec we read back and assert against,
 * without depending on the in-cluster watcher or LLM.
 *
 * Two sub-tests:
 *
 * 1. file+scratch: bash tool (mount: 'scratch')
 *    - Job label: app=kubeclaw-sidecar-tool
 *    - Containers: kubeclaw-tool-bridge + user-tool (image alpine:latest)
 *    - user-tool command: ['/bin/sh', '/kubeclaw/tool-wrapper.sh']
 *    - user-tool has a 'work' emptyDir volume mounted at /work
 *    - user-tool env: KUBECLAW_TOOL_RUN, WORKDIR=/work, KUBECLAW_TOOL_FIELDS=command
 *    - kubeclaw-tool-bridge does NOT have the 'work' volume mounted (security boundary)
 *
 * 2. file+group: bash_persist tool (mount: 'group')
 *    - user-tool has a 'work' PVC (kubeclaw-groups) mounted at /work
 *      with subPath == groupFolder
 *    - kubeclaw-tool-bridge does NOT have the 'work' volume mounted
 *
 * Why no PVC write/read round-trip?
 *   A full Redis+LLM round trip to verify bash_persist data persistence would
 *   require the deployed orchestrator to understand the new catalog tool format,
 *   which it may not (predates this branch). The manifest-level assertions here
 *   plus the Task-8 integration test (tool-catalog-spawn.test.ts) cover the
 *   behavioral path. This test confirms the real K8s Job spec produced by the
 *   new createSidecarToolPodJob code is correct.
 *
 * Cluster gate
 * ────────────
 * If the orchestrator pod is not running/ready, all tests skip cleanly.
 * The test does NOT require the orchestrator to be on this branch — it calls
 * jobRunner directly, so the deployed orchestrator version does not matter.
 *
 * Run: npx vitest run e2e/minikube-live-bash-data-pvc.test.ts --config vitest.e2e.config.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const NAMESPACE = process.env.NAMESPACE || 'kubeclaw';

// jobRunner reads KUBECLAW_NAMESPACE from config.ts at module-load time.
// Set it here (before any dynamic import) so jobs land in the right namespace.
// The minikube-live config has no env{} block, so we must self-seed it.
if (!process.env.KUBECLAW_NAMESPACE) {
  process.env.KUBECLAW_NAMESPACE = NAMESPACE;
}

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
  metadata: { name: string; labels?: Record<string, string> };
  spec: {
    template: {
      spec: {
        containers: K8sContainer[];
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
  kubectl([
    'delete', 'job', '-n', NAMESPACE, jobName,
    '--ignore-not-found=true',
  ]);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: bash catalog tool — file-bridge + mounts manifest assertions', () => {
  let orchestratorRunning = false;

  // Jobs created during tests; cleaned up in afterAll.
  const createdJobs: string[] = [];

  beforeAll(() => {
    orchestratorRunning = isOrchestratorReady();
    if (!orchestratorRunning) {
      console.warn(
        `[minikube-live-bash-data-pvc] Orchestrator not ready in namespace ${NAMESPACE} — all tests will skip`,
      );
    }
  });

  afterAll(async () => {
    for (const jobName of createdJobs) {
      await deleteJobIfExists(jobName);
    }
  });

  // ── 1. file + scratch ────────────────────────────────────────────────────────

  it(
    'bash (file+scratch): job has two containers, wrapper command, work emptyDir on user-tool only',
    async (ctx) => {
      if (!orchestratorRunning) return ctx.skip();

      // Set the group mount allowlist in process env so assertGroupMountAllowed
      // passes for alpine:latest. (scratch does not call assertGroupMountAllowed,
      // but assertToolImageAllowed passes when the list is empty anyway.)
      process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:latest';

      const { jobRunner } = await import('../src/k8s/job-runner.js');

      const agentJobId = `e2e-bash-scratch-${Date.now()}`;
      const groupFolder = `e2e-bash-scratch-${Date.now()}`;
      const toolName = 'bash';
      const runTemplate = 'sh -c "$(cat "$INPUT_DIR/command")"';

      let jobName: string;
      try {
        jobName = await jobRunner.createSidecarToolPodJob({
          agentJobId,
          groupFolder,
          toolName,
          toolSpec: {
            name: toolName,
            description: 'Run a bash command (scratch workspace)',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
            },
            image: 'alpine:latest',
            pattern: 'file',
            mount: 'scratch',
            run: runTemplate,
          },
          timeout: 60_000,
        });
      } finally {
        delete process.env.TOOL_GROUP_MOUNT_ALLOWLIST;
      }
      createdJobs.push(jobName!);

      const job = await pollForJob(
        `app=kubeclaw-sidecar-tool,kubeclaw/agent-job=${agentJobId}`,
        60_000,
      );

      // ── container count + names ──────────────────────────────────────────────
      const containers = job.spec.template.spec.containers;
      expect(containers).toHaveLength(2);
      const names = containers.map((c) => c.name);
      expect(names).toContain('kubeclaw-tool-bridge');
      expect(names).toContain('user-tool');

      // ── user-tool assertions ─────────────────────────────────────────────────
      const userTool = containers.find((c) => c.name === 'user-tool')!;
      expect(userTool).toBeDefined();
      expect(userTool.image).toBe('alpine:latest');

      // Command must be the wrapper script (not the toolSpec.run shell command directly)
      expect(userTool.command).toEqual(['/bin/sh', '/kubeclaw/tool-wrapper.sh']);

      // user-tool must have 'work' emptyDir mounted at /work
      const workMount = userTool.volumeMounts?.find((m) => m.name === 'work');
      expect(workMount).toBeDefined();
      expect(workMount!.mountPath).toBe('/work');
      // scratch: no subPath (plain emptyDir)
      expect(workMount!.subPath).toBeUndefined();

      // env assertions
      const userEnvMap = Object.fromEntries(
        (userTool.env ?? []).map((e) => [e.name, e.value ?? '']),
      );
      expect(userEnvMap.KUBECLAW_TOOL_RUN).toBe(runTemplate);
      expect(userEnvMap.WORKDIR).toBe('/work');
      expect(userEnvMap.KUBECLAW_TOOL_FIELDS).toBe('command');

      // ── volume assertions ────────────────────────────────────────────────────
      const volumes = job.spec.template.spec.volumes ?? [];
      const workVol = volumes.find((v) => v.name === 'work');
      expect(workVol).toBeDefined();
      expect(workVol!.emptyDir).toBeDefined();
      // scratch → no PVC
      expect(workVol!.persistentVolumeClaim).toBeUndefined();

      // ── security boundary: bridge must NOT have the 'work' volume mounted ────
      const bridge = containers.find((c) => c.name === 'kubeclaw-tool-bridge')!;
      const bridgeWorkMount = bridge.volumeMounts?.find((m) => m.name === 'work');
      expect(
        bridgeWorkMount,
        'kubeclaw-tool-bridge must not have the work volume mounted (security boundary)',
      ).toBeUndefined();

      console.log(`bash file+scratch job created: ${jobName!}`);
    },
    90_000,
  );

  // ── 2. file + group ──────────────────────────────────────────────────────────

  it(
    'bash_persist (file+group): user-tool has group PVC at /work with subPath; bridge has no work mount',
    async (ctx) => {
      if (!orchestratorRunning) return ctx.skip();

      // alpine:latest must be in the group mount allowlist for this test.
      process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:latest';

      const { jobRunner } = await import('../src/k8s/job-runner.js');

      const agentJobId = `e2e-bash-group-${Date.now()}`;
      const groupFolder = `e2e-bash-group-${Date.now()}`;
      const toolName = 'bash_persist';
      const runTemplate = 'sh -c "$(cat "$INPUT_DIR/command")"';

      let jobName: string;
      try {
        jobName = await jobRunner.createSidecarToolPodJob({
          agentJobId,
          groupFolder,
          toolName,
          toolSpec: {
            name: toolName,
            description: 'Run a bash command with persistent group workspace',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
            },
            image: 'alpine:latest',
            pattern: 'file',
            mount: 'group',
            run: runTemplate,
          },
          timeout: 60_000,
          groupsPvc: 'kubeclaw-groups',
        });
      } finally {
        delete process.env.TOOL_GROUP_MOUNT_ALLOWLIST;
      }
      createdJobs.push(jobName!);

      const job = await pollForJob(
        `app=kubeclaw-sidecar-tool,kubeclaw/agent-job=${agentJobId}`,
        60_000,
      );

      const containers = job.spec.template.spec.containers;
      expect(containers).toHaveLength(2);

      // ── user-tool: group PVC mounted at /work with subPath == groupFolder ────
      const userTool = containers.find((c) => c.name === 'user-tool')!;
      expect(userTool).toBeDefined();
      expect(userTool.image).toBe('alpine:latest');

      const workMount = userTool.volumeMounts?.find((m) => m.name === 'work');
      expect(workMount).toBeDefined();
      expect(workMount!.mountPath).toBe('/work');
      // group mount: subPath must be the groupFolder
      expect(workMount!.subPath).toBe(groupFolder);

      // ── volume: must be a PVC (kubeclaw-groups), not emptyDir ────────────────
      const volumes = job.spec.template.spec.volumes ?? [];
      const workVol = volumes.find((v) => v.name === 'work');
      expect(workVol).toBeDefined();
      expect(
        workVol!.persistentVolumeClaim,
        'work volume must be a PVC for group mount',
      ).toBeDefined();
      expect(workVol!.persistentVolumeClaim!.claimName).toBe('kubeclaw-groups');
      // group → no emptyDir
      expect(workVol!.emptyDir).toBeUndefined();

      // ── env: WORKDIR=/work, run template and fields ──────────────────────────
      const userEnvMap = Object.fromEntries(
        (userTool.env ?? []).map((e) => [e.name, e.value ?? '']),
      );
      expect(userEnvMap.KUBECLAW_TOOL_RUN).toBe(runTemplate);
      expect(userEnvMap.WORKDIR).toBe('/work');
      expect(userEnvMap.KUBECLAW_TOOL_FIELDS).toBe('command');

      // ── security boundary: bridge must NOT have the 'work' volume mounted ────
      const bridge = containers.find((c) => c.name === 'kubeclaw-tool-bridge')!;
      const bridgeWorkMount = bridge.volumeMounts?.find((m) => m.name === 'work');
      expect(
        bridgeWorkMount,
        'kubeclaw-tool-bridge must not have the work volume mounted (security boundary)',
      ).toBeUndefined();

      console.log(`bash_persist file+group job created: ${jobName!}`);
    },
    90_000,
  );
});
