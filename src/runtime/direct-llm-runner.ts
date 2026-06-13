/**
 * DirectLLMRunner — calls an OpenAI-compatible API directly inside the
 * orchestrator process or a channel pod. No Kubernetes Job is spawned for
 * chat. Conversation history is persisted in SQLite per group. When the LLM
 * calls a tool, execution is delegated to a K8s tool pod (browser / execution
 * categories) or a full K8s tool job (execute_agent).
 *
 * Configure via environment variables (see src/runtime/llm-client.ts).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

import { GROUPS_DIR, KUBECLAW_CHANNEL, KUBECLAW_MODE } from '../config.js';
import {
  getConversationHistory,
  appendConversationMessage,
  appendConversationHistory,
  getLatestSummary,
  insertSummary,
  deleteMessagesByIds,
  getGroupProfile,
} from '../db.js';
import { estimateMessagesTokens } from './compression/token-estimate.js';
import { summarize } from './compression/summarizer.js';
import { getRagProvider } from '../rag/provider.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import {
  MessageRunner,
  ContainerInput,
  ContainerOutput,
  Task,
  AvailableGroup,
  RunAgentOverrides,
  LocalTool,
} from './types.js';
export type { RunAgentOverrides };
import { createLLMClient, DEFAULT_DIRECT_MODEL } from './llm-client.js';
import { jobRunner } from '../k8s/job-runner.js';
import type { McpServerStatus, ToolSpec } from '../types.js';
import type { GroupMcpEntry } from '../capabilities/types.js';
import { McpManager } from './mcp-manager.js';
import type { ChannelMetrics } from '../metrics/channel.js';
import {
  getToolJobResultStream,
  getRedisClient,
  getSpawnToolJobStream,
  getSpawnToolPodStream,
  getTaskRequestStream,
  getToolCallsStream,
  getToolResultsStream,
} from '../k8s/redis-client.js';
import { loadSkills } from './skill-loader.js';
import { proposeSkill, DupCheckFn } from './tools/propose-skill.js';
import { makeSetReminderTool } from './tools/set-reminder.js';
import { resolveToolByName } from '../tools/reconciler.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Be concise and direct in your responses. ' +
  'When a user asks to be reminded about something, use `set_reminder` (preferred) or ' +
  '`schedule_task` with `schedule_type: "once"` and a resolved absolute ISO 8601 datetime; ' +
  'never pass relative phrases like "in 3 days" as the schedule_value.';

const RECOMMENDATION_CONTRACT = `

## Recommendation guidelines

When the user asks for a recommendation (restaurants, films, activities, products, or any
"best X near me / for me" request), follow this contract:

1. **Profile** — call \`read_user_profile\` first. Use the returned fields (location,
   cuisine_likes, cuisine_dislikes, dietary_restrictions, budget_tier) to tailor results.
   If the profile is empty (\`{}\`), ask a single clarifying question about location before
   proceeding.

2. **Search** — call \`places_search\` (or \`web_search\` if \`places_search\` is unavailable)
   with a query that incorporates the user's location and any constraints already known.

3. **Refinement** — if the user adds a constraint ("cheaper", "closer", "vegetarian"),
   re-invoke \`places_search\` with the updated query rather than answering from memory.
   Conversation history already contains the prior results; you do not need to repeat them.

4. **Present results** — return a short ranked list (3–5 items) with:
   - **Name** and address / area
   - One-line reason why it fits this user
   - Source citation (URL or "via places_search")

Do not give a recommendation without calling at least one search tool — hallucinated
restaurant names cause real harm.
`;

/**
 * Opt-out sentinel for the recommendation contract.
 *
 * If a group's CLAUDE.md contains the exact string
 *   <!-- no-recommendation-contract -->
 * as its FIRST line, the RECOMMENDATION_CONTRACT block above will NOT be
 * appended to the system prompt for that group.  This lets individual groups
 * (e.g. developer/admin groups) suppress the recommendation flow entirely.
 *
 * To opt out, open the group's CLAUDE.md file and add the sentinel as the
 * very first line before any other content.
 */
const RECOMMENDATION_CONTRACT_OPT_OUT = '<!-- no-recommendation-contract -->';

const MAX_TOOL_ROUNDS = 10;
const TOOL_TIMEOUT_MS = 60_000; // 60 s per tool call
const TOOL_JOB_TIMEOUT_MS = 300_000; // 5 min for full tool jobs

// ---- Context compression thresholds ----

const COMPRESSION_THRESHOLD_MESSAGES = parseInt(
  process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES || '50',
  10,
);
const COMPRESSION_THRESHOLD_TOKENS = parseInt(
  process.env.KUBECLAW_COMPRESSION_THRESHOLD_TOKENS || '32000',
  10,
);

/** Exported for unit testing only. */
export function shouldCompress(
  messageCount: number,
  tokenEstimate: number,
  thresholdMessages: number,
  thresholdTokens: number,
): boolean {
  const msgCheck = thresholdMessages > 0 && messageCount > thresholdMessages;
  const tokenCheck = thresholdTokens > 0 && tokenEstimate > thresholdTokens;
  return msgCheck || tokenCheck;
}

// ---- Tool definitions ----

export const TOOLS: OpenAI.ChatCompletionFunctionTool[] = [
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
        'Search the web for a query. Returns a JSON array of up to 10 results, each with ' +
        'fields: title (string), url (string), snippet (string — the most relevant excerpt), ' +
        'published (ISO date string, optional), source (hostname, optional). ' +
        'Use when the user asks to look something up or find current information.',
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
      name: 'execute_agent',
      description:
        'Spawn a full coding agent for complex, multi-step coding tasks: writing or editing code, running tests, installing packages, browsing the codebase. Use when the task requires sustained agentic work beyond a single command.',
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
        'Schedule a recurring or one-time task. The task will run automatically and send results ' +
        'to the current chat. For one-time reminders, prefer `set_reminder` instead. ' +
        'When scheduling a `once` task, `schedule_value` MUST be an absolute ISO 8601 datetime ' +
        'string (e.g. "2026-06-01T09:00:00Z"). Resolve any relative expression like "in 3 days" ' +
        'to a concrete datetime before calling this tool.',
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
              'Cron expression (e.g. "0 9 * * 1-5"), interval in milliseconds (e.g. "300000" for 5 min), ' +
              'or absolute ISO 8601 datetime for once (e.g. "2026-06-01T09:00:00Z"). ' +
              'For `once` tasks, this MUST be an absolute datetime — never a relative phrase like "in 3 days".',
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
  {
    type: 'function',
    function: {
      name: 'propose_skill',
      description:
        'Capture a reusable instruction or pattern as a skill candidate. Use when the user has just taught you something they want remembered for future conversations (a correction, a preferred tool, a non-obvious pattern). Will stage a candidate that the user reviews via /skills review.',
      parameters: {
        type: 'object',
        properties: {
          proposed_name: {
            type: 'string',
            description: 'kebab-case slug (e.g. prefer-rg-over-grep)',
          },
          description: {
            type: 'string',
            description: 'one-line, specific, what triggers it',
          },
          body: {
            type: 'string',
            description: 'markdown body of the instruction',
          },
          rationale: {
            type: 'string',
            description: 'why this is worth keeping; shown to the user',
          },
        },
        required: ['proposed_name', 'description', 'body', 'rationale'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'places_search',
      description:
        'Search for local places (restaurants, cafés, shops, attractions) near a given location. ' +
        'Returns a ranked list of results with name, address, rating, price tier, and a brief description. ' +
        'Use when the user asks for recommendations for a place to eat, visit, or shop.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'What to search for, e.g. "Italian restaurants", "coffee shops", "bookstores"',
          },
          location: {
            type: 'string',
            description:
              'Where to search, e.g. "Melbourne CBD, Australia", "Brooklyn, NY". ' +
              'Omit to use the profile location if available.',
          },
          max_results: {
            type: 'number',
            description:
              'Maximum number of results to return (default 5, max 10)',
          },
        },
        required: ['query'],
      },
    },
  },
];

/**
 * Set of tool names the LLM is authorised to call.  Used as a cardinality
 * guard when recording metrics: any name the LLM fabricates that is not in
 * this set is bucketed as 'unknown' so Prometheus label cardinality stays
 * bounded.  Derived from the static TOOLS list; custom / MCP tools are added
 * at dispatch time (see recordToolCall call site in runAgent).
 */
const STATIC_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOLS.map((t) => t.function.name),
);

// Translate LLM-facing tool names to the names the tool server expects
const TOOL_SERVER_NAME: Record<string, string> = {
  web_fetch: 'webFetch',
  web_search: 'webSearch',
  browser: 'agentBrowser',
  places_search: 'placesSearch',
};

// Map LLM tool name → tool pod category
const TOOL_CATEGORY: Record<string, 'browser' | 'execution'> = {
  web_fetch: 'browser',
  web_search: 'browser',
  browser: 'browser',
  places_search: 'browser',
};

// ---- Catalog tool definitions ----

export function buildCatalogToolDefs(
  tools: ToolSpec[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ---- K8s tool pod dispatch ----

async function executeToolViaK8s(
  toolJobId: string,
  groupFolder: string,
  toolName: string,
  args: Record<string, unknown>,
  spawnedCategories: Set<string>,
  maxToolOutputBytes?: number,
): Promise<string> {
  const isCustomTool = !TOOL_CATEGORY[toolName];
  const category = TOOL_CATEGORY[toolName] ?? toolName;
  const serverToolName = TOOL_SERVER_NAME[toolName] ?? toolName;
  const requestId = crypto.randomUUID();
  const redis = getRedisClient();

  const callsStream = getToolCallsStream(toolJobId, category);
  const resultsStream = getToolResultsStream(toolJobId, category);

  // In direct (orchestrator) mode, resolve the catalog spec up front so an
  // unknown tool fails before we write an orphaned tool-call stream entry.
  const directSpec =
    KUBECLAW_MODE !== 'channel' && isCustomTool
      ? resolveToolByName(toolName)
      : undefined;
  if (KUBECLAW_MODE !== 'channel' && isCustomTool && !directSpec) {
    return `Tool error: unknown tool ${toolName}`;
  }

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

    if (KUBECLAW_MODE === 'channel') {
      const spawnFields: string[] = [
        'agentJobId',
        toolJobId,
        'groupFolder',
        groupFolder,
        'category',
        category,
        'timeout',
        String(TOOL_TIMEOUT_MS),
        'channel',
        KUBECLAW_CHANNEL,
      ];
      if (maxToolOutputBytes !== undefined) {
        spawnFields.push('maxToolOutputBytes', String(maxToolOutputBytes));
      }
      await redis.xadd(getSpawnToolPodStream(), '*', ...spawnFields);
      logger.debug(
        { toolJobId, category },
        'DirectLLMRunner: requested tool pod from orchestrator',
      );
    } else {
      if (directSpec) {
        await jobRunner.createSidecarToolPodJob({
          agentJobId: toolJobId,
          groupFolder,
          toolName,
          toolSpec: directSpec,
          timeout: TOOL_TIMEOUT_MS,
        });
        logger.debug(
          { toolJobId, toolName },
          'DirectLLMRunner: spawned sidecar tool pod',
        );
      } else {
        await jobRunner.createToolPodJob({
          agentJobId: toolJobId,
          groupFolder,
          category: category as 'browser' | 'execution',
          timeout: TOOL_TIMEOUT_MS,
          maxToolOutputBytes,
        });
        logger.debug(
          { toolJobId, category },
          'DirectLLMRunner: spawned tool pod',
        );
      }
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

// ---- K8s tool job dispatch ----

async function executeToolJob(
  groupFolder: string,
  chatJid: string,
  task: string,
  originMessageId?: string | null,
): Promise<string> {
  const redis = getRedisClient();
  const toolJobId = `agent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const resultStream = getToolJobResultStream(toolJobId);

  if (KUBECLAW_MODE === 'channel') {
    // Delegate to orchestrator via Redis stream.
    // Include the originMessageId so the orchestrator can store it in
    // tool_jobs.message_id for accurate interruption notices (Story 37 AC2).
    const spawnFields: string[] = [
      'agentJobId',
      toolJobId,
      'groupFolder',
      groupFolder,
      'chatJid',
      chatJid,
      'prompt',
      task,
      'timeout',
      String(TOOL_JOB_TIMEOUT_MS),
      'channel',
      KUBECLAW_CHANNEL,
    ];
    if (originMessageId) {
      spawnFields.push('messageId', originMessageId);
    }
    await redis.xadd(getSpawnToolJobStream(), '*', ...spawnFields);
    logger.debug(
      { toolJobId },
      'DirectLLMRunner: requested tool job from orchestrator',
    );
  } else {
    // Orchestrator spawns tool job directly and writes result to Redis
    const group: RegisteredGroup = {
      name: groupFolder,
      folder: groupFolder,
      trigger: '',
      added_at: new Date().toISOString(),
    };
    // Run asynchronously and write result to stream when done
    jobRunner
      .runToolJob(group, { groupFolder, chatJid, isMain: false, prompt: task })
      .then(
        async (output) => {
          const result = output.result ?? output.error ?? 'Tool job completed';
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
  const deadline = Date.now() + TOOL_JOB_TIMEOUT_MS;
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
        return obj.result ?? 'Tool job completed with no output';
      }
    }
  }

  return `Tool job timed out after ${TOOL_JOB_TIMEOUT_MS / 1000}s`;
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
    const spec = {
      kind: 'mcp' as const,
      name: args.name as string,
      image: args.image as string,
      ...(args.port ? { port: Number(args.port) } : {}),
      ...(args.path ? { path: args.path as string } : {}),
      ...(args.command ? { command: args.command as string[] } : {}),
      ...(args.env ? { env: args.env as Record<string, string> } : {}),
      ...(args.channels ? { channels: args.channels as string[] } : {}),
      ...(args.allowedTools
        ? { allowedTools: args.allowedTools as string[] }
        : {}),
      ...(args.resources
        ? { resources: args.resources as Record<string, unknown> }
        : {}),
    };
    await redis.xadd(
      getTaskRequestStream(),
      '*',
      'type',
      'install_capability',
      'groupFolder',
      groupFolder,
      'isMain',
      String(isMain),
      'spec',
      JSON.stringify(spec),
    );
    return `MCP server "${args.name}" deployment requested. It will be available shortly.`;
  }

  if (action === 'remove_mcp_server') {
    await redis.xadd(
      getTaskRequestStream(),
      '*',
      'type',
      'remove_capability',
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
    const resultStream = `kubeclaw:capabilities-list-result:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await redis.xadd(
      getTaskRequestStream(),
      '*',
      'type',
      'list_capabilities',
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
          if (!obj.result) return 'No MCP servers found.';
          try {
            const all = JSON.parse(obj.result) as Array<{ kind: string }>;
            const mcpServers = all.filter((c) => c.kind === 'mcp');
            if (mcpServers.length === 0) return 'No MCP servers deployed.';
            return JSON.stringify(mcpServers, null, 2);
          } catch {
            return obj.result;
          }
        }
      }
    }
    return 'Timed out waiting for MCP server list.';
  }

  return `Unknown MCP action: ${action}`;
}

// ---- Runner ----

function getModel(
  group: RegisteredGroup,
  llmProviderOverride?: string,
): string {
  const p = llmProviderOverride ?? group.llmProvider;
  if (p && p !== 'claude' && p !== 'openrouter') return p;
  return DEFAULT_DIRECT_MODEL;
}

function loadSystemPrompt(
  groupFolder: string,
  groupsDir: string = GROUPS_DIR,
): string {
  const claudeMd = path.join(groupsDir, groupFolder, 'CLAUDE.md');
  let base = DEFAULT_SYSTEM_PROMPT;
  try {
    const content = fs.readFileSync(claudeMd, 'utf-8');
    if (content.trim()) base = content.trim();
  } catch {
    // file missing — use default
  }

  // Append recommendation contract unless the prompt explicitly opts out.
  const hasOptOut = base.includes(RECOMMENDATION_CONTRACT_OPT_OUT);
  if (!hasOptOut) {
    base = base + RECOMMENDATION_CONTRACT;
  }

  let prompt = base;
  try {
    const { promptSuffix } = loadSkills(groupsDir, groupFolder);
    if (promptSuffix) prompt = base + promptSuffix;
  } catch (err) {
    logger.warn({ err, groupFolder }, 'skill-loader failed; using base prompt');
  }

  // Append per-group profile section when a profile row exists and has content.
  const profile = getGroupProfile(groupFolder);
  if (profile) {
    const bullets: string[] = [];
    if (profile.timezone) bullets.push(`- **Timezone:** ${profile.timezone}`);
    if (profile.location) bullets.push(`- **Location:** ${profile.location}`);
    if (profile.cuisineLikes)
      bullets.push(`- **Cuisine likes:** ${profile.cuisineLikes}`);
    if (profile.cuisineDislikes)
      bullets.push(`- **Cuisine dislikes:** ${profile.cuisineDislikes}`);
    if (profile.dietaryRestrictions)
      bullets.push(
        `- **Dietary restrictions:** ${profile.dietaryRestrictions}`,
      );
    if (profile.budgetTier)
      bullets.push(`- **Budget tier:** ${profile.budgetTier}`);
    if (bullets.length > 0) {
      prompt += `\n\n## Your profile\n${bullets.join('\n')}`;
    }
  }

  return prompt;
}

/**
 * @internal Test-only: exposes loadSystemPrompt with an explicit groupsDir so
 * unit tests can point it at a temp directory without needing the real FS layout.
 */
export function _loadSystemPromptForTest(
  groupFolder: string,
  groupsDir: string,
): string {
  return loadSystemPrompt(groupFolder, groupsDir);
}

/**
 * Strip the `<context ... />` XML header that formatMessages() prepends to
 * every formatted prompt before the string is persisted to conversation
 * history or RAG storage. The header carries ephemeral metadata
 * (current_time, timezone) that should influence the LLM for the current
 * turn only — storing it would pollute history with stale timestamps.
 *
 * The header has the form (single line, self-closing):
 *   <context timezone="..." current_time="..." />
 *
 * If no such header is present the original string is returned unchanged,
 * so callers that already pass plain text (e.g. scheduled tasks, tests) are
 * unaffected.
 *
 * Exported for unit testing only.
 */
export function stripContextHeader(prompt: string): string {
  return prompt.replace(/^<context [^/]*\/>\n?/, '');
}

/** Derive a stable provider label from the configured base URL. */
function resolveProviderLabel(): string {
  const base = process.env.OPENAI_BASE_URL ?? '';
  if (base.includes('openrouter')) return 'openrouter';
  if (base.includes('groq')) return 'groq';
  if (base.includes('mistral')) return 'mistral';
  if (base.includes('anthropic') || base.includes('claude')) return 'anthropic';
  if (base.includes('localhost') || base.includes('127.0.0.1')) return 'local';
  if (base === '') return 'openai';
  // best-effort: extract the hostname third component
  try {
    return new URL(base).hostname.split('.').at(-2) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export class DirectLLMRunner implements MessageRunner {
  private client: OpenAI;
  private mcpManager: McpManager | null = null;
  /** Channel-resident tools intercepted locally (no K8s pod spawned). */
  private localTools: Map<string, LocalTool> = new Map();
  private channelMetrics: ChannelMetrics | null = null;
  // Tool catalog source (injected by channel-runner; defaults to empty).
  // NOTE: in channel pods this is injected from the mounted ConfigMap loader.
  // In the orchestrator (direct-mode scheduled tasks) it must be injected from
  // the in-process merged catalog (baseline + SQLite) so seam-1 tool *definitions*
  // match seam-2 resolution — wired in src/index.ts (Task 10). Until injected,
  // direct-mode runs see an empty catalog in the LLM tool list.
  private toolCatalog: { getForChannel: (channel: string) => ToolSpec[] } = {
    getForChannel: () => [],
  };

  setToolCatalog(c: { getForChannel: (channel: string) => ToolSpec[] }): void {
    this.toolCatalog = c;
  }

  constructor(client?: OpenAI) {
    this.client = client ?? createLLMClient();
    this.registerLocalTool(
      'set_reminder',
      makeSetReminderTool(scheduleTaskDirect),
    );
  }

  /** Wire in channel-tier Prometheus metrics (called from channel-runner.ts). */
  setChannelMetrics(metrics: ChannelMetrics): void {
    this.channelMetrics = metrics;
  }

  /**
   * Register a locally-intercepted tool.
   *
   * The tool definition is added to the LLM's effective tool list. When the
   * LLM calls the tool, the handler is invoked in-process — no K8s tool pod
   * is spawned. Call this before the first runAgent() invocation.
   */
  registerLocalTool(name: string, tool: LocalTool): void {
    this.localTools.set(name, tool);
  }

  /**
   * Return the names of all registered local tools (for testing).
   */
  getLocalToolNames(): string[] {
    return [...this.localTools.keys()];
  }

  /**
   * Configure MCP server connections. Can be called multiple times
   * to reconfigure (e.g. when capabilities_update control message arrives).
   */
  async configureMcp(servers: McpServerStatus[]): Promise<void> {
    if (this.mcpManager) {
      await this.mcpManager.reconfigure(servers);
    } else {
      this.mcpManager = new McpManager();
      await this.mcpManager.initialize(servers);
    }
  }

  /**
   * Configure per-group MCP capability templates.
   * Can be called multiple times to reconfigure (e.g. when capabilities_update arrives).
   */
  async configureGroupMcpTemplates(templates: GroupMcpEntry[]): Promise<void> {
    if (!this.mcpManager) {
      this.mcpManager = new McpManager();
      await this.mcpManager.initialize([]);
    }
    await this.mcpManager.configureGroupMcpTemplates(templates);
  }

  async runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    _onProcess?: (proc: unknown, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    overrides: RunAgentOverrides = {},
  ): Promise<ContainerOutput> {
    const model = getModel(group, overrides.llmProvider);
    const provider = resolveProviderLabel();
    const systemPrompt =
      overrides.systemPromptOverride ?? loadSystemPrompt(input.groupFolder);

    // Record skill load: 1 if a custom CLAUDE.md was loaded, 0 if using default
    const hasCustomPrompt = systemPrompt !== DEFAULT_SYSTEM_PROMPT;
    if (hasCustomPrompt) {
      this.channelMetrics?.recordSkillLoad({ group: input.groupFolder });
    }

    // Isolated scheduled tasks run without conversation history to avoid
    // polluting the user's chat context and accumulating token cost.
    const useHistory = !(
      input.isScheduledTask && input.sessionId === undefined
    );
    // Fetch all history (unlimited) so the compression check can count total
    // messages. For sessionKey-scoped sessions (isolated specialists), we skip
    // compression so the standard limit applies; for the main group we fetch
    // unlimited so the compression check can see the full history.
    const rawHistory = useHistory
      ? overrides.sessionKey
        ? getConversationHistory({ sessionKey: overrides.sessionKey })
        : getConversationHistory(input.groupFolder, 0)
      : [];

    // Record conversation history size
    this.channelMetrics?.setConversationHistorySize(
      { group: input.groupFolder },
      rawHistory.length,
    );

    // --- Context compression ---
    // GroupQueue serializes all messages within a group (state.active = true for
    // the duration of runForGroup), so this check and the summarization write
    // cannot interleave with another runAgent call for the same group.
    // Thresholds are re-read from env at call time (not cached at import time)
    // so that tests and operators can override them at runtime.
    const compressionThresholdMessages = parseInt(
      process.env.KUBECLAW_COMPRESSION_THRESHOLD_MESSAGES ||
        String(COMPRESSION_THRESHOLD_MESSAGES),
      10,
    );
    const compressionThresholdTokens = parseInt(
      process.env.KUBECLAW_COMPRESSION_THRESHOLD_TOKENS ||
        String(COMPRESSION_THRESHOLD_TOKENS),
      10,
    );
    let activeSummaryMarker: string | null = null;
    // Only run compression on the main group-folder history (not isolated specialist sessions).
    if (useHistory && !overrides.sessionKey) {
      const tokenEst = estimateMessagesTokens(rawHistory);
      if (
        shouldCompress(
          rawHistory.length,
          tokenEst,
          compressionThresholdMessages,
          compressionThresholdTokens,
        )
      ) {
        const keepWindow = parseInt(
          process.env.MAX_CONVERSATION_HISTORY || '20',
          10,
        );
        const toSummarize = rawHistory.slice(
          0,
          Math.max(0, rawHistory.length - keepWindow),
        );
        if (toSummarize.length > 0) {
          try {
            const prevSummary = getLatestSummary(input.groupFolder);
            const { text, tokenCount } = await summarize(
              toSummarize,
              this.client,
              model,
            );
            const summaryId = insertSummary({
              groupFolder: input.groupFolder,
              sessionKey: input.sessionId ?? input.groupFolder,
              parentSummaryId: prevSummary?.id ?? null,
              messageStartId: toSummarize[0].id,
              messageEndId: toSummarize[toSummarize.length - 1].id,
              summaryText: text,
              modelUsed: model,
              tokenCount,
            });
            deleteMessagesByIds(toSummarize.map((m) => m.id));
            activeSummaryMarker = `[summary_id=${summaryId}] ${text}`;
            logger.info(
              {
                groupFolder: input.groupFolder,
                summaryId,
                messagesCompressed: toSummarize.length,
              },
              'DirectLLMRunner: compressed conversation history',
            );
          } catch (err) {
            logger.warn(
              { groupFolder: input.groupFolder, err },
              'DirectLLMRunner: summarization failed — falling back to sliding-window',
            );
          }
        }
      }
    }

    // After possible compression, slice to keep-window for the actual LLM call.
    const keepWindow = parseInt(
      process.env.MAX_CONVERSATION_HISTORY || '20',
      10,
    );
    const history = activeSummaryMarker
      ? rawHistory.slice(Math.max(0, rawHistory.length - keepWindow))
      : rawHistory;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...(activeSummaryMarker
        ? [{ role: 'system' as const, content: activeSummaryMarker }]
        : []),
      ...history.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: input.prompt },
    ];

    const toolJobId = `direct-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const spawnedCategories = new Set<string>();

    const customToolDefs = buildCatalogToolDefs(
      this.toolCatalog.getForChannel(KUBECLAW_CHANNEL),
    );
    const mcpTools = this.mcpManager?.getTools() ?? [];
    const localToolDefs = [...this.localTools.values()].map((lt) => lt.def);
    const allTools = [
      ...TOOLS,
      ...customToolDefs,
      ...mcpTools,
      ...localToolDefs,
    ];
    const effectiveTools = overrides.toolFilter
      ? allTools.filter(
          (t) =>
            t.type === 'function' && overrides.toolFilter!.has(t.function.name),
        )
      : allTools;

    logger.debug(
      { group: group.name, model, historyLen: history.length },
      'DirectLLMRunner: calling API',
    );

    let fullResponse = '';
    let toolRounds = 0;

    try {
      const effectiveMaxRounds = overrides.maxToolRounds ?? MAX_TOOL_ROUNDS;
      while (toolRounds <= effectiveMaxRounds) {
        const llmStart = Date.now();
        let llmSuccess = true;
        let response: OpenAI.ChatCompletion;
        try {
          response = await this.client.chat.completions.create({
            model,
            messages,
            tools: effectiveTools,
            tool_choice: 'auto',
          });
        } catch (llmErr) {
          llmSuccess = false;
          this.channelMetrics?.recordLlmCall({
            provider,
            model,
            success: false,
            durationMs: Date.now() - llmStart,
          });
          throw llmErr;
        }
        const llmDurationMs = Date.now() - llmStart;
        this.channelMetrics?.recordLlmCall({
          provider,
          model,
          success: llmSuccess,
          durationMs: llmDurationMs,
        });

        // Record token usage from the response
        if (response.usage) {
          if (response.usage.prompt_tokens) {
            this.channelMetrics?.recordTokens({
              provider,
              model,
              direction: 'input',
              count: response.usage.prompt_tokens,
            });
          }
          if (response.usage.completion_tokens) {
            this.channelMetrics?.recordTokens({
              provider,
              model,
              direction: 'output',
              count: response.usage.completion_tokens,
            });
          }
        }

        const msg = response.choices[0].message;
        messages.push(msg);

        const toolCalls =
          msg.tool_calls?.filter((c) => c.type === 'function') ?? [];

        if (toolCalls.length === 0) {
          // Some reasoning models leave `content` null and put their answer in
          // a non-standard field. Known variants:
          //   - `reasoning_content` (Gemma extended-thinking via some providers)
          //   - `reasoning`         (Nemotron via OpenRouter)
          // Fall back through these fields so the response is not silently
          // discarded when the model exhausts its token budget on chain-of-thought.
          const extended = msg as typeof msg & {
            reasoning_content?: string;
            reasoning?: string;
          };
          fullResponse =
            msg.content ||
            extended.reasoning_content ||
            extended.reasoning ||
            '';
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
          let toolSuccess = true;
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
              result = await executeToolJob(
                input.groupFolder,
                input.chatJid,
                args.task as string,
                input.originMessageId,
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
            } else if (call.function.name === 'propose_skill') {
              const proposeArgs = args as unknown as Parameters<
                typeof proposeSkill
              >[2];
              const dupCheck: DupCheckFn = async (a, existing) => {
                if (existing.length === 0) return { duplicate: false };
                const sys =
                  'You judge whether a proposed skill is a duplicate of any existing skill. Reply JSON: {"duplicate": boolean, "existing": "<name>"|null, "suggestion": "<short>"|null}';
                const listing = existing
                  .map(
                    (s) =>
                      `- ${s.frontmatter.name}: ${s.frontmatter.description}`,
                  )
                  .join('\n');
                const user = `Existing skills:\n${listing}\n\nProposed:\nname: ${a.proposed_name}\ndescription: ${a.description}\n`;
                const completion = await this.client.chat.completions.create({
                  model,
                  messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: user },
                  ],
                  response_format: { type: 'json_object' },
                  max_tokens: 200,
                });
                try {
                  return JSON.parse(
                    completion.choices[0].message.content ??
                      '{"duplicate":false}',
                  );
                } catch {
                  return { duplicate: false };
                }
              };
              const proposeResult = await proposeSkill(
                GROUPS_DIR,
                input.groupFolder,
                proposeArgs,
                dupCheck,
              );
              result =
                proposeResult.kind === 'staged'
                  ? `Staged candidate ${proposeResult.candidateId}. Tell the user: ${proposeResult.preview}\n\nThey can reply '/skills review' to triage.`
                  : proposeResult.kind === 'duplicate'
                    ? `Duplicate of '${proposeResult.existing}'. ${proposeResult.suggestion}`
                    : `Error: ${proposeResult.message}`;
            } else if (this.localTools.has(call.function.name)) {
              result = await this.localTools
                .get(call.function.name)!
                .handler(args, input);
            } else if (this.mcpManager?.hasTool(call.function.name)) {
              result = await this.mcpManager.callTool(
                call.function.name,
                args,
                {
                  groupFolder: group.folder,
                },
              );
            } else {
              result = await executeToolViaK8s(
                toolJobId,
                input.groupFolder,
                call.function.name,
                args,
                spawnedCategories,
                overrides.maxToolOutputBytes,
              );
            }
          } catch (err) {
            toolSuccess = false;
            result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          }

          // Guard cardinality: bucket any name the LLM fabricated outside the
          // registered tool set as 'unknown' so Prometheus label cardinality
          // stays bounded.  effectiveTools includes static, custom, and MCP tools.
          const knownToolNames = new Set([
            ...STATIC_TOOL_NAMES,
            ...effectiveTools
              .filter((t) => t.type === 'function')
              .map((t) => t.function.name),
          ]);
          const toolLabel = knownToolNames.has(call.function.name)
            ? call.function.name
            : 'unknown';
          this.channelMetrics?.recordToolCall({
            tool: toolLabel,
            status: toolSuccess ? 'success' : 'failure',
          });

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result,
          });
        }
      }

      // Strip the ephemeral <context current_time="…" /> header before
      // persisting — timestamps belong in the LLM turn, not in stored history.
      const persistedUserContent = stripContextHeader(input.prompt);

      if (useHistory) {
        if (overrides.sessionKey) {
          appendConversationHistory({
            groupFolder: group.folder,
            sessionKey: overrides.sessionKey,
            role: 'user',
            content: persistedUserContent,
          });
          appendConversationHistory({
            groupFolder: group.folder,
            sessionKey: overrides.sessionKey,
            role: 'assistant',
            content: fullResponse,
          });
        } else {
          appendConversationMessage(
            input.groupFolder,
            'user',
            persistedUserContent,
          );
          appendConversationMessage(
            input.groupFolder,
            'assistant',
            fullResponse,
          );
        }
      }

      if (fullResponse) {
        void getRagProvider().indexConversationTurn(
          input.groupFolder,
          persistedUserContent,
          fullResponse,
        );
      } else {
        logger.debug(
          { group: group.name, toolRounds },
          'DirectLLMRunner: empty response — skipping RAG indexing',
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

export const __testing__ = {
  loadSystemPromptForTest: (group: string, groupsDir: string) =>
    loadSystemPrompt(group, groupsDir),
  toolsForTest: () => TOOLS,
  toolCategoryForTest: (name: string) => TOOL_CATEGORY[name],
  toolServerNameForTest: (name: string) => TOOL_SERVER_NAME[name],
};
