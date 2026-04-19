/**
 * Runtime Types for KubeClaw
 *
 * Four-tier pod model:
 *   Orchestrator  — manages pod lifecycles, mediates discovery
 *   Channel pods  — own LLM conversations via DirectLLMRunner
 *   Capability    — sidecar runners (file / HTTP) for custom containers
 *   Tool jobs     — short-lived specialist K8s jobs (NOT full agent conversations)
 *
 * The MessageRunner interface is the shared contract across all tiers.
 */

import { RegisteredGroup, McpServerStatus } from '../types.js';
import { RawAttachment } from '../k8s/types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface Task {
  id: string;
  groupFolder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

/**
 * Unified interface for message/conversation execution across runtimes.
 *
 * In the four-tier model:
 *   - DirectLLMRunner implements this for channel pods (primary path)
 *   - KubernetesToolJobRunner implements this for orchestrator-spawned tool jobs
 *   - FileSidecarToolJobRunner / HttpSidecarToolJobRunner implement this for
 *     custom container sidecars
 *
 * @alias AgentRunner — kept as a backwards-compatible re-export
 */
export interface MessageRunner {
  runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess?: (proc: unknown, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput>;

  writeTasksSnapshot(groupFolder: string, isMain: boolean, tasks: Task[]): void;
  writeGroupsSnapshot(
    groupFolder: string,
    isMain: boolean,
    groups: AvailableGroup[],
    registeredJids: Set<string>,
  ): void;
  shutdown(): Promise<void>;

  /**
   * Spawn a preprocessing job to convert raw attachments before the runner executes.
   * Implemented by KubernetesToolJobRunner; not available on other runners.
   */
  runPreprocessingJob?(
    group: RegisteredGroup,
    attachments: RawAttachment[],
    opts?: { groupsPvc?: string },
  ): Promise<boolean>;

  /**
   * Configure (or reconfigure) MCP server connections.
   * Implemented by DirectLLMRunner; not available on other runners.
   */
  configureMcp?(servers: McpServerStatus[]): Promise<void>;

  /**
   * Send a follow-up message to an active sidecar job.
   * Implemented by FileSidecarToolJobRunner and HttpSidecarToolJobRunner.
   */
  sendFollowUpMessage?(groupFolder: string, text: string): Promise<boolean>;
}

/**
 * Backwards-compatible alias. Prefer MessageRunner for new code.
 */
export type AgentRunner = MessageRunner;
