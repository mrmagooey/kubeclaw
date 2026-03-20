import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import fs from 'fs';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

describe('readEnvFile', () => {
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const originalCwd = process.cwd;

  beforeEach(() => {
    vi.resetAllMocks();
    process.cwd = vi.fn().mockReturnValue('/test/project');
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  it('returns empty object when .env file does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const result = readEnvFile(['SOME_KEY']);
    expect(result).toEqual({});
    expect(logger.debug).toHaveBeenCalled();
  });

  it('returns empty object when no keys requested', () => {
    mockReadFileSync.mockReturnValue('KEY=value');

    const result = readEnvFile([]);
    expect(result).toEqual({});
  });

  it('parses simple key=value pairs', () => {
    mockReadFileSync.mockReturnValue('KEY1=value1\nKEY2=value2');

    const result = readEnvFile(['KEY1', 'KEY2']);
    expect(result).toEqual({ KEY1: 'value1', KEY2: 'value2' });
  });

  it('returns only requested keys', () => {
    mockReadFileSync.mockReturnValue('KEY1=value1\nKEY2=value2\nKEY3=value3');

    const result = readEnvFile(['KEY1', 'KEY3']);
    expect(result).toEqual({ KEY1: 'value1', KEY3: 'value3' });
  });

  it('handles keys with equals sign in value', () => {
    mockReadFileSync.mockReturnValue('KEY=value=with=equals');

    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'value=with=equals' });
  });

  it('strips double quotes from values', () => {
    mockReadFileSync.mockReturnValue('KEY="quoted value"');

    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'quoted value' });
  });

  it('strips single quotes from values', () => {
    mockReadFileSync.mockReturnValue("KEY='single quoted'");

    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'single quoted' });
  });

  it('ignores empty values', () => {
    mockReadFileSync.mockReturnValue('KEY=');

    const result = readEnvFile(['KEY']);
    expect(result).toEqual({});
  });

  it('ignores comment lines starting with #', () => {
    mockReadFileSync.mockReturnValue('# This is a comment\nKEY=value');

    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('ignores blank lines', () => {
    mockReadFileSync.mockReturnValue('\n\nKEY=value\n\n');

    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('ignores lines without equals sign', () => {
    mockReadFileSync.mockReturnValue('JUST_A_KEY\nKEY=value');

    const result = readEnvFile(['KEY', 'JUST_A_KEY']);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('trims keys and values', () => {
    mockReadFileSync.mockReturnValue('  KEY  =  value  ');

    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('handles multiple keys with same name (last one wins)', () => {
    mockReadFileSync.mockReturnValue('KEY=first\nKEY=second');

    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'second' });
  });

  it('reads from correct path', () => {
    mockReadFileSync.mockReturnValue('KEY=value');

    readEnvFile(['KEY']);

    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join('/test/project', '.env'),
      'utf-8',
    );
  });
});
