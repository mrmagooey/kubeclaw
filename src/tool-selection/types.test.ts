import { describe, expect, it } from 'vitest';

import type { FindToolsResult } from './types';
import { isReadyResult } from './types';

describe('tool-selection types', () => {
  it('narrows a ready result', () => {
    const r: FindToolsResult = {
      status: 'ready',
      tools: [{ name: 'x', description: 'd', provenance: 'catalog' }],
      message: 'ok',
    };
    expect(isReadyResult(r)).toBe(true);
  });
  it('rejects a non-ready result', () => {
    const r: FindToolsResult = { status: 'unavailable', message: 'no' };
    expect(isReadyResult(r)).toBe(false);
  });
});
