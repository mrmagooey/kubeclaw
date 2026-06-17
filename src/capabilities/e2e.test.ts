/**
 * End-to-end test of the capabilities subsystem.
 *
 * Traces the full lifecycle chain that the unit tests for individual modules
 * cannot cover in isolation:
 *
 *   installCapability(spec)
 *      → setCapability (DB write)
 *      → applySpec → buildYaml → jobRunner.applyYamlToK8s (mocked)
 *      → notifyAllChannels → redis.publish('kubeclaw:control:<channel>', ...)
 *      → channel-side handleCapabilitiesUpdate(msg)
 *      → getDirectLLMRunner().configureMcp(mcpServers)
 *      → resetRagProvider() (so the cached singleton picks up new RAG entries)
 *
 * The test mocks the K8s and runtime sides; the registry, builders, DB, and
 * channel-runner handler logic run for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// channel-runner.ts has a module-level guard that calls process.exit(1) when
// KUBECLAW_CHANNEL is unset. The hoisted block here runs before the static
// imports below, so the channel-runner module loads cleanly. KUBECLAW_NAMESPACE
// is set to 'kubeclaw' so the rendered YAML and the K8s delete calls match
// what the production deployment uses (config.ts defaults it to 'default').
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'http';
  process.env.KUBECLAW_NAMESPACE = 'kubeclaw';
});

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const mockApplyYaml = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteDeployment = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockDeleteService = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockDeletePvc = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockPublish = vi.hoisted(() => vi.fn().mockResolvedValue(1));

const mockConfigureMcp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockResetRag = vi.hoisted(() => vi.fn());

vi.mock('../k8s/job-runner.js', () => ({
  jobRunner: {
    applyYamlToK8s: mockApplyYaml,
    deleteDeployment: mockDeleteDeployment,
    deleteService: mockDeleteService,
    deletePersistentVolumeClaim: mockDeletePvc,
  },
}));

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({ publish: mockPublish })),
  getControlChannel: (n: string) => `kubeclaw:control:${n}`,
}));

vi.mock('../runtime/index.js', () => ({
  getDirectLLMRunner: () => ({ configureMcp: mockConfigureMcp }),
  shutdownAllRunners: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../rag/provider.js', () => ({
  resetRagProvider: mockResetRag,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Subject under test ──────────────────────────────────────────────────────

import {
  installCapability,
  removeCapability,
  listCapabilities,
} from './registry.js';
import { handleCapabilitiesUpdate } from '../channel-runner.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { getAllCapabilities } from './db.js';
import type { ControlMessage } from '../k8s/types.js';

beforeEach(async () => {
  await _initTestDatabase();
  __resetDbForTest();
  mockApplyYaml.mockClear();
  mockDeleteDeployment.mockClear();
  mockDeleteService.mockClear();
  mockDeletePvc.mockClear();
  mockPublish.mockClear();
  mockConfigureMcp.mockClear();
  mockResetRag.mockClear();
});

/**
 * Find the publish call addressed to a specific channel control key, parse
 * its capabilities_update payload, and feed it to the channel-side handler
 * just like a live channel pod's pubsub subscription would.
 */
async function deliverUpdateTo(channelName: string): Promise<void> {
  const target = `kubeclaw:control:${channelName}`;
  const calls = mockPublish.mock.calls
    .filter((c) => c[0] === target)
    .map((c) => JSON.parse(c[1] as string))
    .filter((c) => c.command === 'capabilities_update');
  const update = calls.at(-1);
  if (!update) throw new Error(`No capabilities_update published to ${target}`);
  await handleCapabilitiesUpdate(update as ControlMessage);
}

// ─── Test cases ──────────────────────────────────────────────────────────────

describe('capabilities subsystem — end-to-end', () => {
  it('install MCP → applies YAML, persists, notifies, channel reconfigures runtime', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });

    // K8s reconciliation happened.
    expect(mockApplyYaml).toHaveBeenCalledOnce();
    const yaml = mockApplyYaml.mock.calls[0][0] as string;
    expect(yaml).toContain('kubeclaw-cap-weather');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');

    // DB persisted the spec.
    expect(listCapabilities()).toHaveLength(1);

    // Notification published to the unrestricted-channel broadcast set.
    await deliverUpdateTo('http');

    // Channel-side handler reconfigured the runtime with the right shape.
    expect(mockConfigureMcp).toHaveBeenCalledOnce();
    const servers = mockConfigureMcp.mock.calls[0][0] as Array<{
      name: string;
      url: string;
      allowedTools?: string[];
    }>;
    expect(servers).toEqual([
      { name: 'weather', url: 'http://kubeclaw-cap-weather:3000/mcp' },
    ]);

    // RAG cache invalidated even when no RAG entries are present (cheap).
    expect(mockResetRag).toHaveBeenCalledOnce();
  });

  it('install MCP with allowedTools and custom path propagates through to runtime', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'calendar',
      image: 'mcp/calendar:2.0',
      port: 4000,
      path: '/api/mcp',
      allowedTools: ['list_events', 'create_event'],
    });
    await deliverUpdateTo('http');
    expect(mockConfigureMcp).toHaveBeenCalledWith([
      {
        name: 'calendar',
        url: 'http://kubeclaw-cap-calendar:4000/api/mcp',
        allowedTools: ['list_events', 'create_event'],
      },
    ]);
  });

  it('install RAG capability triggers cache reset but yields no MCP runtime change', async () => {
    await installCapability({
      kind: 'rag',
      backend: 'qdrant',
      name: 'main-rag',
      image: 'qdrant/qdrant:latest',
    });
    await deliverUpdateTo('http');
    // The runtime is told there are zero MCP servers (empty list, not skipped).
    expect(mockConfigureMcp).toHaveBeenCalledWith([]);
    // RAG provider cache was invalidated so the next provider lookup picks up
    // the freshly installed Qdrant entry.
    expect(mockResetRag).toHaveBeenCalledOnce();
  });

  it('install ACL-restricted capability only notifies the targeted channel', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'slack-only',
      image: 'mcp/x:1.0',
      channels: ['slack'],
    });

    // The ACL'd spec is reachable to slack.
    await deliverUpdateTo('slack');
    expect(mockConfigureMcp).toHaveBeenLastCalledWith([
      { name: 'slack-only', url: 'http://kubeclaw-cap-slack-only:3000/mcp' },
    ]);

    // The same broadcast went to other known channels with an empty list,
    // because notifyAllChannels always hits KNOWN_CHANNELS — those channels
    // see nothing.
    mockConfigureMcp.mockClear();
    await deliverUpdateTo('http');
    expect(mockConfigureMcp).toHaveBeenCalledWith([]);
  });

  it('remove MCP → deletes K8s resources, drops DB row, runtime gets the empty list', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    mockPublish.mockClear();
    mockConfigureMcp.mockClear();

    await removeCapability('weather');

    expect(mockDeleteDeployment).toHaveBeenCalledWith(
      'kubeclaw-cap-weather',
      'kubeclaw',
    );
    expect(mockDeleteService).toHaveBeenCalledWith(
      'kubeclaw-cap-weather',
      'kubeclaw',
    );
    expect(listCapabilities()).toHaveLength(0);

    // Channel sees the removal.
    await deliverUpdateTo('http');
    expect(mockConfigureMcp).toHaveBeenCalledWith([]);
  });

  it('remove RAG capability also deletes its PVC', async () => {
    await installCapability({
      kind: 'rag',
      backend: 'qdrant',
      name: 'main-rag',
      image: 'qdrant/qdrant:latest',
    });
    mockDeletePvc.mockClear();
    await removeCapability('main-rag');
    expect(mockDeletePvc).toHaveBeenCalledWith(
      'kubeclaw-cap-main-rag-data',
      'kubeclaw',
    );
  });

  it('handleCapabilitiesUpdate with RAG entry syncs it to local DB so getRagEntry can resolve it', async () => {
    // Simulate a capabilities_update message arriving at the channel pod with a
    // Qdrant RAG entry. The channel pod has no prior knowledge of this entry.
    const msg: ControlMessage = {
      command: 'capabilities_update',
      capabilities: JSON.stringify([
        {
          name: 'test-rag',
          kind: 'rag',
          endpoint: 'http://kubeclaw-cap-test-rag:6333',
          kindMetadata: {
            backend: 'qdrant',
            provider: { adapter: 'vector-store', embedding: { provider: 'openai' } },
          },
        },
      ]),
    };

    // Initially the channel-side DB is empty.
    expect(getAllCapabilities()).toHaveLength(0);

    await handleCapabilitiesUpdate(msg);

    // syncCapabilitiesToLocalDb should have written the RAG entry so
    // DirectLLMRunner.runAgent → getRagProvider() → getRagEntry() can find it.
    const caps = getAllCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0].kind).toBe('rag');
    expect(caps[0].name).toBe('test-rag');
    expect((caps[0] as { backend?: string }).backend).toBe('qdrant');

    // The provider cache was also reset.
    expect(mockResetRag).toHaveBeenCalledOnce();
  });

  it('handleCapabilitiesUpdate removes stale entries no longer in the update', async () => {
    // Seed the channel-side DB with an old RAG entry.
    const seedMsg: ControlMessage = {
      command: 'capabilities_update',
      capabilities: JSON.stringify([
        {
          name: 'old-rag',
          kind: 'rag',
          endpoint: 'http://kubeclaw-cap-old-rag:6333',
          kindMetadata: {
            backend: 'qdrant',
            provider: { adapter: 'vector-store', embedding: { provider: 'openai' } },
          },
        },
      ]),
    };
    await handleCapabilitiesUpdate(seedMsg);
    expect(getAllCapabilities()).toHaveLength(1);

    // A subsequent update without old-rag should remove it.
    const updateMsg: ControlMessage = {
      command: 'capabilities_update',
      capabilities: JSON.stringify([]),
    };
    mockResetRag.mockClear();
    await handleCapabilitiesUpdate(updateMsg);

    expect(getAllCapabilities()).toHaveLength(0);
    expect(mockResetRag).toHaveBeenCalledOnce();
  });

  it('two installs aggregate so the channel sees both MCP servers in one update', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    await installCapability({
      kind: 'mcp',
      name: 'calendar',
      image: 'mcp/cal:1.0',
    });
    // The most-recent broadcast on `http` carries both entries.
    await deliverUpdateTo('http');
    const servers = mockConfigureMcp.mock.calls.at(-1)?.[0] as Array<{
      name: string;
    }>;
    expect(servers.map((s) => s.name).sort()).toEqual(['calendar', 'weather']);
  });
});
