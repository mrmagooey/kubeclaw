/**
 * Unit tests for Story 174: bootstrap-runner manifest validation, hash, and Job spawner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CoreV1Api, BatchV1Api } from '@kubernetes/client-node';

// ---- validateChannelManifest + computeManifestHash ----

import {
  validateChannelManifest,
  computeManifestHash,
  canonicalJson,
} from './bootstrap-runner.js';

describe('canonicalJson', () => {
  it('sorts object keys deterministically', () => {
    const result = canonicalJson({ b: 1, a: 2 });
    expect(result).toBe('{"a":2,"b":1}');
  });

  it('handles nested objects', () => {
    const result = canonicalJson({ z: { b: 1, a: 2 } });
    expect(result).toBe('{"z":{"a":2,"b":1}}');
  });

  it('handles arrays without reordering', () => {
    const result = canonicalJson([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('handles null', () => {
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('validateChannelManifest', () => {
  it('accepts a valid manifest with dependencies only', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'runtime',
        dependencies: { telegraf: '4.16.3' },
      }),
      packageLockJson: JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: { telegraf: '4.16.3' } } },
      }),
    };
    expect(() => validateChannelManifest(manifest)).not.toThrow();
  });

  it('rejects a manifest with devDependencies', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'runtime',
        devDependencies: { vitest: '1.0.0' },
      }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest)).toThrow(/devDependencies/);
  });

  it('rejects a manifest with non-allowlisted lifecycle scripts at top level', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'runtime',
        scripts: { postinstall: 'node setup.js' },
      }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest)).toThrow(
      /scripts not allowed/,
    );
  });

  it('allows explicitly allowlisted scripts', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'runtime',
        scripts: { prepare: 'node prepare.js' },
      }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest, ['prepare'])).not.toThrow();
  });

  it('rejects per-package lifecycle scripts in lock file', () => {
    const manifest = {
      packageJson: JSON.stringify({
        name: 'runtime',
        dependencies: { puppeteer: '21.0.0' },
      }),
      packageLockJson: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/puppeteer': {
            scripts: { postinstall: 'node install.js' },
          },
        },
      }),
    };
    expect(() => validateChannelManifest(manifest)).toThrow(
      /lifecycle script not allowed/,
    );
  });
});

describe('computeManifestHash', () => {
  it('produces a consistent sha256 for canonical JSON', () => {
    const pkg = JSON.stringify({
      name: 'runtime',
      dependencies: { telegraf: '4.16.3' },
    });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });
    const h1 = computeManifestHash(pkg, lock);
    const h2 = computeManifestHash(pkg, lock);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different content', () => {
    const pkg1 = JSON.stringify({
      name: 'runtime',
      dependencies: { telegraf: '4.16.3' },
    });
    const pkg2 = JSON.stringify({
      name: 'runtime',
      dependencies: { telegraf: '4.17.0' },
    });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });
    expect(computeManifestHash(pkg1, lock)).not.toBe(
      computeManifestHash(pkg2, lock),
    );
  });

  it('is independent of JSON key order (uses canonical form)', () => {
    const pkg1 = '{"name":"runtime","dependencies":{"telegraf":"4.16.3"}}';
    const pkg2 = '{"dependencies":{"telegraf":"4.16.3"},"name":"runtime"}';
    const lock = '{}';
    expect(computeManifestHash(pkg1, lock)).toBe(
      computeManifestHash(pkg2, lock),
    );
  });
});

// ---- bootstrapChannelFromSkill ----

import { bootstrapChannelFromSkill } from './bootstrap-runner.js';

function makeFakeK8s() {
  const createdPvcs: Array<{ name: string; body: unknown }> = [];
  const createdJobs: Array<{ name: string; body: unknown }> = [];
  const coreV1 = {
    readNamespacedPersistentVolumeClaim: vi
      .fn()
      .mockRejectedValue({ statusCode: 404 }),
    createNamespacedPersistentVolumeClaim: vi
      .fn()
      .mockImplementation(
        ({ body }: { body: { metadata: { name: string } } }) => {
          createdPvcs.push({ name: body.metadata.name, body });
          return Promise.resolve({ body });
        },
      ),
  } as unknown as CoreV1Api;
  const batchV1 = {
    createNamespacedJob: vi
      .fn()
      .mockImplementation(
        ({ body }: { body: { metadata: { name: string } } }) => {
          createdJobs.push({ name: body.metadata.name, body });
          return Promise.resolve({ body });
        },
      ),
  } as unknown as BatchV1Api;
  return { coreV1, batchV1, createdPvcs, createdJobs };
}

describe('bootstrapChannelFromSkill', () => {
  let fakeK8s: ReturnType<typeof makeFakeK8s>;

  beforeEach(() => {
    fakeK8s = makeFakeK8s();
  });

  it('creates a PVC named kubeclaw-channel-<instance>-runtime', async () => {
    const result = await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
    });
    expect(result.bootstrapJobId).toBeTruthy();
    expect(fakeK8s.createdPvcs[0].name).toBe(
      'kubeclaw-channel-my-telegram-runtime',
    );
  });

  it('creates a Job named kubeclaw-bootstrap-<instance>', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
    });
    expect(fakeK8s.createdJobs[0].name).toBe('kubeclaw-bootstrap-my-telegram');
  });

  it('returns alreadyInProgress when instance is already active', async () => {
    const activeBootstraps = new Map([['my-telegram', 'existing-job-id']]);
    const result = await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps,
    });
    expect(result.alreadyInProgress).toBe(true);
    expect(result.bootstrapJobId).toBe('existing-job-id');
    expect(fakeK8s.createdJobs).toHaveLength(0);
  });

  it('Job spec has KUBECLAW_SUPERUSER=true env var', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
    });
    const jobBody = fakeK8s.createdJobs[0].body as {
      spec: {
        template: {
          spec: { containers: [{ env: { name: string; value: string }[] }] };
        };
      };
    };
    const envs = jobBody.spec.template.spec.containers[0].env;
    const envMap = Object.fromEntries(envs.map((e) => [e.name, e.value]));
    expect(envMap['KUBECLAW_SUPERUSER']).toBe('true');
    expect(envMap['KUBECLAW_BOOTSTRAP_SKILL']).toBe('bootstrap-telegram');
    expect(envMap['KUBECLAW_BOOTSTRAP_CHANNEL_TYPE']).toBe('telegram');
    expect(envMap['KUBECLAW_BOOTSTRAP_INSTANCE']).toBe('my-telegram');
  });

  it('Job spec has activeDeadlineSeconds = 900 by default', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
    });
    const jobBody = fakeK8s.createdJobs[0].body as {
      spec: { activeDeadlineSeconds: number };
    };
    expect(jobBody.spec.activeDeadlineSeconds).toBe(900);
  });

  it('registers instance in activeBootstraps map', async () => {
    const activeBootstraps = new Map<string, string>();
    const result = await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps,
    });
    expect(activeBootstraps.get('my-telegram')).toBe(result.bootstrapJobId);
  });

  it('respects custom timeoutSeconds', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
      timeoutSeconds: 60,
    });
    const jobBody = fakeK8s.createdJobs[0].body as {
      spec: { activeDeadlineSeconds: number };
    };
    expect(jobBody.spec.activeDeadlineSeconds).toBe(60);
  });

  it('bootstrap Job spec includes an inspector sidecar mounting runtime PVC at /runtime-inspect (Story 176)', async () => {
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1: fakeK8s.coreV1, batchV1: fakeK8s.batchV1 },
      namespace: 'test-ns',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
    });
    const jobBody = fakeK8s.createdJobs[0].body as {
      spec: {
        template: {
          spec: {
            containers: Array<{
              name: string;
              command?: string[];
              volumeMounts?: Array<{ mountPath: string }>;
            }>;
          };
        };
      };
    };
    const containers = jobBody.spec.template.spec.containers;
    const inspector = containers.find((c) => c.name === 'inspector');
    expect(inspector).toBeTruthy();
    expect(inspector?.command).toEqual(['sleep', 'infinity']);
    expect(
      inspector?.volumeMounts?.some((m) => m.mountPath === '/runtime-inspect'),
    ).toBe(true);
  });
});

// ─── Story 175: cleanupBootstrapResources ────────────────────────────────────

import {
  cleanupBootstrapResources,
  waitForBootstrapJobCompletion,
  reconcileOrphanedBootstrapsOnStartup,
} from './bootstrap-runner.js';
import type {
  CleanupBootstrapDeps,
  ReconcileOrphanedBootstrapsDeps,
  FailedBootstrapJob,
} from './bootstrap-runner.js';

function makeCleanupDeps(
  overrides: Partial<CleanupBootstrapDeps> = {},
): CleanupBootstrapDeps & {
  deletedJobs: string[];
  deletedPvcs: string[];
  deletedSecrets: string[];
  ssePublished: Array<{
    topic: string;
    payload: { type: string; text: string };
  }>;
  activeBootstraps: Map<string, string>;
} {
  const deletedJobs: string[] = [];
  const deletedPvcs: string[] = [];
  const deletedSecrets: string[] = [];
  const ssePublished: Array<{
    topic: string;
    payload: { type: string; text: string };
  }> = [];
  const activeBootstraps = new Map<string, string>();

  return {
    deletedJobs,
    deletedPvcs,
    deletedSecrets,
    ssePublished,
    activeBootstraps,
    deleteJob: vi.fn(async (name: string) => {
      deletedJobs.push(name);
    }),
    deletePvc: vi.fn(async (name: string) => {
      deletedPvcs.push(name);
    }),
    deleteSecret: vi.fn(async (name: string) => {
      deletedSecrets.push(name);
    }),
    publishSse: vi.fn(
      async (topic: string, payload: { type: string; text: string }) => {
        ssePublished.push({ topic, payload });
      },
    ),
    ...overrides,
  };
}

describe('cleanupBootstrapResources', () => {
  it('deletes Job, PVC, and Secret with the correct names', async () => {
    const deps = makeCleanupDeps();
    deps.activeBootstraps.set('my-tg', 'job-123');

    await cleanupBootstrapResources('job-123', 'my-tg', deps);

    expect(deps.deletedJobs).toEqual(['kubeclaw-bootstrap-my-tg']);
    expect(deps.deletedPvcs).toEqual(['kubeclaw-channel-my-tg-runtime']);
    expect(deps.deletedSecrets).toEqual(['kubeclaw-channel-my-tg-credentials']);
  });

  it('publishes SSE with type=timeout to the correct topic', async () => {
    const deps = makeCleanupDeps();

    await cleanupBootstrapResources('job-abc', 'my-tg', deps);

    expect(deps.ssePublished).toHaveLength(1);
    expect(deps.ssePublished[0].topic).toBe('kubeclaw:bootstrap:job-abc');
    expect(deps.ssePublished[0].payload.type).toBe('timeout');
    expect(deps.ssePublished[0].payload.text).toContain('job-abc');
    expect(deps.ssePublished[0].payload.text).toContain('timed out');
  });

  it('removes the instanceName from activeBootstraps', async () => {
    const deps = makeCleanupDeps();
    deps.activeBootstraps.set('my-tg', 'job-abc');

    await cleanupBootstrapResources('job-abc', 'my-tg', deps);

    expect(deps.activeBootstraps.has('my-tg')).toBe(false);
  });

  it('removes instance from activeBootstraps even when all deletes fail', async () => {
    const deps = makeCleanupDeps({
      deleteJob: vi.fn().mockRejectedValue(new Error('Internal error')),
      deletePvc: vi.fn().mockRejectedValue(new Error('Internal error')),
      deleteSecret: vi.fn().mockRejectedValue(new Error('Internal error')),
    });
    deps.activeBootstraps.set('my-tg', 'job-fail');

    await cleanupBootstrapResources('job-fail', 'my-tg', deps);

    expect(deps.activeBootstraps.has('my-tg')).toBe(false);
  });

  it('removes instance from activeBootstraps even when SSE publish fails', async () => {
    const deps = makeCleanupDeps({
      publishSse: vi.fn().mockRejectedValue(new Error('Redis down')),
    });
    deps.activeBootstraps.set('my-tg', 'job-redis-fail');

    await cleanupBootstrapResources('job-redis-fail', 'my-tg', deps);

    expect(deps.activeBootstraps.has('my-tg')).toBe(false);
  });

  it('continues cleanup chain when Job delete fails (non-NotFound)', async () => {
    let pvcDeleted = false;
    const deps = makeCleanupDeps({
      deleteJob: vi.fn().mockRejectedValue(new Error('API server error')),
      deletePvc: vi.fn(async () => {
        pvcDeleted = true;
      }),
    });

    await cleanupBootstrapResources('job-err', 'my-tg', deps);

    expect(pvcDeleted).toBe(true);
  });

  it('continues cleanup chain when PVC delete fails', async () => {
    let secretDeleted = false;
    const deps = makeCleanupDeps({
      deletePvc: vi.fn().mockRejectedValue(new Error('API server error')),
      deleteSecret: vi.fn(async () => {
        secretDeleted = true;
      }),
    });

    await cleanupBootstrapResources('job-err', 'my-tg', deps);

    expect(secretDeleted).toBe(true);
  });

  it('does not throw when all operations succeed', async () => {
    const deps = makeCleanupDeps();

    await expect(
      cleanupBootstrapResources('job-ok', 'my-tg', deps),
    ).resolves.toBeUndefined();
  });
});

// ─── Story 175: waitForBootstrapJobCompletion ─────────────────────────────────

describe('waitForBootstrapJobCompletion', () => {
  it('does NOT call cleanup when Job completes successfully', async () => {
    const cleanupDeps = makeCleanupDeps();
    const waitForJob = vi.fn().mockResolvedValue(undefined);

    await waitForBootstrapJobCompletion(
      'kubeclaw-bootstrap-my-tg',
      'job-ok',
      'my-tg',
      {
        waitForJob,
        cleanupDeps,
        bootstrapTimeoutSeconds: 60,
      },
    );

    expect(cleanupDeps.deletedJobs).toHaveLength(0);
    expect(cleanupDeps.activeBootstraps.has('my-tg')).toBe(false);
  });

  it('calls cleanup when Job fails with DeadlineExceeded', async () => {
    const cleanupDeps = makeCleanupDeps();
    cleanupDeps.activeBootstraps.set('my-tg', 'job-timeout');
    const waitForJob = vi
      .fn()
      .mockRejectedValue(new Error('DeadlineExceeded: Job deadline exceeded'));

    await waitForBootstrapJobCompletion(
      'kubeclaw-bootstrap-my-tg',
      'job-timeout',
      'my-tg',
      {
        waitForJob,
        cleanupDeps,
        bootstrapTimeoutSeconds: 60,
      },
    );

    expect(cleanupDeps.deletedJobs).toContain('kubeclaw-bootstrap-my-tg');
    expect(cleanupDeps.deletedPvcs).toContain('kubeclaw-channel-my-tg-runtime');
    expect(cleanupDeps.ssePublished[0].payload.type).toBe('timeout');
    expect(cleanupDeps.activeBootstraps.has('my-tg')).toBe(false);
  });

  it('does NOT call cleanup on non-deadline errors', async () => {
    const cleanupDeps = makeCleanupDeps();
    cleanupDeps.activeBootstraps.set('my-tg', 'job-err');
    const waitForJob = vi
      .fn()
      .mockRejectedValue(new Error('Job failed: BackoffLimitExceeded'));

    await waitForBootstrapJobCompletion(
      'kubeclaw-bootstrap-my-tg',
      'job-err',
      'my-tg',
      {
        waitForJob,
        cleanupDeps,
        bootstrapTimeoutSeconds: 60,
      },
    );

    // non-deadline errors do NOT trigger cleanup
    expect(cleanupDeps.deletedJobs).toHaveLength(0);
    // instance is NOT freed by waitForBootstrapJobCompletion on non-deadline error
    expect(cleanupDeps.activeBootstraps.has('my-tg')).toBe(true);
  });

  it('passes timeoutMs = (bootstrapTimeoutSeconds + 60) * 1000 to waitForJob', async () => {
    const cleanupDeps = makeCleanupDeps();
    const waitForJob = vi.fn().mockResolvedValue(undefined);

    await waitForBootstrapJobCompletion(
      'kubeclaw-bootstrap-my-tg',
      'job-ok',
      'my-tg',
      {
        waitForJob,
        cleanupDeps,
        bootstrapTimeoutSeconds: 120,
      },
    );

    // (120 + 60) * 1000 = 180_000 ms
    expect(waitForJob).toHaveBeenCalledWith(
      'kubeclaw-bootstrap-my-tg',
      180_000,
    );
  });

  it('uses BOOTSTRAP_SKILL_TIMEOUT_SECONDS default (900) when not provided', async () => {
    const cleanupDeps = makeCleanupDeps();
    const waitForJob = vi.fn().mockResolvedValue(undefined);
    const orig = process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS;
    delete process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS;

    await waitForBootstrapJobCompletion(
      'kubeclaw-bootstrap-my-tg',
      'job-ok',
      'my-tg',
      {
        waitForJob,
        cleanupDeps,
        // no bootstrapTimeoutSeconds — should default to 900
      },
    );

    if (orig !== undefined) process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS = orig;

    // (900 + 60) * 1000 = 960_000
    expect(waitForJob).toHaveBeenCalledWith(
      'kubeclaw-bootstrap-my-tg',
      960_000,
    );
  });
});

// ─── Story 175: reconcileOrphanedBootstrapsOnStartup ─────────────────────────

function makeFailedJob(
  overrides: Partial<FailedBootstrapJob> = {},
): FailedBootstrapJob {
  return {
    jobName: 'kubeclaw-bootstrap-test-tg',
    instanceName: 'test-tg',
    bootstrapJobId: 'orphan-job-001',
    failureReason: 'DeadlineExceeded',
    ...overrides,
  };
}

describe('reconcileOrphanedBootstrapsOnStartup', () => {
  it('calls cleanupBootstrapResources for each orphaned Job', async () => {
    const cleanupDeps = makeCleanupDeps();
    const orphan1 = makeFailedJob({
      instanceName: 'tg-1',
      bootstrapJobId: 'job-1',
    });
    const orphan2 = makeFailedJob({
      instanceName: 'tg-2',
      bootstrapJobId: 'job-2',
      jobName: 'kubeclaw-bootstrap-tg-2',
    });

    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: vi.fn().mockResolvedValue([orphan1, orphan2]),
      cleanup: cleanupDeps,
    };

    await reconcileOrphanedBootstrapsOnStartup(deps);

    expect(cleanupDeps.deletedJobs).toContain('kubeclaw-bootstrap-tg-1');
    expect(cleanupDeps.deletedJobs).toContain('kubeclaw-bootstrap-tg-2');
  });

  it('publishes timeout SSE for each orphan', async () => {
    const cleanupDeps = makeCleanupDeps();
    const orphan = makeFailedJob({
      instanceName: 'tg-sse',
      bootstrapJobId: 'job-sse',
    });

    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: vi.fn().mockResolvedValue([orphan]),
      cleanup: cleanupDeps,
    };

    await reconcileOrphanedBootstrapsOnStartup(deps);

    expect(cleanupDeps.ssePublished[0].topic).toBe(
      'kubeclaw:bootstrap:job-sse',
    );
    expect(cleanupDeps.ssePublished[0].payload.type).toBe('timeout');
  });

  it('skips all cleanup when there are no orphaned Jobs', async () => {
    const cleanupDeps = makeCleanupDeps();
    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: vi.fn().mockResolvedValue([]),
      cleanup: cleanupDeps,
    };

    await reconcileOrphanedBootstrapsOnStartup(deps);

    expect(cleanupDeps.deletedJobs).toHaveLength(0);
    expect(cleanupDeps.ssePublished).toHaveLength(0);
  });

  it('does not throw when listFailedBootstrapJobs throws', async () => {
    const cleanupDeps = makeCleanupDeps();
    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: vi
        .fn()
        .mockRejectedValue(new Error('K8s unavailable')),
      cleanup: cleanupDeps,
    };

    await expect(
      reconcileOrphanedBootstrapsOnStartup(deps),
    ).resolves.toBeUndefined();
  });

  it('continues past one orphan whose cleanup fails', async () => {
    let secondCleaned = false;
    const cleanupDeps = makeCleanupDeps({
      deleteJob: vi
        .fn()
        .mockRejectedValueOnce(new Error('first job delete failed'))
        .mockImplementation(async () => {
          secondCleaned = true;
        }),
    });
    const orphan1 = makeFailedJob({
      instanceName: 'tg-fail',
      bootstrapJobId: 'job-fail',
    });
    const orphan2 = makeFailedJob({
      instanceName: 'tg-ok',
      bootstrapJobId: 'job-ok',
      jobName: 'kubeclaw-bootstrap-tg-ok',
    });

    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: vi.fn().mockResolvedValue([orphan1, orphan2]),
      cleanup: cleanupDeps,
    };

    await reconcileOrphanedBootstrapsOnStartup(deps);

    expect(secondCleaned).toBe(true);
  });

  it('aborts early when timeoutMs is exceeded (bounded deadline loop)', async () => {
    const cleanupDeps = makeCleanupDeps();
    // Create many orphans but give an extremely short deadline
    const orphans = Array.from({ length: 10 }, (_, i) =>
      makeFailedJob({
        instanceName: `tg-${i}`,
        bootstrapJobId: `job-${i}`,
        jobName: `kubeclaw-bootstrap-tg-${i}`,
      }),
    );

    let cleanupCallCount = 0;
    const slowCleanupDeps: CleanupBootstrapDeps = {
      ...cleanupDeps,
      deleteJob: vi.fn(async () => {
        cleanupCallCount++;
        // Simulate slow delete to exhaust deadline
        await new Promise((r) => setTimeout(r, 20));
      }),
    };

    const deps: ReconcileOrphanedBootstrapsDeps = {
      listFailedBootstrapJobs: vi.fn().mockResolvedValue(orphans),
      cleanup: slowCleanupDeps,
      timeoutMs: 50, // very short — should abort after first 2-3 orphans
    };

    await reconcileOrphanedBootstrapsOnStartup(deps);

    expect(cleanupCallCount).toBeGreaterThan(0);
    expect(cleanupCallCount).toBeLessThan(10);
  });
});
