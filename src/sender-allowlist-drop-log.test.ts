/**
 * Unit tests for the drop-mode DECISION (Gap 1 coverage).
 *
 * The callers in channel-runner.ts / index.ts drop a message when
 *   shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, sender, cfg)
 * and only then emit the "sender-allowlist: dropping message" log. The log
 * itself is a call-site side effect (covered by the cluster-gated e2e AC5 in
 * e2e/sender-allowlist-drop.test.ts). These unit tests cover the drop
 * decision logic — the part that determines whether a message is actually
 * dropped — without any cluster dependency.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock config so loadSenderAllowlist doesn't hit the real FS path.
vi.mock('./config.js', () => ({
  SENDER_ALLOWLIST_PATH: '/nonexistent/sender-allowlist.json',
}));

import {
  shouldDropMessage,
  isSenderAllowed,
  SenderAllowlistConfig,
} from './sender-allowlist.js';

/** Mirror of the call-site predicate in channel-runner.ts / index.ts. */
function wouldDrop(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return (
    shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, sender, cfg)
  );
}

function cfg(
  entry: SenderAllowlistConfig['default'],
  chats: SenderAllowlistConfig['chats'] = {},
): SenderAllowlistConfig {
  return { default: entry, chats, logDenied: true };
}

describe('shouldDropMessage — drop mode predicate', () => {
  it('returns true when the entry mode is "drop"', () => {
    expect(
      shouldDropMessage('chat@g.us', cfg({ allow: '*', mode: 'drop' })),
    ).toBe(true);
  });

  it('returns false when the entry mode is "trigger"', () => {
    expect(
      shouldDropMessage('chat@g.us', cfg({ allow: '*', mode: 'trigger' })),
    ).toBe(false);
  });

  it('uses the per-chat override over the default', () => {
    const c = cfg(
      { allow: '*', mode: 'trigger' },
      { 'drop-chat@g.us': { allow: '*', mode: 'drop' } },
    );
    expect(shouldDropMessage('drop-chat@g.us', c)).toBe(true);
    expect(shouldDropMessage('other-chat@g.us', c)).toBe(false);
  });
});

describe('drop decision (shouldDropMessage && !isSenderAllowed)', () => {
  it('drops in drop mode when the sender is NOT in the allowlist', () => {
    const c = cfg({ allow: ['alice'], mode: 'drop' });
    expect(wouldDrop('chat@g.us', 'carol', c)).toBe(true);
  });

  it('does NOT drop in drop mode when the sender IS in the allowlist', () => {
    const c = cfg({ allow: ['alice', 'bob'], mode: 'drop' });
    expect(wouldDrop('chat@g.us', 'alice', c)).toBe(false);
  });

  it('does NOT drop in drop mode when allow is "*" (everyone allowed)', () => {
    const c = cfg({ allow: '*', mode: 'drop' });
    expect(wouldDrop('chat@g.us', 'anyone', c)).toBe(false);
  });

  it('never drops in trigger mode, even for a disallowed sender', () => {
    const c = cfg({ allow: ['alice'], mode: 'trigger' });
    expect(wouldDrop('chat@g.us', 'carol', c)).toBe(false);
  });

  it('honours a per-chat drop override for a disallowed sender', () => {
    const c = cfg(
      { allow: '*', mode: 'trigger' },
      { 'locked@g.us': { allow: ['alice'], mode: 'drop' } },
    );
    expect(wouldDrop('locked@g.us', 'carol', c)).toBe(true);
    expect(wouldDrop('locked@g.us', 'alice', c)).toBe(false);
    expect(wouldDrop('open@g.us', 'carol', c)).toBe(false);
  });
});
