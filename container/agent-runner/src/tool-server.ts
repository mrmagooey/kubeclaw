/**
 * NanoClaw Tool Server
 * Alternative entrypoint for the agent container image.
 * Runs in tool category pods (execution | browser) and executes tool calls
 * routed from the agent MCP server via Redis Streams.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { createClient, RedisClientType } from 'redis';

const execFileAsync = promisify(execFile);

const agentJobId = process.env.KUBECLAW_AGENT_JOB_ID!;
const category = process.env.KUBECLAW_CATEGORY as 'execution' | 'browser' | string;
const redisUrl = process.env.REDIS_URL || 'redis://kubeclaw-redis:6379';
const idleTimeout = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10);
const toolMode = process.env.KUBECLAW_TOOL_MODE as 'http-bridge' | 'file-bridge' | 'acp-bridge' | undefined;
const toolPort = parseInt(process.env.KUBECLAW_TOOL_PORT || '8080', 10);
const SHARED_DIR = process.env.KUBECLAW_SHARED_DIR || '/shared';

const TOOLCALLS_STREAM = `kubeclaw:toolcalls:${agentJobId}:${category}`;
const TOOLRESULTS_STREAM = `kubeclaw:toolresults:${agentJobId}:${category}`;

const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY'];

function log(msg: string): void {
  console.error(`[tool-server:${category}] ${msg}`);
}

// --- Execution tools ---

async function toolBash(input: { command: string; timeout?: number }): Promise<string> {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SECRET_ENV_VARS) delete cleanEnv[key];

  const timeoutMs = input.timeout || 120000;
  try {
    const { stdout, stderr } = await execFileAsync(
      '/bin/bash',
      ['-c', input.command],
      { env: cleanEnv, cwd: '/workspace/group', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout + (stderr ? `\nstderr: ${stderr}` : '');
  } catch (err: any) {
    const out = (err.stdout || '') + (err.stderr ? `\nstderr: ${err.stderr}` : '');
    return out || err.message;
  }
}

async function toolRead(input: { file_path: string; offset?: number; limit?: number }): Promise<string> {
  const content = fs.readFileSync(input.file_path, 'utf-8');
  const lines = content.split('\n');
  const start = (input.offset || 1) - 1;
  const end = input.limit ? start + input.limit : lines.length;
  return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n');
}

async function toolWrite(input: { file_path: string; content: string }): Promise<string> {
  fs.mkdirSync(path.dirname(input.file_path), { recursive: true });
  fs.writeFileSync(input.file_path, input.content, 'utf-8');
  return `Written to ${input.file_path}`;
}

async function toolEdit(input: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<string> {
  const content = fs.readFileSync(input.file_path, 'utf-8');
  if (!content.includes(input.old_string)) {
    throw new Error(`old_string not found in ${input.file_path}`);
  }
  const updated = input.replace_all
    ? content.split(input.old_string).join(input.new_string)
    : content.replace(input.old_string, input.new_string);
  fs.writeFileSync(input.file_path, updated, 'utf-8');
  return `Edited ${input.file_path}`;
}

async function toolGlob(input: { pattern: string; path?: string }): Promise<string> {
  const cwd = input.path || '/workspace/group';
  const { stdout } = await execFileAsync('bash', ['-c', `cd ${JSON.stringify(cwd)} && find . -path ${JSON.stringify(`./${input.pattern.replace(/\*\*/g, '*')}`)} 2>/dev/null | head -100`]);
  // Use ripgrep/glob style via bash find as fallback; prefer glob if available
  return stdout.trim() || '(no matches)';
}

async function toolGrep(input: { pattern: string; path?: string; glob?: string; output_mode?: string }): Promise<string> {
  const searchPath = input.path || '/workspace/group';
  const args = ['-r', '--no-heading', '-l'];
  if (input.glob) args.push('--include', input.glob);
  args.push(input.pattern, searchPath);
  try {
    const { stdout } = await execFileAsync('grep', args, { maxBuffer: 5 * 1024 * 1024 });
    return stdout.trim() || '(no matches)';
  } catch (err: any) {
    if (err.code === 1) return '(no matches)';
    throw err;
  }
}

async function toolTodoWrite(input: { todos: Array<{ id: string; content: string; status: string; priority: string }> }): Promise<string> {
  const todoPath = '/workspace/group/.claude/todos.json';
  fs.mkdirSync(path.dirname(todoPath), { recursive: true });
  fs.writeFileSync(todoPath, JSON.stringify(input.todos, null, 2));
  return 'Todos updated.';
}

async function toolNotebookEdit(input: { notebook_path: string; new_source: string; cell_id: string }): Promise<string> {
  const nb = JSON.parse(fs.readFileSync(input.notebook_path, 'utf-8'));
  const cell = nb.cells?.find((c: { id?: string }) => c.id === input.cell_id);
  if (!cell) throw new Error(`Cell ${input.cell_id} not found`);
  cell.source = input.new_source;
  fs.writeFileSync(input.notebook_path, JSON.stringify(nb, null, 2));
  return `Cell ${input.cell_id} updated.`;
}

// --- Browser tools ---

async function toolWebFetch(input: { url: string; prompt?: string }): Promise<string> {
  const res = await fetch(input.url, { headers: { 'User-Agent': 'Mozilla/5.0 NanoClaw/1.0' } });
  const text = await res.text();
  // Trim to avoid huge responses
  return text.slice(0, 50000);
}

async function toolWebSearch(input: { query: string }): Promise<string> {
  // Use DuckDuckGo HTML endpoint
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 NanoClaw/1.0' } });
  const html = await res.text();
  // Extract result titles and snippets
  const results = [...html.matchAll(/<a class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)]
    .slice(0, 10)
    .map(([, url, title]) => `${title}: ${url}`)
    .join('\n');
  return results || html.slice(0, 5000);
}

async function toolAgentBrowser(input: { command: string }): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('agent-browser', [input.command], { timeout: 60000 });
    return stdout + (stderr ? `\nstderr: ${stderr}` : '');
  } catch (err: any) {
    return err.stdout || err.message;
  }
}

async function toolTask(input: Record<string, unknown>): Promise<string> {
  // Proxy to orchestrator via Redis tasks channel
  const redis = await getRedisForTask();
  const groupFolder = process.env.KUBECLAW_GROUP_FOLDER || 'unknown';
  await redis.publish(
    `kubeclaw:tasks:${groupFolder}`,
    JSON.stringify({ type: 'schedule_task', ...input }),
  );
  return 'Task request sent.';
}

let taskRedis: RedisClientType | null = null;
async function getRedisForTask(): Promise<RedisClientType> {
  if (!taskRedis) {
    taskRedis = createClient({ url: redisUrl }) as RedisClientType;
    await taskRedis.connect();
  }
  return taskRedis;
}

// --- Bridge modes ---

async function executeToolBridgeHttp(tool: string, input: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`http://localhost:${toolPort}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, input }),
  });
  if (!res.ok) throw new Error(`Bridge HTTP error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result ?? null;
}

async function executeToolBridgeFile(tool: string, input: Record<string, unknown>, requestId: string): Promise<unknown> {
  const reqPath = path.join(SHARED_DIR, `${requestId}.request.json`);
  const resPath = path.join(SHARED_DIR, `${requestId}.response.json`);
  fs.writeFileSync(reqPath, JSON.stringify({ requestId, tool, input }));
  const deadline = Date.now() + idleTimeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(resPath)) {
      const data = JSON.parse(fs.readFileSync(resPath, 'utf-8')) as { result?: unknown; error?: string };
      fs.unlinkSync(resPath);
      if (data.error) throw new Error(data.error);
      return data.result ?? null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('File bridge timeout');
}

// --- ACP bridge mode ---

const acpAgentName = process.env.KUBECLAW_ACP_AGENT_NAME;
const acpMode = process.env.KUBECLAW_ACP_MODE || 'sync';

async function executeToolBridgeAcp(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const acpBaseUrl = `http://localhost:${toolPort}`;
  const agentName = acpAgentName || tool;

  // Convert tool input to ACP message format
  const taskText = (input.task as string) ?? JSON.stringify(input);
  const acpInput = [{
    role: 'user',
    parts: [{ content: taskText, content_type: 'text/plain' }],
  }];

  if (acpMode === 'sync') {
    const res = await fetch(`${acpBaseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: agentName, input: acpInput, mode: 'synchronous' }),
      signal: AbortSignal.timeout(idleTimeout),
    });
    if (!res.ok) throw new Error(`ACP error: ${res.status} ${await res.text()}`);
    return extractACPResult(await res.json());
  }

  // Async: POST /runs returns run_id, poll for result
  const createRes = await fetch(`${acpBaseUrl}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_name: agentName, input: acpInput }),
  });
  if (!createRes.ok) throw new Error(`ACP error: ${createRes.status} ${await createRes.text()}`);
  const run = await createRes.json() as { run_id: string; status: string };

  // Poll with exponential backoff
  let delay = 500;
  const deadline = Date.now() + idleTimeout;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);

    const pollRes = await fetch(`${acpBaseUrl}/runs/${run.run_id}`);
    if (!pollRes.ok) throw new Error(`ACP poll error: ${pollRes.status}`);
    const state = await pollRes.json() as { status: string; output?: unknown };

    if (state.status === 'completed') return extractACPResult(state);
    if (state.status === 'failed') throw new Error('ACP agent run failed');
    if (state.status === 'cancelled') throw new Error('ACP agent run cancelled');
    if (state.status === 'awaiting') {
      return `ACP agent is awaiting input: ${JSON.stringify(state.output ?? 'additional information needed')}`;
    }
  }
  throw new Error('ACP agent timed out');
}

function extractACPResult(response: any): string {
  const output = response.output ?? response.result ?? [];
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .flatMap((msg: any) => (msg.parts ?? [])
        .filter((p: any) => !p.content_type || p.content_type === 'text/plain')
        .map((p: any) => p.content))
      .join('\n');
  }
  return JSON.stringify(output);
}

// --- Tool dispatch ---

async function executeTool(tool: string, input: Record<string, unknown>, requestId: string): Promise<unknown> {
  if (toolMode === 'acp-bridge') return executeToolBridgeAcp(tool, input);
  if (toolMode === 'http-bridge') return executeToolBridgeHttp(tool, input);
  if (toolMode === 'file-bridge') return executeToolBridgeFile(tool, input, requestId);
  return executeToolLocal(tool, input);
}

async function executeToolLocal(tool: string, input: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    // execution
    case 'bash': return toolBash(input as any);
    case 'read': return toolRead(input as any);
    case 'write': return toolWrite(input as any);
    case 'edit': return toolEdit(input as any);
    case 'glob': return toolGlob(input as any);
    case 'grep': return toolGrep(input as any);
    case 'todoWrite': return toolTodoWrite(input as any);
    case 'notebookEdit': return toolNotebookEdit(input as any);
    // browser
    case 'webFetch': return toolWebFetch(input as any);
    case 'webSearch': return toolWebSearch(input as any);
    case 'agentBrowser': return toolAgentBrowser(input as any);
    case 'task':
    case 'taskOutput':
    case 'taskStop': return toolTask(input as any);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// --- Main loop ---

async function main(): Promise<void> {
  if (!agentJobId || (!category && !toolMode)) {
    log('KUBECLAW_AGENT_JOB_ID and either KUBECLAW_CATEGORY or KUBECLAW_TOOL_MODE are required');
    process.exit(1);
  }

  log(`Starting. agentJobId=${agentJobId} category=${category} toolMode=${toolMode ?? 'none'}`);

  const redis = createClient({ url: redisUrl }) as RedisClientType;
  redis.on('error', (err) => log(`Redis error: ${err.message}`));
  await redis.connect();
  log('Connected to Redis');

  let lastId = '0-0'; // process from beginning so pre-spawned calls are picked up
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log('Idle timeout reached, exiting');
      process.exit(0);
    }, idleTimeout);
  }

  resetIdleTimer();

  while (true) {
    try {
      const response = await redis.xRead(
        [{ key: TOOLCALLS_STREAM, id: lastId }],
        { BLOCK: Math.min(idleTimeout, 30000), COUNT: 1 },
      );

      if (!response || response.length === 0) continue;

      const streamData = response[0];
      if (!streamData?.messages?.length) continue;

      for (const message of streamData.messages) {
        lastId = message.id;
        resetIdleTimer();

        const fields = message.message as Record<string, string>;
        const requestId = fields.requestId;
        const tool = fields.tool;
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(fields.input || '{}');
        } catch {
          input = {};
        }

        log(`Executing tool=${tool} requestId=${requestId}`);

        let result: unknown;
        let error: string | undefined;
        try {
          result = await executeTool(tool, input, requestId);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          log(`Tool error: ${error}`);
        }

        await redis.xAdd(TOOLRESULTS_STREAM, '*', {
          requestId,
          result: JSON.stringify(result ?? null),
          ...(error ? { error } : {}),
        });
      }
    } catch (err) {
      log(`Stream read error: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
