import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../capabilities/client.js', () => ({
  getRagEntry: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getRagProvider, __resetRagProviderForTest } from './provider.js';
import { getRagEntry } from '../capabilities/client.js';

beforeEach(() => {
  __resetRagProviderForTest();
  vi.mocked(getRagEntry).mockReset();
  delete process.env.KUBECLAW_CHANNEL;
  delete process.env.QDRANT_URL;
});

describe('getRagProvider', () => {
  it('returns LightRAG when capability registry has lightrag', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag',
      name: 'lr',
      endpoint: 'http://lr',
      kindMetadata: { backend: 'lightrag' },
    } as never);
    expect(getRagProvider().name).toBe('lightrag');
  });

  it('returns Qdrant when capability registry has qdrant', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag',
      name: 'q',
      endpoint: 'http://q',
      kindMetadata: { backend: 'qdrant' },
    } as never);
    expect(getRagProvider().name).toBe('qdrant');
    expect(process.env.QDRANT_URL).toBe('http://q');
  });

  it('returns NullRagProvider when nothing configured', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    expect(getRagProvider().name).toBe('none');
  });

  it('passes KUBECLAW_CHANNEL env var to getRagEntry (not CHANNEL_NAME)', () => {
    process.env.KUBECLAW_CHANNEL = 'telegram';
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    getRagProvider();
    expect(vi.mocked(getRagEntry)).toHaveBeenCalledWith('telegram');
  });

  it('falls back to wildcard channel name when KUBECLAW_CHANNEL is unset', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    getRagProvider();
    expect(vi.mocked(getRagEntry)).toHaveBeenCalledWith('*');
  });
});
