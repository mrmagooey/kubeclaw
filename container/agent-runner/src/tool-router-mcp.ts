/**
 * Tool Router MCP Server
 * Proxies tool calls from the Claude agent to category pods via Redis Streams.
 * Runs as a stdio MCP server alongside the nanoclaw MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createClient, RedisClientType } from 'redis';
import { randomUUID } from 'crypto';

const agentJobId = process.env.NANOCLAW_JOB_ID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const redisUrl = process.env.REDIS_URL || 'redis://nanoclaw-redis:6379';

// How long to wait for a tool result before giving up (ms)
const TOOL_CALL_TIMEOUT = 120_000;

function log(msg: string): void {
  console.error(`[tool-router-mcp] ${msg}`);
}

// Redis client for tool call/result streams
let redis: RedisClientType | null = null;

async function getRedis(): Promise<RedisClientType> {
  if (!redis) {
    redis = createClient({ url: redisUrl }) as RedisClientType;
    redis.on('error', (err) => log(`Redis error: ${err.message}`));
    await redis.connect();
    log('Redis connected');
  }
  return redis;
}

// Dedup map: category -> Promise<void> (resolves when pod is ready)
const categoryReady = new Map<string, Promise<void>>();

async function ensurePodReady(category: 'execution' | 'browser'): Promise<void> {
  if (categoryReady.has(category)) {
    return categoryReady.get(category)!;
  }

  const promise = (async () => {
    const r = await getRedis();
    const taskChannel = `nanoclaw:tasks:${groupFolder}`;
    const inputStream = `nanoclaw:input:${agentJobId}`;

    log(`Requesting ${category} pod`);
    await r.publish(taskChannel, JSON.stringify({
      type: 'tool_pod_request',
      agentJobId,
      category,
      groupFolder,
    }));

    // Wait for ack on input stream
    log(`Waiting for tool_pod_ack (category=${category})`);
    let lastId = '$';
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await r.xRead(
        [{ key: inputStream, id: lastId }],
        { BLOCK: 5000, COUNT: 10 },
      );
      if (!response?.length) continue;
      for (const stream of response) {
        for (const message of stream.messages) {
          lastId = message.id;
          const fields = message.message as Record<string, string>;
          if (fields.type === 'tool_pod_ack' && fields.category === category) {
            log(`Got ack for ${category} pod: ${fields.podJobId}`);
            return;
          }
        }
      }
    }
    throw new Error(`Timeout waiting for ${category} pod ack`);
  })();

  categoryReady.set(category, promise);
  return promise;
}

async function callTool(
  category: 'execution' | 'browser',
  tool: string,
  input: Record<string, unknown>,
): Promise<string> {
  await ensurePodReady(category);

  const r = await getRedis();
  const requestId = randomUUID();
  const callsStream = `nanoclaw:toolcalls:${agentJobId}:${category}`;
  const resultsStream = `nanoclaw:toolresults:${agentJobId}:${category}`;

  await r.xAdd(callsStream, '*', {
    requestId,
    tool,
    input: JSON.stringify(input),
  });

  // Poll results stream for matching requestId
  const deadline = Date.now() + TOOL_CALL_TIMEOUT;
  let lastId = '$';
  while (Date.now() < deadline) {
    const response = await r.xRead(
      [{ key: resultsStream, id: lastId }],
      { BLOCK: 5000, COUNT: 10 },
    );
    if (!response?.length) continue;
    for (const stream of response) {
      for (const message of stream.messages) {
        lastId = message.id;
        const fields = message.message as Record<string, string>;
        if (fields.requestId === requestId) {
          if (fields.error) throw new Error(fields.error);
          return fields.result ?? 'null';
        }
      }
    }
  }
  throw new Error(`Timeout waiting for tool result: ${tool} (${requestId})`);
}

// --- MCP Server ---

const server = new McpServer({ name: 'toolrouter', version: '1.0.0' });

// Execution tools
server.tool('bash', 'Run a bash command', {
  command: z.string(),
  timeout: z.number().optional(),
}, async (args) => {
  const result = await callTool('execution', 'bash', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('read', 'Read a file', {
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
}, async (args) => {
  const result = await callTool('execution', 'read', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('write', 'Write a file', {
  file_path: z.string(),
  content: z.string(),
}, async (args) => {
  const result = await callTool('execution', 'write', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('edit', 'Edit a file', {
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
}, async (args) => {
  const result = await callTool('execution', 'edit', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('glob', 'Find files by pattern', {
  pattern: z.string(),
  path: z.string().optional(),
}, async (args) => {
  const result = await callTool('execution', 'glob', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('grep', 'Search file contents', {
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  output_mode: z.string().optional(),
}, async (args) => {
  const result = await callTool('execution', 'grep', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('todoWrite', 'Write todos', {
  todos: z.array(z.object({
    id: z.string(),
    content: z.string(),
    status: z.string(),
    priority: z.string(),
  })),
}, async (args) => {
  const result = await callTool('execution', 'todoWrite', args as any);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('notebookEdit', 'Edit a notebook cell', {
  notebook_path: z.string(),
  cell_id: z.string(),
  new_source: z.string(),
}, async (args) => {
  const result = await callTool('execution', 'notebookEdit', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

// Browser tools
server.tool('webSearch', 'Search the web', {
  query: z.string(),
}, async (args) => {
  const result = await callTool('browser', 'webSearch', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('webFetch', 'Fetch a URL', {
  url: z.string(),
  prompt: z.string().optional(),
}, async (args) => {
  const result = await callTool('browser', 'webFetch', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('agentBrowser', 'Run browser automation', {
  command: z.string(),
}, async (args) => {
  const result = await callTool('browser', 'agentBrowser', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('task', 'Schedule a task', {
  prompt: z.string(),
  schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
  schedule_value: z.string().optional(),
  context_mode: z.enum(['group', 'isolated']).optional(),
  target_group_jid: z.string().optional(),
}, async (args) => {
  const result = await callTool('browser', 'task', args as any);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('taskOutput', 'Get task output', {
  task_id: z.string(),
}, async (args) => {
  const result = await callTool('browser', 'taskOutput', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

server.tool('taskStop', 'Stop a task', {
  task_id: z.string(),
}, async (args) => {
  const result = await callTool('browser', 'taskStop', args);
  return { content: [{ type: 'text' as const, text: JSON.parse(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
