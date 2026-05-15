/**
 * MCP Client Manager for channel pods.
 *
 * Connects to remote MCP server pods over HTTP, discovers their tools,
 * converts them to OpenAI function-calling format, and routes tool calls
 * to the correct MCP server.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type OpenAI from 'openai';

import { logger } from '../logger.js';
import type { McpServerStatus } from '../types.js';

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  tools: OpenAI.ChatCompletionTool[];
}

/** Tracks a server that failed to connect with backoff state. */
interface FailedServer {
  status: McpServerStatus;
  /** Monotonically increasing retry count (0 = never connected). */
  retries: number;
  /** Timestamp (ms) after which the next retry is allowed. */
  retryAfter: number;
}

/** Backoff schedule: index = retry number, value = delay in ms (capped at 30 s). */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

function nextRetryDelay(retries: number): number {
  return RETRY_DELAYS_MS[Math.min(retries, RETRY_DELAYS_MS.length - 1)];
}

function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  for (const pattern of allowedTools) {
    if (pattern === toolName) return true;
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(toolName)) return true;
    }
  }
  return false;
}

/** Interval (ms) between background retry ticks. */
const RETRY_TICK_INTERVAL_MS = 5_000;

export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  private toolToServer = new Map<string, string>();
  /** Servers that failed to connect and are waiting for a retry window. */
  private failedServers = new Map<string, FailedServer>();
  /** Background timer that retries failed servers without waiting for reconfigure(). */
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Connect to MCP servers and discover their tools.
   * Starts the background retry tick so failed servers are retried automatically.
   */
  async initialize(serverStatuses: McpServerStatus[]): Promise<void> {
    for (const status of serverStatuses) {
      try {
        await this.connectServer(status);
      } catch (err) {
        logger.warn(
          { server: status.name, url: status.url, err },
          'Failed to connect to MCP server, skipping',
        );
        this.failedServers.set(status.name, {
          status,
          retries: 0,
          retryAfter: Date.now() + nextRetryDelay(0),
        });
      }
    }
    this.startRetryTick();
  }

  /**
   * Reconfigure: disconnect removed servers, connect new ones, and retry
   * previously-failed servers whose backoff window has elapsed.
   */
  async reconfigure(serverStatuses: McpServerStatus[]): Promise<void> {
    const newNames = new Set(serverStatuses.map((s) => s.name));

    // Disconnect servers that are no longer in the list
    for (const [name, server] of this.servers) {
      if (!newNames.has(name)) {
        logger.info({ server: name }, 'Disconnecting removed MCP server');
        await this.disconnectServer(server);
        this.servers.delete(name);
        // Remove tool mappings for this server
        for (const [tool, sName] of this.toolToServer) {
          if (sName === name) this.toolToServer.delete(tool);
        }
      }
    }

    // Remove failed-server entries that are no longer requested
    for (const name of this.failedServers.keys()) {
      if (!newNames.has(name)) {
        this.failedServers.delete(name);
      }
    }

    const now = Date.now();

    // Connect new servers, and retry failed servers whose backoff has elapsed
    for (const status of serverStatuses) {
      if (this.servers.has(status.name)) {
        // Already connected — nothing to do.
        continue;
      }

      const failed = this.failedServers.get(status.name);
      if (failed && now < failed.retryAfter) {
        // Still within the backoff window — skip.
        logger.debug(
          {
            server: status.name,
            retryAfter: new Date(failed.retryAfter).toISOString(),
            retries: failed.retries,
          },
          'MCP server in backoff, skipping retry',
        );
        continue;
      }

      try {
        await this.connectServer(status);
        // Success: clear any previous failure record.
        this.failedServers.delete(status.name);
      } catch (err) {
        const retries = (failed?.retries ?? 0) + 1;
        const delay = nextRetryDelay(retries);
        logger.warn(
          {
            server: status.name,
            url: status.url,
            err,
            retries,
            nextRetryInMs: delay,
          },
          'Failed to connect to MCP server during reconfigure, will retry',
        );
        this.failedServers.set(status.name, {
          status,
          retries,
          retryAfter: now + delay,
        });
      }
    }
  }

  /**
   * Get all discovered tools in OpenAI format.
   */
  getTools(): OpenAI.ChatCompletionTool[] {
    const tools: OpenAI.ChatCompletionTool[] = [];
    for (const server of this.servers.values()) {
      tools.push(...server.tools);
    }
    return tools;
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  hasTool(toolName: string): boolean {
    return this.toolToServer.has(toolName);
  }

  /**
   * Execute a tool call, routing to the correct MCP server.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const serverName = this.toolToServer.get(toolName);
    if (!serverName) return `Unknown MCP tool: ${toolName}`;

    const server = this.servers.get(serverName);
    if (!server) return `MCP server "${serverName}" not connected`;

    try {
      const result = await server.client.callTool({
        name: toolName,
        arguments: args,
      });

      const content = result.content || [];
      const textParts = (content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '');

      return textParts.join('\n') || 'Tool returned no text output';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `MCP tool error (${toolName}): ${msg}`;
    }
  }

  /**
   * Shut down all connections and stop background retries.
   */
  async shutdown(): Promise<void> {
    this.stopRetryTick();
    for (const server of this.servers.values()) {
      await this.disconnectServer(server);
    }
    this.servers.clear();
    this.toolToServer.clear();
    this.failedServers.clear();
  }

  /** Start background retry tick (idempotent — does nothing if already running). */
  private startRetryTick(): void {
    if (this.retryTimer !== null) return;
    const timer = setInterval(async () => {
      await this.tickRetries();
    }, RETRY_TICK_INTERVAL_MS);
    // Don't keep the process alive solely for retries.
    timer.unref();
    this.retryTimer = timer;
  }

  /** Stop the background retry tick. */
  private stopRetryTick(): void {
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * On each tick, attempt to reconnect failed servers whose backoff has elapsed.
   * Operates on a snapshot of failedServers keys to avoid mutation-during-iteration issues.
   */
  private async tickRetries(): Promise<void> {
    if (this.failedServers.size === 0) return;
    const now = Date.now();
    // Snapshot the keys so we don't iterate over a map we may mutate.
    const names = Array.from(this.failedServers.keys());
    for (const name of names) {
      const failed = this.failedServers.get(name);
      if (!failed || now < failed.retryAfter) continue;
      try {
        await this.connectServer(failed.status);
        // Success: remove from failed set.
        this.failedServers.delete(name);
        logger.debug(
          { server: name },
          'MCP server reconnected via background retry tick',
        );
      } catch (err) {
        const retries = failed.retries + 1;
        const delay = nextRetryDelay(retries);
        logger.warn(
          {
            server: name,
            url: failed.status.url,
            err,
            retries,
            nextRetryInMs: delay,
          },
          'Background retry tick: failed to connect to MCP server, will retry',
        );
        this.failedServers.set(name, {
          status: failed.status,
          retries,
          retryAfter: Date.now() + delay,
        });
      }
    }
  }

  private async connectServer(status: McpServerStatus): Promise<void> {
    const url = new URL(status.url);
    const client = new Client({
      name: `kubeclaw-${status.name}`,
      version: '1.0.0',
    });

    let transport: StreamableHTTPClientTransport | SSEClientTransport;

    try {
      // Try Streamable HTTP first (modern MCP servers)
      transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
    } catch {
      // Fall back to SSE transport (legacy MCP servers)
      const sseClient = new Client({
        name: `kubeclaw-${status.name}`,
        version: '1.0.0',
      });
      transport = new SSEClientTransport(url);
      await sseClient.connect(transport);
      // Use the SSE client instead
      await this.discoverAndRegister(status, sseClient, transport);
      return;
    }

    await this.discoverAndRegister(status, client, transport);
  }

  private async discoverAndRegister(
    status: McpServerStatus,
    client: Client,
    transport: StreamableHTTPClientTransport | SSEClientTransport,
  ): Promise<void> {
    // Discover tools
    const toolsResponse = await client.listTools();
    const allTools = toolsResponse.tools || [];

    const tools: OpenAI.ChatCompletionTool[] = [];
    for (const tool of allTools) {
      // Apply allowedTools filter
      if (
        status.allowedTools?.length &&
        !isToolAllowed(tool.name, status.allowedTools)
      ) {
        continue;
      }

      // Check for name collision with existing tools
      if (this.toolToServer.has(tool.name)) {
        logger.warn(
          {
            tool: tool.name,
            server: status.name,
            existingServer: this.toolToServer.get(tool.name),
          },
          'MCP tool name collision, skipping (first server wins)',
        );
        continue;
      }

      this.toolToServer.set(tool.name, status.name);
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || `Execute ${tool.name}`,
          parameters: (tool.inputSchema as Record<string, unknown>) || {
            type: 'object',
            properties: {},
          },
        },
      });
    }

    this.servers.set(status.name, {
      name: status.name,
      client,
      transport,
      tools,
    });
    logger.info(
      {
        server: status.name,
        toolCount: tools.length,
        totalDiscovered: allTools.length,
      },
      'Connected to MCP server',
    );
  }

  private async disconnectServer(server: ConnectedServer): Promise<void> {
    try {
      await server.client.close();
    } catch (err) {
      logger.warn(
        { server: server.name, err },
        'Error disconnecting MCP server',
      );
    }
  }
}
