import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mergeManifests,
  ChannelManifestReconciler,
  loadBaselineFromDisk,
  renderChannelManifestConfigMapData,
} from './reconciler.js';
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

describe('loadBaselineFromDisk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chman-baseline-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBaselineFile(channelType: string): void {
    writeFileSync(
      join(dir, `${channelType}.json`),
      JSON.stringify({
        packageJson: VALID_PKG,
        packageLockJson: VALID_LOCK,
        manifestHash: 'disk-hash',
      }),
    );
  }

  it('returns [] when the directory does not exist', () => {
    expect(loadBaselineFromDisk(join(dir, 'missing'))).toEqual([]);
  });

  it('loads one helm-baseline entry per JSON file, carrying raw manifests', () => {
    writeBaselineFile('http-echo');
    const entries = loadBaselineFromDisk(dir);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.channel_type).toBe('http-echo');
    expect(e.source).toBe('helm-baseline');
    expect(e.manifest_hash).toBe('disk-hash');
    expect(e.package_name).toBe('runtime');
    expect(e.package_version).toBe('1.0.0');
    // Raw manifests must survive so the bootstrap Job can run `npm ci`.
    expect(e.package_json).toBe(VALID_PKG);
    expect(e.package_lock_json).toBe(VALID_LOCK);
  });

  it('skips unparseable files and keeps valid ones', () => {
    writeBaselineFile('http-echo');
    writeFileSync(join(dir, 'broken.json'), '{ not valid json');
    const entries = loadBaselineFromDisk(dir);
    expect(entries.map((e) => e.channel_type)).toEqual(['http-echo']);
  });
});

describe('startup reconcile from disk baseline', () => {
  let dir: string;

  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
    dir = mkdtempSync(join(tmpdir(), 'chman-startup-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('populates the ConfigMap from a disk baseline even with no admin overrides', async () => {
    // Regression for the empty kubeclaw-channel-manifests ConfigMap: a fresh
    // install has a populated Helm baseline on disk but zero SQLite overrides.
    // The startup reconcile must still render the baseline channel so bootstrap
    // Jobs can find their package.json.
    writeFileSync(
      join(dir, 'http-echo.json'),
      JSON.stringify({
        packageJson: VALID_PKG,
        packageLockJson: VALID_LOCK,
        manifestHash: 'disk-hash',
      }),
    );
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => loadBaselineFromDisk(dir),
      configMapApply: apply,
    });
    await r.apply();
    expect(apply).toHaveBeenCalledOnce();
    const parsed = JSON.parse(apply.mock.calls[0][0]) as {
      manifests: Array<{
        channel_type: string;
        package_json?: string;
        package_lock_json?: string;
      }>;
    };
    expect(parsed.manifests).toHaveLength(1);
    expect(parsed.manifests[0].channel_type).toBe('http-echo');
    expect(parsed.manifests[0].package_json).toBe(VALID_PKG);
    expect(parsed.manifests[0].package_lock_json).toBe(VALID_LOCK);
  });
});

describe('hostMode in mergeManifests and render', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('baseline entry with hostMode channel-runner survives merge+render into ConfigMap', async () => {
    const baselineWithHostMode = makeBaseline('telegram');
    (baselineWithHostMode as ChannelManifestEntry & { hostMode?: string }).hostMode = 'channel-runner';
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [baselineWithHostMode],
      configMapApply: apply,
    });
    await r.apply();
    expect(apply).toHaveBeenCalledOnce();
    const parsed = JSON.parse(apply.mock.calls[0][0]) as {
      manifests: Array<{ channel_type: string; hostMode?: string }>;
    };
    expect(parsed.manifests).toHaveLength(1);
    expect(parsed.manifests[0].hostMode).toBe('channel-runner');
  });

  it('baseline entry without hostMode renders with hostMode standalone', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [makeBaseline('telegram')],
      configMapApply: apply,
    });
    await r.apply();
    const parsed = JSON.parse(apply.mock.calls[0][0]) as {
      manifests: Array<{ channel_type: string; hostMode: string }>;
    };
    expect(parsed.manifests[0].hostMode).toBe('standalone');
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

describe('renderChannelManifestConfigMapData', () => {
  it('includes hostMode in each per-type ConfigMap value (regression: silent drop defaulted all channels to standalone)', () => {
    const data = renderChannelManifestConfigMapData([
      {
        channel_type: 'irc',
        package_json: '{"name":"irc-runtime","version":"1.0.0"}',
        package_lock_json: '{"lockfileVersion":3}',
        manifest_hash: 'abc',
        hostMode: 'channel-runner',
      },
    ]);
    expect(data['irc.json']).toBeDefined();
    const parsed = JSON.parse(data['irc.json']) as {
      packageJson: string;
      packageLockJson: string;
      manifestHash: string;
      hostMode: string;
    };
    expect(parsed.hostMode).toBe('channel-runner');
    expect(parsed.manifestHash).toBe('abc');
    expect(parsed.packageJson).toContain('irc-runtime');
  });

  it("defaults hostMode to 'standalone' when absent", () => {
    const data = renderChannelManifestConfigMapData([
      {
        channel_type: 'http-echo',
        package_json: '{"name":"x"}',
        package_lock_json: '{}',
        manifest_hash: 'h',
      },
    ]);
    expect(JSON.parse(data['http-echo.json']).hostMode).toBe('standalone');
  });

  it('skips entries missing package files', () => {
    const data = renderChannelManifestConfigMapData([
      { channel_type: 'broken', manifest_hash: 'h', hostMode: 'standalone' },
    ]);
    expect(data['broken.json']).toBeUndefined();
  });
});
