// e2e/search-command.test.ts
/**
 * Search command E2E test.
 *
 * Uses a real sql.js in-memory database to verify the full path:
 *   appendConversationMessage() → FTS trigger → searchConversations() → handleSearchCommand()
 *
 * No Kubernetes or mock LLM server required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { _initTestDatabase, appendConversationMessage } from '../src/db.js';
import { handleSearchCommand } from '../src/runtime/search-command.js';

beforeAll(async () => {
  await _initTestDatabase();
});

describe('search command e2e', () => {
  const GROUP = `e2e-search-${Date.now()}`;

  it('finds a message inserted via appendConversationMessage', () => {
    appendConversationMessage(
      GROUP,
      'user',
      'the deployment uses a sidecar proxy for TLS termination',
    );
    appendConversationMessage(
      GROUP,
      'assistant',
      'yes the sidecar handles mTLS between pods',
    );
    appendConversationMessage(
      GROUP,
      'user',
      'let me check the logs for errors unrelated topic',
    );

    const out = handleSearchCommand(GROUP, '/search sidecar');

    expect(out).toMatch(/found 2 results/i);
    expect(out).toContain('[sidecar]');
    expect(out).not.toContain('unrelated');
  });

  it('--limit flag caps results', () => {
    const out = handleSearchCommand(GROUP, '/search --limit 1 sidecar');
    expect(out).toMatch(/found 1 result/i);
    const lines = out.split('\n').filter((l) => l.startsWith('['));
    expect(lines.length).toBe(1);
  });

  it('--since filter excludes older messages', () => {
    // All messages were inserted today; filtering to a future date returns nothing.
    const out = handleSearchCommand(GROUP, '/search --since 2030-01 sidecar');
    expect(out).toMatch(/no results/i);
  });

  it('returns no-results message for an unmatched query', () => {
    const out = handleSearchCommand(GROUP, '/search xqzz_e2e_no_match');
    expect(out).toMatch(/no results/i);
  });

  it('does not bleed results across groups', () => {
    appendConversationMessage(
      'other-e2e-group',
      'user',
      'sidecar proxy in a completely different group',
    );
    const out = handleSearchCommand(GROUP, '/search sidecar');
    const resultLines = out.split('\n').filter((l) => /^\[\d+\]/.test(l));
    // Should still be 2 hits from GROUP, not 3
    expect(resultLines.length).toBe(2);
  });
});
