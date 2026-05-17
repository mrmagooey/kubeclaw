import { describe, it, expect, vi } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)`
// guard. Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

import { folderPrefixForChannel } from './channel-runner.js';
import { isSearchCommand, handleSearchCommand } from './runtime/search-command.js';

describe('folderPrefixForChannel', () => {
  it('returns "oauth" for oauth-webchat', () => {
    expect(folderPrefixForChannel('oauth-webchat')).toBe('oauth');
  });

  it('returns the established prefix for known channels', () => {
    expect(folderPrefixForChannel('telegram')).toBe('tg');
    expect(folderPrefixForChannel('http')).toBe('http');
  });

  it('falls back to first 3 chars for unknown channels', () => {
    expect(folderPrefixForChannel('matrix')).toBe('mat');
  });
});

describe('/search dispatch', () => {
  it('isSearchCommand identifies /search messages', () => {
    expect(isSearchCommand('/search hello')).toBe(true);
    expect(isSearchCommand('/skills list')).toBe(false);
    expect(isSearchCommand('regular message')).toBe(false);
  });

  it('handleSearchCommand returns a no-results message for unknown query', async () => {
    const { _initTestDatabase } = await import('./db.js');
    await _initTestDatabase();
    const out = handleSearchCommand('test-group', '/search xqzz_channel_runner_dispatch');
    expect(out).toMatch(/no results/i);
  });
});
