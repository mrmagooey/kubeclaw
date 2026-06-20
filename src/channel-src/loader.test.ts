// src/channel-src/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeKey, loadChannelSource } from './loader.js';

describe('decodeKey', () => {
  it('splits type and flat file', () => {
    expect(decodeKey('signal__channel-entry.js')).toEqual({
      channelType: 'signal',
      relPath: 'channel-entry.js',
    });
  });
  it('decodes nested paths', () => {
    expect(decodeKey('signal__lib__util.js')).toEqual({
      channelType: 'signal',
      relPath: 'lib/util.js',
    });
  });
  it('returns null without a separator', () => {
    expect(decodeKey('placeholder')).toBeNull();
  });
});

describe('loadChannelSource', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'csrc-'));
    writeFileSync(join(dir, 'signal__channel-entry.js'), 'A');
    writeFileSync(join(dir, 'signal__lib__util.js'), 'B');
    writeFileSync(join(dir, 'http-echo__channel-entry.js'), 'C');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns only the requested type, decoded and sorted', () => {
    const files = loadChannelSource('signal', dir);
    expect(files).toEqual([
      { path: 'channel-entry.js', content: 'A' },
      { path: 'lib/util.js', content: 'B' },
    ]);
  });
  it('returns [] for an absent dir', () => {
    expect(loadChannelSource('signal', join(dir, 'nope'))).toEqual([]);
  });
  it('returns [] for an unknown type', () => {
    expect(loadChannelSource('telegram', dir)).toEqual([]);
  });
});
