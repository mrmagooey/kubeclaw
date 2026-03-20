/**
 * Kubernetes-specific types for NanoClaw runtime
 */

import { ContainerInput, ContainerOutput } from '../container-runner.js';

export interface JobInput extends ContainerInput {
  jobId?: string;
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
  provider?: 'claude' | 'openrouter';
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
  type: 'message' | 'close' | 'task_update';
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
    | 'refresh_groups';
  taskId?: string;
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
}

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
