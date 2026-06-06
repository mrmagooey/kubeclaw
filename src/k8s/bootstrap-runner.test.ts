/**
 * Unit tests for Story 174: bootstrap-runner manifest validation, hash, and Job spawner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CoreV1Api, BatchV1Api } from '@kubernetes/client-node';

// ---- validateChannelManifest + computeManifestHash ----

import { validateChannelManifest, computeManifestHash, canonicalJson } from './bootstrap-runner.js';

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
      packageJson: JSON.stringify({ name: 'runtime', dependencies: { telegraf: '4.16.3' } }),
      packageLockJson: JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: { telegraf: '4.16.3' } } },
      }),
    };
    expect(() => validateChannelManifest(manifest)).not.toThrow();
  });

  it('rejects a manifest with devDependencies', () => {
    const manifest = {
      packageJson: JSON.stringify({ name: 'runtime', devDependencies: { vitest: '1.0.0' } }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest)).toThrow(/devDependencies/);
  });

  it('rejects a manifest with non-allowlisted lifecycle scripts at top level', () => {
    const manifest = {
      packageJson: JSON.stringify({ name: 'runtime', scripts: { postinstall: 'node setup.js' } }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest)).toThrow(/scripts not allowed/);
  });

  it('allows explicitly allowlisted scripts', () => {
    const manifest = {
      packageJson: JSON.stringify({ name: 'runtime', scripts: { prepare: 'node prepare.js' } }),
      packageLockJson: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    };
    expect(() => validateChannelManifest(manifest, ['prepare'])).not.toThrow();
  });

  it('rejects per-package lifecycle scripts in lock file', () => {
    const manifest = {
      packageJson: JSON.stringify({ name: 'runtime', dependencies: { puppeteer: '21.0.0' } }),
      packageLockJson: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/puppeteer': { scripts: { postinstall: 'node install.js' } },
        },
      }),
    };
    expect(() => validateChannelManifest(manifest)).toThrow(/lifecycle script not allowed/);
  });
});

describe('computeManifestHash', () => {
  it('produces a consistent sha256 for canonical JSON', () => {
    const pkg = JSON.stringify({ name: 'runtime', dependencies: { telegraf: '4.16.3' } });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });
    const h1 = computeManifestHash(pkg, lock);
    const h2 = computeManifestHash(pkg, lock);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different content', () => {
    const pkg1 = JSON.stringify({ name: 'runtime', dependencies: { telegraf: '4.16.3' } });
    const pkg2 = JSON.stringify({ name: 'runtime', dependencies: { telegraf: '4.17.0' } });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });
    expect(computeManifestHash(pkg1, lock)).not.toBe(computeManifestHash(pkg2, lock));
  });

  it('is independent of JSON key order (uses canonical form)', () => {
    const pkg1 = '{"name":"runtime","dependencies":{"telegraf":"4.16.3"}}';
    const pkg2 = '{"dependencies":{"telegraf":"4.16.3"},"name":"runtime"}';
    const lock = '{}';
    expect(computeManifestHash(pkg1, lock)).toBe(computeManifestHash(pkg2, lock));
  });
});

// ---- bootstrapChannelFromSkill ----

import { bootstrapChannelFromSkill } from './bootstrap-runner.js';

function makeFakeK8s() {
  const createdPvcs: Array<{ name: string; body: unknown }> = [];
  const createdJobs: Array<{ name: string; body: unknown }> = [];
  const coreV1 = {
    readNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue({ statusCode: 404 }),
    createNamespacedPersistentVolumeClaim: vi.fn().mockImplementation(
      ({ body }: { body: { metadata: { name: string } } }) => {
        createdPvcs.push({ name: body.metadata.name, body });
        return Promise.resolve({ body });
      },
    ),
  } as unknown as CoreV1Api;
  const batchV1 = {
    createNamespacedJob: vi.fn().mockImplementation(
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
    expect(fakeK8s.createdPvcs[0].name).toBe('kubeclaw-channel-my-telegram-runtime');
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
      spec: { template: { spec: { containers: [{ env: { name: string; value: string }[] }] } } };
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
    const jobBody = fakeK8s.createdJobs[0].body as { spec: { activeDeadlineSeconds: number } };
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
    const jobBody = fakeK8s.createdJobs[0].body as { spec: { activeDeadlineSeconds: number } };
    expect(jobBody.spec.activeDeadlineSeconds).toBe(60);
  });
});
