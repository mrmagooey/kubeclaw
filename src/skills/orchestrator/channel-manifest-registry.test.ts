import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerChannelManifest,
  listChannelManifestOverrides,
} from './channel-manifest-registry.js';
import { _initTestDatabase, __resetDbForTest, db } from '../../db.js';

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

describe('channel_manifest_overrides table', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('table exists after schema init', () => {
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='channel_manifest_overrides'`,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values[0][0]).toBe('channel_manifest_overrides');
  });
});

describe('registerChannelManifest', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('inserts a valid manifest and returns the hash', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.source).toBe('admin-registered');
    expect(listChannelManifestOverrides()).toHaveLength(1);
  });

  it('rejects package_json that is not valid JSON', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: 'not-json',
      package_lock_json: VALID_LOCK,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/invalid JSON/i);
  });

  it('rejects package_json missing top-level dependencies', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: JSON.stringify({ name: 'runtime', version: '1.0.0' }),
      package_lock_json: VALID_LOCK,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/dependencies/i);
  });

  it('rejects package_json with devDependencies', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: JSON.stringify({
        name: 'runtime',
        dependencies: { telegraf: '4.16.3' },
        devDependencies: { typescript: '5.0.0' },
      }),
      package_lock_json: VALID_LOCK,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/devDependencies/i);
  });

  it('rejects non-allowlisted lifecycle script in package.json scripts', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: JSON.stringify({
        name: 'runtime',
        dependencies: { telegraf: '4.16.3' },
        scripts: { postinstall: 'echo hi' },
      }),
      package_lock_json: VALID_LOCK,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/postinstall/i);
  });

  it('accepts lifecycle script when it is in the allowlist', () => {
    const r = registerChannelManifest(
      {
        channel_type: 'telegram',
        package_json: JSON.stringify({
          name: 'runtime',
          dependencies: { telegraf: '4.16.3' },
          scripts: { prepare: 'node setup.js' },
        }),
        package_lock_json: VALID_LOCK,
      },
      ['prepare'],
    );
    expect(r.ok).toBe(true);
  });

  it('rejects non-allowlisted lifecycle script in lockfile packages', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: JSON.stringify({
        name: 'runtime',
        lockfileVersion: 3,
        packages: {
          'node_modules/foo': { scripts: { postinstall: 'echo bad' } },
        },
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/node_modules\/foo/);
    expect(r.error).toMatch(/postinstall/);
  });

  it('rejects lockfile v1/v2 (lockfileVersion !== 3)', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: JSON.stringify({
        name: 'runtime',
        lockfileVersion: 2,
        packages: {},
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/lockfileVersion/i);
  });

  it('is idempotent on identical (channel_type, content) — no reconcile on second call', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const r1 = registerChannelManifest(
      {
        channel_type: 'telegram',
        package_json: VALID_PKG,
        package_lock_json: VALID_LOCK,
      },
      [],
      reconcile,
    );
    expect(r1.ok).toBe(true);
    // Give the fire-and-forget reconcile a tick to run
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);

    const r2 = registerChannelManifest(
      {
        channel_type: 'telegram',
        package_json: VALID_PKG,
        package_lock_json: VALID_LOCK,
      },
      [],
      reconcile,
    );
    expect(r2.ok).toBe(true);
    // Same hash — idempotent short-circuit, reconcile NOT called again
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('calls reconcile again on same channel_type with different content', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    registerChannelManifest(
      {
        channel_type: 'telegram',
        package_json: VALID_PKG,
        package_lock_json: VALID_LOCK,
      },
      [],
      reconcile,
    );
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Different content for same channel_type → new hash → reconcile
    const newPkg = JSON.stringify({
      name: 'runtime',
      version: '2.0.0',
      dependencies: { telegraf: '4.16.4' },
    });
    registerChannelManifest(
      {
        channel_type: 'telegram',
        package_json: newPkg,
        package_lock_json: VALID_LOCK,
      },
      [],
      reconcile,
    );
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('triggers reconcile after successful insert', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    registerChannelManifest(
      {
        channel_type: 'telegram',
        package_json: VALID_PKG,
        package_lock_json: VALID_LOCK,
      },
      [],
      reconcile,
    );
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledOnce();
  });
});

describe('registerChannelManifest host_mode', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('persists host_mode channel-runner when provided', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
    });
    expect(r.ok).toBe(true);
    const list = listChannelManifestOverrides();
    expect(list).toHaveLength(1);
    expect(list[0].host_mode).toBe('channel-runner');
  });

  it('defaults host_mode to standalone when omitted', () => {
    registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
    });
    const list = listChannelManifestOverrides();
    expect(list[0].host_mode).toBe('standalone');
  });

  it('rejects host_mode bogus with an error', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'bogus' as 'standalone',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/host_mode/i);
  });

  it('updates host_mode even when manifest hash is unchanged', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    // Register with standalone host_mode
    registerChannelManifest(
      {
        channel_type: 'telegram',
        package_json: VALID_PKG,
        package_lock_json: VALID_LOCK,
        host_mode: 'standalone',
      },
      [],
      reconcile,
    );
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Re-register with same package files (same hash) but different host_mode
    const r2 = registerChannelManifest(
      {
        channel_type: 'telegram',
        package_json: VALID_PKG,
        package_lock_json: VALID_LOCK,
        host_mode: 'channel-runner',
      },
      [],
      reconcile,
    );
    expect(r2.ok).toBe(true);
    await Promise.resolve();
    // Should have called reconcile again because host_mode changed
    expect(reconcile).toHaveBeenCalledTimes(2);

    // Verify the stored host_mode is now 'channel-runner'
    const list = listChannelManifestOverrides();
    expect(list).toHaveLength(1);
    expect(list[0].host_mode).toBe('channel-runner');
  });
});

describe('registerChannelManifest http_port', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('persists http_port 4080 when provided and returns entry with httpPort: 4080', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      http_port: 4080,
    });
    expect(r.ok).toBe(true);
    const list = listChannelManifestOverrides();
    expect(list).toHaveLength(1);
    expect(list[0].http_port).toBe(4080);
  });

  it('entry has no http_port (undefined) when not provided', () => {
    registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
    });
    const list = listChannelManifestOverrides();
    expect(list[0].http_port).toBeUndefined();
  });

  it('rejects http_port 80 (below 1024) with descriptive error', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      http_port: 80,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/http_port/i);
    expect(r.error).toMatch(/1024/);
  });

  it('rejects http_port 70000 (above 65535) with descriptive error', () => {
    const r = registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      http_port: 70000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/http_port/i);
    expect(r.error).toMatch(/65535/);
  });
});

describe('registerChannelManifest sidecar', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  const VALID_SIDECAR = {
    image: 'bbernhard/signal-cli-rest-api:0.93',
    port: 8080,
    sessionMountPath: '/home/signal-api/.local/share/signal-cli',
    sessionStorageGi: 2,
  };

  it('registers a valid sidecar + host_mode channel-runner and persists it', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: VALID_SIDECAR,
    });
    expect(r.ok).toBe(true);
    const list = listChannelManifestOverrides();
    expect(list).toHaveLength(1);
    expect(list[0].sidecar).toEqual(VALID_SIDECAR);
  });

  it('stores optional sidecar fields when provided', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: {
        ...VALID_SIDECAR,
        env: [{ name: 'MODE', value: 'normal' }],
        healthPath: '/v1/about',
        egressPorts: [443],
      },
    });
    expect(r.ok).toBe(true);
    const list = listChannelManifestOverrides();
    expect(list[0].sidecar?.env).toEqual([{ name: 'MODE', value: 'normal' }]);
    expect(list[0].sidecar?.healthPath).toBe('/v1/about');
    expect(list[0].sidecar?.egressPorts).toEqual([443]);
  });

  it('rejects sidecar when host_mode is standalone', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'standalone',
      sidecar: VALID_SIDECAR,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/channel-runner/i);
  });

  it('rejects sidecar when host_mode is omitted (defaults to standalone)', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      sidecar: VALID_SIDECAR,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/channel-runner/i);
  });

  it('rejects sidecar with missing image', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, image: '' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/image/i);
  });

  it('rejects sidecar with missing port (zero)', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, port: 0 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/port/i);
  });

  it('rejects sidecar with port above 65535', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, port: 70000 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/port/i);
  });

  it('accepts a valid mid-range port (1234)', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, port: 1234 },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects sidecar with missing sessionMountPath', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, sessionMountPath: '' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/sessionMountPath/i);
  });

  it('rejects sidecar with non-absolute sessionMountPath', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, sessionMountPath: 'relative/path' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/sessionMountPath/i);
  });

  it('rejects sidecar with sessionStorageGi = 0', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, sessionStorageGi: 0 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/sessionStorageGi/i);
  });

  it('rejects egressPorts containing an out-of-range port (70000)', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, egressPorts: [443, 70000] },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/egressPorts/i);
  });

  it('accepts egressPorts: [443]', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, egressPorts: [443] },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects env entry with empty name', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, env: [{ name: '', value: 'x' }] },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/env/i);
  });

  it('accepts sidecar with runAsUser=101 (nginx-unprivileged uid)', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, runAsUser: 101 },
    });
    expect(r.ok).toBe(true);
    const list = listChannelManifestOverrides();
    expect(list[0].sidecar?.runAsUser).toBe(101);
  });

  it('rejects sidecar.runAsUser=0 (must be > 0)', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, runAsUser: 0 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/runAsUser/i);
  });

  it('rejects sidecar.runAsUser=-1 (negative)', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: { ...VALID_SIDECAR, runAsUser: -1 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/runAsUser/i);
  });

  it('accepts sidecar without runAsUser (omitted is valid — lets image USER apply)', () => {
    const r = registerChannelManifest({
      channel_type: 'signal',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
      host_mode: 'channel-runner',
      sidecar: VALID_SIDECAR, // no runAsUser
    });
    expect(r.ok).toBe(true);
    const list = listChannelManifestOverrides();
    expect(list[0].sidecar?.runAsUser).toBeUndefined();
  });
});

describe('listChannelManifestOverrides', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('returns empty array when no overrides registered', () => {
    expect(listChannelManifestOverrides()).toEqual([]);
  });

  it('returns all overrides ordered by channel_type', () => {
    registerChannelManifest({
      channel_type: 'telegram',
      package_json: VALID_PKG,
      package_lock_json: VALID_LOCK,
    });
    registerChannelManifest({
      channel_type: 'slack',
      package_json: JSON.stringify({
        name: 'runtime',
        dependencies: { '@slack/bolt': '3.0.0' },
      }),
      package_lock_json: VALID_LOCK,
    });
    const list = listChannelManifestOverrides();
    expect(list).toHaveLength(2);
    expect(list[0].channel_type).toBe('slack');
    expect(list[1].channel_type).toBe('telegram');
  });
});
