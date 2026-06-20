import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeChannelAdapter } from './load-runtime-adapter.js';
import type { ChannelSdk } from './index.js';

function fakeSdk(): ChannelSdk {
  return {
    registerChannel: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any,
    readEnvFile: vi.fn(() => ({})),
    assistantName: 'Andy',
  };
}

describe('loadRuntimeChannelAdapter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rta-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns false when the entry file is absent', async () => {
    const loaded = await loadRuntimeChannelAdapter(
      fakeSdk(),
      join(dir, 'nope.js'),
    );
    expect(loaded).toBe(false);
  });

  it('imports the adapter and invokes its default register(sdk)', async () => {
    const entry = join(dir, 'channel-entry.mjs');
    writeFileSync(
      entry,
      `export default function register(sdk){ sdk.registerChannel('fake', () => null); }`,
    );
    const sdk = fakeSdk();
    const loaded = await loadRuntimeChannelAdapter(sdk, entry);
    expect(loaded).toBe(true);
    expect(sdk.registerChannel).toHaveBeenCalledWith(
      'fake',
      expect.any(Function),
    );
  });

  it('throws when the default export is not a function', async () => {
    const entry = join(dir, 'bad.mjs');
    writeFileSync(entry, `export default 42;`);
    await expect(loadRuntimeChannelAdapter(fakeSdk(), entry)).rejects.toThrow(
      /default export.*function/i,
    );
  });
});
