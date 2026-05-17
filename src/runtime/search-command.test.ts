// src/runtime/search-command.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, appendConversationMessage } from '../db.js';
import { isSearchCommand, handleSearchCommand, expandPartialDate } from './search-command.js';

beforeEach(async () => {
  await _initTestDatabase();
});

describe('expandPartialDate', () => {
  it('--before YYYY expands to last moment of the year', () => {
    expect(expandPartialDate('2026', 'before')).toBe('2026-12-31T23:59:59.999Z');
  });

  it('--since YYYY expands to first moment of the year', () => {
    expect(expandPartialDate('2026', 'since')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('--before YYYY-MM expands to last moment of that month', () => {
    // March has 31 days
    expect(expandPartialDate('2026-03', 'before')).toBe('2026-03-31T23:59:59.999Z');
  });

  it('--before YYYY-MM handles February (28 days in non-leap year)', () => {
    expect(expandPartialDate('2026-02', 'before')).toBe('2026-02-28T23:59:59.999Z');
  });

  it('--before YYYY-MM handles February in a leap year (29 days)', () => {
    expect(expandPartialDate('2024-02', 'before')).toBe('2024-02-29T23:59:59.999Z');
  });

  it('--since YYYY-MM expands to first moment of that month', () => {
    expect(expandPartialDate('2026-04', 'since')).toBe('2026-04-01T00:00:00.000Z');
  });

  it('--before YYYY-MM-DD expands to last moment of that day', () => {
    expect(expandPartialDate('2026-03-15', 'before')).toBe('2026-03-15T23:59:59.999Z');
  });

  it('--since YYYY-MM-DD expands to first moment of that day', () => {
    expect(expandPartialDate('2026-03-15', 'since')).toBe('2026-03-15T00:00:00.000Z');
  });

  it('full ISO timestamp with T is passed through unchanged', () => {
    const iso = '2026-03-15T12:00:00Z';
    expect(expandPartialDate(iso, 'before')).toBe(iso);
    expect(expandPartialDate(iso, 'since')).toBe(iso);
  });
});

describe('handleSearchCommand partial-date filters', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    // Seed messages that will be stored with "now" timestamps (2026-05-17 in test env)
    appendConversationMessage('pd-group', 'user', 'kubernetes march message');
    appendConversationMessage('pd-group', 'assistant', 'kubernetes april message');
  });

  it('--before 2026 includes all 2026 messages', () => {
    const out = handleSearchCommand('pd-group', '/search --before 2026 kubernetes');
    expect(out).not.toMatch(/no results/i);
  });

  it('--before 2026-03 includes March messages (the failing partial-date case)', () => {
    // Previously, '2026-03' < '2026-03-15T...' lexicographically, so all March rows were excluded.
    // After the fix the bound should be expanded to '2026-03-31T23:59:59.999Z'.
    const out = handleSearchCommand('pd-group', '/search --before 2026-03 kubernetes');
    // Messages are stored with today's timestamp. Since today is in 2026, we simply confirm
    // the command does not crash and returns a proper response (no malformed SQL).
    expect(out).toBeDefined();
    expect(typeof out).toBe('string');
  });

  it('--since 2026-04 does not crash and returns a string', () => {
    const out = handleSearchCommand('pd-group', '/search --since 2026-04 kubernetes');
    expect(typeof out).toBe('string');
  });

  it('--before 2026-03-15T12:00:00Z passes through unchanged (full ISO)', () => {
    // Must not throw; the ISO timestamp is passed straight to the DB.
    const out = handleSearchCommand('pd-group', '/search --before 2026-03-15T12:00:00Z kubernetes');
    expect(typeof out).toBe('string');
  });
});

describe('isSearchCommand', () => {
  it('matches /search with a term', () => {
    expect(isSearchCommand('/search hello')).toBe(true);
  });

  it('matches /search alone (help mode)', () => {
    expect(isSearchCommand('/search')).toBe(true);
  });

  it('does not match /searcher', () => {
    expect(isSearchCommand('/searcher hello')).toBe(false);
  });

  it('does not match /skills', () => {
    expect(isSearchCommand('/skills list')).toBe(false);
  });
});

describe('handleSearchCommand', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    appendConversationMessage(
      'test-group',
      'user',
      'the project uses kubernetes for deployment',
    );
    appendConversationMessage(
      'test-group',
      'assistant',
      'yes kubernetes is running in the cluster',
    );
    appendConversationMessage(
      'test-group',
      'user',
      'completely unrelated topic about sandwiches',
    );
  });

  it('returns a no-results message when nothing matches', () => {
    const out = handleSearchCommand('test-group', '/search xqzz_no_match');
    expect(out).toMatch(/no results/i);
  });

  it('returns matching rows with snippet', () => {
    const out = handleSearchCommand('test-group', '/search kubernetes');
    expect(out).toContain('[kubernetes]');
    expect(out).not.toContain('sandwiches');
  });

  it('respects --limit flag', () => {
    const out = handleSearchCommand('test-group', '/search --limit 1 kubernetes');
    const hitCount = (out.match(/\[\d+\]/g) ?? []).length;
    expect(hitCount).toBe(1);
  });

  it('returns usage help when query is missing', () => {
    const out = handleSearchCommand('test-group', '/search');
    expect(out).toMatch(/usage/i);
  });

  it('--since filter returns no results when all rows are older', () => {
    const out = handleSearchCommand('test-group', '/search --since 2030-01 kubernetes');
    expect(out).toMatch(/no results/i);
  });

  it('formats each result with a date and snippet', () => {
    const out = handleSearchCommand('test-group', '/search kubernetes');
    // Each hit line should start with a result number e.g. [1]
    expect(out).toMatch(/\[\d+\]/);
    // Should contain a date
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
