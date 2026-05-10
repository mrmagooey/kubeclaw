import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { setCapability, getCapabilityStatus } from './db.js';
import { probeOnce } from './health.js';

const fetchMock = vi.fn();
beforeEach(async () => {
  await _initTestDatabase();
  __resetDbForTest();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('health.probeOnce', () => {
  it('marks ready on 200', async () => {
    setCapability({ kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await probeOnce();
    expect(getCapabilityStatus('weather')?.lifecycle).toBe('ready');
  });

  it('marks unhealthy on 500', async () => {
    setCapability({ kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await probeOnce();
    expect(getCapabilityStatus('weather')?.lifecycle).toBe('unhealthy');
    expect(getCapabilityStatus('weather')?.lastError).toContain('500');
  });

  it('marks unhealthy on fetch error', async () => {
    setCapability({ kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' });
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    await probeOnce();
    expect(getCapabilityStatus('weather')?.lifecycle).toBe('unhealthy');
    expect(getCapabilityStatus('weather')?.lastError).toContain(
      'connection refused',
    );
  });
});
