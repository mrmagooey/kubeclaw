import { describe, it, expect, beforeEach } from 'vitest';
import { runToolSelection, type TsaDeps } from './agent.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { getAutoTool } from './provenance.js';
import type { ToolSpec } from '../tools/types.js';

const exif: ToolSpec = {
  name: 'extract_metadata', description: 'Extract EXIF metadata from an image',
  parameters: {}, image: 'kubeclaw/exiftool:latest', pattern: 'file', mount: 'group',
};
const imageSearch: ToolSpec = {
  name: 'image_search', description: 'Search the web for images',
  parameters: {}, image: 'kubeclaw/image-search:latest', pattern: 'http',
  credentials: ['brave-search'],
};

function deps(over: Partial<TsaDeps> = {}): TsaDeps {
  return {
    chat: async () => JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
    liveCatalog: () => [],
    library: () => [],
    catalogHostLookup: (id) => (id === 'brave-search' ? 'api.search.brave.com' : undefined),
    reconcile: async () => {},
    now: () => 1000,
    nonce: 'n',
    ...over,
  };
}

describe('runToolSelection', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('returns ready from the live catalog without registering', async () => {
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'exif' },
      deps({
        liveCatalog: () => [exif],
        chat: async () => JSON.stringify({ name: 'extract_metadata', confidence: 0.9, reason: 'ok' }),
      }),
    );
    expect(r.status).toBe('ready');
  });

  it('activates a credential-free library tool and records provenance=library', async () => {
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'exif' },
      deps({
        library: () => [exif],
        chat: async () => JSON.stringify({ name: 'extract_metadata', confidence: 0.9, reason: 'ok' }),
      }),
    );
    expect(r.status).toBe('ready');
    expect(getAutoTool('extract_metadata')?.provenance).toBe('library');
  });

  it('returns pending_credential (and does NOT register) for a credentialed library tool', async () => {
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'image' },
      deps({
        library: () => [imageSearch],
        chat: async () => JSON.stringify({ name: 'image_search', confidence: 0.9, reason: 'ok' }),
      }),
    );
    expect(r.status).toBe('pending_credential');
    if (r.status === 'pending_credential') {
      expect(r.catalogId).toBe('brave-search');
      expect(r.host).toBe('api.search.brave.com');
      expect(r.approvalToken).toBeTruthy();
    }
    expect(getAutoTool('image_search')).toBeUndefined();
  });

  it('returns unavailable when nothing matches', async () => {
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'xyz' },
      deps(),
    );
    expect(r.status).toBe('unavailable');
  });
});
