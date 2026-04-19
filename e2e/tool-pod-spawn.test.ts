/**
 * Tool Pod Spawn Watcher E2E Tests
 *
 * Verifies that the orchestrator's startToolPodSpawnWatcher() correctly processes
 * messages from the kubeclaw:spawn-tool-pod stream and creates the right K8s jobs:
 *
 *   - Standard category (no toolImage) → single-container job (app=kubeclaw-tool-pod)
 *   - Sidecar (toolImage present) → two-container job (app=kubeclaw-sidecar-tool)
 *     with kubeclaw-tool-bridge + user-tool containers
 *
 * Requires: orchestrator running in cluster (same prerequisite as orchestrator.test.ts).
 * The global-setup ensures minikube + helm chart are up before tests run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { requireKubernetes, getSharedRedis, getNamespace } from './setup.js';

const NAMESPACE = getNamespace();

interface K8sJob {
  metadata: {
    name: string;
    creationTimestamp: string;
    labels?: Record<string, string>;
  };
  spec: {
    template: {
      spec: {
        containers: Array<{ name: string; image: string; env?: Array<{ name: string; value?: string }> }>;
        volumes?: Array<{ name: string; emptyDir?: object }>;
      };
    };
  };
}

function pollForJob(labelSelector: string, timeoutMs = 60000): Promise<K8sJob> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const result = spawnSync(
        'kubectl',
        ['get', 'jobs', '-n', NAMESPACE, '-l', labelSelector, '-o', 'json'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      if (result.status === 0) {
        const items = (JSON.parse(result.stdout) as { items: K8sJob[] }).items;
        if (items.length > 0) return resolve(items[0]);
      }
      if (Date.now() >= deadline) {
        return reject(new Error(`Timed out waiting for job with label ${labelSelector}`));
      }
      setTimeout(check, 3000);
    };
    check();
  });
}

describe('Tool Pod Spawn Watcher', () => {
  let orchestratorRunning = false;

  beforeAll(() => {
    requireKubernetes();
    try {
      const result = spawnSync(
        'kubectl',
        ['get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-orchestrator', '-o', 'json'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      if (result.status === 0) {
        const pods = JSON.parse(result.stdout).items as Array<{
          status: { phase: string; containerStatuses?: Array<{ ready: boolean }> };
        }>;
        if (pods.length > 0 && pods[0].status.phase === 'Running') {
          orchestratorRunning = pods[0].status.containerStatuses?.every((c) => c.ready) ?? false;
        }
      }
    } catch {
      // orchestrator not deployed
    }
  });

  it('standard category creates a single-container tool pod job', async (ctx) => {
    if (!orchestratorRunning) ctx.skip();
    const redis = getSharedRedis();
    if (!redis) ctx.skip();

    // Trim stream + wait one BLOCK cycle to avoid the lastId='$' race
    await redis.del('kubeclaw:spawn-tool-pod');
    await new Promise((r) => setTimeout(r, 6000));

    const agentJobId = `e2e-tpspawn-std-${Date.now()}`;
    const groupFolder = `spawn-std-${Date.now()}`;

    await redis.xadd(
      'kubeclaw:spawn-tool-pod', '*',
      'agentJobId', agentJobId,
      'groupFolder', groupFolder,
      'category', 'execution',
      'timeout', '60000',
      'channel', '',
    );

    const job = await pollForJob(
      `app=kubeclaw-tool-pod,nanoclaw/agent-job=${agentJobId}`,
    );

    const containers = job.spec.template.spec.containers;
    expect(containers).toHaveLength(1);

    const envMap = Object.fromEntries(
      (containers[0].env ?? []).map((e) => [e.name, e.value ?? '']),
    );
    expect(envMap.KUBECLAW_TOOL_JOB_ID).toBe(agentJobId);
    expect(envMap.KUBECLAW_CATEGORY).toBe('execution');

    console.log(`✅ Standard tool pod job created: ${job.metadata.name}`);
  }, 90000);

  it('sidecar spawn with toolImage creates a two-container job', async (ctx) => {
    if (!orchestratorRunning) ctx.skip();
    const redis = getSharedRedis();
    if (!redis) ctx.skip();

    await redis.del('kubeclaw:spawn-tool-pod');
    await new Promise((r) => setTimeout(r, 6000));

    const agentJobId = `e2e-tpspawn-sc-${Date.now()}`;
    const groupFolder = `spawn-sc-${Date.now()}`;
    const toolName = 'home-control';

    await redis.xadd(
      'kubeclaw:spawn-tool-pod', '*',
      'agentJobId', agentJobId,
      'groupFolder', groupFolder,
      'category', toolName,
      'timeout', '60000',
      'channel', '',
      'toolImage', 'alpine:latest',
      'toolPattern', 'http',
      'toolPort', '8080',
    );

    const job = await pollForJob(
      `app=kubeclaw-sidecar-tool,nanoclaw/agent-job=${agentJobId}`,
    );

    const containers = job.spec.template.spec.containers;
    expect(containers).toHaveLength(2);

    const names = containers.map((c) => c.name);
    expect(names).toContain('kubeclaw-tool-bridge');
    expect(names).toContain('user-tool');

    const userTool = containers.find((c) => c.name === 'user-tool')!;
    expect(userTool.image).toBe('alpine:latest');

    const bridge = containers.find((c) => c.name === 'kubeclaw-tool-bridge')!;
    const bridgeEnv = Object.fromEntries(
      (bridge.env ?? []).map((e) => [e.name, e.value ?? '']),
    );
    expect(bridgeEnv.KUBECLAW_TOOL_MODE).toBe('http-bridge');
    expect(bridgeEnv.KUBECLAW_CATEGORY).toBe(toolName);
    expect(bridgeEnv.KUBECLAW_TOOL_JOB_ID).toBe(agentJobId);

    console.log(`✅ Sidecar tool pod job created: ${job.metadata.name}`);
  }, 90000);

  it('sidecar spawn with file pattern includes shared emptyDir volume', async (ctx) => {
    if (!orchestratorRunning) ctx.skip();
    const redis = getSharedRedis();
    if (!redis) ctx.skip();

    await redis.del('kubeclaw:spawn-tool-pod');
    await new Promise((r) => setTimeout(r, 6000));

    const agentJobId = `e2e-tpspawn-file-${Date.now()}`;
    const groupFolder = `spawn-file-${Date.now()}`;

    await redis.xadd(
      'kubeclaw:spawn-tool-pod', '*',
      'agentJobId', agentJobId,
      'groupFolder', groupFolder,
      'category', 'file-tool',
      'timeout', '60000',
      'channel', '',
      'toolImage', 'alpine:latest',
      'toolPattern', 'file',
    );

    const job = await pollForJob(
      `app=kubeclaw-sidecar-tool,nanoclaw/agent-job=${agentJobId}`,
    );

    const volumes = job.spec.template.spec.volumes ?? [];
    const sharedVol = volumes.find((v) => v.name === 'shared');
    expect(sharedVol).toBeDefined();
    expect(sharedVol!.emptyDir).toBeDefined();

    const bridge = job.spec.template.spec.containers.find(
      (c) => c.name === 'kubeclaw-tool-bridge',
    )!;
    const bridgeEnv = Object.fromEntries(
      (bridge.env ?? []).map((e) => [e.name, e.value ?? '']),
    );
    expect(bridgeEnv.KUBECLAW_TOOL_MODE).toBe('file-bridge');

    console.log(`✅ File-bridge sidecar job created with shared volume: ${job.metadata.name}`);
  }, 90000);
});
