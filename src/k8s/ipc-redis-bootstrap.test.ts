/**
 * Unit tests for Story 174: commit_channel_config IPC handler.
 * Story 176 adds: mismatch detection tests using injected readPvcFiles stub.
 */
import { describe, it, expect, vi } from 'vitest';
import { processCommitChannelConfig } from './ipc-redis-bootstrap.js';
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
    );
    expect(deps.createDeployment).not.toHaveBeenCalled();
  });

  it('steady-state Deployment uses the provided channelBaseImage', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'my-registry/kubeclaw-channel-base:v2',
    );
    const deployment = (deps.createDeployment as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(deployment.spec.template.spec.containers[0].image).toBe(
      'my-registry/kubeclaw-channel-base:v2',
    );
  });

  it('steady-state Deployment runtime PVC name is kubeclaw-channel-<instance>-runtime', async () => {
    const deps = makeDeps();
    await processCommitChannelConfig(
      validPayload,
      deps,
      'kubeclaw-test',
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
      'kubeclaw-channel-base:latest',
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
        'kubeclaw-channel-base:latest',
      ),
    ).resolves.not.toThrow();
  });
});
