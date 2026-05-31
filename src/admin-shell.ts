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

import { execSync } from 'child_process';
import { initDatabase } from './db.js';
import * as db from './db.js';
import { logger } from './logger.js';
import { createLLMClient, DEFAULT_DIRECT_MODEL } from './runtime/llm-client.js';
import { setupChannel } from './skills/orchestrator/channel-setup.js';
import { removeChannel } from './skills/orchestrator/channel-remove.js';
import type { ChannelSetupInput } from './skills/orchestrator/types.js';
import {
  installCapability,
  removeCapability,
  listCapabilities,
} from './capabilities/index.js';
import { getCapabilityStatus } from './capabilities/db.js';
import {
  registerSpecialist,
  editSpecialist,
  removeSpecialist,
  listSpecialistOverrides,
} from './skills/orchestrator/specialist-registry.js';
import {
  SpecialistReconciler,
  loadBaselineFromDisk,
} from './specialists/reconciler.js';
import { RealPerGroupK8sClient } from './per-group-capabilities/k8s-client.js';
import {
  setGroupCredential,
  unsetGroupCredential,
} from './per-group-capabilities/credentials.js';
import { onGroupRemoved } from './per-group-capabilities/index.js';

// K8s clients (in-cluster config, auto-detected from service account)
const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const perGroupK8s = new RealPerGroupK8sClient(kc);
const NAMESPACE = process.env.KUBECLAW_NAMESPACE || 'kubeclaw';
const ORCHESTRATOR_DEPLOYMENT = 'kubeclaw-orchestrator';

const specialistReconciler = new SpecialistReconciler({
  baselineLoader: loadBaselineFromDisk,
  configMapApply: async (rendered: string) => {
    const data: Record<string, string> = { 'specialists.json': rendered };
    // GET the existing ConfigMap to obtain its resourceVersion (needed for PUT).
    // Fall back to CREATE if the ConfigMap does not exist yet.
    // Note: patchNamespacedConfigMap sends application/json-patch+json which
    // expects an array of patch ops, not a full object — so we use GET+replace
    // (PUT) or create instead.
    let resourceVersion: string | undefined;
    try {
      const existing = await coreV1.readNamespacedConfigMap({
        name: 'kubeclaw-specialists',
        namespace: NAMESPACE,
      });
      resourceVersion = existing.metadata?.resourceVersion;
    } catch (err: unknown) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status !== 404) throw err;
    }

    const body = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'kubeclaw-specialists',
        namespace: NAMESPACE,
        ...(resourceVersion ? { resourceVersion } : {}),
      },
      data,
    };
    if (resourceVersion !== undefined) {
      await coreV1.replaceNamespacedConfigMap({
        name: 'kubeclaw-specialists',
        namespace: NAMESPACE,
        body,
      });
    } else {
      await coreV1.createNamespacedConfigMap({ namespace: NAMESPACE, body });
    }
  },
});

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
              'LLM provider for K8s tool jobs: "claude", "openai", "openrouter", or "ollama". Use "ollama" to route tool jobs to a local Ollama K8s Service.',
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
      name: 'remove_channel',
      description:
        'Remove a channel instance and all its associated K8s resources (Deployment, Secret, and PersistentVolumeClaims). Idempotent — safe to call even if resources are already absent.',
      parameters: {
        type: 'object',
        properties: {
          instanceName: {
            type: 'string',
            description:
              'The channel instance name passed to setup_channel (e.g. "http", "telegram", "http-staging").',
          },
        },
        required: ['instanceName'],
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
  {
    type: 'function',
    function: {
      name: 'install_capability',
      description:
        'Install or update a long-lived capability pod. Spec is a JSON object with kind ("mcp" | "rag" | "http"), name, image, and kind-specific fields.',
      parameters: {
        type: 'object',
        required: ['spec'],
        properties: {
          spec: {
            type: 'object',
            description: 'CapabilitySpec — see docs/SPEC.md',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_capability',
      description: 'Remove a capability pod and its persistent storage.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_capabilities',
      description:
        'List all installed capabilities with their lifecycle status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_capability_logs',
      description: 'Fetch the last N log lines from a capability pod.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          lines: { type: 'number', default: 200 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_specialist',
      description:
        'Register a new global specialist agent in the specialist_overrides SQLite table. The specialist will be included in the merged catalog immediately and channel pods will see the update within ~30s.',
      parameters: {
        type: 'object',
        required: ['name', 'prompt'],
        properties: {
          name: {
            type: 'string',
            description:
              'Specialist name (letters, digits, hyphens, underscores; must start with a letter). Used as the primary @mention alias.',
          },
          prompt: {
            type: 'string',
            description: 'System prompt for this specialist.',
          },
          triggers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Additional @mention aliases (without leading @). Case-insensitive. E.g. ["Researcher", "Analysis"].',
          },
          llmProvider: {
            type: 'string',
            description:
              'Override LLM provider for this specialist (e.g. "claude", "openrouter"). Omit to inherit group default.',
          },
          memory: {
            type: 'object',
            description:
              'Memory settings. Set isolated: true to give the specialist its own conversation history.',
            properties: {
              isolated: { type: 'boolean' },
            },
          },
          claudemd: {
            type: 'string',
            description: 'Extra content appended to the system prompt.',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Allowlist of tool names. When set, the specialist can only call listed tools.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_specialist',
      description:
        'Update fields on an existing specialist override. Only provided fields are changed; omitted fields keep their current values. Changes propagate to channel pods within ~30s.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            description: 'Name of the specialist to edit.',
          },
          prompt: { type: 'string' },
          triggers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replacement triggers list (without leading @).',
          },
          llmProvider: { type: 'string' },
          memory: {
            type: 'object',
            properties: { isolated: { type: 'boolean' } },
          },
          claudemd: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_specialist',
      description:
        'Remove a specialist override from the SQLite table. The specialist will be excluded from the merged catalog immediately and channel pods will see the update within ~30s.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            description: 'Name of the specialist override to remove.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_specialists',
      description:
        'List all specialist overrides stored in the SQLite table (admin-shell managed entries only; does not include Helm baseline specialists).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_group_credential',
      description:
        'Set an env-var credential on a per-(group, capability) K8s Secret. The Secret is mounted as envFrom into the per-group MCP capability Deployment. Takes effect on the next reconcile or pod restart.',
      parameters: {
        type: 'object',
        required: ['group_folder', 'capability_name', 'env_name', 'value'],
        properties: {
          group_folder: {
            type: 'string',
            description: 'Target group folder name.',
          },
          capability_name: {
            type: 'string',
            description: 'Per-group capability name (e.g. "github").',
          },
          env_name: {
            type: 'string',
            description: 'Env-var name to set in the Secret.',
          },
          value: {
            type: 'string',
            description:
              'Secret value (will be base64-encoded into the Secret data).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unset_group_credential',
      description:
        'Remove a single env-var key from a per-(group, capability) K8s Secret. Deletes the Secret entirely if no keys remain.',
      parameters: {
        type: 'object',
        required: ['group_folder', 'capability_name', 'env_name'],
        properties: {
          group_folder: { type: 'string' },
          capability_name: { type: 'string' },
          env_name: { type: 'string' },
        },
      },
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
  void onGroupRemoved(existing.folder);
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

async function handleRemoveChannel(input: ToolInput): Promise<string> {
  const instanceName = input.instanceName as string | undefined;
  if (!instanceName) return 'Error: instanceName is required.';
  const result = await removeChannel(instanceName);
  return result.summary;
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

// ---- Capability tool handlers ----

async function handleInstallCapability(input: ToolInput): Promise<string> {
  const spec = input.spec as Parameters<typeof installCapability>[0];
  if (!spec || typeof spec !== 'object') {
    return 'Error: spec is required (JSON object).';
  }
  await installCapability(spec);
  return `Installed capability ${spec.name} (kind=${spec.kind}).`;
}

async function handleRemoveCapability(input: ToolInput): Promise<string> {
  const name = input.name as string | undefined;
  if (!name) return 'Error: name is required.';
  await removeCapability(name);
  return `Removed capability ${name}.`;
}

async function handleListCapabilities(): Promise<string> {
  const all = listCapabilities().map((spec) => ({
    spec,
    status: getCapabilityStatus(spec.name),
  }));
  return JSON.stringify(all, null, 2);
}

async function handleGetCapabilityLogs(input: ToolInput): Promise<string> {
  const name = input.name as string | undefined;
  const lines = (input.lines as number | undefined) ?? 200;
  if (!name) return 'Error: name is required.';
  const dep = `kubeclaw-cap-${name}`;
  try {
    const out = execSync(
      `kubectl logs deployment/${dep} -n kubeclaw --tail=${lines}`,
      { encoding: 'utf8' },
    );
    return out;
  } catch (err) {
    return `Failed to fetch logs: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---- Specialist tool handlers ----

function handleRegisterSpecialist(input: ToolInput): string {
  const spec = {
    name: input.name as string,
    prompt: input.prompt as string,
    ...(input.triggers !== undefined && {
      triggers: input.triggers as string[],
    }),
    ...(input.llmProvider !== undefined && {
      llmProvider: input.llmProvider as string,
    }),
    ...(input.memory !== undefined && {
      memory: input.memory as { isolated?: boolean },
    }),
    ...(input.claudemd !== undefined && { claudemd: input.claudemd as string }),
    ...(input.tools !== undefined && { tools: input.tools as string[] }),
  };
  const result = registerSpecialist(
    spec,
    specialistReconciler.apply.bind(specialistReconciler),
  );
  if (!result.ok) return `Error: ${result.error}`;
  return `Registered specialist "${spec.name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleEditSpecialist(input: ToolInput): string {
  const name = input.name as string;
  if (!name) return 'Error: name is required.';
  const patch: Record<string, unknown> = {};
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if (input.triggers !== undefined) patch.triggers = input.triggers;
  if (input.llmProvider !== undefined) patch.llmProvider = input.llmProvider;
  if (input.memory !== undefined) patch.memory = input.memory;
  if (input.claudemd !== undefined) patch.claudemd = input.claudemd;
  if (input.tools !== undefined) patch.tools = input.tools;
  const result = editSpecialist(
    { name, patch },
    specialistReconciler.apply.bind(specialistReconciler),
  );
  if (!result.ok) return `Error: ${result.error}`;
  return `Updated specialist "${name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleRemoveSpecialist(input: ToolInput): string {
  const name = input.name as string;
  if (!name) return 'Error: name is required.';
  const result = removeSpecialist(
    { name },
    specialistReconciler.apply.bind(specialistReconciler),
  );
  if (!result.ok) return `Error: ${result.error}`;
  return `Removed specialist override "${name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleListSpecialists(): string {
  const specialists = listSpecialistOverrides();
  if (specialists.length === 0)
    return 'No specialist overrides registered. (Helm baseline specialists are not shown here.)';
  return specialists
    .map((s) =>
      [
        `Name: ${s.name}`,
        `  Prompt: ${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? '…' : ''}`,
        ...(s.triggers ? [`  Triggers: ${s.triggers.join(', ')}`] : []),
        ...(s.llmProvider ? [`  Provider: ${s.llmProvider}`] : []),
        ...(s.memory ? [`  Memory: ${JSON.stringify(s.memory)}`] : []),
        ...(s.tools ? [`  Tools: ${s.tools.join(', ')}`] : []),
      ].join('\n'),
    )
    .join('\n\n');
}

async function handleSetGroupCredential(input: ToolInput): Promise<string> {
  const groupFolder = input.group_folder as string;
  const capabilityName = input.capability_name as string;
  const envName = input.env_name as string;
  const value = input.value as string;
  if (!groupFolder || !capabilityName || !envName || !value) {
    return 'Error: group_folder, capability_name, env_name, and value are all required.';
  }
  try {
    await setGroupCredential({
      client: perGroupK8s,
      namespace: NAMESPACE,
      groupFolder,
      capabilityName,
      envName,
      value,
    });
    return `Set credential ${envName} on (${groupFolder}, ${capabilityName}). Takes effect on next reconcile.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleUnsetGroupCredential(input: ToolInput): Promise<string> {
  const groupFolder = input.group_folder as string;
  const capabilityName = input.capability_name as string;
  const envName = input.env_name as string;
  if (!groupFolder || !capabilityName || !envName) {
    return 'Error: group_folder, capability_name, and env_name are all required.';
  }
  try {
    await unsetGroupCredential({
      client: perGroupK8s,
      namespace: NAMESPACE,
      groupFolder,
      capabilityName,
      envName,
    });
    return `Removed credential ${envName} from (${groupFolder}, ${capabilityName}).`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
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
    case 'remove_channel':
      return handleRemoveChannel(input);
    case 'get_orchestrator_status':
      return handleGetOrchestratorStatus();
    case 'restart_orchestrator':
      return handleRestartOrchestrator();
    case 'install_capability':
      return handleInstallCapability(input);
    case 'remove_capability':
      return handleRemoveCapability(input);
    case 'list_capabilities':
      return handleListCapabilities();
    case 'get_capability_logs':
      return handleGetCapabilityLogs(input);
    case 'register_specialist':
      return handleRegisterSpecialist(input);
    case 'edit_specialist':
      return handleEditSpecialist(input);
    case 'remove_specialist':
      return handleRemoveSpecialist(input);
    case 'list_specialists':
      return handleListSpecialists();
    case 'set_group_credential':
      return handleSetGroupCredential(input);
    case 'unset_group_credential':
      return handleUnsetGroupCredential(input);
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
  let lastToolResult = '';

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
      const extended = msg as typeof msg & { reasoning_content?: string };
      const text = msg.content || extended.reasoning_content || '';
      // Small local models (e.g. Gemma) sometimes return an empty final
      // message after a successful tool call. Surface the last tool output
      // so the user gets something actionable instead of a blank reply.
      return text || lastToolResult;
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
      lastToolResult = result;
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
