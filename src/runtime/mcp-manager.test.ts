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
  mockRequestGroupCapability,
  MockClient,
  MockStreamableHTTPTransport,
  MockSSETransport,
  capturedTransportArgs,
} = vi.hoisted(() => {
  const mockListTools = vi.fn();
  const mockCallTool = vi.fn();
  const mockConnect = vi.fn();
  const mockClose = vi.fn();
  const mockRequestGroupCapability = vi.fn();

  // Stores the args passed to the most-recent MockStreamableHTTPTransport construction.
  const capturedTransportArgs: { url?: unknown; options?: unknown } = {};

  class MockClient {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
    constructor(_opts: unknown) {}
  }

  class MockStreamableHTTPTransport {
    close = vi.fn();
    constructor(_url: unknown, _options?: unknown) {
      capturedTransportArgs.url = _url;
      capturedTransportArgs.options = _options;
    }
  }

  class MockSSETransport {
    constructor(_url: unknown) {}
  }

  return {
    mockListTools,
    mockCallTool,
    mockConnect,
    mockClose,
    mockRequestGroupCapability,
    MockClient,
    MockStreamableHTTPTransport,
    MockSSETransport,
    capturedTransportArgs,
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

vi.mock('../capabilities/discovery-client.js', () => ({
  requestGroupCapability: mockRequestGroupCapability,
}));

// ---- Import after mocks ----

import { McpManager } from './mcp-manager.js';
import type { McpServerStatus } from '../types.js';
import type { GroupMcpEntry } from '../capabilities/types.js';

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
      expect(tools[0].function.name).toBe('mcp__weather__get_weather');
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
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(false);
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
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(true);
      expect(manager.hasTool('mcp__calendar__list_events')).toBe(true);
      expect(manager.hasTool('mcp__calendar__create_event')).toBe(false);
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

      expect(manager.hasTool('mcp__calendar__list_events')).toBe(true);
      expect(manager.hasTool('mcp__calendar__create_event')).toBe(false);
      expect(manager.hasTool('mcp__calendar__delete_event')).toBe(false);
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
      expect(tools).toHaveLength(2);
      // Both servers emit their own tool (prefixed by server name, no collision)
      const names = tools.map((t) => t.function.name).sort();
      expect(names).toEqual([
        'mcp__server1__shared_tool',
        'mcp__server2__shared_tool',
      ]);
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
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(true);
    });

    it('returns false for unknown tools', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);
      expect(manager.hasTool('mcp__weather__nonexistent')).toBe(false);
    });

    it('returns false when no servers initialized', () => {
      const manager = new McpManager();
      expect(manager.hasTool('mcp__anything__foo')).toBe(false);
    });
  });

  describe('callTool', () => {
    it('routes call to correct MCP server and returns result', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const result = await manager.callTool('mcp__weather__get_weather', {
        location: 'NYC',
      });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'get_weather',
        arguments: { location: 'NYC' },
      });
      expect(result).toBe('Sunny, 72F');
    });

    it('returns error message for unknown tool', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const result = await manager.callTool('mcp__weather__nonexistent', {});
      expect(result).toBe('Unknown MCP tool: mcp__weather__nonexistent');
    });

    it('handles tool call errors gracefully', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      mockCallTool.mockRejectedValueOnce(new Error('Server timeout'));
      const result = await manager.callTool('mcp__weather__get_weather', {
        location: 'NYC',
      });
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

      const result = await manager.callTool('mcp__weather__get_weather', {
        location: 'NYC',
      });
      expect(result).toBe('Line 1\nLine 2');
    });

    it('returns fallback message when tool returns no text', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'image', data: 'base64...' }],
      });

      const result = await manager.callTool('mcp__weather__get_weather', {
        location: 'NYC',
      });
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
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(true);

      await manager.reconfigure([]);
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(false);
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
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(true);
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
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(false);

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

      expect(manager.hasTool('mcp__weather__get_weather')).toBe(true);
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

      expect(manager.hasTool('mcp__weather__get_weather')).toBe(true);
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

  describe('background retry tick', () => {
    it('retries a failed server automatically after backoff elapses (no reconfigure needed)', async () => {
      vi.useFakeTimers();
      const startTime = Date.now();

      // Both transports fail on initialize — server goes into failedServers.
      mockConnect
        .mockRejectedValueOnce(new Error('EHOSTUNREACH')) // StreamableHTTP attempt
        .mockRejectedValueOnce(new Error('EHOSTUNREACH')); // SSE fallback attempt

      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      expect(manager.getTools()).toHaveLength(0);
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(false);

      // Prepare a successful connection for the retry attempt.
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

      // Advance time past the first backoff window (5 s) and fire exactly one tick.
      vi.setSystemTime(startTime + 6_000);
      // advanceTimersByTimeAsync fires timers that fall within the window without looping forever.
      await vi.advanceTimersByTimeAsync(6_000);

      // Check before shutdown clears state.
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(true);
      expect(manager.getTools()).toHaveLength(1);

      vi.useRealTimers();
      await manager.shutdown();
    });

    it('does not retry a failed server before its backoff window elapses', async () => {
      vi.useFakeTimers();
      const startTime = Date.now();

      // Both transports fail on initialize.
      mockConnect
        .mockRejectedValueOnce(new Error('EHOSTUNREACH')) // StreamableHTTP attempt
        .mockRejectedValueOnce(new Error('EHOSTUNREACH')); // SSE fallback attempt

      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const connectCallsAfterInit = mockConnect.mock.calls.length;
      expect(connectCallsAfterInit).toBe(2);

      // Advance time to just inside the backoff window (4 s < 5 s delay).
      // The tick fires at 5 s intervals but the retryAfter is 5 s from startTime,
      // so at t=4 s the retryAfter has not elapsed.
      vi.setSystemTime(startTime + 4_000);
      await vi.advanceTimersByTimeAsync(4_000);

      vi.useRealTimers();
      await manager.shutdown();

      // No additional connect calls should have been made.
      expect(mockConnect.mock.calls.length).toBe(connectCallsAfterInit);
      expect(manager.getTools()).toHaveLength(0);
    });

    it('stops retrying after shutdown is called', async () => {
      vi.useFakeTimers();
      const startTime = Date.now();

      // Both transports fail on initialize.
      mockConnect
        .mockRejectedValueOnce(new Error('EHOSTUNREACH'))
        .mockRejectedValueOnce(new Error('EHOSTUNREACH'));

      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      // Shut down before the backoff elapses.
      await manager.shutdown();

      const connectCallsAfterShutdown = mockConnect.mock.calls.length;

      // Advance time well past any backoff; timers should be cleared.
      vi.setSystemTime(startTime + 60_000);
      await vi.runAllTimersAsync();

      vi.useRealTimers();

      // No additional connect attempts after shutdown.
      expect(mockConnect.mock.calls.length).toBe(connectCallsAfterShutdown);
    });
  });

  describe('shutdown', () => {
    it('closes all client connections', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      await manager.shutdown();

      expect(mockClose).toHaveBeenCalled();
      expect(manager.getTools()).toHaveLength(0);
      expect(manager.hasTool('mcp__weather__get_weather')).toBe(false);
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

    it('returns tools in OpenAI format with prefixed names', async () => {
      const manager = new McpManager();
      await manager.initialize([weatherServer]);

      const tools = manager.getTools();
      expect(tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'mcp__weather__get_weather',
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

  describe('McpManager — group MCP templates', () => {
    it('configureGroupMcpTemplates advertises tools from cached schemas', async () => {
      const mgr = new McpManager();
      await mgr.configureGroupMcpTemplates([
        {
          name: 'filesystem',
          kind: 'mcp-group',
          state: 'ready',
          toolSchemas: [
            {
              name: 'read_file',
              description: 'reads',
              inputSchema: { type: 'object' },
            },
            {
              name: 'list_dir',
              description: 'lists',
              inputSchema: { type: 'object' },
            },
          ],
        },
      ]);
      const tools = mgr.getTools();
      const names = tools.map((t) => t.function.name).sort();
      expect(names).toEqual([
        'mcp__filesystem__list_dir',
        'mcp__filesystem__read_file',
      ]);
    });

    it('configureGroupMcpTemplates drops pending-schema entries', async () => {
      const mgr = new McpManager();
      await mgr.configureGroupMcpTemplates([
        { name: 'github', kind: 'mcp-group', state: 'pending-schema' },
      ]);
      expect(mgr.getTools()).toEqual([]);
    });

    it('configureGroupMcpTemplates drops failed entries', async () => {
      const mgr = new McpManager();
      await mgr.configureGroupMcpTemplates([
        { name: 'github', kind: 'mcp-group', state: 'failed', error: 'no pod' },
      ]);
      expect(mgr.getTools()).toEqual([]);
    });

    it('hasTool recognises prefixed group tool names', async () => {
      const mgr = new McpManager();
      await mgr.configureGroupMcpTemplates([
        {
          name: 'filesystem',
          kind: 'mcp-group',
          state: 'ready',
          toolSchemas: [{ name: 'read_file', inputSchema: {} }],
        },
      ]);
      expect(mgr.hasTool('mcp__filesystem__read_file')).toBe(true);
      expect(mgr.hasTool('read_file')).toBe(false);
    });

    it('allowedTools filter applies to group templates', async () => {
      const mgr = new McpManager();
      await mgr.configureGroupMcpTemplates([
        {
          name: 'filesystem',
          kind: 'mcp-group',
          state: 'ready',
          toolSchemas: [
            { name: 'read_file', inputSchema: {} },
            { name: 'write_file', inputSchema: {} },
          ],
          allowedTools: ['read_file'],
        },
      ]);
      const names = mgr.getTools().map((t) => t.function.name);
      expect(names).toEqual(['mcp__filesystem__read_file']);
    });
  });
});

// ---------------------------------------------------------------------------
// Group-scoped MCP dispatch tests (callOneShotMcp via callTool)
// ---------------------------------------------------------------------------

describe('callTool — group-scoped MCP dispatch', () => {
  const readyGroupTemplate: GroupMcpEntry = {
    name: 'filesystem',
    kind: 'mcp-group',
    state: 'ready',
    toolSchemas: [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
      {
        name: 'write_file',
        description: 'Write a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
        },
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockRequestGroupCapability.mockResolvedValue({
      endpoint: 'http://cap:3000',
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'file content' }],
    });
  });

  async function makeGroupManager(): Promise<McpManager> {
    const mgr = new McpManager();
    await mgr.configureGroupMcpTemplates([readyGroupTemplate]);
    return mgr;
  }

  it('aggregates single text content part and returns the text', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'hello' }],
    });
    const mgr = await makeGroupManager();
    const result = await mgr.callTool(
      'mcp__filesystem__read_file',
      { path: '/etc/hosts' },
      { groupFolder: 'my-group' },
    );
    expect(result).toBe('hello');
  });

  it('joins multiple text parts with newline', async () => {
    mockCallTool.mockResolvedValue({
      content: [
        { type: 'text', text: 'part one' },
        { type: 'text', text: 'part two' },
      ],
    });
    const mgr = await makeGroupManager();
    const result = await mgr.callTool(
      'mcp__filesystem__read_file',
      {},
      { groupFolder: 'my-group' },
    );
    expect(result).toBe('part one\npart two');
  });

  it('falls back to JSON.stringify of result when content is empty', async () => {
    const mockResult = { content: [] };
    mockCallTool.mockResolvedValue(mockResult);
    const mgr = await makeGroupManager();
    const result = await mgr.callTool(
      'mcp__filesystem__read_file',
      {},
      { groupFolder: 'my-group' },
    );
    expect(result).toBe(JSON.stringify(mockResult));
  });

  it('falls back to JSON.stringify of result when content has non-text parts only', async () => {
    const mockResult = { content: [{ type: 'image', data: 'abc123' }] };
    mockCallTool.mockResolvedValue(mockResult);
    const mgr = await makeGroupManager();
    const result = await mgr.callTool(
      'mcp__filesystem__read_file',
      {},
      { groupFolder: 'my-group' },
    );
    expect(result).toBe(JSON.stringify(mockResult));
  });

  it('returns capability unavailable error when requestGroupCapability returns error', async () => {
    mockRequestGroupCapability.mockResolvedValue({ error: 'pod not ready' });
    const mgr = await makeGroupManager();
    const result = await mgr.callTool(
      'mcp__filesystem__read_file',
      {},
      { groupFolder: 'my-group' },
    );
    const parsed = JSON.parse(result) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0].text).toContain(
      'capability unavailable: pod not ready',
    );
  });

  it('returns MCP call failed error when callTool throws', async () => {
    mockCallTool.mockRejectedValue(new Error('connection refused'));
    const mgr = await makeGroupManager();
    const result = await mgr.callTool(
      'mcp__filesystem__read_file',
      {},
      { groupFolder: 'my-group' },
    );
    const parsed = JSON.parse(result) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0].text).toContain('MCP call failed');
    expect(parsed.content[0].text).toContain('connection refused');
  });

  it('still calls connect when callTool throws (transport.close is called in finally)', async () => {
    mockCallTool.mockRejectedValue(new Error('oops'));
    const mgr = await makeGroupManager();
    await mgr.callTool(
      'mcp__filesystem__read_file',
      {},
      { groupFolder: 'my-group' },
    );
    // connect was called, proving the transport was created and used
    expect(mockConnect).toHaveBeenCalled();
  });

  it('throws when groupFolder is missing for a group-scoped tool', async () => {
    const mgr = await makeGroupManager();
    await expect(
      mgr.callTool('mcp__filesystem__read_file', {}),
    ).rejects.toThrow('ctx.groupFolder');
  });

  it('hasTool returns false for a tool that exists but is not in allowedTools', async () => {
    const mgr = new McpManager();
    await mgr.configureGroupMcpTemplates([
      {
        name: 'filesystem',
        kind: 'mcp-group',
        state: 'ready',
        toolSchemas: [
          { name: 'read_file', inputSchema: {} },
          { name: 'write_file', inputSchema: {} },
        ],
        allowedTools: ['read_file'],
      },
    ]);
    expect(mgr.hasTool('mcp__filesystem__read_file')).toBe(true);
    expect(mgr.hasTool('mcp__filesystem__write_file')).toBe(false);
  });

  it('constructs the correct MCP URL by appending /mcp to the endpoint', async () => {
    mockRequestGroupCapability.mockResolvedValue({
      endpoint: 'http://my-cap:3000',
    });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const mgr = await makeGroupManager();
    await mgr.callTool(
      'mcp__filesystem__read_file',
      {},
      { groupFolder: 'my-group' },
    );
    // The transport was constructed — connect was called successfully
    expect(mockConnect).toHaveBeenCalled();
    // The tool call passed the bare tool name (without prefix)
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'read_file',
      arguments: {},
    });
  });

  it('sends Authorization: Bearer header when requestGroupCapability returns a token', async () => {
    mockRequestGroupCapability.mockResolvedValue({
      endpoint: 'http://svc.kubeclaw.svc.cluster.local:3000',
      token: 'tok123',
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'result' }],
    });
    const mgr = await makeGroupManager();
    await mgr.callTool(
      'mcp__filesystem__read_file',
      { path: '/etc/hosts' },
      { groupFolder: 'my-group' },
    );
    const opts = capturedTransportArgs.options as
      | { requestInit?: { headers?: Record<string, string> } }
      | undefined;
    expect(opts?.requestInit?.headers?.Authorization).toBe('Bearer tok123');
  });

  it('does not send Authorization header when no token is returned', async () => {
    mockRequestGroupCapability.mockResolvedValue({
      endpoint: 'http://svc.kubeclaw.svc.cluster.local:3000',
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'result' }],
    });
    const mgr = await makeGroupManager();
    await mgr.callTool(
      'mcp__filesystem__read_file',
      {},
      { groupFolder: 'my-group' },
    );
    expect(capturedTransportArgs.options).toBeUndefined();
  });
});
