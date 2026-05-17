// src/runtime/search-command.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, appendConversationMessage } from '../db.js';
import { isSearchCommand, handleSearchCommand } from './search-command.js';

beforeEach(async () => {
  await _initTestDatabase();
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
