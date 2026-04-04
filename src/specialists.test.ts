import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');
vi.mock('./config.js', () => ({
  GROUPS_DIR: '/fake/groups',
  DATA_DIR: '/fake/data',
}));
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import fs from 'fs';
import { loadSpecialists, detectMentionedSpecialists } from './specialists.js';
import { logger } from './logger.js';

const mockFs = fs as unknown as { readFileSync: ReturnType<typeof vi.fn> };
const mockLogger = logger as unknown as { warn: ReturnType<typeof vi.fn> };

describe('loadSpecialists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when agents.json does not exist (ENOENT)', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFileSync = vi.fn().mockImplementation(() => {
      throw err;
    });

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('returns null for invalid JSON and logs a warning', () => {
    mockFs.readFileSync = vi.fn().mockReturnValue('not-valid-json{{{');

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group' }),
      'Failed to parse agents.json',
    );
  });

  it('returns null when specialists key is missing', () => {
    mockFs.readFileSync = vi
      .fn()
      .mockReturnValue(JSON.stringify({ other: [] }));

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group' }),
      'agents.json missing "specialists" array',
    );
  });

  it('returns null when specialists is not an array', () => {
    mockFs.readFileSync = vi
      .fn()
      .mockReturnValue(JSON.stringify({ specialists: 'oops' }));

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group' }),
      'agents.json "specialists" must be an array',
    );
  });

  it('returns null when specialists array is empty', () => {
    mockFs.readFileSync = vi
      .fn()
      .mockReturnValue(JSON.stringify({ specialists: [] }));

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group' }),
      'agents.json "specialists" array is empty',
    );
  });

  it('returns null when an entry is missing name', () => {
    mockFs.readFileSync = vi
      .fn()
      .mockReturnValue(
        JSON.stringify({ specialists: [{ prompt: 'Do stuff' }] }),
      );

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group', index: 0 }),
      'Specialist entry missing non-empty "name" string',
    );
  });

  it('returns null when an entry is missing prompt', () => {
    mockFs.readFileSync = vi
      .fn()
      .mockReturnValue(JSON.stringify({ specialists: [{ name: 'Research' }] }));

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group', index: 0 }),
      'Specialist entry missing non-empty "prompt" string',
    );
  });

  it('returns null when name is empty string', () => {
    mockFs.readFileSync = vi
      .fn()
      .mockReturnValue(
        JSON.stringify({ specialists: [{ name: '', prompt: 'Do stuff' }] }),
      );

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group', index: 0 }),
      'Specialist entry missing non-empty "name" string',
    );
  });

  it('returns null when prompt is empty string', () => {
    mockFs.readFileSync = vi
      .fn()
      .mockReturnValue(
        JSON.stringify({ specialists: [{ name: 'Research', prompt: '' }] }),
      );

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group', index: 0 }),
      'Specialist entry missing non-empty "prompt" string',
    );
  });

  it('returns valid SpecialistDef[] for well-formed input', () => {
    mockFs.readFileSync = vi.fn().mockReturnValue(
      JSON.stringify({
        specialists: [
          { name: 'Research', prompt: 'You are a research assistant.' },
          { name: 'Writer', prompt: 'You are a writing specialist.' },
        ],
      }),
    );

    const result = loadSpecialists('my-group');

    expect(result).toEqual([
      { name: 'Research', prompt: 'You are a research assistant.' },
      { name: 'Writer', prompt: 'You are a writing specialist.' },
    ]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('returns null for invalid group folder name containing path traversal', () => {
    const result = loadSpecialists('../etc');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: '../etc' }),
      'Invalid group folder name',
    );
  });

  it('returns null for empty group folder name', () => {
    const result = loadSpecialists('');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: '' }),
      'Invalid group folder name',
    );
  });

  it('logs a warning for non-ENOENT read errors', () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    mockFs.readFileSync = vi.fn().mockImplementation(() => {
      throw err;
    });

    const result = loadSpecialists('my-group');

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'my-group' }),
      'Failed to read agents.json',
    );
  });
});

describe('detectMentionedSpecialists', () => {
  const available = [
    { name: 'Research', prompt: 'You are a researcher.' },
    { name: 'Writer', prompt: 'You are a writer.' },
    { name: 'Coder', prompt: 'You are a coder.' },
  ];

  it('returns empty array for empty prompt', () => {
    expect(detectMentionedSpecialists('', available)).toEqual([]);
  });

  it('returns empty array when mentioned name is not in available', () => {
    expect(
      detectMentionedSpecialists('Hey @Unknown help me', available),
    ).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const result = detectMentionedSpecialists(
      '@research do some analysis',
      available,
    );
    expect(result).toEqual([
      { name: 'Research', prompt: 'You are a researcher.' },
    ]);
  });

  it('returns matched specialists in available order', () => {
    const result = detectMentionedSpecialists(
      '@Writer and @Research please help',
      available,
    );
    // Should be in available order: Research first, then Writer
    expect(result).toEqual([
      { name: 'Research', prompt: 'You are a researcher.' },
      { name: 'Writer', prompt: 'You are a writer.' },
    ]);
  });

  it('deduplicates repeated mentions of the same specialist', () => {
    const result = detectMentionedSpecialists(
      '@Research @research please help',
      available,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Research');
  });

  it('returns multiple different matched specialists', () => {
    const result = detectMentionedSpecialists(
      '@Research @Coder both help',
      available,
    );
    expect(result).toEqual([
      { name: 'Research', prompt: 'You are a researcher.' },
      { name: 'Coder', prompt: 'You are a coder.' },
    ]);
  });

  it('does not match partial word: @ResearchExtra does not match Research', () => {
    // /@(\w+)/g captures the full word "ResearchExtra", which doesn't match "research"
    const result = detectMentionedSpecialists(
      '@ResearchExtra please help',
      available,
    );
    expect(result).toEqual([]);
  });

  it('returns empty array when no @ mentions present', () => {
    expect(
      detectMentionedSpecialists('Just a regular message', available),
    ).toEqual([]);
  });
});
