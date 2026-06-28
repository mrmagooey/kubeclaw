/**
 * Unit tests for handleFindToolsMessage — the per-message handler extracted
 * from startFindToolsWatcher so it can be tested without a live Redis loop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleFindToolsMessage,
  type FindToolsHandlerDeps,
} from '../k8s/ipc-redis.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { listToolOverrides } from '../skills/orchestrator/tool-registry.js';
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

const imageSearch: ToolSpec = {
  name: 'image_search',
  description: 'Search the web for images',
  parameters: {},
  image: 'kubeclaw/image-search:latest',
  pattern: 'http',
  credentials: ['brave-search'],
  allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
};

const SECRET = 'test-secret';

function makeDeps(
  over: Partial<FindToolsHandlerDeps> = {},
): FindToolsHandlerDeps {
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

    await handleFindToolsMessage(
      obj,
      makeDeps({
        library: () => [exif],
        chat: async () =>
          JSON.stringify({
            name: 'extract_metadata',
            confidence: 0.9,
            reason: 'ok',
          }),
        writeResult: async (_requestId, json) => {
          written.push(json);
        },
      }),
    );

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
    // Token is keyed on the stable server secret (deps.secret), not a
    // per-request nonce — mint with the same raw SECRET the handler uses.
    const approvalToken = mintApprovalToken(exif.name, 'some-catalog', SECRET);
    const written: string[] = [];

    const obj = {
      kind: 'approve' as const,
      requestId,
      toolName: exif.name,
      catalogId: 'some-catalog',
      approvalToken,
    };

    await handleFindToolsMessage(
      obj,
      makeDeps({
        library: () => [exif],
        writeResult: async (_requestId, json) => {
          written.push(json);
        },
      }),
    );

    expect(written).toHaveLength(1);
    const result = JSON.parse(written[0]);
    expect(result.status).toBe('ready');
    expect(result.tools[0].name).toBe(exif.name);
  });
});

describe('handleFindToolsMessage — cross-request credential approval', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('approves across two separate requests (R1 mint, R2 verify) and registers the tool', async () => {
    let reconciled = 0;
    const deps = makeDeps({
      library: () => [imageSearch],
      catalogHostLookup: (id) =>
        id === 'brave-search' ? 'api.search.brave.com' : undefined,
      reconcile: async () => {
        reconciled++;
      },
      chat: async () =>
        JSON.stringify({
          name: 'image_search',
          confidence: 0.9,
          reason: 'ok',
        }),
    });

    // Request 1 (R1): find a credentialed library tool → pending_credential.
    let firstResult = '';
    await handleFindToolsMessage(
      {
        requestId: 'R1',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'search the web for images',
      },
      {
        ...deps,
        writeResult: async (_id, json) => {
          firstResult = json;
        },
      },
    );

    const pending = JSON.parse(firstResult);
    expect(pending.status).toBe('pending_credential');
    expect(pending.approvalToken).toBeTruthy();
    expect(pending.toolName).toBe('image_search');
    expect(listToolOverrides()).toHaveLength(0);

    // Request 2 (R2): a DIFFERENT requestId carrying the captured token.
    let secondResult = '';
    await handleFindToolsMessage(
      {
        kind: 'approve',
        requestId: 'R2',
        toolName: pending.toolName,
        catalogId: pending.catalogId,
        approvalToken: pending.approvalToken,
      },
      {
        ...deps,
        writeResult: async (_id, json) => {
          secondResult = json;
        },
      },
    );

    const ready = JSON.parse(secondResult);
    expect(ready.status).toBe('ready');
    expect(reconciled).toBe(1);
    expect(listToolOverrides().map((t) => t.name)).toContain('image_search');
  });
});

describe('handleFindToolsMessage — discovered cross-request credential approval', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  const discoveredCredentialed: ToolSpec = {
    name: 'smart_search',
    description: 'Web search via brave',
    parameters: {},
    image: 'registry.example.com/smart-search:latest@sha256:deadbeef',
    pattern: 'http',
    credentials: ['brave-search'],
    allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
  };

  it('approves a discovered credentialed tool across R1/R2 and registers it group-scoped with provenance=discovered', async () => {
    let reconciled = 0;
    const handlerDeps = makeDeps({
      library: () => [], // no library tools — must come from discovery
      catalogHostLookup: (id) =>
        id === 'brave-search' ? 'api.search.brave.com' : undefined,
      reconcile: async () => {
        reconciled++;
      },
      chat: async () =>
        JSON.stringify({ name: null, confidence: 0, reason: 'no match' }),
      searchRegistry: async () => discoveredCredentialed,
    });

    // R1: Tier-3 discovery finds a credentialed tool → pending_credential.
    let firstResult = '';
    await handleFindToolsMessage(
      {
        requestId: 'R1',
        groupFolder: 'team-a',
        channel: 'http',
        taskDescription: 'search the web for smart results',
      },
      {
        ...handlerDeps,
        writeResult: async (_id, json) => {
          firstResult = json;
        },
      },
    );

    const pendingResult = JSON.parse(firstResult);
    expect(pendingResult.status).toBe('pending_credential');
    expect(pendingResult.toolName).toBe('smart_search');
    expect(pendingResult.approvalToken).toBeTruthy();
    // Tool must NOT be registered yet.
    expect(listToolOverrides()).toHaveLength(0);

    // R2: User approves; a separate approve-kind message arrives.
    let secondResult = '';
    await handleFindToolsMessage(
      {
        kind: 'approve',
        requestId: 'R2',
        toolName: pendingResult.toolName,
        catalogId: pendingResult.catalogId,
        approvalToken: pendingResult.approvalToken,
      },
      {
        ...handlerDeps,
        writeResult: async (_id, json) => {
          secondResult = json;
        },
      },
    );

    const readyResult = JSON.parse(secondResult);
    expect(readyResult.status).toBe('ready');
    expect(readyResult.tools[0].name).toBe('smart_search');
    expect(readyResult.tools[0].provenance).toBe('discovered');
    expect(reconciled).toBe(1);
    expect(listToolOverrides().map((t) => t.name)).toContain('smart_search');
  });
});
