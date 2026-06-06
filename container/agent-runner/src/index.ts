/**
 * KubeClaw Agent Runner
 * Uses pi-agent-core for the agentic loop. No hand-rolled tool dispatch.
 *
 * Input protocol:
 *   ContainerInput JSON piped to stdin (built by entrypoint.sh from env vars)
 *
 * Output protocol:
 *   Each result wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs on stdout
 *   In K8s mode: also published to Redis kubeclaw:messages:${groupFolder}
 *
 * Tool calls: all routed via Redis streams to tool pods.
 *   Execution tools (bash, read, write, edit, glob, grep):
 *     → kubeclaw:toolcalls:{jobId}:execution → tool pod → kubeclaw:toolresults:{jobId}:execution
 *   Browser tools (web_fetch, web_search, agent_browser):
 *     → kubeclaw:toolcalls:{jobId}:browser → tool pod → kubeclaw:toolresults:{jobId}:browser
 *   IPC tools (send_message, schedule_task, …):
 *     → Redis pub/sub directly, no tool pod needed
 *
 * Superuser mode (KUBECLAW_SUPERUSER=true):
 *   Adds local_bash, local_read, local_write, local_edit tools that run directly
 *   in this process. Only set by the orchestrator for privileged groups.
 *
 * Follow-up messages: read from kubeclaw:input:{jobId} Redis stream.
 *   No filesystem IPC polling.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentTool, AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { Type, streamSimple } from '@mariozechner/pi-ai';
import type { Model, Api } from '@mariozechner/pi-ai';
import { createClient, RedisClientType } from 'redis';
import { CronExpressionParser } from 'cron-parser';
import { RedisIPCClient } from './redis/ipc-client.js';

const execFileAsync = promisify(execFile);

// ---- Input / Output protocol ----

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---KUBECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---KUBECLAW_OUTPUT_END---';

let redisIpcClient: RedisIPCClient | null = null;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
  if (redisIpcClient) {
    redisIpcClient.sendOutput(output).catch((err) => {
      log(`Warning: failed to publish output to Redis: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

// ---- Stdin ----

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ---- Conversation history ----

const HISTORY_FILE = '/workspace/group/.conversation.json';
const MAX_HISTORY_MESSAGES = parseInt(process.env.KUBECLAW_HISTORY_MAX || '100', 10);

interface ConversationHistory {
  messages: AgentMessage[];
  updatedAt: string;
}

/**
 * Load conversation history, migrating from OpenAI format if needed.
 * OpenAI format uses role: 'user'|'assistant'|'system'|'tool' with string content.
 * AgentMessage uses role: 'user'|'assistant'|'toolResult' with structured content.
 */
function loadHistory(): AgentMessage[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    const messages: unknown[] = raw.messages ?? [];
    if (messages.length === 0) return [];

    // Detect OpenAI format: first non-system message has string content or role 'tool'
    const first = messages.find((m: any) => m.role !== 'system') as any;
    if (first && (typeof first.content === 'string' || first.role === 'tool')) {
      return migrateOpenAIHistory(messages as OpenAIMessage[]);
    }

    return messages as AgentMessage[];
  } catch {
    return [];
  }
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function migrateOpenAIHistory(messages: OpenAIMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  const now = Date.now();

  for (const msg of messages) {
    if (msg.role === 'system') continue; // system prompts are not stored in AgentMessage history

    if (msg.role === 'user') {
      result.push({
        role: 'user',
        content: typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : msg.content || '',
        timestamp: now,
      });
    } else if (msg.role === 'assistant') {
      const content: Array<{ type: 'text'; text: string } | { type: 'toolCall'; id: string; name: string; arguments: Record<string, any> }> = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, any> = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
          content.push({
            type: 'toolCall',
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          });
        }
      }
      result.push({
        role: 'assistant',
        content,
        api: 'openai-completions' as Api,
        provider: 'openai',
        model: 'unknown',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: msg.tool_calls?.length ? 'toolUse' : 'stop',
        timestamp: now,
      });
    } else if (msg.role === 'tool') {
      result.push({
        role: 'toolResult',
        toolCallId: msg.tool_call_id || '',
        toolName: 'unknown',
        content: [{ type: 'text', text: msg.content || '' }],
        isError: false,
        timestamp: now,
      });
    }
  }
  return result;
}

function saveHistory(messages: AgentMessage[]): void {
  try {
    // Filter out system-level or non-standard messages, keep user/assistant/toolResult
    const saveable = messages.filter((m) =>
      m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'
    );
    const capped = saveable.slice(-MAX_HISTORY_MESSAGES);
    const data: ConversationHistory = { messages: capped, updatedAt: new Date().toISOString() };
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Warning: failed to save history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- System prompt ----

function loadSystemPrompt(assistantName?: string): string {
  const parts: string[] = [];

  // Per-group instructions
  try {
    const groupMd = fs.readFileSync('/workspace/group/CLAUDE.md', 'utf-8').trim();
    if (groupMd) parts.push(groupMd);
  } catch { /* not present */ }

  // Global instructions
  try {
    if (!parts.length) {
      const globalMd = fs.readFileSync('/workspace/global/CLAUDE.md', 'utf-8').trim();
      if (globalMd) parts.push(globalMd);
    }
  } catch { /* not present */ }

  if (parts.length === 0) {
    const name = assistantName || 'the assistant';
    return `You are ${name}, a helpful assistant. Be concise and direct.`;
  }

  return parts.join('\n\n');
}

// ---- Input stream manager ----

interface InputEntry {
  type: string;
  text?: string;
  category?: string;
  podJobId?: string;
}

class InputStreamManager {
  private lastId = '0-0';
  private queue: InputEntry[] = [];
  private redis: RedisClientType;
  private streamKey: string;

  constructor(redis: RedisClientType, jobId: string) {
    this.redis = redis;
    this.streamKey = `kubeclaw:input:${jobId}`;
  }

  async poll(): Promise<void> {
    try {
      const response = await (this.redis as any).xRead(
        [{ key: this.streamKey, id: this.lastId }],
        { COUNT: 100 },
      );
      this._enqueue(response);
    } catch { /* ignore */ }
  }

  async blockPoll(timeoutMs: number): Promise<void> {
    try {
      const response = await (this.redis as any).xRead(
        [{ key: this.streamKey, id: this.lastId }],
        { BLOCK: Math.max(100, timeoutMs), COUNT: 100 },
      );
      this._enqueue(response);
    } catch { /* ignore */ }
  }

  drainUserMessages(): string[] {
    const msgs: string[] = [];
    const remaining: InputEntry[] = [];
    for (const entry of this.queue) {
      if (entry.type === 'message' && entry.text) msgs.push(entry.text);
      else remaining.push(entry);
    }
    this.queue = remaining;
    return msgs;
  }

  hasCloseSignal(): boolean {
    return this.queue.some((e) => e.type === 'close');
  }

  async waitForToolPodAck(category: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = this.queue.findIndex(
        (e) => e.type === 'tool_pod_ack' && e.category === category,
      );
      if (idx >= 0) {
        const [ack] = this.queue.splice(idx, 1);
        return ack.podJobId ?? '';
      }
      const blockMs = Math.min(deadline - Date.now(), 5000);
      if (blockMs <= 0) break;
      await this.blockPoll(blockMs);
    }
    throw new Error(`Timeout waiting for tool_pod_ack for category=${category}`);
  }

  private _enqueue(response: any): void {
    if (!response?.length) return;
    for (const stream of response) {
      for (const msg of (stream as any).messages ?? []) {
        this.lastId = msg.id;
        const f = msg.message as Record<string, string>;
        this.queue.push({
          type: f.type || '',
          text: f.text,
          category: f.category,
          podJobId: f.podJobId,
        });
      }
    }
  }
}

// ---- Tool pod dispatch ----

const TOOL_CATEGORY: Record<string, 'execution' | 'browser'> = {
  bash: 'execution',
  read: 'execution',
  write: 'execution',
  edit: 'execution',
  glob: 'execution',
  grep: 'execution',
  web_fetch: 'browser',
  web_search: 'browser',
  agent_browser: 'browser',
};

const TOOL_SERVER_NAME: Record<string, string> = {
  web_fetch: 'webFetch',
  web_search: 'webSearch',
  agent_browser: 'agentBrowser',
};

const TOOL_CALL_TIMEOUT = 120_000;
const POD_ACK_TIMEOUT = 60_000;

async function callToolViaRedis(
  redis: RedisClientType,
  inputStream: InputStreamManager,
  agentJobId: string,
  groupFolder: string,
  toolName: string,
  args: Record<string, unknown>,
  podReadyMap: Map<string, boolean>,
): Promise<string> {
  const category = TOOL_CATEGORY[toolName];
  if (!category) return `Unknown tool: ${toolName}`;

  const serverName = TOOL_SERVER_NAME[toolName] ?? toolName;

  if (!podReadyMap.get(category)) {
    const taskChannel = `kubeclaw:tasks:${groupFolder}`;
    await (redis as any).publish(taskChannel, JSON.stringify({
      type: 'tool_pod_request',
      agentJobId,
      category,
      groupFolder,
    }));
    log(`Requested ${category} tool pod`);
    await inputStream.waitForToolPodAck(category, POD_ACK_TIMEOUT);
    podReadyMap.set(category, true);
    log(`${category} tool pod ready`);
  }

  const requestId = randomUUID();
  const callsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
  const resultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

  await (redis as any).xAdd(callsStream, '*', {
    requestId,
    tool: serverName,
    input: JSON.stringify(args),
  });

  const deadline = Date.now() + TOOL_CALL_TIMEOUT;
  let lastId = '$';

  while (Date.now() < deadline) {
    const blockMs = Math.min(deadline - Date.now(), 5000);
    const response = await (redis as any).xRead(
      [{ key: resultsStream, id: lastId }],
      { BLOCK: blockMs, COUNT: 10 },
    );
    if (!response?.length) continue;
    for (const stream of response) {
      for (const msg of (stream as any).messages ?? []) {
        lastId = msg.id;
        const f = msg.message as Record<string, string>;
        if (f.requestId !== requestId) continue;
        if (f.error) return `Tool error: ${f.error}`;
        try {
          const parsed = JSON.parse(f.result ?? 'null');
          return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
        } catch {
          return f.result ?? '';
        }
      }
    }
  }
  return `Tool timed out after ${TOOL_CALL_TIMEOUT / 1000}s`;
}

// ---- IPC tool handlers ----

async function handleSendMessage(
  redis: RedisClientType,
  groupFolder: string,
  chatJid: string,
  args: Record<string, unknown>,
): Promise<string> {
  const text = String(args.text ?? '');
  const sender = args.sender ? String(args.sender) : undefined;
  await (redis as any).publish(
    `kubeclaw:messages:${groupFolder}`,
    JSON.stringify({ type: 'message', chatJid, text, sender, groupFolder, timestamp: new Date().toISOString() }),
  );
  return 'Message sent.';
}

async function handleScheduleTask(
  redis: RedisClientType,
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
  args: Record<string, unknown>,
): Promise<string> {
  const scheduleType = String(args.schedule_type ?? 'once') as 'cron' | 'interval' | 'once';
  const scheduleValue = String(args.schedule_value ?? '');

  if (scheduleType === 'cron') {
    try { CronExpressionParser.parse(scheduleValue); }
    catch { return `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *".`; }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) return `Invalid interval: "${scheduleValue}". Must be positive milliseconds.`;
  } else if (scheduleType === 'once') {
    if (/[Zz]$/.test(scheduleValue) || /[+-]\d{2}:\d{2}$/.test(scheduleValue)) {
      return `Timestamp must be local time without timezone suffix. Got "${scheduleValue}".`;
    }
    if (isNaN(new Date(scheduleValue).getTime())) {
      return `Invalid timestamp: "${scheduleValue}". Use local time like "2026-02-01T15:30:00".`;
    }
  }

  const targetJid = isMain && args.target_group_jid ? String(args.target_group_jid) : chatJid;
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await (redis as any).publish(
    `kubeclaw:tasks:${groupFolder}`,
    JSON.stringify({
      type: 'schedule_task',
      taskId,
      prompt: String(args.prompt ?? ''),
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: String(args.context_mode ?? 'group'),
      targetJid,
      groupFolder,
      isMain,
    }),
  );
  return `Task ${taskId} scheduled: ${scheduleType} - ${scheduleValue}`;
}

function handleListTasks(groupFolder: string, isMain: boolean): string {
  const tasksFile = '/workspace/ipc/current_tasks.json';
  try {
    if (!fs.existsSync(tasksFile)) return 'No scheduled tasks found.';
    const all: any[] = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    const tasks = isMain ? all : all.filter((t) => t.groupFolder === groupFolder);
    if (tasks.length === 0) return 'No scheduled tasks found.';
    return 'Scheduled tasks:\n' + tasks.map((t) =>
      `- [${t.id}] ${String(t.prompt).slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
    ).join('\n');
  } catch (err) {
    return `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleTaskLifecycle(
  redis: RedisClientType,
  groupFolder: string,
  isMain: boolean,
  type: string,
  args: Record<string, unknown>,
): Promise<string> {
  await (redis as any).publish(
    `kubeclaw:tasks:${groupFolder}`,
    JSON.stringify({ type, taskId: String(args.task_id ?? ''), groupFolder, isMain }),
  );
  return `Task ${args.task_id} ${type.replace('_task', '')} requested.`;
}

async function handleUpdateTask(
  redis: RedisClientType,
  groupFolder: string,
  isMain: boolean,
  args: Record<string, unknown>,
): Promise<string> {
  const payload: Record<string, unknown> = {
    type: 'update_task',
    taskId: String(args.task_id ?? ''),
    groupFolder,
    isMain,
  };
  if (args.prompt !== undefined) payload.prompt = args.prompt;
  if (args.schedule_type !== undefined) payload.schedule_type = args.schedule_type;
  if (args.schedule_value !== undefined) payload.schedule_value = args.schedule_value;

  await (redis as any).publish(`kubeclaw:tasks:${groupFolder}`, JSON.stringify(payload));
  return `Task ${args.task_id} update requested.`;
}

async function handleRegisterGroup(
  redis: RedisClientType,
  groupFolder: string,
  isMain: boolean,
  args: Record<string, unknown>,
): Promise<string> {
  if (!isMain) return 'Only the main group can register new groups.';
  await (redis as any).publish(
    `kubeclaw:tasks:${groupFolder}`,
    JSON.stringify({
      type: 'register_group',
      jid: String(args.jid ?? ''),
      name: String(args.name ?? ''),
      folder: String(args.folder ?? ''),
      trigger: String(args.trigger ?? ''),
      groupFolder,
      isMain,
    }),
  );
  return `Group "${args.name}" registered.`;
}

// ---- Superuser local tools ----

async function localBash(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? '');
  const timeout = typeof args.timeout === 'number' ? args.timeout : 30_000;
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
  } catch (err: any) {
    return `Error: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
  }
}

function localRead(args: Record<string, unknown>): string {
  const filePath = String(args.file_path ?? '');
  const offset = typeof args.offset === 'number' ? args.offset : 0;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const slice = limit !== undefined ? lines.slice(offset, offset + limit) : lines.slice(offset);
    return slice.map((l, i) => `${offset + i + 1}\t${l}`).join('\n');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function localWrite(args: Record<string, unknown>): string {
  const filePath = String(args.file_path ?? '');
  const content = String(args.content ?? '');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Written ${content.length} bytes to ${filePath}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function localEdit(args: Record<string, unknown>): string {
  const filePath = String(args.file_path ?? '');
  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  const replaceAll = args.replace_all === true;
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldStr)) return `old_string not found in ${filePath}`;
    content = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    fs.writeFileSync(filePath, content);
    return `Edited ${filePath}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---- AgentTool helpers ----

/** Create an AgentToolResult from a string. */
function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

// ---- Tool definitions (pi-agent-core AgentTool format) ----

function buildToolDefinitions(
  isSuperuser: boolean,
  isMain: boolean,
  redis: RedisClientType,
  inputStream: InputStreamManager,
  agentJobId: string,
  groupFolder: string,
  chatJid: string,
  podReadyMap: Map<string, boolean>,
): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    // Execution tools (Redis-routed)
    {
      name: 'bash',
      label: 'Bash',
      description: 'Run a bash command in the execution environment.',
      parameters: Type.Object({
        command: Type.String({ description: 'The bash command to run' }),
        timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (optional)' })),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'bash', params as Record<string, unknown>, podReadyMap),
      ),
    },
    {
      name: 'read',
      label: 'Read',
      description: 'Read a file from the workspace.',
      parameters: Type.Object({
        file_path: Type.String(),
        offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (0-based)' })),
        limit: Type.Optional(Type.Number({ description: 'Number of lines to read' })),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'read', params as Record<string, unknown>, podReadyMap),
      ),
    },
    {
      name: 'write',
      label: 'Write',
      description: 'Write content to a file in the workspace.',
      parameters: Type.Object({
        file_path: Type.String(),
        content: Type.String(),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'write', params as Record<string, unknown>, podReadyMap),
      ),
    },
    {
      name: 'edit',
      label: 'Edit',
      description: 'Replace a string in a file.',
      parameters: Type.Object({
        file_path: Type.String(),
        old_string: Type.String(),
        new_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'edit', params as Record<string, unknown>, podReadyMap),
      ),
    },
    {
      name: 'glob',
      label: 'Glob',
      description: 'Find files by glob pattern.',
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String({ description: 'Directory to search in (optional)' })),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'glob', params as Record<string, unknown>, podReadyMap),
      ),
    },
    {
      name: 'grep',
      label: 'Grep',
      description: 'Search file contents with regex.',
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        glob: Type.Optional(Type.String()),
        output_mode: Type.Optional(Type.Union([
          Type.Literal('content'),
          Type.Literal('files_with_matches'),
          Type.Literal('count'),
        ])),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'grep', params as Record<string, unknown>, podReadyMap),
      ),
    },
    // Browser tools (Redis-routed)
    {
      name: 'web_fetch',
      label: 'Web Fetch',
      description: 'Fetch the content of a URL.',
      parameters: Type.Object({
        url: Type.String(),
        prompt: Type.Optional(Type.String({ description: 'Optional focus prompt' })),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'web_fetch', params as Record<string, unknown>, podReadyMap),
      ),
    },
    {
      name: 'web_search',
      label: 'Web Search',
      description: 'Search the web.',
      parameters: Type.Object({
        query: Type.String(),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'web_search', params as Record<string, unknown>, podReadyMap),
      ),
    },
    {
      name: 'agent_browser',
      label: 'Agent Browser',
      description: 'Run browser automation with Playwright.',
      parameters: Type.Object({
        command: Type.String(),
      }),
      execute: async (_id, params) => textResult(
        await callToolViaRedis(redis, inputStream, agentJobId, groupFolder, 'agent_browser', params as Record<string, unknown>, podReadyMap),
      ),
    },
    // IPC tools
    {
      name: 'send_message',
      label: 'Send Message',
      description: 'Send a message to the user immediately while still running. Use for progress updates.',
      parameters: Type.Object({
        text: Type.String(),
        sender: Type.Optional(Type.String({ description: 'Role/identity name (optional)' })),
      }),
      execute: async (_id, params) => textResult(
        await handleSendMessage(redis, groupFolder, chatJid, params as Record<string, unknown>),
      ),
    },
    {
      name: 'schedule_task',
      label: 'Schedule Task',
      description: 'Schedule a recurring or one-time task.',
      parameters: Type.Object({
        prompt: Type.String(),
        schedule_type: Type.Union([Type.Literal('cron'), Type.Literal('interval'), Type.Literal('once')]),
        schedule_value: Type.String(),
        context_mode: Type.Optional(Type.Union([Type.Literal('group'), Type.Literal('isolated')])),
        target_group_jid: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => textResult(
        await handleScheduleTask(redis, groupFolder, chatJid, isMain, params as Record<string, unknown>),
      ),
    },
    {
      name: 'list_tasks',
      label: 'List Tasks',
      description: 'List scheduled tasks.',
      parameters: Type.Object({}),
      execute: async () => textResult(handleListTasks(groupFolder, isMain)),
    },
    {
      name: 'pause_task',
      label: 'Pause Task',
      description: 'Pause a scheduled task.',
      parameters: Type.Object({
        task_id: Type.String(),
      }),
      execute: async (_id, params) => textResult(
        await handleTaskLifecycle(redis, groupFolder, isMain, 'pause_task', params as Record<string, unknown>),
      ),
    },
    {
      name: 'resume_task',
      label: 'Resume Task',
      description: 'Resume a paused task.',
      parameters: Type.Object({
        task_id: Type.String(),
      }),
      execute: async (_id, params) => textResult(
        await handleTaskLifecycle(redis, groupFolder, isMain, 'resume_task', params as Record<string, unknown>),
      ),
    },
    {
      name: 'cancel_task',
      label: 'Cancel Task',
      description: 'Cancel and delete a scheduled task.',
      parameters: Type.Object({
        task_id: Type.String(),
      }),
      execute: async (_id, params) => textResult(
        await handleTaskLifecycle(redis, groupFolder, isMain, 'cancel_task', params as Record<string, unknown>),
      ),
    },
    {
      name: 'update_task',
      label: 'Update Task',
      description: 'Update an existing scheduled task.',
      parameters: Type.Object({
        task_id: Type.String(),
        prompt: Type.Optional(Type.String()),
        schedule_type: Type.Optional(Type.Union([Type.Literal('cron'), Type.Literal('interval'), Type.Literal('once')])),
        schedule_value: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => textResult(
        await handleUpdateTask(redis, groupFolder, isMain, params as Record<string, unknown>),
      ),
    },
  ];

  if (isMain) {
    tools.push({
      name: 'register_group',
      label: 'Register Group',
      description: 'Register a new chat/group. Main group only.',
      parameters: Type.Object({
        jid: Type.String(),
        name: Type.String(),
        folder: Type.String(),
        trigger: Type.String(),
      }),
      execute: async (_id, params) => textResult(
        await handleRegisterGroup(redis, groupFolder, isMain, params as Record<string, unknown>),
      ),
    });
    tools.push({
      name: 'deploy_channel',
      label: 'Deploy Channel',
      description: 'Ask the orchestrator to create Kubernetes resources for a new channel pod. Pass the full multi-document YAML. Main group only.',
      parameters: Type.Object({
        yamlContent: Type.String({ description: 'Multi-document Kubernetes YAML to apply (Deployment, PVC, Service)' }),
      }),
      execute: async (_id, params) => {
        if (!isMain) return textResult('deploy_channel is only available to the main group.');
        await (redis as any).publish(
          `kubeclaw:tasks:${groupFolder}`,
          JSON.stringify({ type: 'deploy_channel', yaml: String((params as any).yamlContent || ''), groupFolder }),
        );
        return textResult('Deployment request sent to orchestrator.');
      },
    });
    tools.push({
      name: 'control_channel',
      label: 'Control Channel',
      description: 'Send a control command to a running channel pod (e.g. reload to force reconnect). Main group only.',
      parameters: Type.Object({
        channelName: Type.String({ description: 'Channel pod name to control (e.g. telegram, irc, discord)' }),
        command: Type.Union([Type.Literal('reload')], { description: 'reload: disconnect and reconnect the channel' }),
      }),
      execute: async (_id, params) => {
        if (!isMain) return textResult('control_channel is only available to the main group.');
        await (redis as any).publish(
          `kubeclaw:tasks:${groupFolder}`,
          JSON.stringify({ type: 'control_channel', channelName: String((params as any).channelName || ''), command: String((params as any).command || ''), groupFolder }),
        );
        return textResult(`Control command '${(params as any).command}' sent to channel '${(params as any).channelName}'.`);
      },
    });
  }

  if (isSuperuser) {
    tools.push(
      {
        name: 'local_bash',
        label: 'Local Bash',
        description: 'Run a bash command directly in this container (superuser mode). Use to install packages, modify agent code, or perform system-level setup.',
        parameters: Type.Object({
          command: Type.String(),
          timeout: Type.Optional(Type.Number()),
        }),
        execute: async (_id, params) => textResult(await localBash(params as Record<string, unknown>)),
      },
      {
        name: 'local_read',
        label: 'Local Read',
        description: "Read a file from this container's filesystem (superuser mode).",
        parameters: Type.Object({
          file_path: Type.String(),
          offset: Type.Optional(Type.Number()),
          limit: Type.Optional(Type.Number()),
        }),
        execute: async (_id, params) => textResult(localRead(params as Record<string, unknown>)),
      },
      {
        name: 'local_write',
        label: 'Local Write',
        description: 'Write a file in this container (superuser mode).',
        parameters: Type.Object({
          file_path: Type.String(),
          content: Type.String(),
        }),
        execute: async (_id, params) => textResult(localWrite(params as Record<string, unknown>)),
      },
      {
        name: 'local_edit',
        label: 'Local Edit',
        description: 'Edit a file in this container (superuser mode).',
        parameters: Type.Object({
          file_path: Type.String(),
          old_string: Type.String(),
          new_string: Type.String(),
          replace_all: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, params) => textResult(localEdit(params as Record<string, unknown>)),
      },
    );
  }

  return tools;
}

// ---- Model construction ----

function buildModel(): Model<Api> {
  const provider = process.env.KUBECLAW_LLM_PROVIDER || 'openai';

  if (provider === 'openrouter') {
    const modelId = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'openrouter',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
  }

  if (provider === 'ollama') {
    const modelId = process.env.OLLAMA_MODEL || 'llama3.2';
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl: `${process.env.OLLAMA_HOST || 'http://ollama:11434'}/v1`,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
  }

  // Default: OpenAI-compatible
  const modelId = process.env.OPENAI_MODEL || process.env.DIRECT_LLM_MODEL || 'gpt-4o';
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function getApiKeyForProvider(provider: string): string | undefined {
  if (provider === 'openrouter') {
    return process.env.OPENROUTER_API_KEY;
  }
  if (provider === 'ollama') return 'ollama';
  return process.env.OPENAI_API_KEY;
}

// ---- Agentic loop ----

const MAX_TOOL_ROUNDS = 20;

async function runAgentLoop(
  input: ContainerInput,
  redis: RedisClientType,
  inputStream: InputStreamManager,
  jobId: string,
): Promise<void> {
  const isSuperuser = process.env.KUBECLAW_SUPERUSER === 'true';
  const podReadyMap = new Map<string, boolean>();

  const systemPrompt = loadSystemPrompt(input.assistantName);
  const history = loadHistory();

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - sent automatically, not directly from a user]\n\n${prompt}`;
  }

  // Drain any pending IPC messages into initial prompt
  await inputStream.poll();
  const pending = inputStream.drainUserMessages();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  const model = buildModel();
  const tools = buildToolDefinitions(
    isSuperuser, input.isMain, redis, inputStream, jobId,
    input.groupFolder, input.chatJid, podReadyMap,
  );

  const sessionId = input.sessionId || randomUUID();
  let toolRounds = 0;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
      messages: history,
    },
    getApiKey: getApiKeyForProvider,
    streamFn: streamSimple,
    // Steering: inject follow-up messages from Redis input stream mid-turn
    steeringMode: 'all',
    followUpMode: 'all',
  });

  // Track tool rounds and final response via event subscription
  let finalResponse = '';
  let agentError: string | undefined;

  agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'turn_end':
        toolRounds++;
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          log(`Max tool rounds (${MAX_TOOL_ROUNDS}) reached, aborting`);
          agent.abort();
        }

        // Check input stream for follow-up messages or close signal after each turn
        await inputStream.poll();
        if (inputStream.hasCloseSignal()) {
          log('Close signal received mid-loop');
          agent.abort();
          return;
        }
        {
          const followUps = inputStream.drainUserMessages();
          if (followUps.length > 0) {
            log(`Received ${followUps.length} follow-up message(s) mid-loop`);
            agent.steer({
              role: 'user',
              content: [{ type: 'text', text: followUps.join('\n') }],
              timestamp: Date.now(),
            });
          }
        }
        break;

      case 'agent_end': {
        // Extract final text from the last assistant message
        const endMessages = event.messages;
        const lastAssistant = [...endMessages].reverse().find(
          (m): m is Extract<AgentMessage, { role: 'assistant' }> => (m as any).role === 'assistant',
        );
        if (lastAssistant) {
          const textParts = (lastAssistant as any).content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text);
          finalResponse = textParts.join('');
          if ((lastAssistant as any).errorMessage) {
            agentError = (lastAssistant as any).errorMessage;
          }
        }
        break;
      }
    }
  });

  try {
    await agent.prompt(prompt);

    if (agentError) {
      writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: agentError });
    } else {
      writeOutput({ status: 'success', result: finalResponse, newSessionId: sessionId });
    }

    // Save conversation history (agent state has the full transcript)
    saveHistory(agent.state.messages);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMsg}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMsg });
  }

  // Wait for follow-up messages or close signal
  log('Waiting for follow-up messages...');
  while (true) {
    await inputStream.blockPoll(5000);

    if (inputStream.hasCloseSignal()) {
      log('Close signal received, exiting');
      break;
    }

    const followUps = inputStream.drainUserMessages();
    if (followUps.length === 0) continue;

    log(`Processing ${followUps.length} follow-up message(s)`);
    const followUpPrompt = followUps.join('\n');

    // Reset tracking for the new prompt
    toolRounds = 0;
    finalResponse = '';
    agentError = undefined;

    try {
      await agent.prompt(followUpPrompt);

      if (agentError) {
        writeOutput({ status: 'error', result: null, error: agentError });
      } else {
        writeOutput({ status: 'success', result: finalResponse, newSessionId: sessionId });
      }

      saveHistory(agent.state.messages);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Follow-up error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    // Check for close signal after follow-up
    await inputStream.poll();
    if (inputStream.hasCloseSignal()) {
      log('Close signal received after follow-up, exiting');
      break;
    }
  }
}

// ---- Main ----

// ---- Bootstrap mode ----
//
// When KUBECLAW_BOOTSTRAP_SKILL is set, this image is being run as a bootstrap
// Job for a new channel install (Stories 174-184). Instead of the normal agent
// loop, we:
//   - Load the named skill markdown as the system prompt
//   - Register the four superuser local_* tools (local_bash/read/write/edit)
//     plus a commit_channel_config IPC tool that hands off to the orchestrator
//   - Drive an agent loop that publishes assistant turns to the admin shell SSE
//     via Redis topic kubeclaw:bootstrap:<jobId>
//
// The skill customises this generic agent container in the running cluster —
// no separate channel image is built.

/**
 * Build a Redis URL with ACL auth for bootstrap mode. The bootstrap Job is
 * given REDIS_USERNAME + REDIS_ADMIN_PASSWORD env vars; we inject them into
 * the URL so the redis client authenticates. Required because Stories 5/146
 * locked Redis behind ACLs.
 */
function buildRedisUrlForBootstrap(): string {
  const base = process.env.REDIS_URL || 'redis://kubeclaw-redis:6379';
  const password = process.env.REDIS_ADMIN_PASSWORD;
  // The bootstrap pod is given REDIS_ADMIN_PASSWORD — despite the name, this
  // is actually the "orchestrator" ACL user's password (per the chart's
  // init-acl script: `user orchestrator on >$REDIS_ADMIN_PASSWORD`). Allow
  // override via REDIS_USERNAME for non-default deployments.
  const username =
    process.env.REDIS_USERNAME || (password ? 'orchestrator' : '');
  if (!password) return base;
  if (base.includes('@')) return base;
  const userPart = username ? encodeURIComponent(username) : '';
  return base.replace(
    /^(redis:\/\/)/,
    `$1${userPart}:${encodeURIComponent(password)}@`,
  );
}

async function waitForBootstrapCommitReply(
  redisUrl: string,
  replyChannel: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    let resolved = false;
    const sub = createClient({ url: redisUrl }) as RedisClientType;
    sub.on('error', () => {});
    sub.connect().then(() => {
      sub.subscribe(replyChannel, (msg: string) => {
        if (resolved) return;
        resolved = true;
        try {
          const data = JSON.parse(msg);
          sub.unsubscribe(replyChannel).catch(() => {});
          sub.quit().catch(() => {});
          if (data.ok) {
            resolve('Channel ready. Bootstrap complete.');
          } else {
            resolve(`Error from orchestrator: ${data.error}`);
          }
        } catch (err: any) {
          resolve(`Error parsing reply: ${err.message}`);
        }
      });
    });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      sub.unsubscribe(replyChannel).catch(() => {});
      sub.quit().catch(() => {});
      resolve('Timeout waiting for orchestrator reply (60s).');
    }, timeoutMs);
  });
}

// How long the bootstrap agent waits for the admin to answer a question before
// giving up. Overridable for tests/non-interactive runs.
const ADMIN_REPLY_TIMEOUT_MS: number = (() => {
  const raw = process.env.KUBECLAW_BOOTSTRAP_ADMIN_REPLY_TIMEOUT_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 600_000;
})();

// Block until the admin publishes a reply on the admin->pod channel. The
// orchestrator's reply_to_bootstrap tool publishes { text } here. Mirrors
// waitForBootstrapCommitReply's subscriber lifecycle.
async function waitForAdminReply(
  redisUrl: string,
  channel: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sub = createClient({ url: redisUrl }) as RedisClientType;
    const cleanup = () => {
      sub.unsubscribe(channel).catch(() => {});
      sub.quit().catch(() => {});
    };
    sub.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    sub.connect().then(() => {
      sub.subscribe(channel, (msg: string) => {
        if (settled) return;
        try {
          const data = JSON.parse(msg) as { text?: string };
          if (typeof data.text !== 'string') return;
          settled = true;
          cleanup();
          resolve(data.text);
        } catch {
          // ignore malformed messages
        }
      });
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timeout waiting for admin reply on ${channel}`));
    }, timeoutMs);
  });
}

async function runBootstrapMode(redis: RedisClientType): Promise<void> {
  const skillName = process.env.KUBECLAW_BOOTSTRAP_SKILL!;
  const jobId = process.env.KUBECLAW_BOOTSTRAP_JOB_ID || '';
  const instanceName = process.env.KUBECLAW_BOOTSTRAP_INSTANCE || '';
  const channelType = process.env.KUBECLAW_BOOTSTRAP_CHANNEL_TYPE || '';
  const redisUrl = buildRedisUrlForBootstrap();

  if (!jobId || !instanceName || !channelType) {
    log('ERROR: bootstrap mode requires KUBECLAW_BOOTSTRAP_JOB_ID, '
      + 'KUBECLAW_BOOTSTRAP_INSTANCE, KUBECLAW_BOOTSTRAP_CHANNEL_TYPE');
    process.exit(1);
  }

  const skillPath = `/workspace/skills/${skillName}.md`;
  if (!fs.existsSync(skillPath)) {
    log(`ERROR: Skill file not found: ${skillPath}`);
    process.exit(1);
  }
  const skillMarkdown = fs.readFileSync(skillPath, 'utf-8');

  const bootstrapTopic = `kubeclaw:bootstrap:${jobId}`;
  const taskChannel = `kubeclaw:bootstrap-task:${jobId}`;
  const replyChannel = `kubeclaw:bootstrap-reply:${jobId}`;
  const adminChannel = `kubeclaw:bootstrap-admin:${jobId}`;

  async function publishToAdmin(text: string): Promise<void> {
    try {
      await redis.publish(bootstrapTopic, JSON.stringify({ type: 'agent', text }));
    } catch (err: any) {
      log(`Warning: failed to publish to admin: ${err.message}`);
    }
  }

  await publishToAdmin(
    `Bootstrap started for channel ${channelType}/${instanceName}. Loading skill: ${skillName}`,
  );

  const systemPrompt = [
    skillMarkdown,
    '',
    `## Bootstrap context`,
    `Channel type:     ${channelType}`,
    `Instance name:    ${instanceName}`,
    `Bootstrap job ID: ${jobId}`,
    '',
    `## Mounted paths`,
    `  /workspace/skills/    — skill files`,
    `  /workspace/manifests/ — per-channel-type npm manifests`,
    `  /runtime              — writable runtime PVC; install packages and write channel-entry.js here`,
    '',
    `When credentials are gathered, validated, and the runtime PVC is ready,`,
    `call commit_channel_config to hand off to the orchestrator.`,
  ].join('\n');

  const commitTool: AgentTool = {
    name: 'commit_channel_config',
    label: 'Commit Channel Config',
    description:
      'Hand off the configured channel to the orchestrator. Call after all '
      + 'credentials are gathered/validated and the runtime PVC contains '
      + 'channel-entry.js and any installed node_modules.',
    parameters: Type.Object({
      channel_type: Type.String({ description: 'Channel type (e.g. "telegram")' }),
      instance_name: Type.String({ description: 'Instance name' }),
      secret_data: Type.Record(Type.String(), Type.String(), {
        description: 'Credential key-value pairs to store in a K8s Secret',
      }),
      runtime_pvc_lock_hash: Type.String({
        description:
          'sha256 of canonical(package.json) + "\\n" + canonical(package-lock.json) '
          + 'on the runtime PVC. Advisory only — orchestrator independently verifies.',
      }),
    }),
    execute: async (_id, args) => {
      const a = args as Record<string, unknown>;
      await publishToAdmin(
        `Requesting hand-off for ${a.channel_type}/${a.instance_name}...`,
      );
      try {
        await redis.publish(
          taskChannel,
          JSON.stringify({
            type: 'commit_channel_config',
            bootstrapJobId: jobId,
            channel_type: a.channel_type,
            instance_name: a.instance_name,
            secret_data: a.secret_data,
            runtime_pvc_lock_hash: a.runtime_pvc_lock_hash,
          }),
        );
        const reply = await waitForBootstrapCommitReply(
          redisUrl,
          replyChannel,
          60_000,
        );
        return textResult(reply);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  };

  // Bootstrap tools = the four superuser local_* tools + commit_channel_config.
  // No execution-pod fan-out, no browser tools, no web tools — bootstrap runs
  // in a single pod with its runtime PVC as the only durable surface.
  const tools: AgentTool[] = [
    {
      name: 'ask_admin',
      label: 'Ask Admin',
      description:
        'Ask the admin operator a question (e.g. which port, an API token) '
        + 'and BLOCK until they answer. Returns the admin reply text. Use this '
        + 'whenever the skill tells you to ask the admin something; never guess '
        + 'a value the admin is supposed to provide.',
      parameters: Type.Object({
        question: Type.String({
          description:
            "The question to ask the admin operator. The returned value is "
            + "the admin's answer.",
        }),
      }),
      execute: async (_id, params) => {
        const question = (params as { question: string }).question;
        await redis.publish(
          bootstrapTopic,
          JSON.stringify({ type: 'question', text: question }),
        );
        log(`[bootstrap] ask_admin: ${question}`);
        try {
          const reply = await waitForAdminReply(
            redisUrl,
            adminChannel,
            ADMIN_REPLY_TIMEOUT_MS,
          );
          log(`[bootstrap] admin replied: ${reply}`);
          return textResult(reply);
        } catch {
          return textResult(
            'Timed out waiting for admin reply. Abort the bootstrap and '
            + 'report the failure to the admin.',
          );
        }
      },
    },
    {
      name: 'local_bash',
      label: 'Local Bash',
      description:
        'Run a bash command in this bootstrap container. Use for npm ci, '
        + 'credential validation (curl), file inspection.',
      parameters: Type.Object({
        command: Type.String(),
        timeout: Type.Optional(Type.Number()),
      }),
      execute: async (_id, params) =>
        textResult(await localBash(params as Record<string, unknown>)),
    },
    {
      name: 'local_read',
      label: 'Local Read',
      description: "Read a file from this container's filesystem.",
      parameters: Type.Object({
        file_path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      execute: async (_id, params) =>
        textResult(localRead(params as Record<string, unknown>)),
    },
    {
      name: 'local_write',
      label: 'Local Write',
      description:
        'Write a file to this container (creates parent dirs). Use to write '
        + '/runtime/channel-entry.js, credential helpers, etc.',
      parameters: Type.Object({
        file_path: Type.String(),
        content: Type.String(),
      }),
      execute: async (_id, params) =>
        textResult(localWrite(params as Record<string, unknown>)),
    },
    {
      name: 'local_edit',
      label: 'Local Edit',
      description: 'Edit a file by find-and-replace on its contents.',
      parameters: Type.Object({
        file_path: Type.String(),
        old_string: Type.String(),
        new_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) =>
        textResult(localEdit(params as Record<string, unknown>)),
    },
    commitTool,
  ];

  const model = buildModel();
  const agent = new Agent({
    initialState: { systemPrompt, model, tools, messages: [] },
    getApiKey: getApiKeyForProvider,
    streamFn: streamSimple,
  });

  let toolRounds = 0;
  let lastPublishedIndex = -1;

  agent.subscribe(async (event: AgentEvent) => {
    if (event.type === 'turn_end') {
      toolRounds++;
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        log(`Max tool rounds (${MAX_TOOL_ROUNDS}) reached in bootstrap, aborting`);
        agent.abort();
        return;
      }
      // Publish any new assistant messages since the last turn to the admin SSE.
      const messages = agent.state.messages;
      for (let i = lastPublishedIndex + 1; i < messages.length; i++) {
        const m = messages[i] as any;
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          const text = m.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
          if (text) {
            log(`[bootstrap] assistant: ${text}`);
            await publishToAdmin(text);
          }
        }
      }
      lastPublishedIndex = messages.length - 1;
    }
  });

  const initialPrompt =
    `Please set up the ${channelType} channel for instance "${instanceName}". `
    + `Follow the skill instructions: install any required packages onto /runtime, `
    + `write the channel-entry.js, gather credentials, validate them, then call `
    + `commit_channel_config.`;

  try {
    await agent.prompt(initialPrompt);
    log('Bootstrap agent loop complete');
  } catch (err: any) {
    log(`Bootstrap error: ${err.message}`);
    await publishToAdmin(`Bootstrap error: ${err.message}`);
  }
}

async function main(): Promise<void> {
  // Bootstrap mode short-circuit — when KUBECLAW_BOOTSTRAP_SKILL is set, this
  // image runs as a channel bootstrap Job (Stories 174-184). Skip stdin/IPC
  // setup entirely and drive the skill-loaded agent loop directly.
  if (process.env.KUBECLAW_BOOTSTRAP_SKILL) {
    const redisUrl = buildRedisUrlForBootstrap();
    const redis = createClient({ url: redisUrl }) as RedisClientType;
    redis.on('error', (err) => log(`Redis error: ${err.message}`));
    await redis.connect();
    log('Redis connected (bootstrap mode)');
    try {
      await runBootstrapMode(redis);
    } finally {
      try { await redis.quit(); } catch { /* best effort */ }
    }
    return;
  }

  let containerInput: ContainerInput;
  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Merge secrets into process.env for API key resolution
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    process.env[key] = value;
  }

  // Connect Redis
  const redisUrl = process.env.REDIS_URL || 'redis://kubeclaw-redis:6379';
  const jobId = process.env.KUBECLAW_JOB_ID || '';

  const redis = createClient({ url: redisUrl }) as RedisClientType;
  redis.on('error', (err) => log(`Redis error: ${err.message}`));
  await redis.connect();
  log('Redis connected');

  // Connect RedisIPCClient for output publishing (K8s mode)
  if (jobId) {
    try {
      redisIpcClient = new RedisIPCClient(
        redisUrl,
        containerInput.groupFolder,
        containerInput.chatJid,
        containerInput.isMain,
        jobId,
      );
      await redisIpcClient.connect();
      log('Redis IPC output connected');
    } catch (err) {
      log(`Warning: failed to connect Redis IPC output: ${err instanceof Error ? err.message : String(err)}`);
      redisIpcClient = null;
    }
  }

  const inputStream = new InputStreamManager(redis, jobId || 'local');

  try {
    await runAgentLoop(containerInput, redis, inputStream, jobId);
  } finally {
    await redisIpcClient?.disconnect().catch(() => {});
    await redis.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[agent-runner] Fatal error:', err);
  process.exit(1);
});
