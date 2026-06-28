import { describe, it, expect } from 'vitest';
import {
  evaluateGate,
  mintApprovalToken,
  verifyApprovalToken,
  APPROVAL_TOKEN_WINDOW_MS,
} from './credential-gate.js';
import type { ToolSpec } from '../tools/types.js';

const lookup = (id: string) =>
  id === 'brave-search' ? 'api.search.brave.com' : undefined;

// A fixed "now" well within window 0 (slot = floor(T/3600000) = 0).
const T0 = 1_000; // 1 second since epoch — slot 0

describe('credential gate', () => {
  it('no approval for a credential-free tool', () => {
    const spec: ToolSpec = {
      name: 'exif',
      description: 'd',
      parameters: {},
      image: 'i',
      pattern: 'file',
    };
    expect(evaluateGate(spec, lookup).needsApproval).toBe(false);
  });

  it('requires approval and resolves the host for a credentialed tool', () => {
    const spec: ToolSpec = {
      name: 'image_search',
      description: 'd',
      parameters: {},
      image: 'i',
      pattern: 'http',
      credentials: ['brave-search'],
    };
    const d = evaluateGate(spec, lookup);
    expect(d).toEqual({
      needsApproval: true,
      catalogId: 'brave-search',
      host: 'api.search.brave.com',
    });
  });

  it('round-trips a valid approval token', () => {
    const t = mintApprovalToken('image_search', 'brave-search', 'nonce123', T0);
    expect(
      verifyApprovalToken(t, 'image_search', 'brave-search', 'nonce123', T0),
    ).toBe(true);
  });

  it('rejects a token for a different tool/credential/nonce', () => {
    const t = mintApprovalToken('image_search', 'brave-search', 'nonce123', T0);
    expect(
      verifyApprovalToken(t, 'other_tool', 'brave-search', 'nonce123', T0),
    ).toBe(false);
    expect(
      verifyApprovalToken(t, 'image_search', 'openai', 'nonce123', T0),
    ).toBe(false);
    expect(
      verifyApprovalToken(t, 'image_search', 'brave-search', 'wrong', T0),
    ).toBe(false);
  });

  it('rejects a malformed (wrong-length) token without throwing', () => {
    expect(
      verifyApprovalToken(
        'short',
        'image_search',
        'brave-search',
        'nonce123',
        T0,
      ),
    ).toBe(false);
  });
});

describe('approval token expiry (time-slotted)', () => {
  // Window boundaries:
  //   slot 0: now ∈ [0, WINDOW)
  //   slot 1: now ∈ [WINDOW, 2*WINDOW)
  //   slot 2: now ∈ [2*WINDOW, 3*WINDOW)

  const W = APPROVAL_TOKEN_WINDOW_MS;

  it('token minted in the same window verifies (same slot)', () => {
    // Mint at start of slot 1, verify in the middle of slot 1.
    const mintNow = W; // slot 1
    const verifyNow = W + 100; // slot 1
    const t = mintApprovalToken('tool', 'cred', 'sec', mintNow);
    expect(verifyApprovalToken(t, 'tool', 'cred', 'sec', verifyNow)).toBe(true);
  });

  it('token minted just before a window boundary verifies just after it (slot skew tolerance)', () => {
    // Mint at the last millisecond of slot 0, verify at the first ms of slot 1.
    const mintNow = W - 1; // slot 0
    const verifyNow = W; // slot 1 — previous slot tolerance accepts slot 0
    const t = mintApprovalToken('tool', 'cred', 'sec', mintNow);
    expect(verifyApprovalToken(t, 'tool', 'cred', 'sec', verifyNow)).toBe(true);
  });

  it('token minted 2+ windows ago is rejected', () => {
    // Mint at slot 0, verify at slot 2: verify checks slot 2 and slot 1 — neither
    // matches slot-0 token.
    const mintNow = 0; // slot 0
    const verifyNow = 2 * W; // slot 2
    const t = mintApprovalToken('tool', 'cred', 'sec', mintNow);
    expect(verifyApprovalToken(t, 'tool', 'cred', 'sec', verifyNow)).toBe(
      false,
    );
  });

  it('a tampered token is rejected even within the same window', () => {
    const t = mintApprovalToken('tool', 'cred', 'sec', T0);
    const tampered = t.slice(0, -4) + 'dead';
    expect(verifyApprovalToken(tampered, 'tool', 'cred', 'sec', T0)).toBe(
      false,
    );
  });
});
