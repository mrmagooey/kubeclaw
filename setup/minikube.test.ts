import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for setup/minikube.ts — parseArgs, hostUsesNftables, resolveCni.
 *
 * All child_process calls are mocked. The tests cover:
 *   - parseArgs: defaults, profile, cpu/memory/disk/skip flags
 *   - parseArgs: --cni flag (= and space forms), --with-cilium
 *   - parseArgs: invalid --cni value throws
 *   - hostUsesNftables: stdout containing nf_tables / legacy / no tag
 *   - resolveCni: explicit cilium / bridge pass-through
 *   - resolveCni: auto + nf_tables → bridge, auto + legacy → cilium
 */

// ── mocks ─────────────────────────────────────────────────────────────────────

// We need to intercept spawnSync calls that hostUsesNftables makes.
// The module uses spawnSync at the top level so we mock child_process.
const mockSpawnSync = vi.fn();
vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }));

// Silence logger output during tests.
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function spawnResult(stdout: string, status = 0) {
  return { status, stdout, stderr: '', error: undefined };
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  let parseArgs: (args: string[]) => {
    cpus: number; memory: number; disk: string;
    reset: boolean; skipBuild: boolean; skipFalco: boolean;
    profile: string;
    cni: 'cilium' | 'bridge' | 'auto';
  };

  beforeEach(async () => {
    // Re-import every time to get a fresh module instance with mocks applied.
    const mod = await import('./minikube.js');
    parseArgs = mod.parseArgs;
  });

  it('returns defaults when no args given', () => {
    const opts = parseArgs([]);
    expect(opts.cpus).toBe(4);
    expect(opts.memory).toBe(6144);
    expect(opts.disk).toBe('20g');
    expect(opts.reset).toBe(false);
    expect(opts.skipBuild).toBe(false);
    expect(opts.skipFalco).toBe(false);
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
    mockSpawnSync.mockReturnValue(
      spawnResult('iptables v1.8.7 (nf_tables)\n'),
    );
    expect(hostUsesNftables()).toBe(true);
  });

  it('returns false when iptables reports legacy', () => {
    mockSpawnSync.mockReturnValue(
      spawnResult('iptables v1.8.7 (legacy)\n'),
    );
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
    mockSpawnSync.mockReturnValue(
      spawnResult('iptables v1.8.7 (nf_tables)\n'),
    );
    expect(resolveCni('auto')).toBe('bridge');
  });

  it('auto returns cilium when host uses legacy iptables', () => {
    mockSpawnSync.mockReturnValue(
      spawnResult('iptables v1.8.7 (legacy)\n'),
    );
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
