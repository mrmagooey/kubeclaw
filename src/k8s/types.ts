/**
 * Kubernetes-specific types for NanoClaw runtime
 */

import { ContainerInput, ContainerOutput } from '../runtime/types.js';
import {
  AdditionalMount,
  K8sToleration,
  K8sAffinity,
  ContainerSecurityContext,
  ToolSpec,
} from '../types.js';

export interface JobInput extends ContainerInput {
  jobId?: string;
  groupsPvc?: string;    // override PVC name for channel pod agent jobs
  sessionsPvc?: string;  // override PVC name for channel pod agent jobs
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

export interface AgentJobSpec {
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
  // PVC override — used when agent job runs on behalf of a channel pod
  groupsPvc?: string;    // defaults to 'kubeclaw-groups'
  sessionsPvc?: string;  // defaults to 'kubeclaw-sessions'
  // Superuser mode: grants direct local tool access in the agent container
  superuser?: boolean;
}

export interface SidecarJobSpec extends AgentJobSpec {
  userImage: string;
  userCommand?: string[];
  userArgs?: string[];
  filePollInterval?: number;
  memoryRequest?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  credentials?: SidecarCredentials;
  userImagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
}

export interface SidecarCredentials {
  username: string;
  password: string;
}

export interface SidecarHttpJobSpec extends AgentJobSpec {
  userImage: string;
  userPort?: number; // default: 8080
  healthEndpoint?: string; // default: /agent/health
  memoryRequest?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  credentials?: SidecarCredentials;
  userImagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
}

export interface SidecarFileJobSpec extends AgentJobSpec {
  userImage: string;
  userCommand?: string[];
  userArgs?: string[];
  filePollInterval?: number; // default: 1000ms
  memoryRequest?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  secrets?: Record<string, string>;
  credentials?: SidecarCredentials;
  userImagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
}

export interface RedisConfig {
  url: string;
  maxRetriesPerRequest: number;
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
  type: 'message' | 'close' | 'task_update' | 'tool_pod_ack';
  text?: string;
  taskId?: string;
  status?: 'paused' | 'resumed' | 'cancelled';
  category?: string;
  podJobId?: string;
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
    | 'tool_pod_request'
    | 'deploy_channel'
    | 'control_channel';
  taskId?: string;
  yaml?: string;  // deploy_channel: Kubernetes YAML to apply
  channelName?: string;  // control_channel: target channel pod name (e.g. 'telegram')
  command?: 'reload';    // control_channel: command to send
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
  // Tool pod request fields
  category?: 'execution' | 'browser';
  agentJobId?: string;
}

export interface ToolPodJobSpec {
  agentJobId: string;
  groupFolder: string;
  category: 'execution' | 'browser';
  timeout: number;
  provider?: string;     // inherit parent agent's provider for image selection
  groupsPvc?: string;    // defaults to 'kubeclaw-groups'
  sessionsPvc?: string;  // defaults to 'kubeclaw-sessions'
}

export interface SidecarToolPodJobSpec {
  agentJobId: string;
  groupFolder: string;
  toolName: string;       // used as Redis stream "category" key
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
  jobSpec: AgentJobSpec;
  priority: number;
  enqueuedAt: string;
}
