/**
 * Kubernetes-specific types for KubeClaw runtime
 */

import { ContainerInput, ContainerOutput } from '../runtime/types.js';
import {
  AdditionalMount,
  K8sToleration,
  K8sAffinity,
  ContainerSecurityContext,
  ToolSpec,
} from '../types.js';
import type { CatalogEntry } from '../credential-broker/resolver.js';

export interface JobInput extends ContainerInput {
  jobId?: string;
  groupsPvc?: string; // override PVC name for channel pod tool jobs
  sessionsPvc?: string; // override PVC name for channel pod tool jobs
}

export interface JobOutput extends ContainerOutput {
  jobId?: string;
}

export interface JobStatus {
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  startTime?: string;
  completionTime?: string;
  message?: string;
  reason?: string;
}

export interface ToolJobSpec {
  name: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  prompt: string;
  sessionId?: string;
  assistantName?: string;
  timeout?: number;
  provider?: string;
  browserSidecar?: boolean;
  // Node scheduling
  nodeSelector?: Record<string, string>;
  tolerations?: K8sToleration[];
  affinity?: K8sAffinity;
  priorityClassName?: string;
  // GPU / accelerator
  deviceRequests?: Record<string, string>;
  // Private registry
  imagePullSecrets?: string[];
  // Security context
  securityContext?: ContainerSecurityContext;
  // Additional volumes
  additionalMounts?: AdditionalMount[];
  // PVC override — used when tool job runs on behalf of a channel pod
  groupsPvc?: string; // defaults to 'kubeclaw-groups'
  sessionsPvc?: string; // defaults to 'kubeclaw-sessions'
  // Per-group credential injection (Task 11).
  // When present, the job manifest stamps catalog-driven envs and owner-group annotation.
  ownerGroup?: string; // group name for kubeclaw.io/owner-group annotation
  catalogEntries?: CatalogEntry[]; // catalog snapshot at pod-create time
  // placeholders: { [catalogId]: { [fieldName]: placeholderString } }
  groupPlaceholders?: Record<string, Record<string, string>>;
}

export interface RedisConfig {
  url: string;
  maxRetriesPerRequest: number | null;
  enableReadyCheck: boolean;
}

export interface AgentOutputMessage {
  type: 'output' | 'task_request' | 'status' | 'log';
  jobId: string;
  groupFolder: string;
  timestamp: string;
  payload: ContainerOutput | TaskRequest | StatusUpdate | LogMessage;
}

export interface HostInputMessage {
  type: 'message' | 'close' | 'eoi' | 'task_update';
  text?: string;
  taskId?: string;
  status?: 'paused' | 'resumed' | 'cancelled';
}

export interface TaskRequest {
  type:
    | 'schedule_task'
    | 'pause_task'
    | 'resume_task'
    | 'cancel_task'
    | 'update_task'
    | 'register_group'
    | 'refresh_groups'
    | 'deploy_channel'
    | 'control_channel'
    | 'install_capability'
    | 'remove_capability'
    | 'list_capabilities'
    | 'secret.add'
    | 'secret.remove'
    | 'secret.list'
    | 'catalog.list'
    | 'commit_channel_config';
  taskId?: string;
  yaml?: string; // deploy_channel: Kubernetes YAML to apply
  channelName?: string; // control_channel: target channel pod name (e.g. 'telegram')
  command?: 'reload'; // control_channel: command to send
  prompt?: string;
  schedule_type?: 'cron' | 'interval' | 'once';
  schedule_value?: string;
  context_mode?: 'group' | 'isolated';
  targetJid?: string;
  groupFolder?: string;
  jid?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  containerConfig?: Record<string, unknown>;
  // Capability fields
  spec?: string; // JSON-stringified CapabilitySpec for install_capability
  resultStream?: string; // for list_capabilities / secret.* result
  // Secret management fields
  catalogId?: string; // secret.add / secret.remove: catalog entry ID
  fields?: string; // secret.add: JSON-stringified Record<string, string>
  group?: string; // secret.add / secret.remove / secret.list: group name
}

/** IPC message type interfaces for credential management */
export interface SecretAddIpc {
  type: 'secret.add';
  group: string;
  catalogId: string;
  fields: Record<string, string>;
}

export interface SecretRemoveIpc {
  type: 'secret.remove';
  group: string;
  catalogId: string;
}

export interface SecretListIpc {
  type: 'secret.list';
  group: string;
}

export interface CatalogListIpc {
  type: 'catalog.list';
}

/** IPC response envelope for secret/catalog operations */
export type IpcResponse =
  | { ok: true; result?: unknown }
  | { ok: false; error: string };

export interface SidecarToolPodJobSpec {
  agentJobId: string;
  groupFolder: string;
  toolName: string; // used as Redis stream "category" key
  toolSpec: ToolSpec;
  timeout: number;
  groupsPvc?: string;
  sessionsPvc?: string;
}

export { ToolSpec };

export interface StatusUpdate {
  status: 'running' | 'completed' | 'failed' | 'timeout';
  message?: string;
}

export interface LogMessage {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

export interface DistributedQueueItem {
  id: string;
  groupJid: string;
  jobSpec: ToolJobSpec;
  priority: number;
  enqueuedAt: string;
}

export interface RawAttachment {
  rawPath: string; // relative path e.g. "attachments/raw/img-123.jpg"
  mediaType: string; // e.g. "image/jpeg" or "application/pdf"
  caption?: string;
}
