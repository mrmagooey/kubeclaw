import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  setCapability,
  getCapability,
  getAllCapabilities,
  getCapabilitiesByKind,
  deleteCapability,
  updateCapabilityStatus,
  getCapabilityStatus,
} from './db.js';
import type { CapabilitySpec } from './types.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';

const mcpSpec: CapabilitySpec = {
  kind: 'mcp',
  name: 'weather',
  image: 'mcp/weather:1.0',
  allowedTools: ['get_forecast'],
};

const ragSpec: CapabilitySpec = {
  kind: 'rag',
  name: 'main-rag',
  image: 'qdrant/qdrant:latest',
  backend: 'qdrant',
  storage: { sizeGi: 20, mountPath: '/qdrant/storage' },
};

describe('capabilities/db', () => {
  beforeAll(async () => {
    await _initTestDatabase();
  });

  beforeEach(() => __resetDbForTest());

  it('persists and retrieves a capability', () => {
    setCapability(mcpSpec);
    const got = getCapability('weather');
    expect(got).toEqual(mcpSpec);
  });

  it('upserts on duplicate name', () => {
    setCapability(mcpSpec);
    setCapability({ ...mcpSpec, image: 'mcp/weather:2.0' });
    expect(getCapability('weather')?.image).toBe('mcp/weather:2.0');
  });

  it('lists all capabilities', () => {
    setCapability(mcpSpec);
    setCapability(ragSpec);
    expect(getAllCapabilities()).toHaveLength(2);
  });

  it('filters by kind', () => {
    setCapability(mcpSpec);
    setCapability(ragSpec);
    expect(getCapabilitiesByKind('rag')).toEqual([ragSpec]);
  });

  it('deletes by name', () => {
    setCapability(mcpSpec);
    deleteCapability('weather');
    expect(getCapability('weather')).toBeUndefined();
  });

  it('updates status fields', () => {
    setCapability(mcpSpec);
    updateCapabilityStatus('weather', {
      lifecycle: 'ready',
      lastProbeAt: '2026-05-10T12:00:00Z',
      lastError: null,
    });
    expect(getCapabilityStatus('weather')).toEqual({
      name: 'weather',
      lifecycle: 'ready',
      lastProbeAt: '2026-05-10T12:00:00Z',
      lastError: null,
    });
  });
});
