import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mockApply = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDelete = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPublish = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockGetCachedSchemas = vi.hoisted(() => vi.fn(() => null));

vi.mock('./reconciler.js', () => ({
  applySpec: mockApply,
  deleteSpec: mockDelete,
  reconcileAllOnStartup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({ publish: mockPublish })),
  getControlChannel: (n: string) => `kubeclaw:control:${n}`,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../per-group-capabilities/schema-cache.js', () => ({
  getCachedSchemas: mockGetCachedSchemas,
}));

import {
  installCapability,
  removeCapability,
  listCapabilities,
  getEntriesForChannel,
  notifyAllChannels,
  specToDiscoveryEntry,
} from './registry.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
  mockApply.mockClear();
  mockDelete.mockClear();
  mockPublish.mockClear();
  mockGetCachedSchemas.mockClear();
});

describe('registry', () => {
  it('install persists, applies, and notifies channels', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    expect(mockApply).toHaveBeenCalledOnce();
    expect(listCapabilities()).toHaveLength(1);
    expect(mockPublish).toHaveBeenCalled();
  });

  it('remove deletes K8s resources, removes DB row, notifies', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    mockPublish.mockClear();
    await removeCapability('weather');
    expect(mockDelete).toHaveBeenCalledOnce();
    expect(listCapabilities()).toHaveLength(0);
    expect(mockPublish).toHaveBeenCalled();
  });

  it('install of a duplicate name updates the spec', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:2.0',
    });
    const list = listCapabilities();
    expect(list).toHaveLength(1);
    expect(list[0].image).toBe('mcp/weather:2.0');
  });

  it('getEntriesForChannel returns only ACL-allowed entries', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'public-mcp',
      image: 'mcp/public:1.0',
    });
    await installCapability({
      kind: 'mcp',
      name: 'slack-only',
      image: 'mcp/slack:1.0',
      channels: ['slack'],
    });
    await installCapability({
      kind: 'mcp',
      name: 'discord-only',
      image: 'mcp/discord:1.0',
      channels: ['discord'],
    });

    expect(
      getEntriesForChannel('slack')
        .map((e) => e.name)
        .sort(),
    ).toEqual(['public-mcp', 'slack-only']);
    expect(
      getEntriesForChannel('http')
        .map((e) => e.name)
        .sort(),
    ).toEqual(['public-mcp']);
  });

  describe('RAG uniqueness', () => {
    const rag = (name: string, channels?: string[]) => ({
      kind: 'rag' as const,
      name,
      image: `rag/${name}:1.0`,
      backend: 'qdrant' as const,
      ...(channels ? { channels } : {}),
    });

    it('rejects a second unscoped RAG', async () => {
      await installCapability(rag('rag-a'));
      await expect(installCapability(rag('rag-b'))).rejects.toThrow(
        /conflicts with already-installed RAG 'rag-a'/,
      );
      expect(listCapabilities()).toHaveLength(1);
      // Side-effects must not have fired for the rejected install.
      expect(mockApply).toHaveBeenCalledOnce();
    });

    it('rejects a RAG when an unscoped RAG already exists, even if the new one is scoped', async () => {
      await installCapability(rag('rag-a'));
      await expect(installCapability(rag('rag-b', ['slack']))).rejects.toThrow(
        /unscoped \(applies to all channels\)/,
      );
    });

    it('rejects a RAG when the existing scoped RAG covers the same channel', async () => {
      await installCapability(rag('rag-a', ['slack', 'telegram']));
      await expect(
        installCapability(rag('rag-b', ['telegram', 'discord'])),
      ).rejects.toThrow(/on channel\(s\): telegram/);
    });

    it('allows two RAGs with disjoint channel ACLs', async () => {
      await installCapability(rag('rag-a', ['slack']));
      await installCapability(rag('rag-b', ['telegram']));
      expect(listCapabilities()).toHaveLength(2);
    });

    it('allows updating an existing RAG (same name) even when unscoped', async () => {
      await installCapability(rag('rag-a'));
      await installCapability({
        ...rag('rag-a'),
        image: 'rag/rag-a:2.0',
      });
      const list = listCapabilities();
      expect(list).toHaveLength(1);
      expect(list[0].image).toBe('rag/rag-a:2.0');
    });

    it('does not block an MCP install when a RAG is present', async () => {
      await installCapability(rag('rag-a'));
      await installCapability({
        kind: 'mcp',
        name: 'weather',
        image: 'mcp/weather:1.0',
      });
      expect(listCapabilities()).toHaveLength(2);
    });
  });

  it("remove notifies a non-standard channel name that was ACL'd to the removed spec", async () => {
    await installCapability({
      kind: 'mcp',
      name: 'mychan-only',
      image: 'mcp/x:1.0',
      channels: ['mychan'], // not in KNOWN_CHANNELS
    });
    mockPublish.mockClear();
    await removeCapability('mychan-only');
    // mockPublish was called for each targeted channel, including mychan.
    const publishedChannels = mockPublish.mock.calls.map((c) => c[0] as string);
    expect(publishedChannels).toContain('kubeclaw:control:mychan');
  });

  describe('endpoint scheme', () => {
    it('defaults to http://', () => {
      const entry = specToDiscoveryEntry({
        kind: 'http', name: 'web', image: 'nginx', port: 8080,
      });
      expect(entry.endpoint).toBe('http://kubeclaw-cap-web:8080');
    });

    it('honors endpointScheme', () => {
      const entry = specToDiscoveryEntry({
        kind: 'http', name: 'maindb', image: 'postgres:16', port: 5432,
        endpointScheme: 'postgresql',
      });
      expect(entry.endpoint).toBe('postgresql://kubeclaw-cap-maindb:5432');
    });
  });

  describe('rag discovery entry', () => {
    it('emits backend + normalized provider in kindMetadata for a legacy spec', () => {
      const entry = specToDiscoveryEntry({
        kind: 'rag', backend: 'qdrant', name: 'r', image: 'qdrant/qdrant',
      });
      if (entry.kind !== 'rag') throw new Error('expected rag entry');
      expect(entry.kindMetadata.backend).toBe('qdrant');
      expect(entry.kindMetadata.provider.adapter).toBe('vector-store');
      expect(entry.endpoint).toBe('http://kubeclaw-cap-r:6333');
    });

    it('passes an explicit provider through to kindMetadata', () => {
      const entry = specToDiscoveryEntry({
        kind: 'rag', backend: 'lightrag', name: 'lr', image: 'lightrag', port: 9621,
        provider: { adapter: 'remote', queryMode: 'naive' },
      });
      if (entry.kind !== 'rag') throw new Error('expected rag entry');
      expect(entry.kindMetadata.provider.adapter).toBe('remote');
      expect(entry.endpoint).toBe('http://kubeclaw-cap-lr:9621');
    });
  });

  describe('transcription discovery entry', () => {
    it('emits the normalized provider in kindMetadata with NO secrets', () => {
      const entry = specToDiscoveryEntry({
        kind: 'transcription',
        name: 'whisper',
        image: 'onerahmet/openai-whisper-asr-webservice:latest',
      });
      if (entry.kind !== 'transcription') throw new Error('expected transcription entry');
      expect(entry.kindMetadata.provider.transcribePath).toBe('/v1/audio/transcriptions');
      expect(entry.kindMetadata.provider.responseField).toBe('text');
      expect(entry.endpoint).toBe('http://kubeclaw-cap-whisper:9000');
      // No secret/key fields exist on the entry — provider config is the whole shape.
      expect(JSON.stringify(entry)).not.toMatch(/apiKey|secret|token/i);
    });

    it('honours an explicit port', () => {
      const entry = specToDiscoveryEntry({
        kind: 'transcription', name: 'w', image: 'img', port: 8080,
      });
      if (entry.kind !== 'transcription') throw new Error('expected transcription entry');
      expect(entry.endpoint).toBe('http://kubeclaw-cap-w:8080');
    });
  });

  describe('one-per-channel transcription guard', () => {
    it('rejects a second universal transcription on the same (all) channels', async () => {
      await installCapability({
        kind: 'transcription', name: 't1', image: 'img',
      });
      await expect(
        installCapability({ kind: 'transcription', name: 't2', image: 'img' }),
      ).rejects.toThrow(/transcription/i);
    });

    it('allows two transcriptions with disjoint channel ACLs', async () => {
      await installCapability({
        kind: 'transcription', name: 't1', image: 'img', channels: ['telegram'],
      });
      await expect(
        installCapability({ kind: 'transcription', name: 't2', image: 'img', channels: ['slack'] }),
      ).resolves.toBeUndefined();
    });

    it('allows updating an existing transcription (same name) even when unscoped', async () => {
      await installCapability({ kind: 'transcription', name: 't1', image: 'img:1' });
      await installCapability({ kind: 'transcription', name: 't1', image: 'img:2' });
      const list = listCapabilities().filter((c) => c.kind === 'transcription');
      expect(list).toHaveLength(1);
      expect(list[0].image).toBe('img:2');
    });

    it('does not block an MCP install when a transcription is present', async () => {
      await installCapability({ kind: 'transcription', name: 't1', image: 'img' });
      await installCapability({ kind: 'mcp', name: 'weather', image: 'mcp/weather:1.0' });
      expect(listCapabilities()).toHaveLength(2);
    });
  });

  describe('notifyAllChannels — group-scoped capabilities', () => {
    it('includes mcp-group entries in the published payload', async () => {
      // Setup: install a group-scoped echo capability + cache its schemas.
      await installCapability({
        kind: 'mcp',
        name: 'echo',
        image: 'echo:1',
        scope: 'group',
      });

      // Mock the schema cache to return a mock schema.
      mockGetCachedSchemas.mockReturnValue([{ name: 'echo', inputSchema: {} }]);

      mockPublish.mockClear();
      await notifyAllChannels();

      // Find the published payload for the 'http' channel (a known channel).
      const httpPublishCall = mockPublish.mock.calls.find(
        (call) => call[0] === 'kubeclaw:control:http',
      );
      expect(httpPublishCall).toBeDefined();

      // Parse the payload and extract the capabilities.
      const payload = JSON.parse(httpPublishCall![1] as string);
      const entries = JSON.parse(payload.capabilities);

      // Verify that a mcp-group entry for 'echo' is present.
      const groupEntry = entries.find(
        (e: { kind: string; name: string }) =>
          e.kind === 'mcp-group' && e.name === 'echo',
      );
      expect(groupEntry).toBeDefined();
      expect(groupEntry?.state).toBe('ready');
      expect(groupEntry?.toolSchemas).toBeDefined();
    });
  });
});
