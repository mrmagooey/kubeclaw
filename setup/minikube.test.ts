import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for setup/minikube.ts.
 *
 * Covers:
 *   - parseArgs: defaults, profile, cpu/memory/disk/skip flags
 *   - parseArgs: --cni flag (= and space forms), --with-cilium
 *   - parseArgs: invalid --cni value throws
 *   - hostUsesNftables: stdout containing nf_tables / legacy / no tag / not-found
 *   - resolveCni: explicit cilium / bridge pass-through, auto + nf_tables → bridge, auto + legacy → cilium
 *   - checkInotifyLimits: low/ok/boundary/non-Linux/unreadable
 */

// ── mocks ─────────────────────────────────────────────────────────────────────

// Intercept spawnSync calls (used by hostUsesNftables and resolveCni).
const mockSpawnSync = vi.fn();
vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }));

// Intercept readFileSync calls (used by checkInotifyLimits).
const mockReadFileResults: Map<string, string | Error> = new Map();
vi.mock('node:fs', () => ({
  readFileSync: vi.fn((filePath: string) => {
    const result = mockReadFileResults.get(filePath);
    if (result === undefined) throw new Error(`ENOENT: ${filePath}`);
    if (result instanceof Error) throw result;
    return result;
  }),
}));

// Silence logger output during tests.
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function spawnResult(stdout: string, status = 0) {
  return { status, stdout, stderr: '', error: undefined };
}

function setInotifyValues(instances: number | null, watches: number | null) {
  if (instances !== null) {
    mockReadFileResults.set(
      '/proc/sys/fs/inotify/max_user_instances',
      `${instances}\n`,
    );
  }
  if (watches !== null) {
    mockReadFileResults.set(
      '/proc/sys/fs/inotify/max_user_watches',
      `${watches}\n`,
    );
  }
}

// FIXME: Tests use dynamic `import('./minikube.js')` inside each `it` so that
// the module is re-evaluated after `process.platform` is overridden in
// `beforeEach`. Refactoring to a top-level import would require a different
// strategy for mocking `process.platform` (e.g. a module factory that reads
// platform at call time), which would need a substantial restructure.

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  let parseArgs: (args: string[]) => {
    cpus: number; memory: number; disk: string;
    reset: boolean; skipBuild: boolean; skipFalco: boolean; skipCertManager: boolean;
    profile: string;
    cni: 'cilium' | 'bridge' | 'auto';
  };

  beforeEach(async () => {
    const mod = await import('./minikube.js');
    parseArgs = mod.parseArgs;
  });

  it('returns defaults when no args given', () => {
    const opts = parseArgs([]);
    expect(opts.cpus).toBe(4);
    expect(opts.memory).toBe(8192);
    expect(opts.disk).toBe('20g');
    expect(opts.reset).toBe(false);
    expect(opts.skipBuild).toBe(false);
    expect(opts.skipFalco).toBe(false);
    expect(opts.skipCertManager).toBe(false);
    expect(opts.profile).toBe('');
    expect(opts.cni).toBe('auto');
  });

  it('parses --reset flag', () => {
    expect(parseArgs(['--reset']).reset).toBe(true);
  });

  it('parses --skip-build flag', () => {
    expect(parseArgs(['--skip-build']).skipBuild).toBe(true);
  });

  it('parses --skip-falco flag', () => {
    expect(parseArgs(['--skip-falco']).skipFalco).toBe(true);
  });

  it('parses --skip-cert-manager flag', () => {
    expect(parseArgs(['--skip-cert-manager']).skipCertManager).toBe(true);
  });

  it('parses --skip-cert-manager alongside other skip flags', () => {
    const opts = parseArgs(['--skip-falco', '--skip-cert-manager', '--skip-build']);
    expect(opts.skipFalco).toBe(true);
    expect(opts.skipCertManager).toBe(true);
    expect(opts.skipBuild).toBe(true);
  });

  it('parses --cpus value', () => {
    expect(parseArgs(['--cpus', '8']).cpus).toBe(8);
  });

  it('parses --memory value', () => {
    expect(parseArgs(['--memory', '4096']).memory).toBe(4096);
  });

  it('parses --disk value', () => {
    expect(parseArgs(['--disk', '40g']).disk).toBe('40g');
  });

  it('parses --profile <name>', () => {
    const opts = parseArgs(['--profile', 'kubeclaw']);
    expect(opts.profile).toBe('kubeclaw');
  });

  it('parses --profile alongside other flags', () => {
    const opts = parseArgs(['--reset', '--profile', 'dev', '--cpus', '6']);
    expect(opts.reset).toBe(true);
    expect(opts.profile).toBe('dev');
    expect(opts.cpus).toBe(6);
  });

  it('leaves profile empty when --profile is not supplied', () => {
    const opts = parseArgs(['--skip-build', '--memory', '8192']);
    expect(opts.profile).toBe('');
    expect(opts.skipBuild).toBe(true);
    expect(opts.memory).toBe(8192);
  });

  it('--cni=cilium sets cni to cilium', () => {
    expect(parseArgs(['--cni=cilium']).cni).toBe('cilium');
  });

  it('--cni=bridge sets cni to bridge', () => {
    expect(parseArgs(['--cni=bridge']).cni).toBe('bridge');
  });

  it('--cni=auto sets cni to auto', () => {
    expect(parseArgs(['--cni=auto']).cni).toBe('auto');
  });

  it('--cni cilium (space-separated) sets cni to cilium', () => {
    expect(parseArgs(['--cni', 'cilium']).cni).toBe('cilium');
  });

  it('--with-cilium sets cni to cilium', () => {
    expect(parseArgs(['--with-cilium']).cni).toBe('cilium');
  });

  it('--with-cilium overrides earlier --cni=bridge', () => {
    expect(parseArgs(['--cni=bridge', '--with-cilium']).cni).toBe('cilium');
  });

  it('--cni=bridge after --with-cilium wins (last write wins)', () => {
    expect(parseArgs(['--with-cilium', '--cni=bridge']).cni).toBe('bridge');
  });

  it('throws on unknown --cni value (= form)', () => {
    expect(() => parseArgs(['--cni=flannel'])).toThrow(/Unknown --cni value "flannel"/);
  });

  it('throws on unknown --cni value (space form)', () => {
    expect(() => parseArgs(['--cni', 'weave'])).toThrow(/Unknown --cni value "weave"/);
  });

  it('parses other flags correctly alongside --cni and --profile', () => {
    const opts = parseArgs([
      '--cpus', '6',
      '--memory', '8192',
      '--disk', '30g',
      '--reset',
      '--skip-build',
      '--skip-falco',
      '--profile', 'kubeclaw',
      '--cni=bridge',
    ]);
    expect(opts.cpus).toBe(6);
    expect(opts.memory).toBe(8192);
    expect(opts.disk).toBe('30g');
    expect(opts.reset).toBe(true);
    expect(opts.skipBuild).toBe(true);
    expect(opts.skipFalco).toBe(true);
    expect(opts.profile).toBe('kubeclaw');
    expect(opts.cni).toBe('bridge');
  });
});

// ── hostUsesNftables ──────────────────────────────────────────────────────────

describe('hostUsesNftables', () => {
  let hostUsesNftables: () => boolean;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('./minikube.js');
    hostUsesNftables = mod.hostUsesNftables;
  });

  it('returns true when iptables reports nf_tables', () => {
    mockSpawnSync.mockReturnValue(spawnResult('iptables v1.8.7 (nf_tables)\n'));
    expect(hostUsesNftables()).toBe(true);
  });

  it('returns false when iptables reports legacy', () => {
    mockSpawnSync.mockReturnValue(spawnResult('iptables v1.8.7 (legacy)\n'));
    expect(hostUsesNftables()).toBe(false);
  });

  it('returns false when iptables output has no backend tag', () => {
    mockSpawnSync.mockReturnValue(spawnResult('iptables v1.6.0\n'));
    expect(hostUsesNftables()).toBe(false);
  });

  it('returns false when iptables is not found (status != 0)', () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not found', error: undefined });
    expect(hostUsesNftables()).toBe(false);
  });
});

// ── resolveCni ────────────────────────────────────────────────────────────────

describe('resolveCni', () => {
  let resolveCni: (mode: 'cilium' | 'bridge' | 'auto') => 'cilium' | 'bridge';

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('./minikube.js');
    resolveCni = mod.resolveCni;
  });

  it('returns cilium when explicitly requested', () => {
    expect(resolveCni('cilium')).toBe('cilium');
  });

  it('returns bridge when explicitly requested', () => {
    expect(resolveCni('bridge')).toBe('bridge');
  });

  it('auto returns bridge when host uses nf_tables', () => {
    mockSpawnSync.mockReturnValue(spawnResult('iptables v1.8.7 (nf_tables)\n'));
    expect(resolveCni('auto')).toBe('bridge');
  });

  it('auto returns cilium when host uses legacy iptables', () => {
    mockSpawnSync.mockReturnValue(spawnResult('iptables v1.8.7 (legacy)\n'));
    expect(resolveCni('auto')).toBe('cilium');
  });

  it('explicit cilium ignores iptables backend (no spawnSync call)', () => {
    resolveCni('cilium');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('explicit bridge ignores iptables backend (no spawnSync call)', () => {
    resolveCni('bridge');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

// ── checkInotifyLimits ────────────────────────────────────────────────────────

describe('checkInotifyLimits', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileResults.clear();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('returns an error when max_user_instances is below the minimum (512)', async () => {
    setInotifyValues(128, 524288);
    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('inotify limits are too low');
    expect(errors[0]).toContain('max_user_instances = 128');
    expect(errors[0]).toContain('sudo sysctl -w fs.inotify.max_user_instances=8192');
    expect(errors[0]).toContain('sudo sysctl -w fs.inotify.max_user_watches=524288');
    expect(errors[0]).toContain('/etc/sysctl.d/99-inotify.conf');
  });

  it('returns an error when max_user_watches is below the minimum (65536)', async () => {
    setInotifyValues(8192, 8192);
    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('inotify limits are too low');
    expect(errors[0]).toContain('max_user_watches   = 8192');
    expect(errors[0]).toContain('sudo sysctl -w fs.inotify.max_user_watches=524288');
  });

  it('returns an error when both values are below their minimums', async () => {
    setInotifyValues(128, 8192);
    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('max_user_instances = 128');
    expect(errors[0]).toContain('max_user_watches   = 8192');
  });

  it('returns no errors when both values meet the thresholds', async () => {
    setInotifyValues(512, 65536);
    const { checkInotifyLimits } = await import('./minikube.js');
    expect(checkInotifyLimits()).toHaveLength(0);
  });

  it('returns no errors when values greatly exceed the thresholds', async () => {
    setInotifyValues(8192, 524288);
    const { checkInotifyLimits } = await import('./minikube.js');
    expect(checkInotifyLimits()).toHaveLength(0);
  });

  it('passes when instances is exactly at the minimum boundary (512)', async () => {
    setInotifyValues(512, 65536);
    const { checkInotifyLimits } = await import('./minikube.js');
    expect(checkInotifyLimits()).toHaveLength(0);
  });

  it('passes when watches is exactly at the minimum boundary (instances=8192, watches=65536)', async () => {
    setInotifyValues(8192, 65536);
    const { checkInotifyLimits } = await import('./minikube.js');
    expect(checkInotifyLimits()).toHaveLength(0);
  });

  it('returns an error when instances is one below the minimum (511)', async () => {
    setInotifyValues(511, 65536);
    const { checkInotifyLimits } = await import('./minikube.js');
    expect(checkInotifyLimits()).toHaveLength(1);
  });

  it('skips the check on non-Linux platforms (macOS)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockReadFileResults.clear();
    const { checkInotifyLimits } = await import('./minikube.js');
    expect(checkInotifyLimits()).toHaveLength(0);
  });

  it('skips the check on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockReadFileResults.clear();
    const { checkInotifyLimits } = await import('./minikube.js');
    expect(checkInotifyLimits()).toHaveLength(0);
  });

  it('returns an error when /proc/sys/fs/inotify files are unreadable', async () => {
    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('(unreadable)');
  });

  it('error message includes the sysctl.d persistence snippet', async () => {
    setInotifyValues(128, 8192);
    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();
    expect(errors[0]).toContain('fs.inotify.max_user_instances = 8192');
    expect(errors[0]).toContain('fs.inotify.max_user_watches   = 524288');
    expect(errors[0]).toContain('sudo sysctl --system');
  });
});
