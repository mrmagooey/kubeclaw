/**
 * Tests for the mcp-server.ts dispatcher entrypoint.
 *
 * Covers:
 * - parseArgs: correct parsing of --server, --root, --port with defaults
 * - parseArgs: throws when --server is omitted
 * - main(): rejects unknown --server values with process.exit(2)
 * - main(): dispatches to filesystem/database start() without booting real servers
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Intercept dynamic imports inside main() so no real servers start.
vi.mock('./mcp/filesystem/server.js', () => ({
  start: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./mcp/database/server.js', () => ({
  start: vi.fn().mockResolvedValue(undefined),
}));

import { parseArgs, main } from './mcp-server.js';
import * as fsServer from './mcp/filesystem/server.js';
import * as dbServer from './mcp/database/server.js';

describe('parseArgs', () => {
  it('parses --server filesystem with explicit --root and --port', () => {
    expect(
      parseArgs(['--server', 'filesystem', '--root', '/mydata', '--port', '4000']),
    ).toEqual({ server: 'filesystem', root: '/mydata', port: 4000 });
  });

  it('uses default root=/data and port=3000 for --server filesystem', () => {
    expect(parseArgs(['--server', 'filesystem'])).toEqual({
      server: 'filesystem',
      root: '/data',
      port: 3000,
    });
  });

  it('uses default root=/data and port=3000 for --server database', () => {
    expect(parseArgs(['--server', 'database'])).toEqual({
      server: 'database',
      root: '/data',
      port: 3000,
    });
  });

  it('parses explicit --port for database', () => {
    expect(parseArgs(['--server', 'database', '--port', '5432'])).toEqual({
      server: 'database',
      root: '/data',
      port: 5432,
    });
  });

  it('throws when --server is missing', () => {
    expect(() => parseArgs([])).toThrow();
  });

  it('throws when --server is empty string', () => {
    expect(() => parseArgs(['--server', ''])).toThrow();
  });
});

describe('main dispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('writes an error to stderr and exits 2 for unknown --server', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(main(['--server', 'unknown-server-name'])).rejects.toThrow(
      'process.exit(2)',
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown-server-name'),
    );
  });

  it('writes an error to stderr and exits 2 when --server is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(main([])).rejects.toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('dispatches to filesystem start() with parsed root and port', async () => {
    await main(['--server', 'filesystem', '--root', '/workspace', '--port', '4001']);

    expect(fsServer.start).toHaveBeenCalledWith({ root: '/workspace', port: 4001 });
  });

  it('dispatches to filesystem start() using defaults', async () => {
    await main(['--server', 'filesystem']);

    expect(fsServer.start).toHaveBeenCalledWith({ root: '/data', port: 3000 });
  });

  it('dispatches to database start() with parsed port (no root)', async () => {
    await main(['--server', 'database', '--port', '5433']);

    expect(dbServer.start).toHaveBeenCalledWith({ port: 5433 });
  });

  it('dispatches to database start() using default port', async () => {
    await main(['--server', 'database']);

    expect(dbServer.start).toHaveBeenCalledWith({ port: 3000 });
  });
});
