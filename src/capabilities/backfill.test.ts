import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mockApply = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPublish = vi.hoisted(() => vi.fn().mockResolvedValue(1));

vi.mock('./reconciler.js', () => ({
  applySpec: mockApply,
  deleteSpec: vi.fn().mockResolvedValue(undefined),
  reconcileAllOnStartup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({ publish: mockPublish })),
  getControlChannel: (n: string) => `kubeclaw:control:${n}`,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  backfillFromLegacyMcp,
  __resetBackfillFlagForTest,
  listCapabilities,
} from './registry.js';
import { _initTestDatabase, __resetDbForTest, setMcpServer } from '../db.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
  __resetBackfillFlagForTest();
  mockApply.mockClear();
  mockPublish.mockClear();
});

describe('backfillFromLegacyMcp', () => {
  it('copies legacy mcp_servers rows into capabilities, kind=mcp', async () => {
    setMcpServer({ name: 'weather', image: 'mcp/weather:1.0' });
    setMcpServer({ name: 'calendar', image: 'mcp/cal:1.0' });
    await backfillFromLegacyMcp();
    const result = listCapabilities();
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.kind === 'mcp')).toBe(true);
    expect(result.map((c) => c.name).sort()).toEqual(['calendar', 'weather']);
  });

  it('skips names that already exist in capabilities', async () => {
    setMcpServer({ name: 'weather', image: 'mcp/weather:1.0' });
    // Pre-existing capability with same name
    const { setCapability } = await import('./db.js');
    setCapability({ kind: 'mcp', name: 'weather', image: 'mcp/weather:2.0' });

    await backfillFromLegacyMcp();
    const result = listCapabilities();
    expect(result).toHaveLength(1);
    expect(result[0].image).toBe('mcp/weather:2.0'); // unchanged
  });

  it('is idempotent across multiple calls', async () => {
    setMcpServer({ name: 'weather', image: 'mcp/weather:1.0' });
    await backfillFromLegacyMcp();
    mockApply.mockClear();
    await backfillFromLegacyMcp(); // second call should no-op
    expect(mockApply).not.toHaveBeenCalled();
  });
});
