/**
 * Integration test for /capabilities tools command.
 *
 * Exercises the chain:
 *   handleCapabilitiesUpdate(capabilities_update msg with mcp-group entries)
 *     → _groupCapabilityEntries populated
 *       → handleCapabilitiesCommand('group', '/capabilities tools echo', noOpIpc)
 *         → correct reply
 *
 * Tests:
 *   AC1: provisioned + schema scraped → list of tools
 *   AC3: provisioned + schema not yet scraped (pending-schema) → "schema not yet available"
 *   (AC2 is pure unit; no integration wiring needed beyond the Map lookup)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// channel-runner.ts has a module-level guard on KUBECLAW_CHANNEL.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'http';
});

vi.mock('../runtime/index.js', () => ({
  getDirectLLMRunner: vi.fn().mockReturnValue({
    configureMcp: vi.fn().mockResolvedValue(undefined),
    configureGroupMcpTemplates: vi.fn().mockResolvedValue(undefined),
  }),
  shutdownAllRunners: vi.fn(),
}));

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn(),
  }),
  getChannelStatusChannel: vi.fn().mockReturnValue('ch'),
  getTaskRequestStream: vi.fn().mockReturnValue('ts'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('sp'),
}));

vi.mock('../rag/provider.js', () => ({
  resetRagProvider: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../capabilities/db.js', () => ({
  getAllCapabilities: vi.fn().mockReturnValue([]),
  setCapability: vi.fn(),
  deleteCapability: vi.fn(),
}));

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    getAllChats: vi.fn().mockReturnValue([]),
    getAllTasks: vi.fn().mockReturnValue([]),
    getAllSessions: vi.fn().mockReturnValue({}),
    getAllRegisteredGroups: vi.fn().mockReturnValue({}),
    getRouterState: vi.fn().mockReturnValue(''),
    setRouterState: vi.fn(),
    initDatabase: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  handleCapabilitiesUpdate,
  handleCapabilitiesCommand,
  _groupCapabilityEntries,
  type CapabilityIpcFn,
} from '../channel-runner.js';
import type { ControlMessage } from '../k8s/types.js';

const noOpIpc = vi.fn() as unknown as CapabilityIpcFn;
const TEST_GROUP = 'http-http-test';

/** Build a minimal capabilities_update payload. */
function buildUpdate(entries: object[]): ControlMessage {
  return {
    command: 'capabilities_update',
    capabilities: JSON.stringify(entries),
  } as unknown as ControlMessage;
}

beforeEach(() => {
  _groupCapabilityEntries.clear();
});

describe('/capabilities tools — integration (handleCapabilitiesUpdate wiring)', () => {
  it('AC1: schema available → handleCapabilitiesCommand lists tool names', async () => {
    const update = buildUpdate([
      {
        name: 'echo',
        kind: 'mcp-group',
        state: 'ready',
        toolSchemas: [
          { name: 'echo_text', description: 'Echoes text', inputSchema: {} },
          { name: 'echo_json', description: 'Echoes JSON', inputSchema: {} },
        ],
      },
    ]);

    await handleCapabilitiesUpdate(update);

    const result = await handleCapabilitiesCommand(TEST_GROUP, '/capabilities tools echo', noOpIpc);

    expect(result.reply).toContain('echo_text');
    expect(result.reply).toContain('echo_json');
    expect(result.reply).toMatch(/Tools for 'echo'/);
  });

  it('AC3: pending-schema → reply contains "schema not yet available"', async () => {
    const update = buildUpdate([
      {
        name: 'echo',
        kind: 'mcp-group',
        state: 'pending-schema',
      },
    ]);

    await handleCapabilitiesUpdate(update);

    const result = await handleCapabilitiesCommand(TEST_GROUP, '/capabilities tools echo', noOpIpc);

    expect(result.reply).toMatch(/schema not yet available/i);
  });

  it('after capabilities_update with empty mcp-group list, previously-known entry is gone', async () => {
    // First install an echo entry.
    await handleCapabilitiesUpdate(
      buildUpdate([
        {
          name: 'echo',
          kind: 'mcp-group',
          state: 'ready',
          toolSchemas: [{ name: 'echo_text', description: 'Echoes text', inputSchema: {} }],
        },
      ]),
    );
    expect(_groupCapabilityEntries.has('echo')).toBe(true);

    // Then push an update with no mcp-group entries.
    await handleCapabilitiesUpdate(buildUpdate([]));

    const result = await handleCapabilitiesCommand(TEST_GROUP, '/capabilities tools echo', noOpIpc);
    expect(result.reply).toMatch(/not provisioned/i);
  });

  it('description truncated in reply (integration path)', async () => {
    const longDesc = 'B'.repeat(120);
    const update = buildUpdate([
      {
        name: 'echo',
        kind: 'mcp-group',
        state: 'ready',
        toolSchemas: [{ name: 'my_tool', description: longDesc, inputSchema: {} }],
      },
    ]);
    await handleCapabilitiesUpdate(update);

    const result = await handleCapabilitiesCommand(TEST_GROUP, '/capabilities tools echo', noOpIpc);
    expect(result.reply).toContain('my_tool');
    expect(result.reply).not.toContain(longDesc);
    expect(result.reply).toContain('…');
  });
});
