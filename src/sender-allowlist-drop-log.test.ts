/**
 * Unit tests for the drop-mode log line in shouldDropMessage (Gap 1 coverage).
 *
 * AC5 from e2e/sender-allowlist-drop.test.ts ("kubectl logs shows
 * 'sender-allowlist: dropping message'") requires a live Kubernetes cluster
 * and therefore runs only in the cluster-gated e2e suite.  These unit tests
 * cover the same observable behaviour — the structured log is emitted —
 * without any cluster dependency, by mocking the pino logger and calling
 * shouldDropMessage directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Logger mock: use vi.hoisted so variables are available in the factory ──
const { mockLoggerInfo, mockLoggerDebug } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerDebug: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: mockLoggerInfo,
    debug: mockLoggerDebug,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Mock config so loadSenderAllowlist doesn't hit the real FS path ─────────
vi.mock('./config.js', () => ({
  SENDER_ALLOWLIST_PATH: '/nonexistent/sender-allowlist.json',
}));

import {
  shouldDropMessage,
  SenderAllowlistConfig,
} from './sender-allowlist.js';

function dropCfg(overrides: Partial<SenderAllowlistConfig> = {}): SenderAllowlistConfig {
  return {
    default: { allow: '*', mode: 'drop' },
    chats: {},
    logDenied: true,
    ...overrides,
  };
}

function triggerCfg(): SenderAllowlistConfig {
  return {
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('shouldDropMessage — drop decision', () => {
  it('returns true when the entry mode is "drop"', () => {
    expect(shouldDropMessage('chat@g.us', dropCfg())).toBe(true);
  });

  it('returns false when the entry mode is "trigger"', () => {
    expect(shouldDropMessage('chat@g.us', triggerCfg())).toBe(false);
  });

  it('uses per-chat override over default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { 'drop-chat@g.us': { allow: '*', mode: 'drop' } },
      logDenied: true,
    };
    expect(shouldDropMessage('drop-chat@g.us', cfg)).toBe(true);
    expect(shouldDropMessage('other-chat@g.us', cfg)).toBe(false);
  });
});

describe('shouldDropMessage — drop-mode log line (AC5 unit coverage)', () => {
  it('emits logger.info with "sender-allowlist: dropping message" in drop mode', () => {
    shouldDropMessage('chat@g.us', dropCfg(), 'alice@s.whatsapp.net');
    expect(mockLoggerInfo).toHaveBeenCalledOnce();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { chatJid: 'chat@g.us', sender: 'alice@s.whatsapp.net' },
      'sender-allowlist: dropping message',
    );
  });

  it('includes sender in the log even when sender is undefined', () => {
    shouldDropMessage('chat@g.us', dropCfg());
    expect(mockLoggerInfo).toHaveBeenCalledOnce();
    const [bindings, msg] = mockLoggerInfo.mock.calls[0];
    expect(msg).toBe('sender-allowlist: dropping message');
    expect(bindings).toMatchObject({ chatJid: 'chat@g.us' });
  });

  it('suppresses the log when logDenied is false', () => {
    const cfg = dropCfg({ logDenied: false });
    shouldDropMessage('chat@g.us', cfg, 'alice@s.whatsapp.net');
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('does NOT emit the drop log in trigger mode', () => {
    shouldDropMessage('chat@g.us', triggerCfg(), 'alice@s.whatsapp.net');
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('logs once per call, not per sender in the allowlist', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice', 'bob'], mode: 'drop' },
      chats: {},
      logDenied: true,
    };
    shouldDropMessage('chat@g.us', cfg, 'carol@s.whatsapp.net');
    expect(mockLoggerInfo).toHaveBeenCalledOnce();
  });
});
