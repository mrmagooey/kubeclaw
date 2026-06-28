import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ToolSpec } from '../tools/types.js';

/** Approval tokens expire after one window aligned with the pending-discovered TTL. */
export const APPROVAL_TOKEN_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface GateDecision {
  needsApproval: boolean;
  catalogId?: string;
  host?: string;
}

export function evaluateGate(
  spec: ToolSpec,
  lookup: (id: string) => string | undefined,
): GateDecision {
  const id = spec.credentials?.[0];
  if (!id) return { needsApproval: false };
  return { needsApproval: true, catalogId: id, host: lookup(id) };
}

/** Compute the HMAC for a given name/catalogId/nonce/slot combination. */
function computeTokenForSlot(
  toolName: string,
  catalogId: string,
  nonce: string,
  slot: number,
): string {
  return createHmac('sha256', nonce)
    .update(`${toolName}|${catalogId}|${slot}`)
    .digest('hex');
}

/**
 * Mint a short-lived approval token for `toolName`/`catalogId`.
 *
 * The token is keyed on the current time-slot (aligned to
 * `APPROVAL_TOKEN_WINDOW_MS`) so it expires after at most two windows
 * (standard TOTP-style: verify accepts the current slot OR the previous one).
 *
 * @param now  Caller-supplied timestamp in milliseconds (use `deps.now()`).
 */
export function mintApprovalToken(
  toolName: string,
  catalogId: string,
  nonce: string,
  now: number,
): string {
  const slot = Math.floor(now / APPROVAL_TOKEN_WINDOW_MS);
  return computeTokenForSlot(toolName, catalogId, nonce, slot);
}

/**
 * Verify an approval token.
 *
 * Accepts the token if it matches the HMAC for either the current time-slot
 * OR the immediately preceding slot — this tolerates tokens minted just
 * before a window boundary being verified just after it.
 *
 * A token minted two or more windows ago is always rejected.
 *
 * @param now  Caller-supplied timestamp in milliseconds (use `deps.now()`).
 */
export function verifyApprovalToken(
  token: string,
  toolName: string,
  catalogId: string,
  nonce: string,
  now: number,
): boolean {
  const slot = Math.floor(now / APPROVAL_TOKEN_WINDOW_MS);
  for (const s of [slot, slot - 1]) {
    const expected = computeTokenForSlot(toolName, catalogId, nonce, s);
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}
