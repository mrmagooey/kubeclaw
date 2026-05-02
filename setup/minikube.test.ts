import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for the inotify preflight check added to setup/minikube.ts.
 *
 * Covers:
 *   - low max_user_instances fails
 *   - low max_user_watches fails
 *   - both values ok passes
 *   - non-Linux platform is skipped
 */

// ── fs mock ───────────────────────────────────────────────────────────────────

let mockReadFileResults: Map<string, string | Error> = new Map();

vi.mock('node:fs', () => ({
  readFileSync: vi.fn((filePath: string) => {
    const result = mockReadFileResults.get(filePath);
    if (result === undefined) throw new Error(`ENOENT: ${filePath}`);
    if (result instanceof Error) throw result;
    return result;
  }),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

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
// `beforeEach`. Refactoring to a top-level import + `vi.mock('node:fs')` would
// require a different strategy for mocking `process.platform` (e.g. a module
// factory that reads platform at call time), which would need a substantial
// restructure. Leave as-is until a cleaner pattern is established.

// ── tests ─────────────────────────────────────────────────────────────────────

describe('checkInotifyLimits', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileResults.clear();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    // Default to linux for most tests
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
    const errors = checkInotifyLimits();

    expect(errors).toHaveLength(0);
  });

  it('returns no errors when values greatly exceed the thresholds', async () => {
    setInotifyValues(8192, 524288);

    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();

    expect(errors).toHaveLength(0);
  });

  it('passes when instances is exactly at the minimum boundary (512)', async () => {
    setInotifyValues(512, 65536);

    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();

    expect(errors).toHaveLength(0);
  });

  it('passes when watches is exactly at the minimum boundary (instances=8192, watches=65536)', async () => {
    setInotifyValues(8192, 65536);

    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();

    expect(errors).toHaveLength(0);
  });

  it('returns an error when instances is one below the minimum (511)', async () => {
    setInotifyValues(511, 65536);

    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();

    expect(errors).toHaveLength(1);
  });

  it('skips the check on non-Linux platforms (macOS)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    // Don't set any mock values — if it read the files on macOS it would throw
    mockReadFileResults.clear();

    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();

    expect(errors).toHaveLength(0);
  });

  it('skips the check on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockReadFileResults.clear();

    const { checkInotifyLimits } = await import('./minikube.js');
    const errors = checkInotifyLimits();

    expect(errors).toHaveLength(0);
  });

  it('returns an error when /proc/sys/fs/inotify files are unreadable', async () => {
    // Don't set any values — readFileSync will throw ENOENT
    // Both values unreadable (null), which should trigger the fail path

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
