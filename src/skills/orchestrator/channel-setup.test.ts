import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    makeApiClient() {
      return {};
    }
  },
  CoreV1Api: class {},
  AppsV1Api: class {},
}));

// ─── Story 181: patchRuntimePvc + waitForDeploymentRollout ───────────────────

import { patchRuntimePvc, waitForDeploymentRollout } from './channel-setup.js';

describe('patchRuntimePvc', () => {
  it('calls patchNamespacedDeployment with the correct volume claimName', async () => {
    const patchFn = vi.fn().mockResolvedValue({});
    const fakeAppsV1 = {
      patchNamespacedDeployment: patchFn,
    } as any;

    await patchRuntimePvc(
      'my-telegram',
      'kubeclaw-channel-my-telegram-runtime-v2',
      {
        appsV1: fakeAppsV1,
        namespace: 'kubeclaw-test',
      },
    );

    expect(patchFn).toHaveBeenCalledOnce();
    const call = patchFn.mock.calls[0][0];
    expect(call.name).toBe('kubeclaw-channel-my-telegram');
    expect(call.namespace).toBe('kubeclaw-test');
    const body = call.body;
    const volumes = body.spec.template.spec.volumes;
    expect(volumes).toContainEqual({
      name: 'runtime',
      persistentVolumeClaim: {
        claimName: 'kubeclaw-channel-my-telegram-runtime-v2',
      },
    });
  });
});

describe('waitForDeploymentRollout', () => {
  it('resolves immediately when deployment is already updated and available', async () => {
    const readFn = vi.fn().mockResolvedValue({
      spec: { replicas: 1 },
      status: { updatedReplicas: 1, availableReplicas: 1 },
    });
    const fakeAppsV1 = { readNamespacedDeployment: readFn } as any;

    await expect(
      waitForDeploymentRollout('kubeclaw-channel-my-telegram', {
        appsV1: fakeAppsV1,
        namespace: 'kubeclaw-test',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
    expect(readFn).toHaveBeenCalledTimes(1);
  });

  it('rejects on timeout if deployment never becomes fully available', async () => {
    const readFn = vi.fn().mockResolvedValue({
      spec: { replicas: 2 },
      status: { updatedReplicas: 1, availableReplicas: 1 },
    });
    const fakeAppsV1 = { readNamespacedDeployment: readFn } as any;

    await expect(
      waitForDeploymentRollout('kubeclaw-channel-my-telegram', {
        appsV1: fakeAppsV1,
        namespace: 'kubeclaw-test',
        pollIntervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/rollout timeout/i);
  });
});
