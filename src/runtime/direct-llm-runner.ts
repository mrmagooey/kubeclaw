/**
 * DirectLLMRunner — calls an OpenAI-compatible API directly inside the
 * orchestrator process or a channel pod. No Kubernetes Job is spawned for
 * chat. Conversation history is persisted in SQLite per group. When the LLM
 * calls a tool, execution is delegated to a K8s tool pod (browser / execution
 * categories) or a full K8s agent job (execute_agent).
 *
 * Configure via environment variables (see src/runtime/llm-client.ts).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

import { GROUPS_DIR, KUBECLAW_CHANNEL, KUBECLAW_MODE } from '../config.js';
import { getConversationHistory, appendConversationMessage } from '../db.js';
import { indexConversationTurn } from '../rag/indexer.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import {
  AgentRunner,
  ContainerInput,
  ContainerOutput,
  Task,
  AvailableGroup,
} from './types.js';
import { createLLMClient, DEFAULT_DIRECT_MODEL } from './llm-client.js';
import { jobRunner } from '../k8s/job-runner.js';
import type { McpServerStatus, ToolSpec } from '../types.js';
import { McpManager } from './mcp-manager.js';
import {
  getAgentJobResultStream,
  getRedisClient,
  getSpawnAgentJobStream,
  getSpawnToolPodStream,
  getTaskRequestStream,
  getToolCallsStream,
  getToolResultsStream,
} from '../k8s/redis-client.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Be concise and direct in your responses.';

const MAX_TOOL_ROUNDS = 10;
const TOOL_TIMEOUT_MS = 60_000; // 60 s per tool call
const AGENT_JOB_TIMEOUT_MS = 300_000; // 5 min for full agent jobs

// ---- Tool definitions ----

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch the content of a URL. Use when the user asks to visit a website or read a specific page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for a query. Use when the user asks to look something up or find current information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser',
      description:
        'Control a real web browser (Playwright). Use for JavaScript-heavy pages, filling forms, clicking, or any interaction that plain fetching cannot handle.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Natural language instruction for what to do in the browser',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a bash command in an isolated container. Use for scripts, data processing, file operations, or anything requiring a shell.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds (default 30)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_agent',
      description:
        'Spawn a full Claude Code agent for complex, multi-step coding tasks: writing or editing code, running tests, installing packages, browsing the codebase. Use when the task requires sustained agentic work beyond a single command.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'Complete description of the task for the agent to perform',
          },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        'Schedule a recurring or one-time task. The task will run automatically and send results to the current chat.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What the task should do each time it runs',
          },
          schedule_type: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
            description:
              'cron = cron expression, interval = repeat every N ms, once = run once at a specific time',
          },
          schedule_value: {
            type: 'string',
            description:
              'Cron expression (e.g. "0 9 * * 1-5"), interval in milliseconds (e.g. "300000" for 5min), or ISO datetime for once',
          },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description:
        'List all scheduled tasks for the current chat. Shows task ID, prompt, schedule, status, and next run time.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Cancel (delete) a scheduled task by its ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to cancel' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_task',
      description: 'Pause or resume a scheduled task by its ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID to pause or resume',
          },
          action: {
            type: 'string',
            enum: ['pause', 'resume'],
            description: 'Whether to pause or resume the task',
          },
        },
        required: ['task_id', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deploy_mcp_server',
      description:
        'Deploy an MCP (Model Context Protocol) server as a Kubernetes pod. The server exposes tools that become available to the agent. Main group only.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Unique name for this MCP server (e.g. "weather", "calendar")',
          },
          image: {
            type: 'string',
            description:
              'Container image for the MCP server (e.g. "mcp/weather-server:latest")',
          },
          port: {
            type: 'number',
            description: 'Port the MCP server listens on (default 3000)',
          },
          path: {
            type: 'string',
            description: 'MCP endpoint path (default "/mcp")',
          },
          channels: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Which channels can access this server (e.g. ["telegram", "http"]). Empty = all channels.',
          },
          env: {
            type: 'object',
            description: 'Environment variables for the MCP server container',
          },
        },
        required: ['name', 'image'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_mcp_server',
      description: 'Remove an MCP server pod and its service. Main group only.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the MCP server to remove',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_mcp_servers',
      description: 'List all deployed MCP servers and their configuration.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

// Translate LLM-facing tool names to the names the tool server expects
const TOOL_SERVER_NAME: Record<string, string> = {
  web_fetch: 'webFetch',
  web_search: 'webSearch',
  browser: 'agentBrowser',
  bash: 'bash',
};

// Map LLM tool name → tool pod category
const TOOL_CATEGORY: Record<string, 'browser' | 'execution'> = {
  web_fetch: 'browser',
  web_search: 'browser',
  browser: 'browser',
  bash: 'execution',
};

// ---- K8s tool pod dispatch ----

async function executeToolViaK8s(
  agentJobId: string,
  groupFolder: string,
  toolName: string,
  args: Record<string, unknown>,
  spawnedCategories: Set<string>,
  group?: RegisteredGroup,
): Promise<string> {
  const isCustomTool = !TOOL_CATEGORY[toolName];
  const category = TOOL_CATEGORY[toolName] ?? toolName;
  const serverToolName = TOOL_SERVER_NAME[toolName] ?? toolName;
  const requestId = crypto.randomUUID();
  const redis = getRedisClient();

  const callsStream = getToolCallsStream(agentJobId, category);
  const resultsStream = getToolResultsStream(agentJobId, category);

  // Write call BEFORE spawning pod so the pod picks it up with lastId='0-0'
  await redis.xadd(
    callsStream,
    '*',
    'requestId',
    requestId,
    'tool',
    serverToolName,
    'input',
    JSON.stringify(args),
  );

  // Spawn pod once per category per runAgent() invocation
  if (!spawnedCategories.has(category)) {
    spawnedCategories.add(category);
    const customSpec = isCustomTool
      ? (group?.containerConfig?.tools ?? []).find((t) => t.name === toolName)
      : undefined;

    if (KUBECLAW_MODE === 'channel') {
      const spawnFields: string[] = [
        'agentJobId',
        agentJobId,
        'groupFolder',
        groupFolder,
        'category',
        category,
        'timeout',
        String(TOOL_TIMEOUT_MS),
        'channel',
        KUBECLAW_CHANNEL,
      ];
      if (customSpec) {
        spawnFields.push(
          'toolImage',
          customSpec.image,
          'toolPattern',
          customSpec.pattern,
          'toolPort',
          String(customSpec.port ?? 8080),
        );
        if (customSpec.acpAgentName)
          spawnFields.push('toolAcpAgentName', customSpec.acpAgentName);
        if (customSpec.acpMode)
          spawnFields.push('toolAcpMode', customSpec.acpMode);
      }
      await redis.xadd(getSpawnToolPodStream(), '*', ...spawnFields);
      logger.debug(
        { agentJobId, category },
        'DirectLLMRunner: requested tool pod from orchestrator',
      );
    } else if (customSpec) {
      await jobRunner.createSidecarToolPodJob({
        agentJobId,
        groupFolder,
        toolName,
        toolSpec: customSpec,
        timeout: TOOL_TIMEOUT_MS,
      });
      logger.debug(
        { agentJobId, toolName },
        'DirectLLMRunner: spawned sidecar tool pod',
      );
    } else {
      await jobRunner.createToolPodJob({
        agentJobId,
        groupFolder,
        category: category as 'browser' | 'execution',
        timeout: TOOL_TIMEOUT_MS,
      });
      logger.debug(
        { agentJobId, category },
        'DirectLLMRunner: spawned tool pod',
      );
    }
  }

  // Block-read results stream until matching requestId arrives or timeout
  const deadline = Date.now() + TOOL_TIMEOUT_MS;
  let lastId = '0-0';

  while (Date.now() < deadline) {
    const blockMs = Math.min(deadline - Date.now(), 5000);
    const response = await redis.xread(
      'COUNT',
      10,
      'BLOCK',
      blockMs,
      'STREAMS',
      resultsStream,
      lastId,
    );
    if (!response) continue;

    for (const [, messages] of response as [string, [string, string[]][]][]) {
      for (const [msgId, fields] of messages) {
        lastId = msgId;
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2)
          obj[fields[i]] = fields[i + 1];
        if (obj.requestId !== requestId) continue;
        if (obj.error) return `Tool error: ${obj.error}`;
        try {
          const parsed = JSON.parse(obj.result ?? 'null');
          return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        } catch {
          return obj.result ?? '';
        }
      }
    }
  }

  return `Tool timed out after ${TOOL_TIMEOUT_MS / 1000}s`;
}

// ---- K8s agent job dispatch ----

async function executeAgentJob(
  groupFolder: string,
  chatJid: string,
  task: string,
): Promise<string> {
  const redis = getRedisClient();
  const agentJobId = `agent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const resultStream = getAgentJobResultStream(agentJobId);

  if (KUBECLAW_MODE === 'channel') {
    // Delegate to orchestrator via Redis stream
    await redis.xadd(
      getSpawnAgentJobStream(),
      '*',
      'agentJobId',
      agentJobId,
      'groupFolder',
      groupFolder,
      'chatJid',
      chatJid,
      'prompt',
      task,
      'timeout',
      String(AGENT_JOB_TIMEOUT_MS),
      'channel',
      KUBECLAW_CHANNEL,
    );
    logger.debug(
      { agentJobId },
      'DirectLLMRunner: requested agent job from orchestrator',
    );
  } else {
    // Orchestrator spawns agent job directly and writes result to Redis
    const group: RegisteredGroup = {
      name: groupFolder,
      folder: groupFolder,
      trigger: '',
      added_at: new Date().toISOString(),
    };
    // Run asynchronously and write result to stream when done
    jobRunner
      .runAgentJob(group, { groupFolder, chatJid, isMain: false, prompt: task })
      .then(
        async (output) => {
          const result = output.result ?? output.error ?? 'Agent job completed';
          await redis.xadd(
            resultStream,
            '*',
            'result',
            String(result),
            'status',
            output.status,
          );
        },
        async (err) => {
          await redis.xadd(
            resultStream,
            '*',
            'result',
            String(err),
            'status',
            'error',
          );
        },
      );
  }

  // Block-read for the final result
  const deadline = Date.now() + AGENT_JOB_TIMEOUT_MS;
  let lastId = '0-0';

  while (Date.now() < deadline) {
    const blockMs = Math.min(deadline - Date.now(), 10_000);
    const response = await redis.xread(
      'COUNT',
      1,
      'BLOCK',
      blockMs,
      'STREAMS',
      resultStream,
      lastId,
    );
    if (!response) continue;

    for (const [, messages] of response as [string, [string, string[]][]][]) {
      for (const [, fields] of messages) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2)
          obj[fields[i]] = fields[i + 1];
        return obj.result ?? 'Agent job completed with no output';
      }
    }
  }

  return `Agent job timed out after ${AGENT_JOB_TIMEOUT_MS / 1000}s`;
}

// ---- Schedule task via Redis IPC ----

async function scheduleTaskDirect(
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
  args: Record<string, unknown>,
): Promise<string> {
  const redis = getRedisClient();
  const taskId = `task-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const resultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  await redis.xadd(
    getTaskRequestStream(),
    '*',
    'type',
    'schedule_task',
    'taskId',
    taskId,
    'groupFolder',
    groupFolder,
    'chatJid',
    chatJid,
    'isMain',
    String(isMain),
    'prompt',
    args.prompt as string,
    'schedule_type',
    args.schedule_type as string,
    'schedule_value',
    args.schedule_value as string,
    'context_mode',
    'isolated',
    'resultStream',
    resultStream,
  );

  // Check for rejection (limit exceeded, duplicate)
  const deadline = Date.now() + 5000;
  let lastId = '0-0';
  while (Date.now() < deadline) {
    const response = await redis.xread(
      'COUNT',
      1,
      'BLOCK',
      1000,
      'STREAMS',
      resultStream,
      lastId,
    );
    if (!response) continue;
    for (const [, messages] of response as [string, [string, string[]][]][]) {
      for (const [, fields] of messages) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2)
          obj[fields[i]] = fields[i + 1];
        return obj.result ?? `Scheduled task "${taskId}".`;
      }
    }
  }

  // No rejection received — task was created successfully
  return `Scheduled task "${taskId}" (${args.schedule_type}: ${args.schedule_value}). It will run automatically.`;
}

// ---- Task management via Redis IPC ----

async function manageTaskDirect(
  groupFolder: string,
  action: string,
  args: Record<string, unknown>,
): Promise<string> {
  const redis = getRedisClient();
  const resultStream = `kubeclaw:task-mgmt-result:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  await redis.xadd(
    getTaskRequestStream(),
    '*',
    'type',
    action,
    'groupFolder',
    groupFolder,
    'resultStream',
    resultStream,
    ...(args.task_id ? ['taskId', args.task_id as string] : []),
    ...(args.action ? ['action', args.action as string] : []),
  );

  // Wait for result from orchestrator
  const deadline = Date.now() + 10_000;
  let lastId = '0-0';
  while (Date.now() < deadline) {
    const response = await redis.xread(
      'COUNT',
      1,
      'BLOCK',
      2000,
      'STREAMS',
      resultStream,
      lastId,
    );
    if (!response) continue;
    for (const [, messages] of response as [string, [string, string[]][]][]) {
      for (const [, fields] of messages) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2)
          obj[fields[i]] = fields[i + 1];
        return obj.result ?? 'No response.';
      }
    }
  }
  return 'Timed out waiting for task management response.';
}

// ---- MCP server management via Redis IPC ----

async function mcpServerAction(
  groupFolder: string,
  isMain: boolean,
  action: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!isMain && action !== 'list_mcp_servers') {
    return 'Only the main group can deploy or remove MCP servers.';
  }

  const redis = getRedisClient();

  if (action === 'deploy_mcp_server') {
    const fields: string[] = [
      'type',
      'deploy_mcp_server',
      'groupFolder',
      groupFolder,
      'isMain',
      String(isMain),
      'name',
      args.name as string,
      'image',
      args.image as string,
    ];
    if (args.port) fields.push('port', String(args.port));
    if (args.path) fields.push('path', args.path as string);
    if (args.command) fields.push('command', JSON.stringify(args.command));
    if (args.env) fields.push('env', JSON.stringify(args.env));
    if (args.channels) fields.push('channels', JSON.stringify(args.channels));
    if (args.allowedTools)
      fields.push('allowedTools', JSON.stringify(args.allowedTools));
    if (args.resources)
      fields.push('resources', JSON.stringify(args.resources));

    await redis.xadd(getTaskRequestStream(), '*', ...fields);
    return `MCP server "${args.name}" deployment requested. It will be available shortly.`;
  }

  if (action === 'remove_mcp_server') {
    await redis.xadd(
      getTaskRequestStream(),
      '*',
      'type',
      'remove_mcp_server',
      'groupFolder',
      groupFolder,
      'isMain',
      String(isMain),
      'name',
      args.name as string,
    );
    return `MCP server "${args.name}" removal requested.`;
  }

  if (action === 'list_mcp_servers') {
    const resultStream = `kubeclaw:mcp-list-result:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await redis.xadd(
      getTaskRequestStream(),
      '*',
      'type',
      'list_mcp_servers',
      'groupFolder',
      groupFolder,
      'isMain',
      String(isMain),
      'resultStream',
      resultStream,
    );

    // Wait for result
    const deadline = Date.now() + 10_000;
    let lastId = '0-0';
    while (Date.now() < deadline) {
      const response = await redis.xread(
        'COUNT',
        1,
        'BLOCK',
        2000,
        'STREAMS',
        resultStream,
        lastId,
      );
      if (!response) continue;
      for (const [, messages] of response as [string, [string, string[]][]][]) {
        for (const [, fields] of messages) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            obj[fields[i]] = fields[i + 1];
          return obj.result ?? 'No MCP servers found.';
        }
      }
    }
    return 'Timed out waiting for MCP server list.';
  }

  return `Unknown MCP action: ${action}`;
}

// ---- Runner ----

function getModel(group: RegisteredGroup): string {
  const p = group.llmProvider;
  if (p && p !== 'claude' && p !== 'openrouter') return p;
  return DEFAULT_DIRECT_MODEL;
}

function loadSystemPrompt(groupFolder: string): string {
  const claudeMd = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  try {
    const content = fs.readFileSync(claudeMd, 'utf-8');
    if (content.trim()) return content.trim();
  } catch {
    // File missing — use default
  }
  return DEFAULT_SYSTEM_PROMPT;
}

export class DirectLLMRunner implements AgentRunner {
  private client: OpenAI;
  private mcpManager: McpManager | null = null;

  constructor(client?: OpenAI) {
    this.client = client ?? createLLMClient();
  }

  /**
   * Configure MCP server connections. Can be called multiple times
   * to reconfigure (e.g. when mcp_update control message arrives).
   */
  async configureMcp(servers: McpServerStatus[]): Promise<void> {
    if (this.mcpManager) {
      await this.mcpManager.reconfigure(servers);
    } else {
      this.mcpManager = new McpManager();
      await this.mcpManager.initialize(servers);
    }
  }

  async runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    _onProcess?: (proc: unknown, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    const model = getModel(group);
    const systemPrompt = loadSystemPrompt(input.groupFolder);
    // Isolated scheduled tasks run without conversation history to avoid
    // polluting the user's chat context and accumulating token cost.
    const useHistory = !(
      input.isScheduledTask && input.sessionId === undefined
    );
    const history = useHistory ? getConversationHistory(input.groupFolder) : [];

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: input.prompt },
    ];

    const agentJobId = `direct-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const spawnedCategories = new Set<string>();

    const customToolDefs: OpenAI.ChatCompletionTool[] = (
      group.containerConfig?.tools ?? []
    ).map((t: ToolSpec) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    const mcpTools = this.mcpManager?.getTools() ?? [];
    const effectiveTools = [...TOOLS, ...customToolDefs, ...mcpTools];

    logger.debug(
      { group: group.name, model, historyLen: history.length },
      'DirectLLMRunner: calling API',
    );

    let fullResponse = '';
    let toolRounds = 0;

    try {
      while (toolRounds <= MAX_TOOL_ROUNDS) {
        const response = await this.client.chat.completions.create({
          model,
          messages,
          tools: effectiveTools,
          tool_choice: 'auto',
        });

        const msg = response.choices[0].message;
        messages.push(msg);

        const toolCalls =
          msg.tool_calls?.filter((c) => c.type === 'function') ?? [];

        if (toolCalls.length === 0) {
          fullResponse = msg.content ?? '';
          break;
        }

        toolRounds++;
        logger.debug(
          {
            group: group.name,
            toolRounds,
            tools: toolCalls.map((c) => c.function.name),
          },
          'DirectLLMRunner: executing tools',
        );

        for (const call of toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments) as Record<
              string,
              unknown
            >;
          } catch {
            // ignore parse errors
          }

          let result: string;
          try {
            if (call.function.name === 'schedule_task') {
              result = await scheduleTaskDirect(
                input.groupFolder,
                input.chatJid,
                input.isMain,
                args,
              );
            } else if (
              call.function.name === 'list_tasks' ||
              call.function.name === 'cancel_task' ||
              call.function.name === 'pause_task'
            ) {
              result = await manageTaskDirect(
                input.groupFolder,
                call.function.name,
                args,
              );
            } else if (call.function.name === 'execute_agent') {
              result = await executeAgentJob(
                input.groupFolder,
                input.chatJid,
                args.task as string,
              );
            } else if (
              call.function.name === 'deploy_mcp_server' ||
              call.function.name === 'remove_mcp_server' ||
              call.function.name === 'list_mcp_servers'
            ) {
              result = await mcpServerAction(
                input.groupFolder,
                input.isMain,
                call.function.name,
                args,
              );
            } else if (this.mcpManager?.hasTool(call.function.name)) {
              result = await this.mcpManager.callTool(call.function.name, args);
            } else {
              result = await executeToolViaK8s(
                agentJobId,
                input.groupFolder,
                call.function.name,
                args,
                spawnedCategories,
                group,
              );
            }
          } catch (err) {
            result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result,
          });
        }
      }

      if (useHistory) {
        appendConversationMessage(input.groupFolder, 'user', input.prompt);
        appendConversationMessage(input.groupFolder, 'assistant', fullResponse);
      }

      if (fullResponse) {
        void indexConversationTurn(
          input.groupFolder,
          input.prompt,
          fullResponse,
        );
      }

      const result: ContainerOutput = {
        status: 'success',
        result: fullResponse,
      };
      if (onOutput) await onOutput(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ group: group.name, error }, 'DirectLLMRunner: API error');
      const result: ContainerOutput = { status: 'error', result: null, error };
      if (onOutput) await onOutput(result);
      return result;
    }
  }

  writeTasksSnapshot(
    _groupFolder: string,
    _isMain: boolean,
    _tasks: Task[],
  ): void {
    // No-op
  }

  writeGroupsSnapshot(
    _groupFolder: string,
    _isMain: boolean,
    _groups: AvailableGroup[],
    _registeredJids: Set<string>,
  ): void {
    // No-op
  }

  async shutdown(): Promise<void> {
    await this.mcpManager?.shutdown();
    this.mcpManager = null;
  }
}
