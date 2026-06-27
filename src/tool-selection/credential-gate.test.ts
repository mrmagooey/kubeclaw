import { describe, it, expect } from 'vitest';
import { evaluateGate, mintApprovalToken, verifyApprovalToken } from './credential-gate.js';
import type { ToolSpec } from '../tools/types.js';

const lookup = (id: string) => (id === 'brave-search' ? 'api.search.brave.com' : undefined);

describe('credential gate', () => {
  it('no approval for a credential-free tool', () => {
    const spec: ToolSpec = { name: 'exif', description: 'd', parameters: {}, image: 'i', pattern: 'file' };
    expect(evaluateGate(spec, lookup).needsApproval).toBe(false);
  });

  it('requires approval and resolves the host for a credentialed tool', () => {
    const spec: ToolSpec = {
      name: 'image_search', description: 'd', parameters: {}, image: 'i', pattern: 'http',
      credentials: ['brave-search'],
    };
    const d = evaluateGate(spec, lookup);
    expect(d).toEqual({ needsApproval: true, catalogId: 'brave-search', host: 'api.search.brave.com' });
  });

  it('round-trips a valid approval token', () => {
    const t = mintApprovalToken('image_search', 'brave-search', 'nonce123');
    expect(verifyApprovalToken(t, 'image_search', 'brave-search', 'nonce123')).toBe(true);
  });

  it('rejects a token for a different tool/credential/nonce', () => {
    const t = mintApprovalToken('image_search', 'brave-search', 'nonce123');
    expect(verifyApprovalToken(t, 'other_tool', 'brave-search', 'nonce123')).toBe(false);
    expect(verifyApprovalToken(t, 'image_search', 'openai', 'nonce123')).toBe(false);
    expect(verifyApprovalToken(t, 'image_search', 'brave-search', 'wrong')).toBe(false);
  });
});
