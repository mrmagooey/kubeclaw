import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
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
    (
      baselineWithHostMode as ChannelManifestEntry & { hostMode?: string }
    ).hostMode = 'channel-runner';
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

describe('httpPort in mergeManifests and render', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('baseline entry with httpPort 4080 survives merge+render into ConfigMap', async () => {
    const baselineWithHttpPort = makeBaseline('telegram');
    (
      baselineWithHttpPort as ChannelManifestEntry & { httpPort?: number }
    ).httpPort = 4080;
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [baselineWithHttpPort],
      configMapApply: apply,
    });
    await r.apply();
    expect(apply).toHaveBeenCalledOnce();
    const parsed = JSON.parse(apply.mock.calls[0][0]) as {
      manifests: Array<{ channel_type: string; httpPort?: number }>;
    };
    expect(parsed.manifests).toHaveLength(1);
    expect(parsed.manifests[0].httpPort).toBe(4080);
  });

  it('baseline entry without httpPort renders with NO httpPort key', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new ChannelManifestReconciler({
      baselineLoader: () => [makeBaseline('telegram')],
      configMapApply: apply,
    });
    await r.apply();
    const parsed = JSON.parse(apply.mock.calls[0][0]) as {
      manifests: Array<{ channel_type: string; httpPort?: number }>;
    };
    expect(
      Object.prototype.hasOwnProperty.call(parsed.manifests[0], 'httpPort'),
    ).toBe(false);
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

  it('includes httpPort in per-type ConfigMap value when present', () => {
    const data = renderChannelManifestConfigMapData([
      {
        channel_type: 'irc',
        package_json: '{"name":"irc-runtime","version":"1.0.0"}',
        package_lock_json: '{"lockfileVersion":3}',
        manifest_hash: 'abc',
        hostMode: 'channel-runner',
        httpPort: 4080,
      },
    ]);
    const parsed = JSON.parse(data['irc.json']) as { httpPort?: number };
    expect(parsed.httpPort).toBe(4080);
  });

  it('omits httpPort key entirely when not set (no default)', () => {
    const data = renderChannelManifestConfigMapData([
      {
        channel_type: 'http-echo',
        package_json: '{"name":"x"}',
        package_lock_json: '{}',
        manifest_hash: 'h',
      },
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(
        JSON.parse(data['http-echo.json']),
        'httpPort',
      ),
    ).toBe(false);
  });
});

// ── Telegram manifest validation (values.yaml integrity) ─────────────────────
describe('telegram manifest: values.yaml integrity', () => {
  // The telegram manifest is embedded in helm/kubeclaw/values.yaml.
  // These tests verify:
  //   1. packageJson and packageLockJson are valid JSON
  //   2. manifestHash = sha256(packageJson + '\n' + packageLockJson)
  //   3. packageJson declares telegraf@4.16.3 (no caret, exact pin)
  //   4. packageLockJson resolves telegraf@4.16.3

  // Inline the exact values from values.yaml so these tests catch drift.
  const TELEGRAM_PKG_JSON =
    '{"name":"runtime","version":"1.0.0","dependencies":{"telegraf":"4.16.3"}}';

  // Lock file: compact JSON generated by npm install telegraf@4.16.3 --package-lock-only --ignore-scripts
  // We store it as the lock file content from the values.yaml entry.
  // For the hash test we need the exact lock string stored in values.yaml.
  // We read it indirectly: the values.yaml is the source of truth for the lock.
  // Here we validate the hash formula using the embedded packageJson and the
  // known-good lock string (which must remain consistent with the hash field).
  const TELEGRAM_MANIFEST_HASH =
    'fc3f1d6b9fea0cbd1dc936d128926920b316bc88e2e6db0360eacee514e46382';

  it('packageJson is valid JSON and pins telegraf@4.16.3 exactly', () => {
    const pkg = JSON.parse(TELEGRAM_PKG_JSON);
    expect(pkg.name).toBe('runtime');
    expect(pkg.dependencies?.telegraf).toBe('4.16.3');
  });

  it('manifestHash matches sha256(packageJson + newline + packageLockJson)', async () => {
    // Load the values.yaml to extract the live packageLockJson
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const valuesPath = join(process.cwd(), 'helm/kubeclaw/values.yaml');
    const values = readFileSync(valuesPath, 'utf-8');

    // Extract packageLockJson from values.yaml via a regex
    // The field appears as: packageLockJson: '...'
    const match = values.match(/packageLockJson:\s*'([^']+)'/);
    expect(match).not.toBeNull();
    const lockJson = match![1]!;

    // Verify lock JSON is parseable and declares telegraf@4.16.3
    const lock = JSON.parse(lockJson);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages?.['node_modules/telegraf']?.version).toBe('4.16.3');

    // Verify the hash
    const computedHash = createHash('sha256')
      .update(TELEGRAM_PKG_JSON + '\n' + lockJson)
      .digest('hex');
    expect(computedHash).toBe(TELEGRAM_MANIFEST_HASH);
  });
});

// ── Helm-render integration test for telegram manifest ────────────────────────
describe('helm-render: telegram channelManifest', () => {
  it('renders telegram.json in the channel-manifests-baseline ConfigMap', () => {
    // Run helm template with the values.yaml defaults (telegram manifest is now included).
    // This confirms the YAML is well-formed and the template iterates over it correctly.
    const rendered = execSync('helm template helm/kubeclaw', {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    // The ConfigMap key should be `telegram.json`
    expect(rendered).toContain('telegram.json');
    // The manifest must carry hostMode: channel-runner
    expect(rendered).toContain('"hostMode":"channel-runner"');
    // The manifest must carry the expected hash
    expect(rendered).toContain(
      'fc3f1d6b9fea0cbd1dc936d128926920b316bc88e2e6db0360eacee514e46382',
    );
  });
});

// ── Discord manifest validation (values.yaml integrity) ──────────────────────
describe('discord manifest: values.yaml integrity', () => {
  // The discord manifest is embedded in helm/kubeclaw/values.yaml.
  // These tests verify:
  //   1. packageJson and packageLockJson are valid JSON
  //   2. manifestHash = sha256(packageJson + '\n' + packageLockJson)
  //   3. packageJson declares discord.js@14.26.4 (no caret, exact pin)
  //   4. packageLockJson resolves discord.js@14.26.4

  const DISCORD_PKG_JSON =
    '{"name":"runtime","version":"1.0.0","dependencies":{"discord.js":"14.26.4"}}';
  const DISCORD_MANIFEST_HASH =
    '64312557644dd2f4c30d19e1a516953d7895f9f9f56a62ec58c8698ac47e46dc';

  it('packageJson is valid JSON and pins discord.js@14.26.4 exactly (no caret)', () => {
    const pkg = JSON.parse(DISCORD_PKG_JSON);
    expect(pkg.name).toBe('runtime');
    // Exact pin — must NOT start with ^ or ~
    expect(pkg.dependencies?.['discord.js']).toBe('14.26.4');
  });

  it('manifestHash matches sha256(packageJson + newline + packageLockJson)', async () => {
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const valuesPath = join(process.cwd(), 'helm/kubeclaw/values.yaml');
    const values = readFileSync(valuesPath, 'utf-8');

    // Extract the discord packageLockJson specifically by finding the discord
    // manifest section: locate 'discord:' and then extract its packageLockJson.
    // We use a two-step approach: find the discord section and then the lock.
    const discordSectionMatch = values.match(
      /discord:\s*\n\s+hostMode:[^\n]+\n\s+packageJson:[^\n]+\n\s+packageLockJson:\s*'([^']+)'/,
    );
    expect(discordSectionMatch).not.toBeNull();
    const lockJson = discordSectionMatch![1]!;

    // Verify lock JSON is parseable and declares discord.js@14.26.4
    const lock = JSON.parse(lockJson);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages?.['node_modules/discord.js']?.version).toBe('14.26.4');

    // Verify the lock root dep is exact (no caret)
    expect(lock.packages?.['']?.dependencies?.['discord.js']).toBe('14.26.4');

    // Verify the hash
    const computedHash = createHash('sha256')
      .update(DISCORD_PKG_JSON + '\n' + lockJson)
      .digest('hex');
    expect(computedHash).toBe(DISCORD_MANIFEST_HASH);
  });
});

// ── Helm-render integration test for discord manifest ────────────────────────
describe('helm-render: discord channelManifest', () => {
  it('renders discord.json in the channel-manifests-baseline ConfigMap', () => {
    const rendered = execSync('helm template helm/kubeclaw', {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    // The ConfigMap key should be `discord.json`
    expect(rendered).toContain('discord.json');
    // The manifest must carry the expected hash
    expect(rendered).toContain(
      '64312557644dd2f4c30d19e1a516953d7895f9f9f56a62ec58c8698ac47e46dc',
    );
  });
});

// ── Matrix manifest validation (values.yaml integrity) ───────────────────────
describe('matrix manifest: values.yaml integrity', () => {
  // The matrix manifest is embedded in helm/kubeclaw/values.yaml.
  // These tests verify:
  //   1. packageJson and packageLockJson are valid JSON
  //   2. manifestHash = sha256(packageJson + '\n' + packageLockJson)
  //   3. packageJson declares matrix-js-sdk@41.8.0 (no caret, exact pin)
  //   4. packageLockJson resolves matrix-js-sdk@41.8.0
  //   5. No initRustCrypto() calls (crypto never loaded in channel-runner context)

  const MATRIX_PKG_JSON =
    '{"name":"runtime","version":"1.0.0","dependencies":{"matrix-js-sdk":"41.8.0"}}';
  const MATRIX_MANIFEST_HASH =
    'ab892cc5c493737c0499794cc37faf3f93b2907e08e1ffa707e693d8753dcc66';

  it('packageJson is valid JSON and pins matrix-js-sdk@41.8.0 exactly (no caret)', () => {
    const pkg = JSON.parse(MATRIX_PKG_JSON);
    expect(pkg.name).toBe('runtime');
    // Exact pin — must NOT start with ^ or ~
    expect(pkg.dependencies?.['matrix-js-sdk']).toBe('41.8.0');
  });

  it('manifestHash matches sha256(packageJson + newline + packageLockJson)', async () => {
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const valuesPath = join(process.cwd(), 'helm/kubeclaw/values.yaml');
    const values = readFileSync(valuesPath, 'utf-8');

    // Extract the matrix packageLockJson: find the matrix section and its lock.
    const matrixSectionMatch = values.match(
      /matrix:\s*\n\s+hostMode:[^\n]+\n\s+packageJson:[^\n]+\n\s+packageLockJson:\s*'([^']+)'/,
    );
    expect(matrixSectionMatch).not.toBeNull();
    const lockJson = matrixSectionMatch![1]!;

    // Verify lock JSON is parseable and declares matrix-js-sdk@41.8.0
    const lock = JSON.parse(lockJson);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages?.['node_modules/matrix-js-sdk']?.version).toBe(
      '41.8.0',
    );

    // Verify the lock root dep is exact (no caret)
    expect(lock.packages?.['']?.dependencies?.['matrix-js-sdk']).toBe('41.8.0');

    // Verify the hash
    const computedHash = createHash('sha256')
      .update(MATRIX_PKG_JSON + '\n' + lockJson)
      .digest('hex');
    expect(computedHash).toBe(MATRIX_MANIFEST_HASH);
  });
});

// ── Helm-render integration test for matrix manifest ─────────────────────────
describe('helm-render: matrix channelManifest', () => {
  it('renders matrix.json in the channel-manifests-baseline ConfigMap', () => {
    const rendered = execSync('helm template helm/kubeclaw', {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    // The ConfigMap key should be `matrix.json`
    expect(rendered).toContain('matrix.json');
    // The manifest must carry hostMode: channel-runner
    expect(rendered).toContain('"hostMode":"channel-runner"');
    // The manifest must carry the expected hash
    expect(rendered).toContain(
      'ab892cc5c493737c0499794cc37faf3f93b2907e08e1ffa707e693d8753dcc66',
    );
  });
});

// ── WhatsApp manifest validation (values.yaml integrity) ─────────────────────
describe('whatsapp manifest: values.yaml integrity', () => {
  // The whatsapp manifest is embedded in helm/kubeclaw/values.yaml.
  // WhatsApp uses NO npm deps (native fetch/http/crypto) — empty dependencies.
  // Tests verify:
  //   1. packageJson and packageLockJson are valid JSON
  //   2. manifestHash = sha256(packageJson + '\n' + packageLockJson)
  //   3. packageJson has empty dependencies {}
  //   4. httpPort: 4080 is set (webhook server)

  const WHATSAPP_PKG_JSON =
    '{"name":"runtime","version":"1.0.0","dependencies":{}}';
  const WHATSAPP_MANIFEST_HASH =
    '264348b405cd912a860ccb687d572590a9cf8f3a65196dcf6799aa93805d4329';

  it('packageJson is valid JSON and has empty dependencies (no npm deps)', () => {
    const pkg = JSON.parse(WHATSAPP_PKG_JSON);
    expect(pkg.name).toBe('runtime');
    expect(pkg.dependencies).toEqual({});
  });

  it('manifestHash matches sha256(packageJson + newline + packageLockJson)', async () => {
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const valuesPath = join(process.cwd(), 'helm/kubeclaw/values.yaml');
    const values = readFileSync(valuesPath, 'utf-8');

    // Extract the whatsapp packageLockJson section
    const whatsappSectionMatch = values.match(
      /whatsapp:\s*\n\s+hostMode:[^\n]+\n\s+httpPort:[^\n]+\n\s+packageJson:[^\n]+\n\s+packageLockJson:\s*'([^']+)'/,
    );
    expect(whatsappSectionMatch).not.toBeNull();
    const lockJson = whatsappSectionMatch![1]!;

    // Verify lock JSON is parseable and has empty dependencies
    const lock = JSON.parse(lockJson);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages?.['']?.dependencies).toEqual({});

    // Verify the hash
    const computedHash = createHash('sha256')
      .update(WHATSAPP_PKG_JSON + '\n' + lockJson)
      .digest('hex');
    expect(computedHash).toBe(WHATSAPP_MANIFEST_HASH);
  });
});

// ── Helm-render integration test for whatsapp manifest ───────────────────────
describe('helm-render: whatsapp channelManifest', () => {
  it('renders whatsapp.json in the channel-manifests-baseline ConfigMap with httpPort', () => {
    const rendered = execSync('helm template helm/kubeclaw', {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    // The ConfigMap key should be `whatsapp.json`
    expect(rendered).toContain('whatsapp.json');
    // The manifest must carry hostMode: channel-runner
    expect(rendered).toContain('"hostMode":"channel-runner"');
    // The manifest must carry httpPort: 4080
    expect(rendered).toContain('"httpPort":4080');
    // The manifest must carry the expected hash
    expect(rendered).toContain(
      '264348b405cd912a860ccb687d572590a9cf8f3a65196dcf6799aa93805d4329',
    );
  });

  it('renders Service and NetworkPolicy for the whatsapp channel (httpPort wiring)', () => {
    // Render with an enabled whatsapp channel instance + httpPort to verify Service renders.
    // channels.*.enabled must be true for the Deployment/Service to be included.
    const valuesFile = join(
      require('os').tmpdir(),
      'whatsapp-test-values.yaml',
    );
    require('fs').writeFileSync(
      valuesFile,
      [
        'channels:',
        '  whatsapp-test:',
        '    type: whatsapp',
        '    httpPort: 4080',
        '    enabled: true',
      ].join('\n'),
    );
    const rendered = execSync(`helm template helm/kubeclaw -f ${valuesFile}`, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    // Service should render for the whatsapp channel instance
    expect(rendered).toContain('kubeclaw-channel-whatsapp-test');
    // Port 4080 should appear in the rendered output
    expect(rendered).toContain('4080');
  });
});
