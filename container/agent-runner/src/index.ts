/**
 * KubeClaw Agent Runner
 * OpenAI-compatible agentic loop. No Claude SDK dependency.
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
import OpenAI from 'openai';
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
  messages: OpenAI.ChatCompletionMessageParam[];
  updatedAt: string;
}

function loadHistory(): OpenAI.ChatCompletionMessageParam[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw: ConversationHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return raw.messages ?? [];
  } catch {
    return [];
  }
}

function saveHistory(messages: OpenAI.ChatCompletionMessageParam[]): void {
  try {
    const capped = messages.slice(-MAX_HISTORY_MESSAGES);
    const data: ConversationHistory = { messages: capped, updatedAt: new Date().toISOString() };
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Warning: failed to save history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- System prompt ----

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant. Be concise and direct.';

function loadSystemPrompt(assistantName?: string): string {
  const parts: string[] = [];

  // Per-group instructions
  try {
    const groupMd = fs.readFileSync('/workspace/group/CLAUDE.md', 'utf-8').trim();
    if (groupMd) parts.push(groupMd);
  } catch { /* not present */ }

  // Global instructions
  try {
    if (!parts.length) { // only load global when group has no own CLAUDE.md
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
// Reads from kubeclaw:input:{jobId} Redis stream, routes messages by type.
// tool_pod_ack messages are queued for ensurePodReady; user messages and
// close signals are queued for the main loop.

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

  // Non-blocking read: enqueue any available messages
  async poll(): Promise<void> {
    try {
      const response = await (this.redis as any).xRead(
        [{ key: this.streamKey, id: this.lastId }],
        { COUNT: 100 },
      );
      this._enqueue(response);
    } catch { /* ignore */ }
  }

  // Blocking read with timeout
  async blockPoll(timeoutMs: number): Promise<void> {
    try {
      const response = await (this.redis as any).xRead(
        [{ key: this.streamKey, id: this.lastId }],
        { BLOCK: Math.max(100, timeoutMs), COUNT: 100 },
      );
      this._enqueue(response);
    } catch { /* ignore */ }
  }

  // Drain queued user messages; leaves acks and close signals in queue
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

  // Check for close signal (does not consume it)
  hasCloseSignal(): boolean {
    return this.queue.some((e) => e.type === 'close');
  }

  // Wait until a tool_pod_ack for category arrives or timeout
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

// Server-side name (what tool-server.ts expects)
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

  // Request tool pod if not yet ready for this category
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

  // Block-read results stream for matching requestId
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

// ---- Tool definitions ----

function buildToolDefinitions(isSuperuser: boolean, isMain: boolean): OpenAI.ChatCompletionTool[] {
  const tools: OpenAI.ChatCompletionTool[] = [
    // Execution tools
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a bash command in the execution environment.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to run' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (optional)' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file from the workspace.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            offset: { type: 'number', description: 'Line number to start reading from (0-based)' },
            limit: { type: 'number', description: 'Number of lines to read' },
          },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write',
        description: 'Write content to a file in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['file_path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit',
        description: 'Replace a string in a file.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glob',
        description: 'Find files by glob pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', description: 'Directory to search in (optional)' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents with regex.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'string' },
            output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
          },
          required: ['pattern'],
        },
      },
    },
    // Browser tools
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch the content of a URL.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            prompt: { type: 'string', description: 'Optional focus prompt' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'agent_browser',
        description: 'Run browser automation with Playwright.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    },
    // IPC tools
    {
      type: 'function',
      function: {
        name: 'send_message',
        description: "Send a message to the user immediately while still running. Use for progress updates.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            sender: { type: 'string', description: 'Role/identity name (optional)' },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_task',
        description: 'Schedule a recurring or one-time task.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
            schedule_value: { type: 'string' },
            context_mode: { type: 'string', enum: ['group', 'isolated'] },
            target_group_jid: { type: 'string' },
          },
          required: ['prompt', 'schedule_type', 'schedule_value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description: 'List scheduled tasks.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pause_task',
        description: 'Pause a scheduled task.',
        parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'resume_task',
        description: 'Resume a paused task.',
        parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_task',
        description: 'Cancel and delete a scheduled task.',
        parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_task',
        description: 'Update an existing scheduled task.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            prompt: { type: 'string' },
            schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
            schedule_value: { type: 'string' },
          },
          required: ['task_id'],
        },
      },
    },
  ];

  if (isMain) {
    tools.push({
      type: 'function',
      function: {
        name: 'register_group',
        description: 'Register a new chat/group. Main group only.',
        parameters: {
          type: 'object',
          properties: {
            jid: { type: 'string' },
            name: { type: 'string' },
            folder: { type: 'string' },
            trigger: { type: 'string' },
          },
          required: ['jid', 'name', 'folder', 'trigger'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'deploy_channel',
        description: 'Ask the orchestrator to create Kubernetes resources for a new channel pod. Pass the full multi-document YAML. Main group only.',
        parameters: {
          type: 'object',
          properties: {
            yamlContent: { type: 'string', description: 'Multi-document Kubernetes YAML to apply (Deployment, PVC, Service)' },
          },
          required: ['yamlContent'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'control_channel',
        description: 'Send a control command to a running channel pod (e.g. reload to force reconnect). Main group only.',
        parameters: {
          type: 'object',
          properties: {
            channelName: { type: 'string', description: 'Channel pod name to control (e.g. telegram, irc, discord)' },
            command: { type: 'string', enum: ['reload'], description: 'reload: disconnect and reconnect the channel' },
          },
          required: ['channelName', 'command'],
        },
      },
    });
  }

  if (isSuperuser) {
    tools.push(
      {
        type: 'function',
        function: {
          name: 'local_bash',
          description: 'Run a bash command directly in this container (superuser mode). Use to install packages, modify agent code, or perform system-level setup.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              timeout: { type: 'number' },
            },
            required: ['command'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'local_read',
          description: 'Read a file from this container\'s filesystem (superuser mode).',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              offset: { type: 'number' },
              limit: { type: 'number' },
            },
            required: ['file_path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'local_write',
          description: 'Write a file in this container (superuser mode).',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['file_path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'local_edit',
          description: 'Edit a file in this container (superuser mode).',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['file_path', 'old_string', 'new_string'],
          },
        },
      },
    );
  }

  return tools;
}

// ---- LLM client factory ----

function createLLMClient(input: ContainerInput): { client: OpenAI; model: string } {
  const provider = process.env.KUBECLAW_LLM_PROVIDER || 'openai';

  if (provider === 'openrouter') {
    return {
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY || 'no-key',
        baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      }),
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o',
    };
  }

  // Default: OpenAI-compatible (openai, or any provider with OPENAI_* vars)
  return {
    client: new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'no-key',
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    }),
    model: process.env.OPENAI_MODEL || process.env.DIRECT_LLM_MODEL || 'gpt-4o',
  };
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
  const { client, model } = createLLMClient(input);
  const tools = buildToolDefinitions(isSuperuser, input.isMain);
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

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: prompt },
  ];

  let finalResponse = '';
  let sessionId = input.sessionId || randomUUID();

  try {
    let toolRounds = 0;
    while (toolRounds <= MAX_TOOL_ROUNDS) {
      log(`LLM call round ${toolRounds} (${messages.length} messages)`);

      const response = await client.chat.completions.create({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
      });

      const msg = response.choices[0].message;
      messages.push(msg);

      const toolCalls = msg.tool_calls?.filter((c) => c.type === 'function') ?? [];

      if (toolCalls.length === 0) {
        finalResponse = msg.content ?? '';
        break;
      }

      log(`Executing ${toolCalls.length} tool call(s)`);

      for (const call of toolCalls) {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments); } catch { /* use empty */ }

        log(`Tool call: ${name}`);
        let result: string;

        if (TOOL_CATEGORY[name]) {
          // Redis-routed tool
          result = await callToolViaRedis(redis, inputStream, jobId, input.groupFolder, name, args, podReadyMap);
        } else if (name.startsWith('local_') && isSuperuser) {
          // Local superuser tool
          switch (name) {
            case 'local_bash': result = await localBash(args); break;
            case 'local_read': result = localRead(args); break;
            case 'local_write': result = localWrite(args); break;
            case 'local_edit': result = localEdit(args); break;
            default: result = `Unknown local tool: ${name}`;
          }
        } else {
          // IPC tool
          switch (name) {
            case 'send_message':
              result = await handleSendMessage(redis, input.groupFolder, input.chatJid, args);
              break;
            case 'schedule_task':
              result = await handleScheduleTask(redis, input.groupFolder, input.chatJid, input.isMain, args);
              break;
            case 'list_tasks':
              result = handleListTasks(input.groupFolder, input.isMain);
              break;
            case 'pause_task':
            case 'resume_task':
            case 'cancel_task':
              result = await handleTaskLifecycle(redis, input.groupFolder, input.isMain, name, args);
              break;
            case 'update_task':
              result = await handleUpdateTask(redis, input.groupFolder, input.isMain, args);
              break;
            case 'register_group':
              result = await handleRegisterGroup(redis, input.groupFolder, input.isMain, args);
              break;
            case 'deploy_channel':
              if (!input.isMain) { result = 'deploy_channel is only available to the main group.'; break; }
              await (redis as any).publish(
                `kubeclaw:tasks:${input.groupFolder}`,
                JSON.stringify({ type: 'deploy_channel', yaml: String(args.yamlContent || ''), groupFolder: input.groupFolder }),
              );
              result = 'Deployment request sent to orchestrator.';
              break;
            case 'control_channel':
              if (!input.isMain) { result = 'control_channel is only available to the main group.'; break; }
              await (redis as any).publish(
                `kubeclaw:tasks:${input.groupFolder}`,
                JSON.stringify({ type: 'control_channel', channelName: String(args.channelName || ''), command: String(args.command || ''), groupFolder: input.groupFolder }),
              );
              result = `Control command '${args.command}' sent to channel '${args.channelName}'.`;
              break;
            default:
              result = `Unknown tool: ${name}`;
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        });
      }

      toolRounds++;

      // Check input stream for follow-up messages or close signal after each round
      await inputStream.poll();
      if (inputStream.hasCloseSignal()) {
        log('Close signal received mid-loop');
        break;
      }
      const followUps = inputStream.drainUserMessages();
      if (followUps.length > 0) {
        log(`Received ${followUps.length} follow-up message(s) mid-loop`);
        messages.push({ role: 'user', content: followUps.join('\n') });
      }
    }

    // Emit result
    writeOutput({ status: 'success', result: finalResponse, newSessionId: sessionId });

    // Persist conversation history (exclude system message)
    const toSave = messages.filter((m) => m.role !== 'system');
    saveHistory(toSave);

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

    // Load latest history and run another loop iteration
    const updatedHistory = loadHistory();
    const followUpMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...updatedHistory,
      { role: 'user', content: followUpPrompt },
    ];

    try {
      let toolRounds = 0;
      let followUpResponse = '';

      while (toolRounds <= MAX_TOOL_ROUNDS) {
        const response = await client.chat.completions.create({
          model,
          messages: followUpMessages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
        });

        const msg = response.choices[0].message;
        followUpMessages.push(msg);

        const toolCalls = msg.tool_calls?.filter((c) => c.type === 'function') ?? [];
        if (toolCalls.length === 0) {
          followUpResponse = msg.content ?? '';
          break;
        }

        for (const call of toolCalls) {
          const name = call.function.name;
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments); } catch { /* use empty */ }

          let result: string;
          if (TOOL_CATEGORY[name]) {
            result = await callToolViaRedis(redis, inputStream, jobId, input.groupFolder, name, args, podReadyMap);
          } else if (name.startsWith('local_') && isSuperuser) {
            switch (name) {
              case 'local_bash': result = await localBash(args); break;
              case 'local_read': result = localRead(args); break;
              case 'local_write': result = localWrite(args); break;
              case 'local_edit': result = localEdit(args); break;
              default: result = `Unknown local tool: ${name}`;
            }
          } else {
            switch (name) {
              case 'send_message': result = await handleSendMessage(redis, input.groupFolder, input.chatJid, args); break;
              case 'schedule_task': result = await handleScheduleTask(redis, input.groupFolder, input.chatJid, input.isMain, args); break;
              case 'list_tasks': result = handleListTasks(input.groupFolder, input.isMain); break;
              case 'pause_task': case 'resume_task': case 'cancel_task': result = await handleTaskLifecycle(redis, input.groupFolder, input.isMain, name, args); break;
              case 'update_task': result = await handleUpdateTask(redis, input.groupFolder, input.isMain, args); break;
              case 'register_group': result = await handleRegisterGroup(redis, input.groupFolder, input.isMain, args); break;
              default: result = `Unknown tool: ${name}`;
            }
          }
          followUpMessages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        toolRounds++;

        await inputStream.poll();
        if (inputStream.hasCloseSignal()) break;
      }

      writeOutput({ status: 'success', result: followUpResponse, newSessionId: sessionId });

      const toSave = followUpMessages.filter((m) => m.role !== 'system');
      saveHistory(toSave);

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

async function main(): Promise<void> {
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

  // Merge secrets into process.env for the OpenAI client
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
