import { describe, it, expect, vi } from 'vitest';

vi.mock('../../rag/provider.js', () => ({ augmentPrompt: vi.fn() }));
vi.mock('../../capabilities/client.js', () => ({ getTranscriptionEntry: vi.fn() }));
vi.mock('../../config.js', () => ({ GROUPS_DIR: '/groups' }));
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildDefaultPreprocessors } from './registry.js';

describe('buildDefaultPreprocessors', () => {
  it('returns transcription (transform) then rag (augment)', () => {
    const chain = buildDefaultPreprocessors();
    expect(chain.map((p) => p.name)).toEqual(['transcription', 'rag']);
    expect(chain.map((p) => p.effect)).toEqual(['transform', 'augment']);
  });
});
