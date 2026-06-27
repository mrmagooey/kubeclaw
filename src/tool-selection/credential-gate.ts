import { createHmac } from 'node:crypto';
import type { ToolSpec } from '../tools/types.js';

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

export function mintApprovalToken(
  toolName: string,
  catalogId: string,
  nonce: string,
): string {
  return createHmac('sha256', nonce)
    .update(`${toolName}|${catalogId}`)
    .digest('hex');
}

export function verifyApprovalToken(
  token: string,
  toolName: string,
  catalogId: string,
  nonce: string,
): boolean {
  return token === mintApprovalToken(toolName, catalogId, nonce);
}
