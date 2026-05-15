/**
 * Tests for McpManager — MCP client manager for channel pods
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mock state ----

const {
  mockListTools,
  mockCallTool,
  mockConnect,
  mockClose,
  MockClient,
  MockStreamableHTTPTransport,
  MockSSETransport,
} = vi.hoisted(() => {
  const mockListTools = vi.fn();
  const mockCallTool = vi.fn();
  const mockConnect = vi.fn();
  const mockClose = vi.fn();

  class MockClient {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
    constructor(_opts: unknown) {}
  }

  class MockStreamableHTTPTransport {
    constructor(_url: unknown) {}
  }

  class MockSSETransport {
    constructor(_url: unknown) {}
  }

  return {
    mockListTools,
    mockCallTool,
    mockConnect,
    mockClose,
    MockClient,
    MockStreamableHTTPTransport,
    MockSSETransport,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: MockStreamableHTTPTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: MockSSETransport,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---- Import after mocks ----

import { McpManager } from './mcp-manager.js';
import type { McpServerStatus } from '../types.js';

// ---- Tests ----

describe('McpManager', () => {
  const weatherServer: McpServerStatus = {
    name: 'weather',
    url: 'http://kubeclaw-mcp-weather:3000/mcp',
  };

  const calendarServer: McpServerStatus = {
    name: 'calendar',
    url: 'http://kubeclaw-mcp-calendar:3000/mcp',
    allowedTools: ['list_events'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather for a location',
          inputSchema: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      ],
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Sunny, 72F' }],
    });
  });

  describe('initialize', () => {
    it('connects to MCP servers and discovers tools', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      expect(mockConnect).toHaveBeenCalled();
      expect(mockListTools).toHaveBeenCalled();

      const tools = manager.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].function.name).toBe('get_weather');
      expect(tools[0].function.description).toBe(
        'Get current weather for a location',
      );
      expect(tools[0].type).toBe('function');
    });

    it('skips servers that fail to connect', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));

      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      expect(manager.getTools()).toHaveLength(0);
      expect(manager.hasTool('get_weather')).toBe(false);
    });

    it('connects to multiple servers', async () => {
      // First server connect + tools
      mockConnect.mockResolvedValueOnce(undefined);
      mockListTools.mockResolvedValueOnce({
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
      // Second server connect + tools
      mockConnect.mockResolvedValueOnce(undefined);
      mockListTools.mockResolvedValueOnce({
        tools: [
          {
            name: 'list_events',
            description: 'List calendar events',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'create_event',
            description: 'Create event',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      const manager = new McpManager();
      await manager.initialize([weatherServer, calendarServer]);

      const tools = manager.getTools();
      // get_weather + list_events (create_event filtered by allowedTools on calendarServer)
      expect(tools).toHaveLength(2);
      expect(manager.hasTool('get_weather')).toBe(true);
      expect(manager.hasTool('list_events')).toBe(true);
      expect(manager.hasTool('create_event')).toBe(false);
    });

    it('applies allowedTools filter', async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockListTools.mockResolvedValueOnce({
        tools: [
          {
            name: 'list_events',
            description: 'List events',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'create_event',
            description: 'Create event',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'delete_event',
            description: 'Delete event',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      const manager = new McpManager();
      await manager.initialize([calendarServer]); // allowedTools: ['list_events']

      expect(manager.hasTool('list_events')).toBe(true);
      expect(manager.hasTool('create_event')).toBe(false);
      expect(manager.hasTool('delete_event')).toBe(false);
    });

    it('handles tool name collisions (first server wins)', async () => {
      const server1: McpServerStatus = {
        name: 'server1',
        url: 'http://s1:3000/mcp',
      };
      const server2: McpServerStatus = {
        name: 'server2',
        url: 'http://s2:3000/mcp',
      };

      mockConnect.mockResolvedValue(undefined);
      mockListTools
        .mockResolvedValueOnce({
          tools: [
            {
              name: 'shared_tool',
              description: 'From server1',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        })
        .mockResolvedValueOnce({
          tools: [
            {
              name: 'shared_tool',
              description: 'From server2',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });

      const manager = new McpManager();
      await manager.initialize([server1, server2]);

      const tools = manager.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].function.description).toBe('From server1');
    });

    it('falls back to SSE transport when StreamableHTTP fails', async () => {
      // First connect (StreamableHTTP) fails, second connect (SSE) succeeds
      mockConnect
        .mockRejectedValueOnce(new Error('StreamableHTTP not supported'))
        .mockResolvedValueOnce(undefined);

      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(manager.getTools()).toHaveLength(1);
    });
  });

  describe('hasTool', () => {
    it('returns true for registered tools', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);
      expect(manager.hasTool('get_weather')).toBe(true);
    });

    it('returns false for unknown tools', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);
      expect(manager.hasTool('nonexistent')).toBe(false);
    });

    it('returns false when no servers initialized', () => {
      const manager = new McpManager();
      expect(manager.hasTool('anything')).toBe(false);
    });
  });

  describe('callTool', () => {
    it('routes call to correct MCP server and returns result', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const result = await manager.callTool('get_weather', { location: 'NYC' });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'get_weather',
        arguments: { location: 'NYC' },
      });
      expect(result).toBe('Sunny, 72F');
    });

    it('returns error message for unknown tool', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const result = await manager.callTool('nonexistent', {});
      expect(result).toBe('Unknown MCP tool: nonexistent');
    });

    it('handles tool call errors gracefully', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      mockCallTool.mockRejectedValueOnce(new Error('Server timeout'));
      const result = await manager.callTool('get_weather', { location: 'NYC' });
      expect(result).toContain('MCP tool error');
      expect(result).toContain('Server timeout');
    });

    it('joins multiple text content parts', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      mockCallTool.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
        ],
      });

      const result = await manager.callTool('get_weather', { location: 'NYC' });
      expect(result).toBe('Line 1\nLine 2');
    });

    it('returns fallback message when tool returns no text', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'image', data: 'base64...' }],
      });

      const result = await manager.callTool('get_weather', { location: 'NYC' });
      expect(result).toBe('Tool returned no text output');
    });
  });

  describe('reconfigure', () => {
    it('adds new servers', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);
      expect(manager.getTools()).toHaveLength(1);

      mockConnect.mockResolvedValueOnce(undefined);
      mockListTools.mockResolvedValueOnce({
        tools: [
          {
            name: 'list_events',
            description: 'List events',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      await manager.reconfigure([weatherServer, calendarServer]);
      expect(manager.getTools()).toHaveLength(2);
    });

    it('removes servers no longer in list', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);
      expect(manager.hasTool('get_weather')).toBe(true);

      await manager.reconfigure([]);
      expect(manager.hasTool('get_weather')).toBe(false);
      expect(manager.getTools()).toHaveLength(0);
      expect(mockClose).toHaveBeenCalled();
    });

    it('keeps existing servers that are still in list', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const connectCallsBefore = mockConnect.mock.calls.length;
      await manager.reconfigure([weatherServer]);

      // Should not reconnect to existing server
      expect(mockConnect.mock.calls.length).toBe(connectCallsBefore);
      expect(manager.hasTool('get_weather')).toBe(true);
    });

    it('retries a previously-failed server when its backoff window has elapsed', async () => {
      // Both StreamableHTTP and SSE transports must fail to mark the server as failed.
      // connectServer tries StreamableHTTP first, then falls back to SSE on failure.
      mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // StreamableHTTP attempt
        .mockRejectedValueOnce(new Error('ECONNREFUSED')); // SSE fallback attempt
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      expect(manager.getTools()).toHaveLength(0);
      expect(manager.hasTool('get_weather')).toBe(false);

      // Advance time past the first backoff window (5 s) using fake timers.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 6_000);

      // Next reconfigure: server is now retryable — connection succeeds.
      mockConnect.mockResolvedValueOnce(undefined);
      mockListTools.mockResolvedValueOnce({
        tools: [
          {
            name: 'get_weather',
            description: 'Get current weather for a location',
            inputSchema: {
              type: 'object',
              properties: { location: { type: 'string' } },
            },
          },
        ],
      });

      await manager.reconfigure([weatherServer]);

      vi.useRealTimers();

      expect(manager.hasTool('get_weather')).toBe(true);
      expect(manager.getTools()).toHaveLength(1);
    });

    it('does not retry a failed server before its backoff window elapses', async () => {
      // Both StreamableHTTP and SSE transports must fail to mark the server as failed.
      mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // StreamableHTTP attempt
        .mockRejectedValueOnce(new Error('ECONNREFUSED')); // SSE fallback attempt
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      // connect was called twice (HTTP + SSE fallback, both rejected).
      const connectCallsAfterInit = mockConnect.mock.calls.length;
      expect(connectCallsAfterInit).toBe(2);
      expect(manager.getTools()).toHaveLength(0);

      // Reconfigure immediately (within the 5 s backoff window) — should NOT retry.
      await manager.reconfigure([weatherServer]);

      // connect should NOT have been called again.
      expect(mockConnect.mock.calls.length).toBe(connectCallsAfterInit);
      expect(manager.getTools()).toHaveLength(0);
    });

    it('clears failed server entry on successful retry', async () => {
      vi.useFakeTimers();
      const startTime = Date.now();

      // Both transports fail on initialize.
      mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // init: HTTP
        .mockRejectedValueOnce(new Error('ECONNREFUSED')); // init: SSE fallback
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      // Advance past first backoff.
      vi.setSystemTime(startTime + 6_000);

      // Second attempt also fails (both transports again).
      mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED again')) // retry: HTTP
        .mockRejectedValueOnce(new Error('ECONNREFUSED again')); // retry: SSE fallback
      await manager.reconfigure([weatherServer]);
      expect(manager.getTools()).toHaveLength(0);

      // Advance past second backoff (15 s from start of second failure).
      vi.setSystemTime(startTime + 6_000 + 16_000);

      // Third attempt succeeds (StreamableHTTP succeeds — no SSE fallback needed).
      mockConnect.mockResolvedValueOnce(undefined);
      mockListTools.mockResolvedValueOnce({
        tools: [
          {
            name: 'get_weather',
            description: 'Weather',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      await manager.reconfigure([weatherServer]);

      vi.useRealTimers();

      expect(manager.hasTool('get_weather')).toBe(true);
    });

    it('removes failed server tracking when server is removed from list', async () => {
      // Both transports fail — server is tracked as failed.
      mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // HTTP
        .mockRejectedValueOnce(new Error('ECONNREFUSED')); // SSE fallback
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const connectCallsAfterInit = mockConnect.mock.calls.length;

      // Remove the server from the list — no retry should ever happen.
      await manager.reconfigure([]);

      // Advance time well past any backoff.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 60_000);
      await manager.reconfigure([]);
      vi.useRealTimers();

      // connect should not have been called again after the initial failures.
      expect(mockConnect.mock.calls.length).toBe(connectCallsAfterInit);
    });
  });

  describe('shutdown', () => {
    it('closes all client connections', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      await manager.shutdown();

      expect(mockClose).toHaveBeenCalled();
      expect(manager.getTools()).toHaveLength(0);
      expect(manager.hasTool('get_weather')).toBe(false);
    });

    it('handles close errors gracefully', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      mockClose.mockRejectedValueOnce(new Error('Already closed'));
      await expect(manager.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('getTools', () => {
    it('returns empty array when no servers', () => {
      const manager = new McpManager();
      expect(manager.getTools()).toEqual([]);
    });

    it('returns tools in OpenAI format', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const tools = manager.getTools();
      expect(tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      });
    });

    it('uses default description when tool has none', async () => {
      mockListTools.mockResolvedValueOnce({
        tools: [
          { name: 'my_tool', inputSchema: { type: 'object', properties: {} } },
        ],
      });

      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const tools = manager.getTools();
      expect(tools[0].function.description).toBe('Execute my_tool');
    });

    it('uses default parameters when tool has no inputSchema', async () => {
      mockListTools.mockResolvedValueOnce({
        tools: [{ name: 'simple_tool', description: 'A simple tool' }],
      });

      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const tools = manager.getTools();
      expect(tools[0].function.parameters).toEqual({
        type: 'object',
        properties: {},
      });
    });
  });
});
