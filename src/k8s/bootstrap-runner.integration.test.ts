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
    // Story 176: read PVC files — default to empty content (no hash check in these tests)
    readPvcFiles: async (_instanceName: string) => ({
      packageJson: JSON.stringify({ name: 'test', dependencies: {} }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    }),
    deleteJob: async (_name: string) => {},
    deletePvc: async (_name: string) => {},
    recordMismatch: (_labels: { channel_type: string }) => {},
    // Task 3: write channel source files — no-op
    writeChannelSource: async (
      _instanceName: string,
      _channelType: string,
    ) => {},
    // Task 5: host mode deps — default standalone
    getChannelHostMode: async (_channelType: string) => 'standalone' as const,
    createPvc: async (_name: string, _sizeGi: number) => {},
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
      channelBaseImage: 'kubeclaw-agent:test',
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
      channelBaseImage: 'kubeclaw-agent:test',
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
      channelBaseImage: 'kubeclaw-agent:test',
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
      channelBaseImage: 'kubeclaw-agent:test',
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
      channelBaseImage: 'kubeclaw-agent:test',
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
      channelBaseImage: 'kubeclaw-agent:test',
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
      'kubeclaw-agent:latest',
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
      'kubeclaw-agent:latest',
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
      'kubeclaw-agent:latest',
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
      'kubeclaw-agent:latest',
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
      'kubeclaw-agent:latest',
    );

    expect(activeBootstraps.has('tg-integ')).toBe(false);
  });

  it('publishes SSE notification on success', async () => {
    await processCommitChannelConfig(
      payload,
      deps,
      'kubeclaw-test',
      'kubeclaw-agent:latest',
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
      'kubeclaw-agent:latest',
    );

    expect(deps.createdDeployments).toHaveLength(0);
    expect(deps.replies[0].payload).toMatchObject({ ok: false });
    expect(deps.sseMessages[0].text).toContain('K8s 403 Forbidden');
  });
});

// ── Story 175: reconcileOrphanedBootstrapsOnStartup integration ───────────────

import {
  cleanupBootstrapResources,
  reconcileOrphanedBootstrapsOnStartup,
} from './bootstrap-runner.js';
import type {
  CleanupBootstrapDeps,
  ReconcileOrphanedBootstrapsDeps,
  FailedBootstrapJob,
} from './bootstrap-runner.js';

function makeIntegCleanupDeps(): CleanupBootstrapDeps & {
  deletedJobs: string[];
  deletedPvcs: string[];
  deletedSecrets: string[];
  sseMessages: Array<{
    topic: string;
    payload: { type: string; text: string };
  }>;
} {
  const deletedJobs: string[] = [];
  const deletedPvcs: string[] = [];
  const deletedSecrets: string[] = [];
  const sseMessages: Array<{
    topic: string;
    payload: { type: string; text: string };
  }> = [];
  const activeBootstraps = new Map<string, string>();

  return {
    deletedJobs,
    deletedPvcs,
    deletedSecrets,
    sseMessages,
    activeBootstraps,
    deleteJob: async (name: string) => {
      deletedJobs.push(name);
    },
    deletePvc: async (name: string) => {
      deletedPvcs.push(name);
    },
    deleteSecret: async (name: string) => {
      deletedSecrets.push(name);
    },
    publishSse: async (
      topic: string,
      payload: { type: string; text: string },
    ) => {
      sseMessages.push({ topic, payload });
    },
  };
}

function makeOrphan(
  overrides: Partial<FailedBootstrapJob> = {},
): FailedBootstrapJob {
  return {
    jobName: 'kubeclaw-bootstrap-integ-tg',
    instanceName: 'integ-tg',
    bootstrapJobId: 'integ-orphan-001',
    failureReason: 'DeadlineExceeded',
    ...overrides,
  };
}

describe('reconcileOrphanedBootstrapsOnStartup (integration)', () => {
  it('cleans up a single DeadlineExceeded orphan — Job, PVC, Secret, SSE', async () => {
    const cleanupDeps = makeIntegCleanupDeps();
    cleanupDeps.activeBootstraps.set('integ-tg', 'integ-orphan-001');

    const orphan = makeOrphan();
    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: async () => [orphan],
      cleanup: cleanupDeps,
    };

    await reconcileOrphanedBootstrapsOnStartup(deps);

    expect(cleanupDeps.deletedJobs).toContain('kubeclaw-bootstrap-integ-tg');
    expect(cleanupDeps.deletedPvcs).toContain(
      'kubeclaw-channel-integ-tg-runtime',
    );
    expect(cleanupDeps.deletedSecrets).toContain(
      'kubeclaw-channel-integ-tg-credentials',
    );
    expect(cleanupDeps.sseMessages[0].topic).toBe(
      'kubeclaw:bootstrap:integ-orphan-001',
    );
    expect(cleanupDeps.sseMessages[0].payload.type).toBe('timeout');
    expect(cleanupDeps.activeBootstraps.has('integ-tg')).toBe(false);
  });

  it('handles NotFound gracefully for already-absent resources', async () => {
    const cleanupDeps = makeIntegCleanupDeps();
    // Simulate all deletes returning NotFound (swallowed by the dep implementations)
    cleanupDeps.deleteJob = async () => {
      // NotFound — return normally (already swallowed)
    };
    cleanupDeps.deletePvc = async () => {
      /* NotFound */
    };
    cleanupDeps.deleteSecret = async () => {
      /* NotFound */
    };

    const orphan = makeOrphan();
    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: async () => [orphan],
      cleanup: cleanupDeps,
    };

    // Should not throw even when all resources are already absent
    await expect(
      reconcileOrphanedBootstrapsOnStartup(deps),
    ).resolves.toBeUndefined();
    // SSE still published
    expect(cleanupDeps.sseMessages[0].payload.type).toBe('timeout');
  });

  it('cleans up multiple orphans in one pass', async () => {
    const cleanupDeps = makeIntegCleanupDeps();

    const orphans: FailedBootstrapJob[] = [
      makeOrphan({
        instanceName: 'tg-a',
        bootstrapJobId: 'job-a',
        jobName: 'kubeclaw-bootstrap-tg-a',
      }),
      makeOrphan({
        instanceName: 'tg-b',
        bootstrapJobId: 'job-b',
        jobName: 'kubeclaw-bootstrap-tg-b',
        failureReason: 'BackoffLimitExceeded',
      }),
    ];

    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: async () => orphans,
      cleanup: cleanupDeps,
    };

    await reconcileOrphanedBootstrapsOnStartup(deps);

    expect(cleanupDeps.deletedJobs).toContain('kubeclaw-bootstrap-tg-a');
    expect(cleanupDeps.deletedJobs).toContain('kubeclaw-bootstrap-tg-b');
    expect(cleanupDeps.sseMessages).toHaveLength(2);
  });

  it('cleanupBootstrapResources correctly frees the activeBootstraps entry', async () => {
    const cleanupDeps = makeIntegCleanupDeps();
    cleanupDeps.activeBootstraps.set('released-tg', 'released-job-id');

    // Call cleanupBootstrapResources directly to test the integration
    await cleanupBootstrapResources(
      'released-job-id',
      'released-tg',
      cleanupDeps,
    );

    expect(cleanupDeps.activeBootstraps.has('released-tg')).toBe(false);
    expect(cleanupDeps.deletedJobs).toEqual(['kubeclaw-bootstrap-released-tg']);
    expect(cleanupDeps.deletedPvcs).toEqual([
      'kubeclaw-channel-released-tg-runtime',
    ]);
  });

  it('cleanupBootstrapResources SSE payload contains bootstrapJobId in text', async () => {
    const cleanupDeps = makeIntegCleanupDeps();

    await cleanupBootstrapResources(
      'specific-job-xyz',
      'some-channel',
      cleanupDeps,
    );

    const msg = cleanupDeps.sseMessages[0];
    expect(msg.topic).toBe('kubeclaw:bootstrap:specific-job-xyz');
    expect(msg.payload.text).toContain('specific-job-xyz');
    expect(msg.payload.text).toContain('timed out');
    expect(msg.payload.text).toContain('nothing was installed');
  });
});

// ── Story 181: runUpgrade + processCommitChannelConfig upgrade integration ────

import { runUpgrade } from './bootstrap-runner.js';
import type { RunUpgradeOpts } from './bootstrap-runner.js';

/**
 * Build a minimal fake K8s AppsV1 client for the upgrade integration tests.
 * The Deployment's runtime volume points at `currentPvcName`.
 */
function makeFakeAppsV1(currentPvcName: string) {
  return {
    readNamespacedDeployment: async () => ({
      spec: {
        template: {
          spec: {
            volumes: [
              {
                name: 'runtime',
                persistentVolumeClaim: { claimName: currentPvcName },
              },
            ],
          },
        },
      },
    }),
  } as any;
}

/**
 * Build the full fake K8s deps for runUpgrade — extends the base bootstrap
 * k8sDeps with appsV1 and tracks created PVCs and Jobs.
 */
function makeUpgradeK8sDeps(currentPvcName: string): ReturnType<
  typeof makeFakeK8sDeps
> & {
  appsV1: ReturnType<typeof makeFakeAppsV1>;
} {
  const base = makeFakeK8sDeps();
  // Simulate PVC not found (so it gets created)
  (base.coreV1 as any).readNamespacedPersistentVolumeClaim = async () => {
    throw new Error('Not Found');
  };
  return {
    ...base,
    appsV1: makeFakeAppsV1(currentPvcName),
  };
}

/**
 * Build CommitChannelConfigDeps with upgrade-path deps wired in.
 */
function makeUpgradeCommitDeps(): ReturnType<typeof makeCommitDeps> & {
  patchedDeployments: Array<{ instanceName: string; newPvcName: string }>;
  rolledOutDeployments: string[];
  scheduledOldPvcDeletions: string[];
} {
  const base = makeCommitDeps();
  const patchedDeployments: Array<{
    instanceName: string;
    newPvcName: string;
  }> = [];
  const rolledOutDeployments: string[] = [];
  const scheduledOldPvcDeletions: string[] = [];

  return {
    ...base,
    patchedDeployments,
    rolledOutDeployments,
    scheduledOldPvcDeletions,
    deletedPvcs: [] as string[],
    deleteJob: async () => {},
    deletePvc: async (name: string) => {
      (base as any).deletedPvcs ??= [];
      ((base as any).deletedPvcs as string[]).push(name);
    },
    readPvcFiles: async () => ({
      packageJson: JSON.stringify({ name: 'channel-base', version: '1.0.0' }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    }),
    recordMismatch: () => {},
    patchDeployment: async (instanceName: string, newPvcName: string) => {
      patchedDeployments.push({ instanceName, newPvcName });
    },
    waitForRollout: async (deploymentName: string) => {
      rolledOutDeployments.push(deploymentName);
    },
    scheduleOldPvcDeletion: (oldPvcName: string) => {
      scheduledOldPvcDeletions.push(oldPvcName);
    },
  };
}

describe('Story 181: runUpgrade + processCommitChannelConfig upgrade (integration)', () => {
  it('happy path: creates versioned PVC, Job, then patched Deployment, waits for rollout, schedules old PVC deletion', async () => {
    const currentPvcName = 'kubeclaw-channel-tg-upgrade-runtime';
    const newPvcName = 'kubeclaw-channel-tg-upgrade-runtime-v2';
    const activeBootstraps = new Map<string, string>();
    const k8sDeps = makeUpgradeK8sDeps(currentPvcName);

    // ── Phase 1: runUpgrade spawns PVC + Job ─────────────────────────────────
    const upgradeResult = await runUpgrade({
      instanceName: 'tg-upgrade',
      targetManifestHash: 'abc123hash',
      k8sDeps,
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-agent:test',
      activeBootstraps,
    });

    expect(upgradeResult.alreadyInProgress).toBeUndefined();
    expect(upgradeResult.newPvcName).toBe(newPvcName);
    expect(upgradeResult.oldPvcName).toBe(currentPvcName);
    expect(k8sDeps.createdPvcs).toHaveLength(1);
    expect(k8sDeps.createdPvcs[0].metadata?.name).toBe(newPvcName);
    expect(k8sDeps.createdJobs).toHaveLength(1);
    expect(k8sDeps.createdJobs[0].metadata?.name).toBe(
      'kubeclaw-bootstrap-tg-upgrade-upgrade',
    );
    expect(activeBootstraps.has('tg-upgrade:upgrade')).toBe(true);

    // ── Phase 2: processCommitChannelConfig (upgrade path) ───────────────────
    const commitDeps = makeUpgradeCommitDeps();
    const payload: CommitChannelConfigPayload = {
      type: 'commit_channel_config',
      bootstrapJobId: upgradeResult.upgradeJobId,
      channel_type: 'telegram',
      instance_name: 'tg-upgrade',
      secret_data: {},
      upgradeFromPvc: currentPvcName,
    };

    await processCommitChannelConfig(
      payload,
      commitDeps,
      'kubeclaw-test',
      'kubeclaw-agent:test',
    );

    // Deployment patched to new PVC name
    expect(commitDeps.patchedDeployments).toHaveLength(1);
    expect(commitDeps.patchedDeployments[0]).toEqual({
      instanceName: 'tg-upgrade',
      newPvcName: 'kubeclaw-channel-tg-upgrade-runtime',
    });
    // Rollout waited
    expect(commitDeps.rolledOutDeployments).toContain(
      'kubeclaw-channel-tg-upgrade',
    );
    // Old PVC scheduled for deletion
    expect(commitDeps.scheduledOldPvcDeletions).toContain(currentPvcName);
    // Release happened
    expect(commitDeps.releasedInstances).toContain('tg-upgrade');
    // Reply sent
    expect(commitDeps.replies).toHaveLength(1);
    expect(commitDeps.replies[0].payload).toEqual({ ok: true });
    // SSE published and mentions upgrade
    expect(commitDeps.sseMessages).toHaveLength(1);
    expect(commitDeps.sseMessages[0].text).toContain('upgraded');
  });

  it('MANIFEST_DIVERGENCE on upgrade: deletes new PVC, does NOT patch Deployment, does NOT delete old PVC', async () => {
    const currentPvcName = 'kubeclaw-channel-tg-mismatch-runtime';
    const newPvcName = 'kubeclaw-channel-tg-mismatch-runtime-v2';
    const expectedHash = 'expectedhash000';

    const commitDeps = makeUpgradeCommitDeps();

    // Return a hash that does NOT match expectedHash
    commitDeps.getManifestHash = async () => expectedHash;
    commitDeps.readPvcFiles = async () => ({
      packageJson: JSON.stringify({ name: 'channel-base', version: '99.0.0' }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    });

    // Track PVC deletions separately
    const deletedPvcs: string[] = [];
    commitDeps.deletePvc = async (name: string) => {
      deletedPvcs.push(name);
    };

    const payload: CommitChannelConfigPayload = {
      type: 'commit_channel_config',
      bootstrapJobId: 'upgrade-mismatch-job',
      channel_type: 'telegram',
      instance_name: 'tg-mismatch',
      secret_data: {},
      upgradeFromPvc: currentPvcName,
    };

    await processCommitChannelConfig(
      payload,
      commitDeps,
      'kubeclaw-test',
      'kubeclaw-agent:test',
    );

    // The NEW versioned PVC (nextRuntimePvcName(currentPvcName)) is deleted.
    // currentPvcName has no version suffix → next is -v2.
    expect(deletedPvcs).toContain(newPvcName);
    // OLD PVC is NOT deleted
    expect(deletedPvcs).not.toContain(currentPvcName);
    // Deployment is NOT patched
    expect(commitDeps.patchedDeployments).toHaveLength(0);
    // Error reply sent
    expect(commitDeps.replies).toHaveLength(1);
    expect(commitDeps.replies[0].payload).toMatchObject({ ok: false });
    // Release happened (retry allowed)
    expect(commitDeps.releasedInstances).toContain('tg-mismatch');
  });

  it('concurrent upgrade rejection: runUpgrade returns alreadyInProgress=upgrade when composite key held', async () => {
    const currentPvcName = 'kubeclaw-channel-tg-concurrent-runtime';
    const activeBootstraps = new Map<string, string>([
      ['tg-concurrent:upgrade', 'existing-upgrade-job-id'],
    ]);
    const k8sDeps = makeUpgradeK8sDeps(currentPvcName);

    const result = await runUpgrade({
      instanceName: 'tg-concurrent',
      targetManifestHash: 'hashvalue',
      k8sDeps,
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-agent:test',
      activeBootstraps,
    });

    expect(result.alreadyInProgress).toBe('upgrade');
    // Nothing created
    expect(k8sDeps.createdPvcs).toHaveLength(0);
    expect(k8sDeps.createdJobs).toHaveLength(0);
  });
});
