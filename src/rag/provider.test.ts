import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../capabilities/client.js', () => ({ getRagEntry: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getRagProvider, resetRagProvider } from './provider.js';
import { getRagEntry } from '../capabilities/client.js';

beforeEach(() => {
  resetRagProvider();
  vi.mocked(getRagEntry).mockReset();
  delete process.env.KUBECLAW_CHANNEL;
});

describe('getRagProvider (adapter-based)', () => {
  it('returns the remote provider for a remote adapter entry', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag', name: 'lr', endpoint: 'http://lr',
      kindMetadata: { backend: 'lightrag', provider: { adapter: 'remote' } },
    } as never);
    expect(getRagProvider().name).toBe('remote');
  });

  it('returns the vector-store provider for a vector-store adapter entry', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag', name: 'q', endpoint: 'http://q',
      kindMetadata: {
        backend: 'qdrant',
        provider: { adapter: 'vector-store', embedding: { provider: 'openai' } },
      },
    } as never);
    expect(getRagProvider().name).toBe('vector-store');
  });

  it('returns NullRagProvider when nothing configured', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    expect(getRagProvider().name).toBe('none');
  });

  it('passes KUBECLAW_CHANNEL to getRagEntry', () => {
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
