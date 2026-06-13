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
import { randomUUID } from 'node:crypto';
import readline from 'readline';
import OpenAI from 'openai';
import * as k8s from '@kubernetes/client-node';

import { execSync } from 'child_process';
import { initDatabase } from './db.js';
import * as db from './db.js';
import { logger } from './logger.js';
import { createLLMClient, DEFAULT_DIRECT_MODEL } from './runtime/llm-client.js';
import {
  setupChannel,
  patchRuntimePvc,
  waitForDeploymentRollout,
} from './skills/orchestrator/channel-setup.js';
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
import {
  registerTool,
  editTool,
  removeTool,
  listToolOverrides,
} from './skills/orchestrator/tool-registry.js';
import {
  ToolReconciler,
  loadBaselineFromDisk as loadToolBaselineFromDisk,
} from './tools/reconciler.js';
import {
  registerChannelManifest,
  listChannelManifestOverrides,
} from './skills/orchestrator/channel-manifest-registry.js';
import {
  ChannelManifestReconciler,
  loadBaselineFromDisk as loadChannelManifestBaselineFromDisk,
  mergeManifests,
} from './channel-manifests/reconciler.js';
import {
  registerBootstrapSkill,
  removeBootstrapSkill,
  listBootstrapSkillOverrides,
} from './skills/orchestrator/bootstrap-skill-registry.js';
import {
  BootstrapSkillReconciler,
  loadBaselineFromDisk as loadBootstrapSkillBaselineFromDisk,
  mergeSkills,
} from './bootstrap-skills/reconciler.js';
import { RealPerGroupK8sClient } from './per-group-capabilities/k8s-client.js';
import {
  setGroupCredential,
  unsetGroupCredential,
} from './per-group-capabilities/credentials.js';
import { onGroupRemoved } from './per-group-capabilities/index.js';
import {
  bootstrapChannelFromSkill,
  waitForBootstrapJobCompletion,
  bootstrapStatus,
  registerBootstrapMeta,
  deregisterBootstrapMeta,
  getBootstrapMeta,
  runUpgrade,
} from './k8s/bootstrap-runner.js';
import type {
  BootstrapK8sDeps,
  CleanupBootstrapDeps,
  BootstrapStatusDeps,
} from './k8s/bootstrap-runner.js';
import {
  currentStepByJob,
  pendingBootstrapQuestionByJob,
} from './k8s/ipc-redis.js';
import { jobRunner } from './k8s/job-runner.js';
import { getRedisClient } from './k8s/redis-client.js';
import {
  startBootstrapAuditGcInterval,
  queryBootstrapAudit,
  type BootstrapAuditOutcome,
} from './skills/orchestrator/bootstrap-audit.js';

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

const toolReconciler = new ToolReconciler({
  baselineLoader: loadToolBaselineFromDisk,
  configMapApply: async (rendered: string) => {
    const data: Record<string, string> = { 'tools.json': rendered };
    let resourceVersion: string | undefined;
    try {
      const existing = await coreV1.readNamespacedConfigMap({
        name: 'kubeclaw-tools',
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
        name: 'kubeclaw-tools',
        namespace: NAMESPACE,
        ...(resourceVersion ? { resourceVersion } : {}),
      },
      data,
    };
    if (resourceVersion !== undefined) {
      await coreV1.replaceNamespacedConfigMap({
        name: 'kubeclaw-tools',
        namespace: NAMESPACE,
        body,
      });
    } else {
      await coreV1.createNamespacedConfigMap({ namespace: NAMESPACE, body });
    }
  },
});

const channelManifestReconciler = new ChannelManifestReconciler({
  baselineLoader: loadChannelManifestBaselineFromDisk,
  configMapApply: async (rendered: string) => {
    // Parse the rendered JSON to extract per-channel-type ConfigMap keys.
    // Build ConfigMap data: one key per channel_type, value is JSON with
    // packageJson, packageLockJson, manifestHash (same shape Helm baseline uses).
    const parsed = JSON.parse(rendered) as {
      manifests: Array<{
        channel_type: string;
        package_json?: string;
        package_lock_json?: string;
        manifest_hash: string;
        source: string;
        registered_at: string;
        registered_by: string;
        package_name: string;
        package_version: string;
      }>;
    };
    const data: Record<string, string> = {};
    for (const m of parsed.manifests) {
      if (m.package_json && m.package_lock_json) {
        data[`${m.channel_type}.json`] = JSON.stringify({
          packageJson: m.package_json,
          packageLockJson: m.package_lock_json,
          manifestHash: m.manifest_hash,
        });
      }
    }

    let resourceVersion: string | undefined;
    try {
      const existing = await coreV1.readNamespacedConfigMap({
        name: 'kubeclaw-channel-manifests',
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
        name: 'kubeclaw-channel-manifests',
        namespace: NAMESPACE,
        ...(resourceVersion ? { resourceVersion } : {}),
      },
      data,
    };
    if (resourceVersion !== undefined) {
      await coreV1.replaceNamespacedConfigMap({
        name: 'kubeclaw-channel-manifests',
        namespace: NAMESPACE,
        body,
      });
    } else {
      await coreV1.createNamespacedConfigMap({ namespace: NAMESPACE, body });
    }
  },
});

/**
 * Startup reconcile for the live `kubeclaw-channel-manifests` ConfigMap.
 *
 * Helm renders that ConfigMap empty (`data: {}`) and the bootstrap Job mounts it
 * to read each channel type's package.json / package-lock.json. Without a startup
 * reconcile the ConfigMap stays empty until an admin registers a manifest, so
 * bootstrap Jobs cannot find their package manifest and stall asking the admin.
 * This merges the Helm baseline (mounted from the `-baseline` ConfigMap) with any
 * SQLite admin overrides and writes the result, honouring the "on startup and on
 * every mutation" contract documented in the ConfigMap template.
 */
export async function reconcileChannelManifestsOnStartup(): Promise<void> {
  await channelManifestReconciler.apply();
}

const bootstrapSkillReconciler = new BootstrapSkillReconciler({
  baselineLoader: loadBootstrapSkillBaselineFromDisk,
  configMapApply: async (rendered: string) => {
    // Parse rendered JSON to build ConfigMap data: one key per skill name (*.md).
    const parsed = JSON.parse(rendered) as {
      skills: Array<{
        name: string;
        markdown?: string;
        content_hash: string;
        source: string;
        registered_at: string;
        registered_by: string;
      }>;
    };
    const data: Record<string, string> = {};
    for (const s of parsed.skills) {
      if (s.markdown) {
        data[`${s.name}.md`] = s.markdown;
      }
    }

    let resourceVersion: string | undefined;
    try {
      const existing = await coreV1.readNamespacedConfigMap({
        name: 'kubeclaw-bootstrap-skills',
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
        name: 'kubeclaw-bootstrap-skills',
        namespace: NAMESPACE,
        ...(resourceVersion ? { resourceVersion } : {}),
      },
      data,
    };
    if (resourceVersion !== undefined) {
      await coreV1.replaceNamespacedConfigMap({
        name: 'kubeclaw-bootstrap-skills',
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

// ─── Story 180: Bootstrap history GC ─────────────────────────────────────────

export const BOOTSTRAP_HISTORY_RETENTION_HOURS = parseInt(
  process.env.BOOTSTRAP_HISTORY_RETENTION_HOURS ?? '24',
  10,
);
const BOOTSTRAP_HISTORY_GC_INTERVAL_MS = 60_000; // 60 s

/**
 * Start a background interval that deletes bootstrap_history rows older than
 * BOOTSTRAP_HISTORY_RETENTION_HOURS.
 *
 * When BOOTSTRAP_HISTORY_RETENTION_HOURS=0 GC is disabled (infinite retention).
 * Mirrors startToolJobPruneInterval from channel-runner.ts exactly.
 */
export function startBootstrapHistoryGcInterval(): void {
  if (
    !Number.isFinite(BOOTSTRAP_HISTORY_RETENTION_HOURS) ||
    BOOTSTRAP_HISTORY_RETENTION_HOURS <= 0
  ) {
    logger.info(
      'bootstrap-history GC disabled (BOOTSTRAP_HISTORY_RETENTION_HOURS=0)',
    );
    return;
  }
  setInterval(() => {
    try {
      const deleted = db.pruneOldBootstrapHistory(
        BOOTSTRAP_HISTORY_RETENTION_HOURS,
      );
      if (deleted > 0) {
        logger.info(
          { deleted, retentionHours: BOOTSTRAP_HISTORY_RETENTION_HOURS },
          'Pruned old bootstrap_history rows',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'bootstrap-history GC interval iteration failed');
    }
  }, BOOTSTRAP_HISTORY_GC_INTERVAL_MS).unref();
}

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
      name: 'list_channel_manifests',
      description:
        'List all channel manifests — both Helm-baseline entries and admin-registered overrides. Returns an array of objects with {channel_type, package_name, package_version, manifest_hash, source, registered_at, registered_by}. Admin-registered entries win on channel_type collision (source: "admin-registered").',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_channel_manifest',
      description:
        'Register a new per-channel-type npm manifest at runtime. Validates JSON structure (top-level dependencies required, no devDependencies, lifecycle-script allowlist enforced), computes sha256 integrity hash, persists to SQLite, and triggers a ConfigMap reconcile. Idempotent on identical (channel_type, content).',
      parameters: {
        type: 'object',
        required: ['channel_type', 'package_json', 'package_lock_json'],
        properties: {
          channel_type: {
            type: 'string',
            description:
              'Channel type name (e.g. "telegram", "slack"). Used as the ConfigMap key.',
          },
          package_json: {
            type: 'string',
            description:
              'Full content of package.json as a JSON string. Must have top-level "dependencies", no "devDependencies", no non-allowlisted lifecycle scripts.',
          },
          package_lock_json: {
            type: 'string',
            description:
              'Full content of package-lock.json as a JSON string. Must be npm lockfile v3 (lockfileVersion: 3). Per-package lifecycle scripts checked against the same allowlist.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_bootstrap_skills',
      description:
        'List all bootstrap skills — both Helm-baseline entries and admin-registered overrides. Returns an array with {name, channel_type, manifest_version, content_hash, source, registered_at, registered_by}. Admin-registered entries win on name collision (source: "admin-registered").',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_bootstrap_skill',
      description:
        'Register a new bootstrap skill at runtime. Validates YAML frontmatter strictly at upload time (not at bootstrap runtime): name must match the argument, description non-empty, bootstrap.channelType non-empty, bootstrap.manifestVersion must match an existing entry in kubeclaw-channel-manifests, bootstrap.expectedQuestions non-empty array. Computes sha256(markdown), persists to SQLite bootstrap_skill_overrides, and triggers a ConfigMap reconcile. Idempotent on identical (name, content).',
      parameters: {
        type: 'object',
        required: ['name', 'markdown'],
        properties: {
          name: {
            type: 'string',
            description:
              'Skill name (e.g. "bootstrap-telegram"). Must match the name field in the markdown frontmatter.',
          },
          markdown: {
            type: 'string',
            description:
              'Full markdown content of the skill file, including YAML frontmatter block (--- ... ---). Required frontmatter fields: name, description, bootstrap.channelType, bootstrap.manifestVersion, bootstrap.expectedQuestions.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_bootstrap_skill',
      description:
        'Remove an admin-registered bootstrap skill. Refuses Helm baseline skills with code PROTECTED_BASELINE. Idempotent on already-removed skills (returns status: "already absent").',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            description: 'Skill name to remove.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bootstrap_channel_from_skill',
      description:
        'Bootstrap a new channel using a skill. Spawns a slim bootstrap Job that installs npm packages onto a per-channel runtime PVC, gathers credentials interactively, then hands off to a steady-state channel pod. Returns a bootstrapJobId for tracking via the SSE stream. Use this for channel types that have a bootstrap skill (e.g. "bootstrap-telegram").',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description:
              'Name of the bootstrap skill (e.g. "bootstrap-telegram"). Must exist in the kubeclaw-bootstrap-skills ConfigMap.',
          },
          channel_type: {
            type: 'string',
            description:
              'Channel type (e.g. "telegram"). Must have a manifest in the kubeclaw-channel-manifests ConfigMap.',
          },
          instance_name: {
            type: 'string',
            description:
              'Unique instance name (lowercase, hyphens only). Used for K8s resource naming: PVC, Job, and Deployment will all be named after this.',
          },
          channel_credentials_hint: {
            type: 'string',
            description:
              'Optional hint about credentials the admin already has (forwarded to the bootstrap agent).',
          },
        },
        required: ['skill_name', 'channel_type', 'instance_name'],
      },
    },
  },
  // Story 181: upgrade_channel
  {
    type: 'function',
    function: {
      name: 'upgrade_channel',
      description:
        'Upgrade a running channel to a new manifest version using blue-green runtime PVC swap. ' +
        'Creates a new versioned runtime PVC, runs the bootstrap skill against the target manifest, ' +
        'then atomically patches the Deployment to the new PVC. ' +
        'On failure (MANIFEST_DIVERGENCE, skill error, or refused credentials), the new PVC is deleted ' +
        'and the channel continues serving on the old version with zero downtime. ' +
        'On success, the old PVC is deleted after a grace period (default 5 min). ' +
        'Returns an upgradeJobId for tracking via the SSE stream.',
      parameters: {
        type: 'object',
        properties: {
          instance_name: {
            type: 'string',
            description:
              'Channel instance name (lowercase, hyphens only). Must match an existing channel Deployment.',
          },
          target_manifest_hash: {
            type: 'string',
            description:
              'SHA-256 hash of the target manifest (from list_channel_manifests). The upgrade will be rejected if the installed packages do not match this hash.',
          },
        },
        required: ['instance_name', 'target_manifest_hash'],
      },
    },
  },
  // Story 180: bootstrap status tools
  {
    type: 'function',
    function: {
      name: 'report_step',
      description:
        'Publish a human-readable step label to the orchestrator during a bootstrap run. ' +
        'Call this between major steps (e.g. after npm ci completes, during credential validation) ' +
        'so operators can see progress via bootstrap_status. ' +
        'Only callable inside a bootstrap agent loop (requires KUBECLAW_BOOTSTRAP_JOB_ID env var). ' +
        'Labels longer than 200 characters are automatically truncated.',
      parameters: {
        type: 'object',
        required: ['label'],
        properties: {
          label: {
            type: 'string',
            description:
              'Human-readable step label (max 200 chars). E.g. "Running npm ci", "Validating credentials".',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply_to_bootstrap',
      description:
        "Forward the admin user's reply to an in-progress channel bootstrap " +
        '(e.g. answering a port or credential question the bootstrap agent asked). ' +
        'Looks up the active bootstrap by instance name and delivers the message ' +
        'to the bootstrap pod over Redis. Call this whenever the user answers a ' +
        'question raised by a running bootstrap.',
      parameters: {
        type: 'object',
        required: ['instance_name', 'message'],
        properties: {
          instance_name: {
            type: 'string',
            description:
              'The channel instance name of the active bootstrap to reply to.',
          },
          message: {
            type: 'string',
            description:
              "The admin's reply text to forward to the bootstrap pod.",
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bootstrap_status',
      description:
        'Return a structured snapshot of all in-progress and recently-completed bootstrap operations. ' +
        'active[] entries come from the in-memory activeBootstraps map joined with K8s pod-phase reads. ' +
        'recent[] entries come from the SQLite bootstrap_history table and persist across orchestrator restarts.',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          limit: {
            type: 'number',
            description:
              'Optional cap on the number of recent[] entries returned (sorted by completed_at DESC). Must be a positive integer. Does not affect active[].',
          },
          channel_type_filter: {
            type: 'string',
            description:
              'Optional exact-match filter: only entries whose channelType equals this string appear in both active[] and recent[].',
          },
          include_logs: {
            type: 'boolean',
            description:
              'When true, each active[] entry includes logsTail (last 50 lines of the bootstrap pod stdout). Defaults to false.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bootstrap_audit_log',
      description:
        'Query the immutable bootstrap_audit compliance log. Returns rows ordered by recorded_at DESC. ' +
        'Each bootstrap_channel_from_skill call produces exactly two rows: a start row (outcome=in-progress) ' +
        'and a terminal row (succeeded | timed-out | manifest-divergence | rejected | error).',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          limit: {
            type: 'number',
            description:
              'Maximum rows to return (default 50, capped at 500). Must be a positive integer.',
          },
          channel_type: {
            type: 'string',
            description:
              'Exact-match filter on channel_type (e.g. "telegram").',
          },
          outcome: {
            type: 'string',
            description:
              'Exact-match filter on outcome. One of: in-progress, succeeded, timed-out, manifest-divergence, rejected, error.',
          },
          since: {
            type: 'string',
            description:
              'ISO-8601 datetime string. Only rows with recorded_at >= since are returned.',
          },
        },
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
      name: 'register_tool',
      description:
        'Register a tool container in the tool catalog (tool_overrides SQLite table). The tool is merged into the catalog immediately and channel pods see it within ~30s. The orchestrator resolves its image at spawn time.',
      parameters: {
        type: 'object',
        required: ['name', 'description', 'parameters', 'image', 'pattern'],
        properties: {
          name: {
            type: 'string',
            description:
              'Tool name the LLM calls (letters, digits, hyphens, underscores; must start with a letter). Must not collide with a built-in (bash, web_search, web_fetch, browser, places_search).',
          },
          description: {
            type: 'string',
            description: 'What the tool does (shown to the LLM).',
          },
          parameters: {
            type: 'object',
            description: 'JSON Schema for the tool arguments.',
          },
          image: {
            type: 'string',
            description: 'Container image for the tool.',
          },
          pattern: {
            type: 'string',
            enum: ['http', 'file', 'acp'],
            description: 'Bridge pattern the tool container speaks.',
          },
          port: {
            type: 'number',
            description:
              'Port the container listens on (http/acp; default 8080).',
          },
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Entrypoint override.',
          },
          healthPath: {
            type: 'string',
            description: 'Readiness path (must begin with /).',
          },
          pullPolicy: {
            type: 'string',
            enum: ['Always', 'IfNotPresent', 'Never'],
          },
          channels: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Channels this tool is visible to. Omit for all channels.',
          },
          acpAgentName: { type: 'string' },
          acpMode: { type: 'string', enum: ['sync', 'async'] },
          memoryRequest: { type: 'string' },
          memoryLimit: { type: 'string' },
          cpuRequest: { type: 'string' },
          cpuLimit: { type: 'string' },
          requestMapping: {
            type: 'object',
            description:
              'Optional HTTP request mapping (pattern "http" only): how to build the real request to the tool container. Fields: method, path ("/x/{field}"), query, headers, body, responsePath.',
            properties: {
              method: {
                type: 'string',
                enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
              },
              path: { type: 'string' },
              query: { type: 'object' },
              headers: { type: 'object' },
              body: {},
              responsePath: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_tool',
      description:
        'Update fields on an existing tool override. Only provided fields change. Propagates to channel pods within ~30s.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Name of the tool to edit.' },
          description: { type: 'string' },
          parameters: { type: 'object' },
          image: { type: 'string' },
          pattern: { type: 'string', enum: ['http', 'file', 'acp'] },
          port: { type: 'number' },
          command: { type: 'array', items: { type: 'string' } },
          healthPath: { type: 'string' },
          pullPolicy: {
            type: 'string',
            enum: ['Always', 'IfNotPresent', 'Never'],
          },
          channels: { type: 'array', items: { type: 'string' } },
          acpAgentName: { type: 'string' },
          acpMode: { type: 'string', enum: ['sync', 'async'] },
          memoryRequest: { type: 'string' },
          memoryLimit: { type: 'string' },
          cpuRequest: { type: 'string' },
          cpuLimit: { type: 'string' },
          requestMapping: {
            type: 'object',
            description:
              'Optional HTTP request mapping (pattern "http" only): how to build the real request to the tool container. Fields: method, path ("/x/{field}"), query, headers, body, responsePath.',
            properties: {
              method: {
                type: 'string',
                enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
              },
              path: { type: 'string' },
              query: { type: 'object' },
              headers: { type: 'object' },
              body: {},
              responsePath: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_tool',
      description:
        'Remove a tool override from the catalog. Excluded immediately; channel pods update within ~30s.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Name of the tool to remove.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tools',
      description:
        'List all tool overrides in the catalog (admin-shell managed entries; does not include Helm baseline tools).',
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

/**
 * In-memory map tracking active bootstrap operations: instanceName → bootstrapJobId.
 * Exported so orchestrator startup can pass it to registerBootstrapDeps.
 */
export const activeBootstraps: Map<string, string> = new Map();

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

async function handleBootstrapChannelFromSkill(
  input: ToolInput,
  adminIdentity: string = 'anonymous',
  adminSessionId: string | null = null,
): Promise<string> {
  const skillName = input.skill_name as string;
  const channelType = input.channel_type as string;
  const instanceName = input.instance_name as string;
  const channelCredentialsHint = input.channel_credentials_hint as
    | string
    | undefined;

  if (!skillName || !channelType || !instanceName) {
    return 'Error: skill_name, channel_type, and instance_name are required.';
  }

  // Validate instanceName is safe for K8s resource naming
  if (!/^[a-z0-9][a-z0-9-]*$/.test(instanceName) || instanceName.length > 40) {
    const sanitized = instanceName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `Error: instance_name must be lowercase alphanumeric with hyphens only (max 40 chars). Suggested: "${sanitized}"`;
  }

  try {
    const { BatchV1Api: BatchV1ApiClass } =
      await import('@kubernetes/client-node');
    const batchV1 = kc.makeApiClient(BatchV1ApiClass);

    const k8sDeps: BootstrapK8sDeps = { coreV1, batchV1 };

    const channelBaseImage =
      process.env.KUBECLAW_BOOTSTRAP_AGENT_IMAGE || 'kubeclaw-agent:latest';

    const result = await bootstrapChannelFromSkill({
      skillName,
      channelType,
      instanceName,
      channelCredentialsHint,
      k8sDeps,
      namespace: NAMESPACE,
      channelBaseImage,
      activeBootstraps,
      timeoutSeconds: parseInt(
        process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS || '900',
        10,
      ),
      pvcSize: process.env.BOOTSTRAP_PVC_SIZE || '1Gi',
      redisUrl: process.env.REDIS_URL,
      redisUsername: process.env.REDIS_BOOTSTRAP_USERNAME,
      redisAdminPassword: process.env.REDIS_ADMIN_PASSWORD,
      openaiApiKey: process.env.OPENAI_API_KEY,
      openaiBaseUrl: process.env.OPENAI_BASE_URL,
      directLlmModel: process.env.DIRECT_LLM_MODEL,
      // Story 184: thread admin identity for bootstrap_audit start row.
      adminIdentity,
      adminSessionId,
      // skillContentHash and manifestHashRequested would be computed from the
      // loaded ConfigMaps at call time. Placeholder empty strings — follow-on
      // story can inject real hashes once ConfigMap reads are wired here.
      skillContentHash: '',
      manifestHashRequested: '',
    });

    if (result.alreadyInProgress) {
      return `Bootstrap already in progress for instance "${instanceName}" (bootstrapJobId: ${result.bootstrapJobId}). Follow progress via the /events SSE stream.`;
    }

    // Story 180: register bootstrap metadata so bootstrapStatus can return it
    const bootstrapStartedAt = new Date().toISOString();
    registerBootstrapMeta(instanceName, {
      channelType,
      skillName,
      startedAt: bootstrapStartedAt,
    });

    // ── Fire-and-forget: watch the bootstrap Job for DeadlineExceeded (Story 175) ──
    // Build the cleanup deps inline so waitForBootstrapJobCompletion can delete
    // K8s resources and publish the timeout SSE if the job's activeDeadlineSeconds fires.
    const batchV1ForCleanup = batchV1;
    const coreV1ForCleanup = coreV1;
    const cleanupDeps: CleanupBootstrapDeps = {
      deleteJob: async (name: string) => {
        try {
          await batchV1ForCleanup.deleteNamespacedJob({
            name,
            namespace: NAMESPACE,
            gracePeriodSeconds: 0,
          });
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) {
            logger.debug({ name }, 'bootstrap cleanup: Job already absent');
            return;
          }
          throw err;
        }
      },
      deletePvc: async (name: string) => {
        try {
          await coreV1ForCleanup.deleteNamespacedPersistentVolumeClaim({
            name,
            namespace: NAMESPACE,
            gracePeriodSeconds: 0,
          });
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) {
            logger.debug({ name }, 'bootstrap cleanup: PVC already absent');
            return;
          }
          throw err;
        }
      },
      deleteSecret: async (name: string) => {
        try {
          await coreV1ForCleanup.deleteNamespacedSecret({
            name,
            namespace: NAMESPACE,
          });
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) {
            logger.debug({ name }, 'bootstrap cleanup: Secret already absent');
            return;
          }
          throw err;
        }
      },
      publishSse: async (topic, payload) => {
        try {
          await getRedisClient().publish(topic, JSON.stringify(payload));
        } catch (err) {
          logger.warn(
            { topic, err },
            'bootstrap cleanup: failed to publish SSE',
          );
        }
      },
      activeBootstraps,
      pendingBootstrapQuestions: pendingBootstrapQuestionByJob,
      // Story 180: record terminal outcome and deregister metadata
      recordTerminal: (instName: string, bjId: string, outcome: string) => {
        const meta = getBootstrapMeta(instName);
        if (meta) {
          db.recordBootstrapTerminal({
            bootstrapJobId: bjId,
            channelType: meta.channelType,
            instanceName: instName,
            skillName: meta.skillName,
            startedAt: meta.startedAt,
            outcome:
              outcome as import('./db.js').BootstrapHistoryRow['outcome'],
          });
        }
        deregisterBootstrapMeta(instName);
      },
      // Story 184: pass audit context so cleanupBootstrapResources can write terminal audit row.
      // Both Story 180 (bootstrap_history) and Story 184 (bootstrap_audit) terminal rows are
      // written from cleanupBootstrapResources to prevent drift between the two tables.
      auditContext: {
        adminIdentity,
        adminSessionId,
        channelType,
        instanceName,
        skillName,
        skillContentHash: '',
        manifestHashRequested: '',
        startedAt: bootstrapStartedAt,
      },
    };

    const timeoutSeconds = parseInt(
      process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS || '900',
      10,
    );
    const bootstrapJobName = `kubeclaw-bootstrap-${instanceName}`;
    waitForBootstrapJobCompletion(
      bootstrapJobName,
      result.bootstrapJobId,
      instanceName,
      {
        waitForJob: (name: string, timeoutMs: number) =>
          jobRunner.waitForJobCompletion(name, timeoutMs),
        cleanupDeps,
        bootstrapTimeoutSeconds: timeoutSeconds,
      },
    ).catch((err) => {
      logger.warn(
        { bootstrapJobName, instanceName, err },
        'waitForBootstrapJobCompletion crashed unexpectedly',
      );
    });

    return [
      `Bootstrap started successfully.`,
      `  bootstrapJobId: ${result.bootstrapJobId}`,
      `  Channel: ${channelType}/${instanceName}`,
      `  Skill: ${skillName}`,
      `  Job: kubeclaw-bootstrap-${instanceName}`,
      `  PVC: kubeclaw-channel-${instanceName}-runtime`,
      ``,
      `The bootstrap agent will appear on the SSE event stream (/events).`,
      `Respond to its questions via /chat in the admin shell.`,
    ].join('\n');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Story 181: upgrade_channel handler ──────────────────────────────────────

async function handleUpgradeChannel(input: ToolInput): Promise<string> {
  const instanceName = input.instance_name as string;
  const targetManifestHash = input.target_manifest_hash as string;

  if (!instanceName) return 'Error: instance_name is required.';
  if (!targetManifestHash) return 'Error: target_manifest_hash is required.';

  if (!/^[a-z0-9][a-z0-9-]*$/.test(instanceName) || instanceName.length > 40) {
    return `Error: instance_name must be lowercase alphanumeric with hyphens only (max 40 chars).`;
  }

  try {
    const { BatchV1Api: BatchV1ApiClass } =
      await import('@kubernetes/client-node');
    const batchV1 = kc.makeApiClient(BatchV1ApiClass);
    const k8sDeps = { coreV1, batchV1, appsV1 };

    const channelBaseImage =
      process.env.KUBECLAW_BOOTSTRAP_AGENT_IMAGE || 'kubeclaw-agent:latest';

    const result = await runUpgrade({
      instanceName,
      targetManifestHash,
      k8sDeps,
      namespace: NAMESPACE,
      channelBaseImage,
      activeBootstraps,
      timeoutSeconds: parseInt(
        process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS || '900',
        10,
      ),
      pvcSize: process.env.BOOTSTRAP_PVC_SIZE || '1Gi',
      redisUrl: process.env.REDIS_URL,
      redisUsername: process.env.REDIS_BOOTSTRAP_USERNAME,
      redisAdminPassword: process.env.REDIS_ADMIN_PASSWORD,
      openaiApiKey: process.env.OPENAI_API_KEY,
      openaiBaseUrl: process.env.OPENAI_BASE_URL,
      directLlmModel: process.env.DIRECT_LLM_MODEL,
    });

    if (result.alreadyInProgress === 'upgrade') {
      return JSON.stringify({
        code: 'ALREADY_IN_PROGRESS',
        reason: `upgrade already active for ${instanceName}`,
      });
    }
    if (result.alreadyInProgress === 'bootstrap') {
      return JSON.stringify({
        code: 'ALREADY_IN_PROGRESS',
        reason: `bootstrap already active for ${instanceName}`,
      });
    }

    // Register metadata under composite key so bootstrap_status shows state: "upgrading"
    const upgradeKey = `${instanceName}:upgrade`;
    registerBootstrapMeta(upgradeKey, {
      channelType: 'upgrade',
      skillName: 'upgrade',
      startedAt: new Date().toISOString(),
    });

    const graceSec = parseInt(
      process.env.UPGRADE_OLD_PVC_GRACE_SECONDS || '300',
      10,
    );

    // Build cleanup deps (same pattern as handleBootstrapChannelFromSkill)
    const cleanupDeps: CleanupBootstrapDeps = {
      deleteJob: async (name: string) => {
        try {
          await batchV1.deleteNamespacedJob({
            name,
            namespace: NAMESPACE,
            gracePeriodSeconds: 0,
          });
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) return;
          throw err;
        }
      },
      deletePvc: async (name: string) => {
        try {
          await coreV1.deleteNamespacedPersistentVolumeClaim({
            name,
            namespace: NAMESPACE,
            gracePeriodSeconds: 0,
          });
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) return;
          throw err;
        }
      },
      // Upgrade path never creates a credentials Secret — no-op
      deleteSecret: async (_name: string) => {},
      publishSse: async (topic, payload) => {
        try {
          await getRedisClient().publish(topic, JSON.stringify(payload));
        } catch (err) {
          logger.warn({ topic, err }, 'upgrade cleanup: failed to publish SSE');
        }
      },
      activeBootstraps,
      pendingBootstrapQuestions: pendingBootstrapQuestionByJob,
      recordTerminal: (instKey: string, bjId: string, outcome: string) => {
        const meta = getBootstrapMeta(instKey);
        if (meta) {
          db.recordBootstrapTerminal({
            bootstrapJobId: bjId,
            channelType: meta.channelType,
            instanceName: instKey,
            skillName: meta.skillName,
            startedAt: meta.startedAt,
            outcome:
              outcome as import('./db.js').BootstrapHistoryRow['outcome'],
          });
        }
        deregisterBootstrapMeta(instKey);
      },
    };

    const upgradeJobName = `kubeclaw-bootstrap-${instanceName}-upgrade`;
    const timeoutSeconds = parseInt(
      process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS || '900',
      10,
    );

    // Fire-and-forget: watch the upgrade Job for DeadlineExceeded (Story 175 pattern)
    waitForBootstrapJobCompletion(
      upgradeJobName,
      result.upgradeJobId,
      upgradeKey,
      {
        waitForJob: (name: string, ms: number) =>
          jobRunner.waitForJobCompletion(name, ms),
        cleanupDeps,
        bootstrapTimeoutSeconds: timeoutSeconds,
      },
    ).catch((err) => {
      logger.warn(
        { upgradeJobName, instanceName, err },
        'upgrade: waitForBootstrapJobCompletion crashed unexpectedly',
      );
    });

    return [
      `Upgrade started successfully.`,
      `  upgradeJobId: ${result.upgradeJobId}`,
      `  Instance: ${instanceName}`,
      `  Old PVC: ${result.oldPvcName}`,
      `  New PVC: ${result.newPvcName}`,
      `  Target hash: ${targetManifestHash}`,
      ``,
      `The upgrade agent will appear on the SSE event stream (/events).`,
      `Old PVC will be deleted ${graceSec}s after successful rollout.`,
      `On failure, the new PVC is deleted and the channel continues on ${result.oldPvcName}.`,
      ``,
      `DURABILITY NOTE: The old PVC grace-period deletion is scheduled via setTimeout.`,
      `If the orchestrator restarts during the grace window, the deletion is lost.`,
      `(Follow-on story: persist pending deletions in SQLite for durability.)`,
    ].join('\n');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
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

// ---- Tool catalog handlers ----

function handleRegisterTool(input: ToolInput): string {
  const spec = {
    name: input.name as string,
    description: input.description as string,
    parameters: input.parameters as Record<string, unknown>,
    image: input.image as string,
    pattern: input.pattern as 'http' | 'file' | 'acp',
    ...(input.port !== undefined && { port: input.port as number }),
    ...(input.command !== undefined && { command: input.command as string[] }),
    ...(input.healthPath !== undefined && {
      healthPath: input.healthPath as string,
    }),
    ...(input.pullPolicy !== undefined && {
      pullPolicy: input.pullPolicy as 'Always' | 'IfNotPresent' | 'Never',
    }),
    ...(input.channels !== undefined && {
      channels: input.channels as string[],
    }),
    ...(input.acpAgentName !== undefined && {
      acpAgentName: input.acpAgentName as string,
    }),
    ...(input.acpMode !== undefined && {
      acpMode: input.acpMode as 'sync' | 'async',
    }),
    ...(input.memoryRequest !== undefined && {
      memoryRequest: input.memoryRequest as string,
    }),
    ...(input.memoryLimit !== undefined && {
      memoryLimit: input.memoryLimit as string,
    }),
    ...(input.cpuRequest !== undefined && {
      cpuRequest: input.cpuRequest as string,
    }),
    ...(input.cpuLimit !== undefined && { cpuLimit: input.cpuLimit as string }),
    ...(input.requestMapping !== undefined && {
      requestMapping:
        input.requestMapping as import('./tools/types.js').RequestMapping,
    }),
  };
  const result = registerTool(spec, toolReconciler.apply.bind(toolReconciler));
  if (!result.ok) return `Error: ${result.error}`;
  return `Registered tool "${spec.name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleEditTool(input: ToolInput): string {
  const name = input.name as string;
  if (!name) return 'Error: name is required.';
  const patch: Record<string, unknown> = {};
  for (const f of [
    'description',
    'parameters',
    'image',
    'pattern',
    'port',
    'command',
    'healthPath',
    'pullPolicy',
    'channels',
    'acpAgentName',
    'acpMode',
    'memoryRequest',
    'memoryLimit',
    'cpuRequest',
    'cpuLimit',
    'requestMapping',
  ]) {
    if (input[f] !== undefined) patch[f] = input[f];
  }
  const result = editTool(
    { name, patch },
    toolReconciler.apply.bind(toolReconciler),
  );
  if (!result.ok) return `Error: ${result.error}`;
  return `Updated tool "${name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleRemoveTool(input: ToolInput): string {
  const name = input.name as string;
  if (!name) return 'Error: name is required.';
  const result = removeTool(
    { name },
    toolReconciler.apply.bind(toolReconciler),
  );
  if (!result.ok) return `Error: ${result.error}`;
  return `Removed tool override "${name}". Changes are live; channel pods will see the updated catalog within ~30s.`;
}

function handleListTools(): string {
  const tools = listToolOverrides();
  if (tools.length === 0)
    return 'No tool overrides registered. (Helm baseline tools are not shown here.)';
  return tools
    .map((t) =>
      [
        `Name: ${t.name}`,
        `  Image: ${t.image}  (${t.pattern})`,
        `  Desc: ${t.description.slice(0, 80)}${t.description.length > 80 ? '…' : ''}`,
        `  Channels: ${t.channels?.length ? t.channels.join(', ') : 'all'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

// ---- Channel manifest tool handlers ----

function handleListChannelManifests(): string {
  const baselineEntries = loadChannelManifestBaselineFromDisk();
  const overrideRows = listChannelManifestOverrides();
  const overrides = overrideRows.map((row) => {
    const p = JSON.parse(row.package_json) as {
      name?: string;
      version?: string;
    };
    return {
      channel_type: row.channel_type,
      package_name: p.name ?? row.channel_type,
      package_version: p.version ?? '0.0.0',
      manifest_hash: row.manifest_hash,
      source: 'admin-registered' as const,
      registered_at: row.registered_at,
      registered_by: row.registered_by,
    };
  });
  const merged = mergeManifests(baselineEntries, overrides);
  if (merged.length === 0) return 'No channel manifests registered.';
  // Strip raw package content from list output for readability
  const listView = merged.map(
    ({ package_json: _pj, package_lock_json: _pl, ...rest }) => rest,
  );
  return JSON.stringify(listView, null, 2);
}

async function handleRegisterChannelManifest(
  input: ToolInput,
): Promise<string> {
  const channel_type = input.channel_type as string;
  const package_json = input.package_json as string;
  const package_lock_json = input.package_lock_json as string;
  if (!channel_type || !package_json || !package_lock_json) {
    return 'Error: channel_type, package_json, and package_lock_json are all required.';
  }
  // Read allowedLifecycleScripts from env (set by Helm values via env injection).
  // Default: empty (no lifecycle scripts allowed).
  const allowedRaw = process.env.BOOTSTRAP_ALLOWED_LIFECYCLE_SCRIPTS ?? '';
  const allowedLifecycleScripts = allowedRaw
    ? allowedRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const result = registerChannelManifest(
    { channel_type, package_json, package_lock_json },
    allowedLifecycleScripts,
    channelManifestReconciler.apply.bind(channelManifestReconciler),
  );
  if (!result.ok) return `Error: ${result.error}`;
  return JSON.stringify({
    channel_type,
    manifest_hash: result.manifest_hash,
    source: result.source,
  });
}

// ---- Bootstrap skill tool handlers (Story 179) ----

function handleListBootstrapSkills(): string {
  const baselineEntries = loadBootstrapSkillBaselineFromDisk();
  const overrideRows = listBootstrapSkillOverrides();
  const overrides = overrideRows.map((row) => {
    const channelTypeMatch = /channelType:\s*(\S+)/.exec(row.markdown);
    const manifestVersionMatch = /manifestVersion:\s*(\S+)/.exec(row.markdown);
    return {
      name: row.name,
      channel_type: channelTypeMatch ? channelTypeMatch[1] : '',
      manifest_version: manifestVersionMatch ? manifestVersionMatch[1] : '',
      content_hash: row.content_hash,
      source: 'admin-registered' as const,
      registered_at: row.registered_at,
      registered_by: row.registered_by,
    };
  });
  const merged = mergeSkills(baselineEntries, overrides);
  if (merged.length === 0) return 'No bootstrap skills registered.';
  // Strip raw markdown from list output for readability
  const listView = merged.map(({ markdown: _md, ...rest }) => rest);
  return JSON.stringify(listView, null, 2);
}

async function handleRegisterBootstrapSkill(input: ToolInput): Promise<string> {
  const name = input.name as string;
  const markdown = input.markdown as string;
  if (!name || !markdown) {
    return 'Error: name and markdown are both required.';
  }

  // Build knownManifests from the Story 178 registry (baseline + overrides).
  // This is the cross-validation source for bootstrap.channelType/manifestVersion.
  const manifestBaselineEntries = loadChannelManifestBaselineFromDisk();
  const manifestOverrideRows = listChannelManifestOverrides();
  const knownManifests = [
    ...manifestBaselineEntries.map((e) => ({
      channelType: e.channel_type,
      manifestVersion: (() => {
        try {
          const pkg = JSON.parse(e.package_json ?? '{}') as {
            version?: string;
          };
          return pkg.version ?? '0.0.0';
        } catch {
          return '0.0.0';
        }
      })(),
    })),
    ...manifestOverrideRows.map((row) => {
      try {
        const pkg = JSON.parse(row.package_json) as { version?: string };
        return {
          channelType: row.channel_type,
          manifestVersion: pkg.version ?? '0.0.0',
        };
      } catch {
        return { channelType: row.channel_type, manifestVersion: '0.0.0' };
      }
    }),
  ];

  const result = registerBootstrapSkill(
    { name, markdown },
    knownManifests,
    bootstrapSkillReconciler.apply.bind(bootstrapSkillReconciler),
  );
  if (!result.ok) return `Error: ${result.error}`;
  return JSON.stringify({
    name,
    content_hash: result.content_hash,
    source: result.source,
  });
}

function handleRemoveBootstrapSkill(input: ToolInput): string {
  const name = input.name as string;
  if (!name) return 'Error: name is required.';
  const result = removeBootstrapSkill(
    name,
    loadBootstrapSkillBaselineFromDisk,
    bootstrapSkillReconciler.apply.bind(bootstrapSkillReconciler),
  );
  if (!result.ok) {
    // PROTECTED_BASELINE structured error
    return JSON.stringify(result);
  }
  return JSON.stringify({ name, status: result.status });
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

// ─── Story 180: report_step + bootstrap_status handlers ──────────────────────

async function handleReportStep(input: ToolInput): Promise<string> {
  const rawLabel = input.label as string | undefined;
  if (!rawLabel) return 'Error: label is required.';

  // Client-side truncation (max 200 chars)
  const label = rawLabel.slice(0, 200);

  const bootstrapJobId = process.env.KUBECLAW_BOOTSTRAP_JOB_ID;
  if (!bootstrapJobId) {
    return 'Error: report_step can only be called inside a bootstrap agent loop (KUBECLAW_BOOTSTRAP_JOB_ID not set).';
  }

  const topic = `kubeclaw:bootstrap:${bootstrapJobId}`;
  const payload = {
    type: 'step',
    label,
    ts: new Date().toISOString(),
  };

  try {
    await getRedisClient().publish(topic, JSON.stringify(payload));
    return `Step reported: "${label}"`;
  } catch (err) {
    return `Error publishing step: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleReplyToBootstrap(input: ToolInput): Promise<string> {
  const instanceName = input.instance_name as string | undefined;
  const message = input.message as string | undefined;

  if (!instanceName || !message) {
    return 'Error: instance_name and message are required.';
  }

  // activeBootstraps maps instanceName -> bootstrapJobId; the bootstrap pod
  // subscribes to kubeclaw:bootstrap-admin:<bootstrapJobId>. Also support the
  // upgrade path, whose key is "<instance>:upgrade".
  const bjid =
    activeBootstraps.get(instanceName) ??
    activeBootstraps.get(`${instanceName}:upgrade`);
  if (!bjid) {
    return `Error: No active bootstrap found for instance "${instanceName}".`;
  }

  try {
    await getRedisClient().publish(
      `kubeclaw:bootstrap-admin:${bjid}`,
      JSON.stringify({ text: message }),
    );
    // Only clear after a successful publish: if the publish throws the pod never
    // received the reply and is still waiting, so the question must stay pending
    // (it keeps surfacing in the admin LLM's context so the reply can be retried).
    pendingBootstrapQuestionByJob.delete(bjid);
    return `Reply forwarded to bootstrap pod for ${instanceName}.`;
  } catch (err) {
    return `Error publishing reply: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleBootstrapStatus(input: ToolInput): Promise<string> {
  const limit = input.limit as number | undefined;
  const channelTypeFilter = input.channel_type_filter as string | undefined;
  const includeLogs = (input.include_logs as boolean | undefined) ?? false;

  const { BatchV1Api: BatchV1ApiClass } =
    await import('@kubernetes/client-node');
  const batchV1 = kc.makeApiClient(BatchV1ApiClass);

  const deps: BootstrapStatusDeps = {
    getStepLabel: (bjid: string) => currentStepByJob.get(bjid),
    getPodPhase: async (instanceName: string) => {
      try {
        const jobName = `kubeclaw-bootstrap-${instanceName}`;
        const job = await batchV1.readNamespacedJob({
          name: jobName,
          namespace: NAMESPACE,
        });
        if (job.status?.succeeded) return 'Succeeded';
        if (job.status?.failed) return 'Failed';
        return 'Running';
      } catch {
        return null;
      }
    },
    getPodLogs: includeLogs
      ? async (instanceName: string) => {
          try {
            const podList = await coreV1.listNamespacedPod({
              namespace: NAMESPACE,
              labelSelector: `kubeclaw-channel=${instanceName},kubeclaw.io/role=bootstrap`,
            });
            const pod = podList.items[0];
            if (!pod?.metadata?.name) return null;
            const logs = await coreV1.readNamespacedPodLog({
              name: pod.metadata.name,
              namespace: NAMESPACE,
              container: 'bootstrap',
              tailLines: 50,
            });
            return typeof logs === 'string' ? logs : null;
          } catch {
            return null;
          }
        }
      : undefined,
    getBootstrapMeta: (instanceName: string) => getBootstrapMeta(instanceName),
  };

  const result = await bootstrapStatus(activeBootstraps, deps, {
    limit,
    channelTypeFilter,
    includeLogs,
  });

  return JSON.stringify(result, null, 2);
}

// ─── Story 184: bootstrap_audit_log handler ───────────────────────────────────

function handleBootstrapAuditLog(input: ToolInput): string {
  const limit = input.limit as number | undefined;
  const channelType = input.channel_type as string | undefined;
  const outcome = input.outcome as BootstrapAuditOutcome | undefined;
  const since = input.since as string | undefined;

  const rows = queryBootstrapAudit({
    limit,
    channelType,
    outcome,
    since,
  });
  return JSON.stringify(rows, null, 2);
}

// db may be undefined when this module is imported directly (e.g. via kubectl
// exec node -e) without main() running first. Guard here so executeTool works
// in both the production path (main → initDatabase) and the test/exec path.
let _dbInitPromise: Promise<void> | null = null;

export async function executeTool(
  name: string,
  input: ToolInput,
  adminIdentity: string = 'anonymous',
  adminSessionId: string | null = null,
): Promise<string> {
  if (!db.db) {
    if (!_dbInitPromise) _dbInitPromise = initDatabase();
    await _dbInitPromise;
  }
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
    case 'register_tool':
      return handleRegisterTool(input);
    case 'edit_tool':
      return handleEditTool(input);
    case 'remove_tool':
      return handleRemoveTool(input);
    case 'list_tools':
      return handleListTools();
    case 'list_channel_manifests':
      return handleListChannelManifests();
    case 'register_channel_manifest':
      return handleRegisterChannelManifest(input);
    case 'list_bootstrap_skills':
      return handleListBootstrapSkills();
    case 'register_bootstrap_skill':
      return handleRegisterBootstrapSkill(input);
    case 'remove_bootstrap_skill':
      return handleRemoveBootstrapSkill(input);
    case 'set_group_credential':
      return handleSetGroupCredential(input);
    case 'unset_group_credential':
      return handleUnsetGroupCredential(input);
    case 'bootstrap_channel_from_skill':
      return handleBootstrapChannelFromSkill(
        input,
        adminIdentity,
        adminSessionId,
      );
    case 'bootstrap_audit_log':
      return handleBootstrapAuditLog(input);
    case 'upgrade_channel':
      return handleUpgradeChannel(input);
    case 'report_step':
      return handleReportStep(input);
    case 'reply_to_bootstrap':
      return handleReplyToBootstrap(input);
    case 'bootstrap_status':
      return handleBootstrapStatus(input);
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

When registering a group, confirm the details before calling register_group. After registering, inform the user that changes take effect on the next orchestrator poll (~2 seconds).

When a channel bootstrap is in progress (started via bootstrap_channel_from_skill) and the user provides an answer to a question the bootstrap agent asked — such as a TCP port, API token, or other configuration value — call reply_to_bootstrap with the channel instance name and the user's answer as the message. Do not answer such questions yourself; forward them so the bootstrap agent can continue.`;

// ---- Shared agentic loop ----

/**
 * Build a system note listing bootstrap agents currently blocked on an
 * ask_admin question, so the admin LLM knows what is pending and which
 * instance_name to pass to reply_to_bootstrap. Reverse-maps activeBootstraps
 * (instanceName -> bootstrapJobId) against the pending-question map populated by
 * the bootstrap topic subscriber. Returns null when nothing is pending.
 */
export function buildPendingBootstrapNote(): string | null {
  const lines: string[] = [];
  for (const [instanceKey, bjid] of activeBootstraps) {
    const pending = pendingBootstrapQuestionByJob.get(bjid);
    if (!pending) continue;
    // Upgrade bootstraps are keyed "<instance>:upgrade"; reply_to_bootstrap
    // resolves either form, so report the base instance name.
    const instanceName = instanceKey.replace(/:upgrade$/, '');
    lines.push(`- instance "${instanceName}" is waiting for: ${pending.text}`);
  }
  if (lines.length === 0) return null;
  return (
    "A bootstrap agent is blocked waiting for an admin answer. If the user's " +
    'message answers one of these questions, call reply_to_bootstrap with the ' +
    "matching instance_name and the user's answer as the message. Do not answer " +
    'these questions yourself.\n' +
    lines.join('\n')
  );
}

async function runAgenticTurn(
  client: OpenAI,
  history: OpenAI.ChatCompletionMessageParam[],
  userInput: string,
  adminIdentity: string = 'anonymous',
  adminSessionId: string | null = null,
): Promise<string> {
  history.push({ role: 'user', content: userInput });
  let lastToolResult = '';

  while (true) {
    const pendingNote = buildPendingBootstrapNote();
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM },
      ...history,
    ];
    if (pendingNote) messages.push({ role: 'system', content: pendingNote });
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
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
        result = await executeTool(
          call.function.name,
          args,
          adminIdentity,
          adminSessionId,
        );
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
  /** UUID generated at SSE registration — used as admin_session_id in bootstrap_audit rows. */
  sessionId: string;
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
      const c: SseAdminClient = {
        username: user,
        sessionId: randomUUID(),
        res,
      };
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
        // Story 184: resolve sessionId from the most-recently-registered SSE client for this user.
        const sseClient = [...sseClients]
          .reverse()
          .find((c) => c.username === user);
        const sessionId = sseClient?.sessionId ?? null;
        runAgenticTurn(client, history, text.trim(), user, sessionId)
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

  // Story 180: prune old bootstrap_history rows
  startBootstrapHistoryGcInterval();
  // Story 184: prune old bootstrap_audit rows
  startBootstrapAuditGcInterval();

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
