/**
 * Unit tests for Story 174: commit_channel_config IPC handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { processCommitChannelConfig } from './ipc-redis-bootstrap.js';
import type {
  CommitChannelConfigDeps,
  CommitChannelConfigPayload,
} from './ipc-redis-bootstrap.js';

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
