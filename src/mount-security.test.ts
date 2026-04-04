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
  const fsActual = (actual as any).default ?? actual;
  const mocked = {
    ...fsActual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    realpathSync: mockRealpathSync,
  };
  return { ...mocked, default: mocked };
});

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  const pathActual = (actual as any).default ?? actual;
  const mocked = {
    ...pathActual,
    join: (...args: string[]) => args.join('/'),
    resolve: (...args: string[]) => args.join('/'),
    sep: '/',
    relative: mockPathRelative,
    isAbsolute: mockPathIsAbsolute,
    basename: mockPathBasename,
  };
  return { ...mocked, default: mocked };
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

describe('validateMount - K8s-native volumes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('allows K8s-native volume types without path validation', async () => {
    mockExistsSync.mockReturnValue(false);
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount(
      { type: 'configmap', configMapName: 'my-config' } as never,
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('K8s-native volume type');
  });

  it('treats hostpath type as a regular mount requiring validation', async () => {
    mockExistsSync.mockReturnValue(false);
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount(
      { type: 'hostpath', hostPath: '/foo' } as never,
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured');
  });
});

describe('loadMountAllowlist - success and cache paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns allowlist when file exists with valid structure', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/projects', allowReadWrite: true }],
        blockedPatterns: ['secret'],
        nonMainReadOnly: false,
      }),
    );
    const { loadMountAllowlist } = await import('./mount-security.js');
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
    // Default blocked patterns are merged in
    expect(result!.blockedPatterns).toContain('secret');
    expect(result!.blockedPatterns).toContain('.ssh');
  });

  it('returns cached allowlist on second call (no fs re-read)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: false,
      }),
    );
    const { loadMountAllowlist } = await import('./mount-security.js');
    loadMountAllowlist(); // First call - loads and caches
    const result = loadMountAllowlist(); // Second call - returns cached
    expect(result).not.toBeNull();
    // readFileSync should only have been called once
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('returns null on repeated calls after error (cached error path)', async () => {
    mockExistsSync.mockReturnValue(false);
    const { loadMountAllowlist } = await import('./mount-security.js');
    loadMountAllowlist(); // First call - sets allowlistLoadError
    const result = loadMountAllowlist(); // Second call - hits cached error branch
    expect(result).toBeNull();
    // existsSync only called once (second call returns early)
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });
});

describe('validateMount - with allowlist configured', () => {
  const validAllowlist = JSON.stringify({
    allowedRoots: [{ path: '/projects', allowReadWrite: true }],
    blockedPatterns: [],
    nonMainReadOnly: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(validAllowlist);
    mockPathBasename.mockImplementation((p: string) => p.split('/').pop() || p);
    mockPathRelative.mockReturnValue('myapp');
    mockPathIsAbsolute.mockReturnValue(false);
  });

  it('returns blocked for invalid container path (contains ..)', async () => {
    mockRealpathSync.mockReturnValue('/projects/myapp');
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount(
      { hostPath: '/projects/myapp', containerPath: '../escape' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('returns blocked when host path does not exist', async () => {
    mockRealpathSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: '/projects/missing' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Host path does not exist');
  });

  it('returns blocked when path matches a blocked pattern', async () => {
    const blockedAllowlist = JSON.stringify({
      allowedRoots: [{ path: '/projects', allowReadWrite: true }],
      blockedPatterns: ['.ssh'],
      nonMainReadOnly: false,
    });
    mockReadFileSync.mockReturnValue(blockedAllowlist);
    mockRealpathSync.mockReturnValue('/home/user/.ssh/keys');
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: '/home/user/.ssh/keys' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern');
  });

  it('returns blocked when path is not under any allowed root', async () => {
    mockRealpathSync.mockReturnValue('/outside/path');
    mockPathRelative.mockReturnValue('../../outside'); // starts with ..
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: '/outside/path' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('returns allowed for a valid path under an allowed root', async () => {
    mockRealpathSync.mockReturnValue('/projects/myapp');
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: '/projects/myapp' }, true);
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/projects/myapp');
  });

  it('allows read-write when root permits and isMain is true', async () => {
    mockRealpathSync.mockReturnValue('/projects/myapp');
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount(
      { hostPath: '/projects/myapp', readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces read-only for non-main group when nonMainReadOnly is true', async () => {
    const nonMainAllowlist = JSON.stringify({
      allowedRoots: [{ path: '/projects', allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    mockReadFileSync.mockReturnValue(nonMainAllowlist);
    mockRealpathSync.mockReturnValue('/projects/myapp');
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount(
      { hostPath: '/projects/myapp', readonly: false },
      false,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('forces read-only when root does not allow read-write', async () => {
    const readonlyRootAllowlist = JSON.stringify({
      allowedRoots: [{ path: '/projects', allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });
    mockReadFileSync.mockReturnValue(readonlyRootAllowlist);
    mockRealpathSync.mockReturnValue('/projects/myapp');
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount(
      { hostPath: '/projects/myapp', readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });
});

describe('validateAdditionalMounts - with allowed mounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      }),
    );
    mockPathBasename.mockImplementation((p: string) => p.split('/').pop() || p);
    mockPathRelative.mockReturnValue('myapp');
    mockPathIsAbsolute.mockReturnValue(false);
    mockRealpathSync.mockReturnValue('/projects/myapp');
  });

  it('includes allowed mounts in result', async () => {
    const { validateAdditionalMounts } = await import('./mount-security.js');
    const result = validateAdditionalMounts(
      [{ hostPath: '/projects/myapp' }],
      'my-group',
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].hostPath).toBe('/projects/myapp');
    expect(result[0].containerPath).toContain('/workspace/extra/');
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
