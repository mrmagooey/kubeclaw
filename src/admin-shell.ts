/**
 * Admin Shell — LLM-powered admin interface for KubeClaw.
 *
 * Two modes (can run simultaneously):
 *
 *   Exec (TTY) — interactive readline REPL inside the pod:
 *     kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- node dist/admin-shell.js
 *
 *   HTTP — browser UI served on a configurable port:
 *     ADMIN_HTTP_PORT=9090 node dist/admin-shell.js
 *     Expose via Kubernetes Service + Ingress for external access.
 *
 * Auth (HTTP mode): ADMIN_HTTP_USERNAME / ADMIN_HTTP_PASSWORD (Basic Auth).
 * LLM:              OPENAI_API_KEY, OPENAI_BASE_URL, DIRECT_LLM_MODEL.
 */

import http from 'node:http';
import readline from 'readline';
import OpenAI from 'openai';
import * as k8s from '@kubernetes/client-node';

import { initDatabase } from './db.js';
import * as db from './db.js';
import { logger } from './logger.js';
import { createLLMClient, DEFAULT_DIRECT_MODEL } from './runtime/llm-client.js';
import {
  setupChannel,
} from './skills/orchestrator/channel-setup.js';
import type { ChannelSetupInput } from './skills/orchestrator/types.js';

// K8s clients (in-cluster config, auto-detected from service account)
const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const NAMESPACE = process.env.KUBECLAW_NAMESPACE || 'kubeclaw';
const ORCHESTRATOR_DEPLOYMENT = 'kubeclaw-orchestrator';

// Guard moved to main() so this module can be imported without side effects.

const MODEL = process.env.ADMIN_SHELL_MODEL || DEFAULT_DIRECT_MODEL;

// ---- Tool definitions ----

export const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_groups',
      description:
        'List all registered groups with their JID, name, folder, trigger, and settings.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_group',
      description:
        'Register a new group (chat) with the orchestrator. Folder name must be lowercase letters, numbers, and hyphens only.',
      parameters: {
        type: 'object',
        properties: {
          jid: {
            type: 'string',
            description: 'Chat JID, e.g. tg:-1001234567890 or dc:123456789',
          },
          name: { type: 'string', description: 'Human-readable group name' },
          folder: {
            type: 'string',
            description: 'Folder name under groups/ (lowercase, hyphens OK)',
          },
          trigger: {
            type: 'string',
            description: 'Trigger pattern, e.g. @Andy',
          },
          isMain: {
            type: 'boolean',
            description: 'True if this is the main control group',
          },
          requiresTrigger: {
            type: 'boolean',
            description: 'If false, respond to every message. Default true.',
          },
          llmProvider: {
            type: 'string',
            description:
              'LLM provider for K8s agent jobs: "claude", "openai", "openrouter", or "ollama". Use "ollama" to route agent jobs to a local Ollama K8s Service.',
          },
          direct: {
            type: 'boolean',
            description: 'If true, use in-process LLM (no K8s job spawned).',
          },
        },
        required: ['jid', 'name', 'folder', 'trigger'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deregister_group',
      description: 'Remove a group registration by JID.',
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string', description: 'Chat JID to remove' },
        },
        required: ['jid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_channels',
      description:
        'List available channel integrations and whether their credentials are configured.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_scheduled_tasks',
      description:
        'List all scheduled tasks with their status and next run time.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sessions',
      description: 'List active conversation session IDs per group folder.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_conversation',
      description: 'Clear the direct-LLM conversation history for a group.',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Group folder name' },
        },
        required: ['folder'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'setup_channel',
      description:
        'Set up a new communication channel. Stores the credential in a K8s Secret and creates a dedicated channel pod Deployment. No orchestrator restart needed. Call this after gathering all required credentials from the user.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['telegram', 'discord', 'slack', 'whatsapp', 'irc', 'http'],
            description: 'Channel type',
          },
          instanceName: {
            type: 'string',
            description:
              'Unique instance name (defaults to the type). Use to create multiple channels of the same type, e.g. "http-staging".',
          },
          token: {
            type: 'string',
            description: 'Bot token or API key (Telegram, Discord, Slack)',
          },
          phoneNumber: {
            type: 'string',
            description: 'Phone number in E.164 format (WhatsApp only)',
          },
          server: {
            type: 'string',
            description: 'IRC server hostname (IRC only)',
          },
          nick: { type: 'string', description: 'IRC nickname (IRC only)' },
          channels: {
            type: 'string',
            description: 'Comma-separated IRC channels to join (IRC only)',
          },
          httpUsers: {
            type: 'string',
            description:
              'Comma-separated user:pass pairs for HTTP channel, e.g. "alice:secret,bob:pass" (HTTP only)',
          },
          httpPort: {
            type: 'number',
            description: 'HTTP listen port, default 4080 (HTTP only)',
          },
          registerGroup: {
            type: 'boolean',
            description:
              'If true, auto-register a default group for this channel with direct LLM mode.',
          },
          groupJid: {
            type: 'string',
            description:
              'Chat JID to register (required if registerGroup is true)',
          },
          groupName: {
            type: 'string',
            description:
              'Group display name (required if registerGroup is true)',
          },
          groupFolder: {
            type: 'string',
            description:
              'Group folder name (required if registerGroup is true)',
          },
          trigger: {
            type: 'string',
            description:
              'Trigger pattern, e.g. @Andy (required if registerGroup is true)',
          },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_orchestrator_status',
      description:
        'Get the current status of the orchestrator Deployment: pod phase, ready replicas, and which channel env vars are set.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restart_orchestrator',
      description:
        'Trigger a rolling restart of the orchestrator Deployment so it picks up new secrets or env vars.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ---- Tool handlers ----

type ToolInput = Record<string, unknown>;

function handleListGroups(): string {
  const groups = db.getAllRegisteredGroups();
  const entries = Object.entries(groups);
  if (entries.length === 0) return 'No groups registered.';
  return entries
    .map(([jid, g]) =>
      [
        `JID: ${jid}`,
        `  Name: ${g.name}`,
        `  Folder: ${g.folder}`,
        `  Trigger: ${g.trigger}`,
        `  Main: ${g.isMain ? 'yes' : 'no'}`,
        `  RequiresTrigger: ${g.requiresTrigger === false ? 'no' : 'yes'}`,
        `  Provider: ${g.llmProvider || 'claude (default)'}`,
        `  Direct: ${g.containerConfig?.direct ? 'yes' : 'no'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function handleRegisterGroup(input: ToolInput): string {
  const jid = input.jid as string;
  const name = input.name as string;
  const folder = input.folder as string;
  const trigger = input.trigger as string;
  const isMain = (input.isMain as boolean) ?? false;
  const requiresTrigger = (input.requiresTrigger as boolean) ?? true;
  const llmProvider = input.llmProvider as string | undefined;
  const direct = (input.direct as boolean) ?? false;

  db.setRegisteredGroup(jid, {
    name,
    folder,
    trigger,
    added_at: new Date().toISOString(),
    isMain,
    requiresTrigger,
    llmProvider,
    containerConfig: direct ? { direct: true } : undefined,
  });
  return `Registered group "${name}" (${jid}) → folder: ${folder}. Changes take effect on next orchestrator poll (~2s).`;
}

function handleDeregisterGroup(input: ToolInput): string {
  const jid = input.jid as string;
  const existing = db.getRegisteredGroup(jid);
  if (!existing) return `No group found with JID: ${jid}`;
  db.deleteRegisteredGroup(jid);
  return `Removed group "${existing.name}" (${jid}).`;
}

function handleListChannels(): string {
  const channels = [
    { name: 'telegram', envVar: 'TELEGRAM_BOT_TOKEN' },
    { name: 'whatsapp', envVar: 'WHATSAPP_BOT_TOKEN' },
    { name: 'discord', envVar: 'DISCORD_BOT_TOKEN' },
    { name: 'slack', envVar: 'SLACK_BOT_TOKEN' },
    { name: 'irc', envVar: 'IRC_SERVER' },
  ];
  return channels
    .map((c) => {
      const configured = !!process.env[c.envVar];
      return `${c.name}: ${configured ? '✓ configured' : '✗ not configured'} (${c.envVar})`;
    })
    .join('\n');
}

function handleListScheduledTasks(): string {
  const tasks = db.getAllScheduledTasks();
  if (tasks.length === 0) return 'No scheduled tasks.';
  return tasks
    .map((t) =>
      [
        `ID: ${t.id}`,
        `  Group: ${t.group_folder}`,
        `  Status: ${t.status}`,
        `  Schedule: ${t.schedule_type} ${t.schedule_value}`,
        `  Next run: ${t.next_run || 'N/A'}`,
        `  Last run: ${t.last_run || 'never'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function handleGetSessions(): string {
  const sessions = db.getAllSessions();
  const entries = Object.entries(sessions);
  if (entries.length === 0) return 'No active sessions.';
  return entries.map(([folder, id]) => `${folder}: ${id}`).join('\n');
}

function handleClearConversation(input: ToolInput): string {
  const folder = input.folder as string;
  db.clearConversationHistory(folder);
  return `Cleared conversation history for group folder: ${folder}`;
}

// ---- K8s channel setup handlers ----

async function handleSetupChannel(input: ToolInput): Promise<string> {
  const result = await setupChannel(input as unknown as ChannelSetupInput);
  return result.log.join('\n');
}

async function handleGetOrchestratorStatus(): Promise<string> {
  const deployment = await appsV1.readNamespacedDeployment({
    name: ORCHESTRATOR_DEPLOYMENT,
    namespace: NAMESPACE,
  });
  const status = deployment.status;

  // List channel pod deployments
  const allDeployments = await appsV1.listNamespacedDeployment({
    namespace: NAMESPACE,
  });
  const channelDeployments = allDeployments.items.filter((d) =>
    d.metadata?.name?.startsWith('kubeclaw-channel-'),
  );
  const channelLines =
    channelDeployments.length === 0
      ? ['  (none)']
      : channelDeployments.map((d) => {
          const name =
            d.metadata?.name?.replace('kubeclaw-channel-', '') ?? '?';
          const ready = d.status?.readyReplicas ?? 0;
          const desired = d.spec?.replicas ?? 1;
          return `  ${name}: ${ready}/${desired} ready`;
        });

  return [
    `Orchestrator: ${ORCHESTRATOR_DEPLOYMENT}`,
    `  Ready: ${status?.readyReplicas ?? 0}/${status?.replicas ?? 0}`,
    `Channel pods:`,
    ...channelLines,
  ].join('\n');
}

async function triggerRollout(): Promise<void> {
  await appsV1.patchNamespacedDeployment({
    name: ORCHESTRATOR_DEPLOYMENT,
    namespace: NAMESPACE,
    body: {
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
            },
          },
        },
      },
    },
  });
}

async function handleRestartOrchestrator(): Promise<string> {
  await triggerRollout();
  return 'Rolling restart triggered. The orchestrator will be back in ~30 seconds.';
}

export async function executeTool(
  name: string,
  input: ToolInput,
): Promise<string> {
  switch (name) {
    case 'list_groups':
      return handleListGroups();
    case 'register_group':
      return handleRegisterGroup(input);
    case 'deregister_group':
      return handleDeregisterGroup(input);
    case 'list_channels':
      return handleListChannels();
    case 'list_scheduled_tasks':
      return handleListScheduledTasks();
    case 'get_sessions':
      return handleGetSessions();
    case 'clear_conversation':
      return handleClearConversation(input);
    case 'setup_channel':
      return handleSetupChannel(input);
    case 'get_orchestrator_status':
      return handleGetOrchestratorStatus();
    case 'restart_orchestrator':
      return handleRestartOrchestrator();
    default:
      return `Unknown tool: ${name}`;
  }
}

// ---- Main REPL ----

const SYSTEM = `You are the KubeClaw admin assistant. You help administrators manage group registrations, channels, and scheduled tasks.

Key concepts:
- Groups: registered chats that the orchestrator responds to. Each group has a folder under groups/ with a CLAUDE.md for agent memory.
- JID format: tg:<chatid> for Telegram, dc:<channelid> for Discord, <number>@g.us for WhatsApp
- Trigger: the pattern that triggers the agent (e.g. "@Andy"). Set requiresTrigger=false for the main group.
- direct: if true, responses are generated in-process (no Kubernetes job spawned). Recommended for all new groups.
- Main group: the primary control group with elevated privileges. Only one group should have isMain=true.

When setting up a channel:
1. Ask the user for the required credentials (bot token, phone number, etc.)
2. For Telegram: ask for the bot token from @BotFather. Remind them to disable Group Privacy in @BotFather for group chats.
3. For Discord/Slack: ask for the bot token.
4. For HTTP: ask for one or more users in the format "user1:pass1,user2:pass2" and an optional port (default 4080). Each user gets their own JID (http:{username}) and isolated group. After setup, tell the user to configure their Kubernetes Ingress to route to the kubeclaw-channel-http Service on that port. Register each user as a separate group with their JID.
5. Call setup_channel with the credentials. This stores the credentials in a K8s Secret and creates a dedicated channel pod Deployment. No orchestrator restart needed.
6. After the channel pod starts (~30s), ask the user for the chat JID (they can get it by sending /chatid to the bot). For HTTP, JIDs are http:{username} — register each user's group immediately.
7. Call register_group to register the group with direct=true.

When registering a group, confirm the details before calling register_group. After registering, inform the user that changes take effect on the next orchestrator poll (~2 seconds).`;

// ---- Shared agentic loop ----

async function runAgenticTurn(
  client: OpenAI,
  history: OpenAI.ChatCompletionMessageParam[],
  userInput: string,
): Promise<string> {
  history.push({ role: 'user', content: userInput });

  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...history],
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const msg = response.choices[0].message;
    history.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content ?? '';
    }

    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue;
      let args: ToolInput = {};
      try {
        args = JSON.parse(call.function.arguments) as ToolInput;
      } catch {
        // malformed JSON from model
      }
      let result: string;
      try {
        result = await executeTool(call.function.name, args);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      history.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
}

// ---- HTTP admin interface ----

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KubeClaw Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: 'Courier New', monospace; background: #0d0d0d; color: #c8c8c8; display: flex; flex-direction: column; height: 100vh }
  #header { padding: 10px 16px; background: #141414; border-bottom: 1px solid #2a2a2a; font-size: 12px; color: #555; display: flex; align-items: center; gap: 12px }
  #header strong { color: #4fc3f7; font-size: 13px }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px }
  .msg { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word }
  .user::before { content: '\\203A  '; color: #4fc3f7 }
  .assistant { color: #c8c8c8 }
  .assistant::before { content: '\\24  '; color: #555 }
  .status { color: #555; font-style: italic; font-size: 12px }
  #form { display: flex; gap: 8px; padding: 10px 16px; background: #141414; border-top: 1px solid #2a2a2a }
  #input { flex: 1; padding: 8px 10px; background: #1a1a1a; border: 1px solid #333; border-radius: 3px; color: #c8c8c8; font-family: inherit; font-size: 13px; outline: none }
  #input:focus { border-color: #4fc3f7 }
  #send { padding: 8px 14px; background: #0d2137; color: #4fc3f7; border: 1px solid #1e3a5f; border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 13px }
  #send:hover { background: #1e3a5f }
  #send:disabled { opacity: 0.35; cursor: default }
</style>
</head>
<body>
<div id="header"><strong>KubeClaw Admin</strong><span id="status">connecting&hellip;</span></div>
<div id="messages"></div>
<form id="form">
  <input id="input" type="text" placeholder="Enter admin command…" autocomplete="off" autofocus>
  <button id="send" type="submit">Run</button>
</form>
<script>
const msgs = document.getElementById('messages');
const statusEl = document.getElementById('status');
const input = document.getElementById('input');
const send = document.getElementById('send');

function addMsg(text, cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

const es = new EventSource('/events');
es.onopen = () => { statusEl.textContent = 'connected'; };
es.addEventListener('message', e => {
  const { type, text } = JSON.parse(e.data);
  addMsg(text, type);
});
es.onerror = () => { statusEl.textContent = 'reconnecting\u2026'; };

document.getElementById('form').addEventListener('submit', async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;
  send.disabled = true;
  addMsg(text, 'user');
  const dot = addMsg('Thinking\u2026', 'status');
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) addMsg('Error: ' + res.status, 'status');
    dot.remove();
  } catch {
    dot.textContent = 'Network error';
  }
  input.disabled = false;
  send.disabled = false;
  input.focus();
});

input.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('form').requestSubmit(); }
});
</script>
</body>
</html>`;

interface SseAdminClient {
  username: string;
  res: http.ServerResponse;
}

export function startHttpAdminServer(client?: OpenAI): void {
  if (!client) client = createLLMClient();
  const port = parseInt(process.env.ADMIN_HTTP_PORT!, 10);
  const username = process.env.ADMIN_HTTP_USERNAME || 'admin';
  const password = process.env.ADMIN_HTTP_PASSWORD || '';

  // Per-user conversation history and in-progress flag
  const histories = new Map<string, OpenAI.ChatCompletionMessageParam[]>();
  const inProgress = new Set<string>();
  const sseClients: SseAdminClient[] = [];

  function checkAuth(req: http.IncomingMessage): string | null {
    if (!password) return username; // no auth configured — accept all
    const header = req.headers.authorization;
    if (!header?.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    const u = decoded.slice(0, colon);
    const p = decoded.slice(colon + 1);
    return u === username && p === password ? u : null;
  }

  function sendUnauthorized(res: http.ServerResponse): void {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="KubeClaw Admin"' });
    res.end('Unauthorized');
  }

  function pushSse(user: string, type: string, text: string): void {
    const payload = JSON.stringify({ type, text });
    const lines =
      payload
        .split('\n')
        .map((l) => `data: ${l}`)
        .join('\n') + '\n\n';
    const dead: SseAdminClient[] = [];
    for (const c of sseClients) {
      if (c.username !== user) continue;
      try {
        if (!c.res.writableEnded) c.res.write(lines);
      } catch {
        dead.push(c);
      }
    }
    for (const c of dead) sseClients.splice(sseClients.indexOf(c), 1);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const user = checkAuth(req);

    if (!user) {
      sendUnauthorized(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(ADMIN_HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(':ok\n\n');
      const c: SseAdminClient = { username: user, res };
      sseClients.push(c);
      const ping = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
        else clearInterval(ping);
      }, 30_000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.splice(sseClients.indexOf(c), 1);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      if (inProgress.has(user)) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('Previous request still in progress');
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 65_536) req.destroy();
      });
      req.on('end', () => {
        let text: string;
        try {
          ({ text } = JSON.parse(body) as { text: string });
          if (!text?.trim()) throw new Error('empty');
        } catch {
          res.writeHead(400);
          res.end('Bad request');
          return;
        }
        res.writeHead(202);
        res.end('accepted');
        inProgress.add(user);
        if (!histories.has(user)) histories.set(user, []);
        const history = histories.get(user)!;
        runAgenticTurn(client, history, text.trim())
          .then((reply) => {
            pushSse(user, 'assistant', reply);
          })
          .catch((err) => {
            pushSse(
              user,
              'status',
              `Error: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            inProgress.delete(user);
          });
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    logger.info({ port }, 'Admin HTTP interface listening');
    console.log(`\n  Admin HTTP: http://localhost:${port}\n`);
  });
}

// ---- Readline REPL (exec mode) ----

async function runRepl(client: OpenAI): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const history: OpenAI.ChatCompletionMessageParam[] = [];

  console.log('KubeClaw Admin Shell');
  console.log(
    `Provider: ${process.env.OPENAI_BASE_URL || 'OpenAI'} | Model: ${MODEL}`,
  );
  console.log(
    'Type your request in plain English. Type "exit" or Ctrl+C to quit.\n',
  );

  rl.on('SIGINT', () => {
    console.log('\nGoodbye.');
    process.exit(0);
  });

  const prompt = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  while (true) {
    let userInput: string;
    try {
      userInput = await prompt('> ');
    } catch {
      break;
    }
    userInput = userInput.trim();
    if (!userInput) continue;
    if (userInput === 'exit' || userInput === 'quit') break;

    const reply = await runAgenticTurn(client, history, userInput);
    process.stdout.write('\n' + reply + '\n\n');
  }

  rl.close();
  console.log('Goodbye.');
}

// ---- Main ----

async function main() {
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    console.error(
      'Error: The admin shell can only be run inside the orchestrator pod.',
    );
    console.error(
      'Use: kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- node dist/admin-shell.js',
    );
    process.exit(1);
  }

  await initDatabase();

  const client: OpenAI = createLLMClient();
  const httpPort = parseInt(process.env.ADMIN_HTTP_PORT || '0', 10);

  if (httpPort) {
    startHttpAdminServer(client);
  }

  if (process.stdin.isTTY) {
    await runRepl(client);
    if (!httpPort) process.exit(0);
    // HTTP server still running — keep process alive via the server
  } else if (!httpPort) {
    console.error(
      'Attach a TTY (kubectl exec -it) or set ADMIN_HTTP_PORT to start the HTTP interface.',
    );
    process.exit(1);
  }
  // HTTP-only mode: process stays alive as long as the server is running
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Admin shell error');
    console.error('Fatal error:', (err as Error).message);
    process.exit(1);
  });
}
