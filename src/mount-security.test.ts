import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
const mockPathRelative = vi.fn();
const mockPathIsAbsolute = vi.fn();
const mockPathBasename = vi.fn();

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/home/user/.config/nanoclaw/mount-allowlist.json',
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    realpathSync: mockRealpathSync,
  };
});

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return {
    ...actual,
    join: (...args: string[]) => args.join('/'),
    resolve: (...args: string[]) => args.join('/'),
    sep: '/',
    relative: mockPathRelative,
    isAbsolute: mockPathIsAbsolute,
    basename: mockPathBasename,
  };
});

describe('loadMountAllowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns null when allowlist file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const { loadMountAllowlist } = await import('./mount-security.js');
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when allowlist file contains invalid JSON', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('invalid json');
    const { loadMountAllowlist } = await import('./mount-security.js');
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when allowedRoots is not an array', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: 'not-array',
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    );
    const { loadMountAllowlist } = await import('./mount-security.js');
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: 'not-array',
        nonMainReadOnly: true,
      }),
    );
    const { loadMountAllowlist } = await import('./mount-security.js');
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when nonMainReadOnly is not a boolean', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'yes',
      }),
    );
    const { loadMountAllowlist } = await import('./mount-security.js');
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });
});

describe('validateMount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns blocked when no allowlist is configured', async () => {
    mockExistsSync.mockReturnValue(false);
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: '~/projects/test' }, true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured');
  });
});

describe('validateAdditionalMounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns empty array for empty mounts input', async () => {
    mockExistsSync.mockReturnValue(false);
    const { validateAdditionalMounts } = await import('./mount-security.js');
    const result = validateAdditionalMounts([], 'test-group', true);
    expect(result).toEqual([]);
  });

  it('rejects all mounts when no allowlist configured', async () => {
    mockExistsSync.mockReturnValue(false);
    const { validateAdditionalMounts } = await import('./mount-security.js');
    const result = validateAdditionalMounts(
      [{ hostPath: '~/projects/myapp' }],
      'test-group',
      true,
    );

    expect(result).toHaveLength(0);
  });
});

describe('generateAllowlistTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns valid JSON template', async () => {
    const { generateAllowlistTemplate } = await import('./mount-security.js');
    const result = generateAllowlistTemplate();

    const parsed = JSON.parse(result);
    expect(parsed.allowedRoots).toBeInstanceOf(Array);
    expect(parsed.blockedPatterns).toBeInstanceOf(Array);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });

  it('includes default allowed roots', async () => {
    const { generateAllowlistTemplate } = await import('./mount-security.js');
    const result = generateAllowlistTemplate();

    const parsed = JSON.parse(result);
    expect(parsed.allowedRoots).toContainEqual(
      expect.objectContaining({ path: '~/projects', allowReadWrite: true }),
    );
  });

  it('includes common blocked patterns', async () => {
    const { generateAllowlistTemplate } = await import('./mount-security.js');
    const result = generateAllowlistTemplate();

    const parsed = JSON.parse(result);
    expect(parsed.blockedPatterns).toContain('password');
    expect(parsed.blockedPatterns).toContain('secret');
    expect(parsed.blockedPatterns).toContain('token');
  });
});
