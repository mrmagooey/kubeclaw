import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInstall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockList = vi.hoisted(() =>
  vi
    .fn()
    .mockReturnValue([
      { kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' },
    ]),
);
const mockStatus = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    name: 'weather',
    lifecycle: 'ready',
    lastProbeAt: '2026-05-10T00:00:00Z',
    lastError: null,
  }),
);

vi.mock('./capabilities/index.js', () => ({
  installCapability: mockInstall,
  removeCapability: mockRemove,
  listCapabilities: mockList,
}));
vi.mock('./capabilities/db.js', () => ({
  getCapabilityStatus: mockStatus,
}));

import { executeTool } from './admin-shell.js';

beforeEach(() => {
  mockInstall.mockClear();
  mockRemove.mockClear();
});

describe('admin-shell capability tools', () => {
  it('install_capability calls installCapability with the spec', async () => {
    const result = await executeTool('install_capability', {
      spec: { kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' },
    });
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(result).toContain('weather');
  });

  it('install_capability returns error when spec missing', async () => {
    const result = await executeTool('install_capability', {});
    expect(result.toLowerCase()).toContain('error');
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('remove_capability delegates by name', async () => {
    const result = await executeTool('remove_capability', { name: 'weather' });
    expect(mockRemove).toHaveBeenCalledWith('weather');
    expect(result).toContain('weather');
  });

  it('list_capabilities returns specs with status', async () => {
    const result = await executeTool('list_capabilities', {});
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status.lifecycle).toBe('ready');
  });

  it('get_capability_logs returns error when name missing', async () => {
    const result = await executeTool('get_capability_logs', {});
    expect(result.toLowerCase()).toContain('error');
  });
});
