import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  },
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockIsRoot = vi.fn();
vi.mock('./platform.js', () => ({ isRoot: mockIsRoot }));

const mockEmitStatus = vi.fn();
vi.mock('./status.js', () => ({ emitStatus: mockEmitStatus }));

const expectedFile = path.join(
  os.homedir(),
  '.config',
  'kubeclaw',
  'mount-allowlist.json',
);

describe('setup/mounts run()', () => {
  let run: typeof import('./mounts.js').run;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsRoot.mockReturnValue(false);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined) as never);
    const mod = await import('./mounts.js');
    run = mod.run;
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('writes an empty allowlist when --empty is passed', async () => {
    await run(['--empty']);
    expect(mockMkdirSync).toHaveBeenCalledWith(path.dirname(expectedFile), {
      recursive: true,
    });
    const [filePath, body] = mockWriteFileSync.mock.calls[0];
    expect(filePath).toBe(expectedFile);
    const parsed = JSON.parse(body as string);
    expect(parsed).toEqual({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CONFIGURE_MOUNTS',
      expect.objectContaining({ STATUS: 'success', ALLOWED_ROOTS: 0 }),
    );
  });

  it('writes the parsed JSON when --json is provided', async () => {
    const config = {
      allowedRoots: ['/home/user/docs', '/tmp/work'],
      blockedPatterns: ['*.secret'],
      nonMainReadOnly: false,
    };
    await run(['--json', JSON.stringify(config)]);
    const [, body] = mockWriteFileSync.mock.calls[0];
    expect(JSON.parse(body as string)).toEqual(config);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CONFIGURE_MOUNTS',
      expect.objectContaining({
        STATUS: 'success',
        ALLOWED_ROOTS: 2,
        NON_MAIN_READ_ONLY: 'false',
      }),
    );
  });

  it('exits with code 4 and emits failed status when --json payload is invalid', async () => {
    await run(['--json', '{not json']);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CONFIGURE_MOUNTS',
      expect.objectContaining({ STATUS: 'failed', ERROR: 'invalid_json' }),
    );
    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  it('reads from stdin (fd 0) when no flag is given and writes the parsed JSON', async () => {
    const stdinPayload = JSON.stringify({
      allowedRoots: ['/srv'],
      nonMainReadOnly: true,
    });
    mockReadFileSync.mockImplementation((fd: unknown) => {
      if (fd === 0) return stdinPayload;
      throw new Error('unexpected readFileSync target: ' + String(fd));
    });
    await run([]);
    const [, body] = mockWriteFileSync.mock.calls[0];
    expect(JSON.parse(body as string)).toEqual({
      allowedRoots: ['/srv'],
      nonMainReadOnly: true,
    });
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CONFIGURE_MOUNTS',
      expect.objectContaining({
        STATUS: 'success',
        ALLOWED_ROOTS: 1,
        NON_MAIN_READ_ONLY: 'true',
      }),
    );
  });

  it('exits with code 4 when stdin contains invalid JSON', async () => {
    mockReadFileSync.mockImplementation(() => 'definitely not json');
    await run([]);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CONFIGURE_MOUNTS',
      expect.objectContaining({ STATUS: 'failed', ERROR: 'invalid_json' }),
    );
    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  it('logs a warning when running as root', async () => {
    mockIsRoot.mockReturnValue(true);
    const { logger } = await import('../src/logger.js');
    await run(['--empty']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('root'));
  });

  it('treats non-array allowedRoots as 0 (defensive count)', async () => {
    await run(['--json', JSON.stringify({ allowedRoots: 'not an array' })]);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CONFIGURE_MOUNTS',
      expect.objectContaining({ ALLOWED_ROOTS: 0 }),
    );
  });
});
