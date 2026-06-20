/**
 * Unit tests for Story 174: commit_channel_config IPC handler.
 * Story 176 adds: mismatch detection tests using injected readPvcFiles stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  processCommitChannelConfig,
  resolveSteadyStateReplicas,
} from './ipc-redis-bootstrap.js';
import type {
  CommitChannelConfigDeps,
  CommitChannelConfigPayload,
} from './ipc-redis-bootstrap.js';
import { computeManifestHash } from './bootstrap-runner.js';

// ── Canonical content used as "approved manifest" in mismatch tests ───────────
const APPROVED_PKG_JSON = JSON.stringify({ name: 'test', dependencies: {} });
const APPROVED_LOCK_JSON = JSON.stringify({
  lockfileVersion: 3,
  packages: {},
});
const APPROVED_HASH = computeManifestHash(
  APPROVED_PKG_JSON,
  APPROVED_LOCK_JSON,
);

// Deviated content: simulates an extra `npm install` modifying the lockfile
const DEVIATED_PKG_JSON = JSON.stringify({
  name: 'test',
  dependencies: { 'left-pad': '1.3.0' },
});
const DEVIATED_LOCK_JSON = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    'node_modules/left-pad': { version: '1.3.0' },
  },
});

function makeDeps(
  overrides: Partial<CommitChannelConfigDeps> = {},
): CommitChannelConfigDeps {
  return {
    createSecret: vi.fn().mockResolvedValue(undefined),
    createDeployment: vi.fn().mockResolvedValue(undefined),
    publishReply: vi.fn().mockResolvedValue(undefined),
    publishSse: vi.fn().mockResolvedValue(undefined),
    getManifestHash: vi.fn().mockResolvedValue(null), // null = no expected hash (skip check)
    releaseBootstrap: vi.fn(),
    // Story 176: new deps — default to matching content so existing tests pass
    readPvcFiles: vi.fn().mockResolvedValue({
      packageJson: APPROVED_PKG_JSON,
      packageLockJson: APPROVED_LOCK_JSON,
    }),
    deleteJob: vi.fn().mockResolvedValue(undefined),
    deletePvc: vi.fn().mockResolvedValue(undefined),
    recordMismatch: vi.fn(),
    // Task 3: default stub — succeeds silently so existing tests are unaffected
    writeChannelSource: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const validPayload: CommitChannelConfigPayload = {
  type: 'commit_channel_config',
  bootstrapJobId: 'job-abc-123',
  channel_type: 'telegram',
  instance_name: 'my-telegram',
  secret_data: { TELEGRAM_BOT_TOKEN: 'bot123:token' },
  runtime_pvc_lock_hash: 'abc123hash',
};

describe('processCommitChannelConfig', () => {
  it('creates a K8s Secret with the given secret_data', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.createSecret).toHaveBeenCalledWith(
      'kubeclaw-channel-my-telegram-credentials',
      { TELEGRAM_BOT_TOKEN: 'bot123:token' },
    );
  });

  it('creates a steady-state Deployment named kubeclaw-channel-<instance>', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.createDeployment).toHaveBeenCalledOnce();
    const deployment = (deps.createDeployment as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(deployment.metadata.name).toBe('kubeclaw-channel-my-telegram');
  });

  it('steady-state Deployment mounts runtime PVC read-only', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    const deployment = (deps.createDeployment as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const runtimeMount =
      deployment.spec.template.spec.containers[0].volumeMounts.find(
        (m: { mountPath: string; readOnly?: boolean }) =>
          m.mountPath === '/runtime',
      );
    expect(runtimeMount).toBeTruthy();
    expect(runtimeMount?.readOnly).toBe(true);
  });

  it('steady-state Deployment has no KUBECLAW_SUPERUSER or KUBECLAW_BOOTSTRAP_SKILL env', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    const deployment = (deps.createDeployment as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const envNames =
      deployment.spec.template.spec.containers[0].env?.map(
        (e: { name: string }) => e.name,
      ) ?? [];
    expect(envNames).not.toContain('KUBECLAW_SUPERUSER');
    expect(envNames).not.toContain('KUBECLAW_BOOTSTRAP_SKILL');
  });

  it('publishes a success reply to the bootstrap pod', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.publishReply).toHaveBeenCalledWith(
      'kubeclaw:bootstrap-reply:job-abc-123',
      { ok: true },
    );
  });

  it('publishes a SSE "ready" message to the admin', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.publishSse).toHaveBeenCalledWith(
      'kubeclaw:bootstrap:job-abc-123',
      expect.stringContaining('ready'),
    );
  });

  it('releases the bootstrap instance name after success', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.releaseBootstrap).toHaveBeenCalledWith('my-telegram');
  });

  it('publishes failure reply when Secret creation throws', async () => {
    const deps = makeDeps({
      createSecret: vi.fn().mockRejectedValue(new Error('K8s error')),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.publishReply).toHaveBeenCalledWith(
      'kubeclaw:bootstrap-reply:job-abc-123',
      expect.objectContaining({ ok: false }),
    );
    expect(deps.createDeployment).not.toHaveBeenCalled();
  });

  it('does not call createDeployment if createSecret fails', async () => {
    const deps = makeDeps({
      createSecret: vi.fn().mockRejectedValue(new Error('secret error')),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.createDeployment).not.toHaveBeenCalled();
  });

  it('steady-state Deployment uses the provided channelBaseImage', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'my-registry/kubeclaw-agent:v2',
    );
    const deployment = (deps.createDeployment as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(deployment.spec.template.spec.containers[0].image).toBe(
      'my-registry/kubeclaw-agent:v2',
    );
  });

  it('steady-state Deployment runtime PVC name is kubeclaw-channel-<instance>-runtime', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    const deployment = (deps.createDeployment as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const runtimeVol = deployment.spec.template.spec.volumes.find(
      (v: { name: string }) => v.name === 'runtime',
    );
    expect(runtimeVol?.persistentVolumeClaim?.claimName).toBe(
      'kubeclaw-channel-my-telegram-runtime',
    );
  });
});

// ─── Story 176: manifest hash mismatch rejection cascade ─────────────────────

describe('processCommitChannelConfig — manifest hash mismatch (Story 176)', () => {
  it('returns MANIFEST_DIVERGENCE error when PVC hash does not match ConfigMap hash', async () => {
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.publishReply).toHaveBeenCalledWith(
      'kubeclaw:bootstrap-reply:job-abc-123',
      expect.objectContaining({ ok: false }),
    );
    const replyArg = (deps.publishReply as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    const errorObj = JSON.parse(replyArg.error);
    expect(errorObj.code).toBe('MANIFEST_DIVERGENCE');
    expect(errorObj.channel_type).toBe('telegram');
    expect(typeof errorObj.expected_hash).toBe('string');
    expect(typeof errorObj.actual_hash).toBe('string');
    expect(errorObj.expected_hash).not.toBe(errorObj.actual_hash);
  });

  it('does NOT create Secret or Deployment on mismatch', async () => {
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.createSecret).not.toHaveBeenCalled();
    expect(deps.createDeployment).not.toHaveBeenCalled();
  });

  it('deletes PVC and Job on mismatch', async () => {
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.deletePvc).toHaveBeenCalledWith(
      'kubeclaw-channel-my-telegram-runtime',
    );
    expect(deps.deleteJob).toHaveBeenCalledWith(
      'kubeclaw-bootstrap-my-telegram',
    );
  });

  it('records the mismatch metric with channel_type on mismatch', async () => {
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.recordMismatch).toHaveBeenCalledWith({
      channel_type: 'telegram',
    });
  });

  it('publishes an SSE rejection message on mismatch', async () => {
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.publishSse).toHaveBeenCalledWith(
      'kubeclaw:bootstrap:job-abc-123',
      expect.stringContaining('Bootstrap rejected'),
    );
    const sseText = (deps.publishSse as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(sseText).toContain('telegram');
    expect(sseText).toContain('No channel was created');
  });

  it('releases the instance name from activeBootstraps on mismatch', async () => {
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.releaseBootstrap).toHaveBeenCalledWith('my-telegram');
  });

  it('proceeds with happy path when PVC hash matches ConfigMap hash', async () => {
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: APPROVED_PKG_JSON,
        packageLockJson: APPROVED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.createSecret).toHaveBeenCalled();
    expect(deps.createDeployment).toHaveBeenCalled();
    expect(deps.recordMismatch).not.toHaveBeenCalled();
    expect(deps.deletePvc).not.toHaveBeenCalled();
    expect(deps.deleteJob).not.toHaveBeenCalled();
  });

  it('skips PVC read and proceeds to happy path when no manifest hash is registered (null)', async () => {
    // No manifest registered → getManifestHash returns null → PVC read skipped
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(null),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.readPvcFiles).not.toHaveBeenCalled();
    expect(deps.createSecret).toHaveBeenCalled();
    expect(deps.createDeployment).toHaveBeenCalled();
  });

  it('publishes failure reply and does NOT create resources when readPvcFiles throws', async () => {
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockRejectedValue(new Error('kubectl exec failed')),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.publishReply).toHaveBeenCalledWith(
      'kubeclaw:bootstrap-reply:job-abc-123',
      expect.objectContaining({ ok: false }),
    );
    expect(deps.createSecret).not.toHaveBeenCalled();
    expect(deps.createDeployment).not.toHaveBeenCalled();
  });

  it('TOCTOU: rejects even when agent passes the correct post-deviate hash as runtime_pvc_lock_hash', async () => {
    // The agent computed its own hash after the extra install and passed it in.
    // The orchestrator still rejects because it reads the PVC independently.
    const agentComputedDeviatedHash = computeManifestHash(
      DEVIATED_PKG_JSON,
      DEVIATED_LOCK_JSON,
    );
    const payload: CommitChannelConfigPayload = {
      ...validPayload,
      runtime_pvc_lock_hash: agentComputedDeviatedHash,
    };
    const deps = makeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      payload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    // Orchestrator still rejects — TOCTOU window is closed
    expect(deps.createSecret).not.toHaveBeenCalled();
    const replyArg = (deps.publishReply as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    const errorObj = JSON.parse(replyArg.error);
    expect(errorObj.code).toBe('MANIFEST_DIVERGENCE');
  });
});

// ─── Story 180: recordTerminal wiring ────────────────────────────────────────

describe('Story 180: recordTerminal wiring in processCommitChannelConfig', () => {
  it('calls recordTerminal with outcome "succeeded" on happy path', async () => {
    const recordTerminal = vi.fn();
    const deps = makeDeps({ recordTerminal });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'succeeded',
        instanceName: 'my-telegram',
        bootstrapJobId: 'job-abc-123',
      }),
    );
  });

  it('calls recordTerminal with outcome "manifest-divergence" on mismatch', async () => {
    const recordTerminal = vi.fn();
    const deps = makeDeps({
      recordTerminal,
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'manifest-divergence',
        errorCode: 'MANIFEST_DIVERGENCE',
      }),
    );
  });

  it('calls recordTerminal with outcome "error" when createSecret throws', async () => {
    const recordTerminal = vi.fn();
    const deps = makeDeps({
      recordTerminal,
      createSecret: vi.fn().mockRejectedValue(new Error('K8s 500')),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        errorMessage: 'K8s 500',
      }),
    );
  });

  it('does not throw when recordTerminal is absent (backward-compat)', async () => {
    const deps = makeDeps({ recordTerminal: undefined });
    await expect(
      processCommitChannelConfig(
        validPayload,
        deps,
        'kubeclaw-test',
        'kubeclaw-agent:latest',
      ),
    ).resolves.not.toThrow();
  });
});

// ── Upgrade path (Story 181) ──────────────────────────────────────────────────

describe('processCommitChannelConfig — upgrade path', () => {
  function makeUpgradeDeps(
    overrides: Partial<CommitChannelConfigDeps> = {},
  ): CommitChannelConfigDeps & {
    patchedDeployments: Array<{ instanceName: string; newPvcName: string }>;
    rolledOutDeployments: string[];
    scheduledOldPvcDeletions: string[];
  } {
    const patchedDeployments: Array<{
      instanceName: string;
      newPvcName: string;
    }> = [];
    const rolledOutDeployments: string[] = [];
    const scheduledOldPvcDeletions: string[] = [];
    return {
      createSecret: vi.fn().mockResolvedValue(undefined),
      createDeployment: vi.fn().mockResolvedValue(undefined),
      publishReply: vi.fn().mockResolvedValue(undefined),
      publishSse: vi.fn().mockResolvedValue(undefined),
      getManifestHash: vi.fn().mockResolvedValue(null),
      releaseBootstrap: vi.fn(),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: APPROVED_PKG_JSON,
        packageLockJson: APPROVED_LOCK_JSON,
      }),
      deleteJob: vi.fn().mockResolvedValue(undefined),
      deletePvc: vi.fn().mockResolvedValue(undefined),
      recordMismatch: vi.fn(),
      patchDeployment: vi
        .fn()
        .mockImplementation(
          async (instanceName: string, newPvcName: string) => {
            patchedDeployments.push({ instanceName, newPvcName });
          },
        ),
      waitForRollout: vi
        .fn()
        .mockImplementation(async (deploymentName: string) => {
          rolledOutDeployments.push(deploymentName);
        }),
      scheduleOldPvcDeletion: vi
        .fn()
        .mockImplementation((oldPvcName: string) => {
          scheduledOldPvcDeletions.push(oldPvcName);
        }),
      patchedDeployments,
      rolledOutDeployments,
      scheduledOldPvcDeletions,
      ...overrides,
    };
  }

  const upgradePayload: CommitChannelConfigPayload = {
    type: 'commit_channel_config',
    bootstrapJobId: 'upgrade-job-abc',
    channel_type: 'telegram',
    instance_name: 'my-telegram',
    secret_data: { TELEGRAM_BOT_TOKEN: 'bot123:token' },
    upgradeFromPvc: 'kubeclaw-channel-my-telegram-runtime-v1',
  };

  it('calls patchDeployment with instanceName and the new PVC name (from pvcName)', async () => {
    const deps = makeUpgradeDeps();
    await processCommitChannelConfig(
      upgradePayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.patchedDeployments).toEqual([
      {
        instanceName: 'my-telegram',
        newPvcName: 'kubeclaw-channel-my-telegram-runtime',
      },
    ]);
  });

  it('calls waitForRollout with the deployment name', async () => {
    const deps = makeUpgradeDeps();
    await processCommitChannelConfig(
      upgradePayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.rolledOutDeployments).toContain('kubeclaw-channel-my-telegram');
  });

  it('schedules old PVC deletion after rollout succeeds', async () => {
    const deps = makeUpgradeDeps();
    await processCommitChannelConfig(
      upgradePayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.scheduledOldPvcDeletions).toContain(
      'kubeclaw-channel-my-telegram-runtime-v1',
    );
  });

  it('does NOT create a new Deployment (patch only)', async () => {
    const deps = makeUpgradeDeps();
    await processCommitChannelConfig(
      upgradePayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.createDeployment).not.toHaveBeenCalled();
  });

  it('does NOT create or update the Secret (credentials preserved)', async () => {
    const deps = makeUpgradeDeps();
    await processCommitChannelConfig(
      upgradePayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.createSecret).not.toHaveBeenCalled();
  });

  it('releases bootstrap on upgrade success', async () => {
    const deps = makeUpgradeDeps();
    await processCommitChannelConfig(
      upgradePayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.releaseBootstrap).toHaveBeenCalledWith('my-telegram');
  });

  it('publishes SSE success message on upgrade success', async () => {
    const deps = makeUpgradeDeps();
    await processCommitChannelConfig(
      upgradePayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    const sseCall = (
      deps.publishSse as ReturnType<typeof vi.fn>
    ).mock.calls.find(([, text]: [string, string]) =>
      /upgraded|patched|ready/i.test(text),
    );
    expect(sseCall).toBeDefined();
  });

  it('MANIFEST_DIVERGENCE on upgrade: deletes new PVC, does NOT patch Deployment, releases bootstrap', async () => {
    const deps = makeUpgradeDeps({
      getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: DEVIATED_PKG_JSON,
        packageLockJson: DEVIATED_LOCK_JSON,
      }),
    });
    await processCommitChannelConfig(
      upgradePayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.patchedDeployments).toHaveLength(0);
    expect(deps.deletePvc).toHaveBeenCalled();
    expect(deps.releaseBootstrap).toHaveBeenCalledWith('my-telegram');
  });
});

// ─── Story 182: replica cap + RO mount invariant ──────────────────────────────

describe('resolveSteadyStateReplicas — Story 182', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OLD_ENV: any = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES;
    delete process.env.BOOTSTRAP_STEADY_STATE_REPLICAS;
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('returns 1 when env var is absent (default RWO)', () => {
    expect(resolveSteadyStateReplicas()).toBe(1);
  });

  it('returns 1 when accessModes is ReadWriteOnce', () => {
    process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES = 'ReadWriteOnce';
    expect(resolveSteadyStateReplicas()).toBe(1);
  });

  it('caps at 1 even when BOOTSTRAP_STEADY_STATE_REPLICAS=3 and RWO', () => {
    process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES = 'ReadWriteOnce';
    process.env.BOOTSTRAP_STEADY_STATE_REPLICAS = '3';
    expect(resolveSteadyStateReplicas()).toBe(1);
  });

  it('returns BOOTSTRAP_STEADY_STATE_REPLICAS value when RWX', () => {
    process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES = 'ReadWriteMany';
    process.env.BOOTSTRAP_STEADY_STATE_REPLICAS = '3';
    expect(resolveSteadyStateReplicas()).toBe(3);
  });

  it('returns 1 when RWX but BOOTSTRAP_STEADY_STATE_REPLICAS is absent', () => {
    process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES = 'ReadWriteMany';
    expect(resolveSteadyStateReplicas()).toBe(1);
  });

  it('returns 1 when RWX but BOOTSTRAP_STEADY_STATE_REPLICAS is invalid', () => {
    process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES = 'ReadWriteMany';
    process.env.BOOTSTRAP_STEADY_STATE_REPLICAS = 'not-a-number';
    expect(resolveSteadyStateReplicas()).toBe(1);
  });
});

// ─── Channel source push (Task 3) ────────────────────────────────────────────

describe('processCommitChannelConfig — channel source push', () => {
  it('pushes channel source before creating the steady-state Deployment', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      writeChannelSource: vi.fn(async () => {
        calls.push('push');
      }),
      createDeployment: vi.fn(async () => {
        calls.push('deploy');
      }),
    });
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.writeChannelSource).toHaveBeenCalledWith(
      validPayload.instance_name,
      validPayload.channel_type,
    );
    expect(calls).toEqual(['push', 'deploy']);
  });

  it('aborts (no Deployment) when the source push fails', async () => {
    const deps = makeDeps({
      writeChannelSource: vi.fn(async () => {
        throw new Error('exec boom');
      }),
      createDeployment: vi.fn(async () => {}),
    });
    const res = await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
    );
    expect(deps.createDeployment).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      ok: false,
      code: 'CHANNEL_SOURCE_PUSH_FAILED',
    });
  });
});

describe('processCommitChannelConfig — Story 182: replica cap + RO mount invariant', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OLD_ENV: any = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES;
    delete process.env.BOOTSTRAP_STEADY_STATE_REPLICAS;
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  const basePayload: CommitChannelConfigPayload = {
    type: 'commit_channel_config',
    bootstrapJobId: 'job-182',
    channel_type: 'telegram',
    instance_name: 'my-telegram',
    secret_data: { TELEGRAM_BOT_TOKEN: 'bot182' },
  };

  it('Steady-state Deployment has replicas:1 on RWO (default) — AC3', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      basePayload,
      deps,
      'test-ns',
      'kubeclaw-agent:latest',
    );
    const deploymentBody = (deps.createDeployment as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { spec: { replicas: number } };
    expect(deploymentBody.spec.replicas).toBe(1);
  });

  it('Steady-state Deployment has replicas:1 even when BOOTSTRAP_STEADY_STATE_REPLICAS=3 and RWO — AC3 cap', async () => {
    process.env.BOOTSTRAP_STEADY_STATE_REPLICAS = '3';
    process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES = 'ReadWriteOnce';
    const deps = makeDeps();
    await processCommitChannelConfig(
      basePayload,
      deps,
      'test-ns',
      'kubeclaw-agent:latest',
    );
    const deploymentBody = (deps.createDeployment as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { spec: { replicas: number } };
    expect(deploymentBody.spec.replicas).toBe(1);
  });

  it('Steady-state Deployment uses BOOTSTRAP_STEADY_STATE_REPLICAS when RWX — AC2 support', async () => {
    process.env.BOOTSTRAP_STEADY_STATE_REPLICAS = '3';
    process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES = 'ReadWriteMany';
    const deps = makeDeps();
    await processCommitChannelConfig(
      basePayload,
      deps,
      'test-ns',
      'kubeclaw-agent:latest',
    );
    const deploymentBody = (deps.createDeployment as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { spec: { replicas: number } };
    expect(deploymentBody.spec.replicas).toBe(3);
  });

  it('Steady-state Deployment mounts runtime PVC read-only (readOnly: true) — AC4 invariant', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      basePayload,
      deps,
      'test-ns',
      'kubeclaw-agent:latest',
    );
    const deploymentBody = (deps.createDeployment as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as {
      spec: {
        template: {
          spec: {
            containers: Array<{
              name: string;
              volumeMounts?: Array<{ name: string; readOnly?: boolean }>;
            }>;
          };
        };
      };
    };
    const channel = deploymentBody.spec.template.spec.containers.find(
      (c) => c.name === 'channel',
    );
    expect(channel).toBeDefined();
    const runtimeMount = channel!.volumeMounts?.find(
      (vm) => vm.name === 'runtime',
    );
    expect(runtimeMount).toBeDefined();
    expect(runtimeMount!.readOnly).toBe(true);
  });

  it('Steady-state Deployment mounts runtime PVC read-only even when RWX — AC4 invariant', async () => {
    process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES = 'ReadWriteMany';
    const deps = makeDeps();
    await processCommitChannelConfig(
      basePayload,
      deps,
      'test-ns',
      'kubeclaw-agent:latest',
    );
    const deploymentBody = (deps.createDeployment as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as {
      spec: {
        template: {
          spec: {
            containers: Array<{
              name: string;
              volumeMounts?: Array<{ name: string; readOnly?: boolean }>;
            }>;
          };
        };
      };
    };
    const channel = deploymentBody.spec.template.spec.containers.find(
      (c) => c.name === 'channel',
    );
    const runtimeMount = channel!.volumeMounts?.find(
      (vm) => vm.name === 'runtime',
    );
    expect(runtimeMount!.readOnly).toBe(true);
  });
});
