import { describe, it, expect, beforeEach } from 'vitest';
import { handleFindToolsMessage } from '../k8s/ipc-redis.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { listToolOverrides } from '../skills/orchestrator/tool-registry.js';
import type { ToolSpec } from '../tools/types.js';

const exif: ToolSpec = {
  name: 'extract_metadata',
  description: 'EXIF',
  parameters: {},
  image: 'i',
  pattern: 'file',
  mount: 'group',
};

describe('find-tools integration', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('activates a library tool end-to-end through the handler', async () => {
    const written: Record<string, string> = {};
    let reconciled = 0;
    await handleFindToolsMessage(
      {
        requestId: 'rid',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'extract exif',
      },
      {
        chat: async () =>
          JSON.stringify({
            name: 'extract_metadata',
            confidence: 0.95,
            reason: 'ok',
          }),
        liveCatalog: () => [],
        library: () => [exif],
        catalogHostLookup: () => undefined,
        reconcile: async () => {
          reconciled++;
        },
        writeResult: async (id, json) => {
          written[id] = json;
        },
        secret: 's',
      },
    );
    expect(JSON.parse(written['rid']).status).toBe('ready');
    expect(listToolOverrides().some((t) => t.name === 'extract_metadata')).toBe(
      true,
    );
    expect(reconciled).toBe(1);
  });
});
