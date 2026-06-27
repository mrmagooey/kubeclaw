import { describe, it, expect } from 'vitest';
import { formatFindToolsResult } from './find-tools-client.js';

describe('formatFindToolsResult', () => {
  it('formats a ready result for the LLM', () => {
    const s = formatFindToolsResult(
      JSON.stringify({
        status: 'ready',
        tools: [
          { name: 'extract_metadata', description: 'EXIF', provenance: 'library' },
        ],
        message: 'Activated.',
      }),
    );
    expect(s).toContain('extract_metadata');
    expect(s).toContain('ready');
  });

  it('formats a pending_credential result with the approval ask', () => {
    const s = formatFindToolsResult(
      JSON.stringify({
        status: 'pending_credential',
        toolName: 'image_search',
        catalogId: 'brave-search',
        host: 'api.search.brave.com',
        approvalToken: 't',
        message: 'needs key',
      }),
    );
    expect(s).toContain('approval');
    expect(s).toContain('brave-search');
  });
});
