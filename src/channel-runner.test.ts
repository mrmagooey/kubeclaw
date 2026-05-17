import { describe, it, expect, vi } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)`
// guard. Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

import { folderPrefixForChannel, _buildShutdown } from './channel-runner.js';

describe('folderPrefixForChannel', () => {
  it('returns "oauth" for oauth-webchat', () => {
    expect(folderPrefixForChannel('oauth-webchat')).toBe('oauth');
  });

  it('returns the established prefix for known channels', () => {
    expect(folderPrefixForChannel('telegram')).toBe('tg');
    expect(folderPrefixForChannel('http')).toBe('http');
  });

  it('falls back to first 3 chars for unknown channels', () => {
    expect(folderPrefixForChannel('matrix')).toBe('mat');
  });
});

describe('_buildShutdown: metrics server closed on shutdown', () => {
  it('calls metricsServer.close() during shutdown', async () => {
    const metricsServer = { close: vi.fn().mockResolvedValue(undefined) };
    const queue = { shutdown: vi.fn().mockResolvedValue(undefined) };
    const channels: Array<{ disconnect: () => Promise<void> }> = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const shutdown = _buildShutdown(
      metricsServer as import('./metrics/registry.js').MetricsServer,
      queue as unknown as import('./group-queue.js').GroupQueue,
      channels as unknown as import('./types.js').Channel[],
    );
    await shutdown('SIGTERM');

    expect(metricsServer.close).toHaveBeenCalledOnce();
    exitSpy.mockRestore();
  });
});
