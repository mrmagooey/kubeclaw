import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeManifests, ChannelManifestReconciler } from './reconciler.js';
import type { ChannelManifestEntry } from './reconciler.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { registerChannelManifest } from '../skills/orchestrator/channel-manifest-registry.js';

const VALID_PKG = JSON.stringify({
  name: 'runtime',
  version: '1.0.0',
  dependencies: { telegraf: '4.16.3' },
});
const VALID_LOCK = JSON.stringify({
  name: 'runtime',
  lockfileVersion: 3,
  packages: {},
});

// Helper to make a baseline entry
function makeBaseline(
  channelType: string,
  hash = 'aaa000',
): ChannelManifestEntry {
  return {
    channel_type: channelType,
    package_name: 'runtime',
    package_version: '1.0.0',
    manifest_hash: hash,
    source: 'helm-baseline',
    registered_at: '2026-01-01T00:00:00.000Z',
    registered_by: 'helm',
    package_json: VALID_PKG,
    package_lock_json: VALID_LOCK,
  };
}

describe('mergeManifests', () => {
  it('admin override wins on channel_type collision', () => {
    const baseline = [makeBaseline('telegram', 'hash-baseline')];
    const overrides: ChannelManifestEntry[] = [
      {
        channel_type: 'telegram',
        package_name: 'runtime',
        package_version: '2.0.0',
        manifest_hash: 'hash-admin',
        source: 'admin-registered',
        registered_at: '2026-06-01T00:00:00.000Z',
        registered_by: 'admin',
      },
    ];
    const merged = mergeManifests(baseline, overrides);
    expect(merged).toHaveLength(1);
    expect(merged[0].manifest_hash).toBe('hash-admin');
    expect(merged[0].source).toBe('admin-registered');
  });

  it('keeps baseline-only and override-only entries', () => {
    const baseline = [makeBaseline('telegram'), makeBaseline('discord')];
    const overrides: ChannelManifestEntry[] = [
      {
        channel_type: 'slack',
        package_name: 'runtime',
        package_version: '1.0.0',
        manifest_hash: 'hash-slack',
        source: 'admin-registered',
        registered_at: '2026-06-01T00:00:00.000Z',
        registered_by: 'admin',
      },
    ];
    const merged = mergeManifests(baseline, overrides);
    expect(merged.map((e) => e.channel_type).sort()).toEqual([
      'discord',
      'slack',
      'telegram',
    ]);
  });

  it('returns empty when both inputs are empty', () => {
    expect(mergeManifests([], [])).toEqual([]);
  });

  it('returns sorted output by channel_type', () => {
    const merged = mergeManifests(
      [makeBaseline('telegram'), makeBaseline('discord')],
      [],
    );
    expect(merged.map((e) => e.channel_type)).toEqual(['discord', 'telegram']);
  });
});

describe('ChannelManifestReconciler.apply', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('calls configMapApply with merged entries JSON', async () => {
    registerChannelManifest({
      channel_type: 'slack',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
    });
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [makeBaseline('telegram')],
      configMapApply: apply,
    });
    await r.apply();
    expect(apply).toHaveBeenCalledOnce();
    const arg: string = apply.mock.calls[0][0];
    const parsed = JSON.parse(arg) as {
      manifests: Array<{ channel_type: string }>;
    };
    const types = parsed.manifests.map((e) => e.channel_type).sort();
    expect(types).toEqual(['slack', 'telegram']);
  });

  it('admin override wins on collision in reconcile output', async () => {
    const adminPkg = JSON.stringify({
      name: 'runtime',
      version: '2.0.0',
      dependencies: { telegraf: '4.16.4' },
    });
    registerChannelManifest({
      channel_type: 'telegram',
      package_json: adminPkg,
      package_lock_json: VALID_LOCK,
    });
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [makeBaseline('telegram', 'helm-hash')],
      configMapApply: apply,
    });
    await r.apply();
    const parsed = JSON.parse(apply.mock.calls[0][0]) as {
      manifests: Array<{
        channel_type: string;
        source: string;
        manifest_hash: string;
      }>;
    };
    const telegram = parsed.manifests.find(
      (e) => e.channel_type === 'telegram',
    );
    expect(telegram?.source).toBe('admin-registered');
    expect(telegram?.manifest_hash).not.toBe('helm-hash');
  });

  it('increments generation on each successful apply', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [],
      configMapApply: apply,
    });
    await r.apply();
    await r.apply();
    const gen1 = JSON.parse(apply.mock.calls[0][0]).generation;
    const gen2 = JSON.parse(apply.mock.calls[1][0]).generation;
    expect(gen2).toBeGreaterThan(gen1);
  });

  it('does not bump generation when configMapApply throws', async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error('k8s error'))
      .mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [],
      configMapApply: apply,
    });
    await expect(r.apply()).rejects.toThrow('k8s error');
    await r.apply();
    // second call should have generation=1 (not 2) because first failed
    const gen = JSON.parse(apply.mock.calls[1][0]).generation;
    expect(gen).toBe(1);
  });

  it('serializes concurrent apply calls', async () => {
    const resolveFns: Array<() => void> = [];
    const apply = vi
      .fn()
      .mockImplementation(
        () => new Promise<void>((resolve) => resolveFns.push(resolve)),
      );
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [],
      configMapApply: apply,
    });

    registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
    });
    const p1 = r.apply();
    await Promise.resolve();

    const slackPkg = JSON.stringify({
      name: 'r',
      dependencies: { x: '1' },
    });
    registerChannelManifest({
      channel_type: 'slack',
      package_json: slackPkg,
      package_lock_json: VALID_LOCK,
    });
    const p2 = r.apply();

    resolveFns[0]!();
    await p1;
    resolveFns[1]!();
    await p2;

    const secondPayload = JSON.parse(apply.mock.calls[1][0]) as {
      manifests: Array<{ channel_type: string }>;
    };
    const types = secondPayload.manifests.map((e) => e.channel_type).sort();
    expect(types).toEqual(['slack', 'telegram']);
  });
});
