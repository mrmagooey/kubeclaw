/**
 * Unit tests for handleFindToolsMessage — the per-message handler extracted
 * from startFindToolsWatcher so it can be tested without a live Redis loop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { handleFindToolsMessage, type FindToolsHandlerDeps } from '../k8s/ipc-redis.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import type { ToolSpec } from '../tools/types.js';
import { mintApprovalToken } from '../tool-selection/credential-gate.js';

const exif: ToolSpec = {
  name: 'extract_metadata',
  description: 'Extract EXIF metadata from an image',
  parameters: {},
  image: 'kubeclaw/exiftool:latest',
  pattern: 'file',
  mount: 'group',
};

const SECRET = 'test-secret';

function nonce(requestId: string): string {
  return createHmac('sha256', SECRET).update(requestId).digest('hex');
}

function makeDeps(over: Partial<FindToolsHandlerDeps> = {}): FindToolsHandlerDeps {
  return {
    chat: async () =>
      JSON.stringify({ name: null, confidence: 0, reason: 'no match' }),
    liveCatalog: () => [],
    library: () => [],
    catalogHostLookup: () => undefined,
    reconcile: async () => {},
    writeResult: async () => {},
    secret: SECRET,
    ...over,
  };
}

describe('handleFindToolsMessage — library match', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('writes a serialized ready result when a library tool matches', async () => {
    const requestId = 'req-1';
    const written: string[] = [];

    const obj = {
      requestId,
      groupFolder: 'g',
      channel: 'http',
      taskDescription: 'extract EXIF from image',
    };

    await handleFindToolsMessage(obj, makeDeps({
      library: () => [exif],
      chat: async () =>
        JSON.stringify({ name: 'extract_metadata', confidence: 0.9, reason: 'ok' }),
      writeResult: async (_requestId, json) => {
        written.push(json);
      },
    }));

    expect(written).toHaveLength(1);
    const result = JSON.parse(written[0]);
    expect(result.status).toBe('ready');
    expect(result.tools[0].name).toBe('extract_metadata');
    expect(result.tools[0].provenance).toBe('library');
  });
});

describe('handleFindToolsMessage — approve path', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('writes a serialized ready result when a valid approval token is submitted', async () => {
    const requestId = 'req-2';
    const n = nonce(requestId);
    const approvalToken = mintApprovalToken(exif.name, 'some-catalog', n);
    const written: string[] = [];

    const obj = {
      kind: 'approve' as const,
      requestId,
      toolName: exif.name,
      catalogId: 'some-catalog',
      approvalToken,
    };

    await handleFindToolsMessage(obj, makeDeps({
      library: () => [exif],
      writeResult: async (_requestId, json) => {
        written.push(json);
      },
    }));

    expect(written).toHaveLength(1);
    const result = JSON.parse(written[0]);
    expect(result.status).toBe('ready');
    expect(result.tools[0].name).toBe(exif.name);
  });
});
