/**
 * Runtime Types for KubeClaw
 *
 * Four-tier pod model:
 *   Orchestrator  — manages pod lifecycles, mediates discovery
 *   Channel pods  — own LLM conversations via DirectLLMRunner
 *   Capability    — long-lived features (memory, MCP)
 *   Tool jobs     — short-lived specialist K8s jobs (NOT full agent conversations)
 *
 * The MessageRunner interface is the shared contract across all tiers.
 */

import type OpenAI from 'openai';
import { RegisteredGroup, McpServerStatus } from '../types.js';
import { RawAttachment } from '../k8s/types.js';
import type { GroupMcpEntry } from '../capabilities/types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  /**
   * User-facing message ID from the POST /message response (Story 25).
   * Propagated to tool job spawn requests so orphan reconciliation (Story 37)
   * can reference it in the interruption notice (AC2).
   */
  originMessageId?: string | null;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'timeout' | 'oomkill';
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
 * Optional overrides for a single runAgent() invocation.
 *
 * - `sessionKey`   — history lookup/write key; defaults to group.folder
 * - `llmProvider`  — model identifier; defaults to group.llmProvider or system default
 * - `toolFilter`   — when present, only tools whose name is in this Set are advertised to the LLM
 */
export interface RunAgentOverrides {
  sessionKey?: string;
  llmProvider?: string;
  toolFilter?: Set<string>;
  /**
   * Replace the channel's default system prompt for this single call. Set by
   * the channel-runner for memory.isolated specialists so the LLM sees the
   * specialist's instructions as the system role rather than embedded in the
   * user message — otherwise the LLM counts the embedded specialist text as a
   * "prior conversation turn" when asked.
   */
  systemPromptOverride?: string;
  /**
   * Override the default MAX_TOOL_ROUNDS (10) for this single runAgent() call.
   * Must be a positive integer. Fallback: MAX_TOOL_ROUNDS constant (10).
   */
  maxToolRounds?: number;
  /**
   * Override the default tool output truncation limit (50 000 bytes) for this
   * single runAgent() call. Propagated to the tool-server pod via the
   * KUBECLAW_MAX_TOOL_OUTPUT_BYTES env var. Fallback: 50000.
   */
  maxToolOutputBytes?: number;
}

/**
 * Unified interface for message/conversation execution across runtimes.
 *
 * In the four-tier model:
 *   - DirectLLMRunner implements this for channel pods (primary path)
 *   - KubernetesToolJobRunner implements this for orchestrator-spawned tool jobs
 *
 * @alias AgentRunner — kept as a backwards-compatible re-export
 */
export interface MessageRunner {
  runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess?: (proc: unknown, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    overrides?: RunAgentOverrides,
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
   * Configure per-group MCP capability templates.
   * Implemented by DirectLLMRunner; not available on other runners.
   */
  configureGroupMcpTemplates?(templates: GroupMcpEntry[]): Promise<void>;

  /**
   * Send a follow-up message to an active job.
   * Optional: implemented by runners that can route follow-up messages to a live job.
   */
  sendFollowUpMessage?(groupFolder: string, text: string): Promise<boolean>;
}

/**
 * Backwards-compatible alias. Prefer MessageRunner for new code.
 */
export type AgentRunner = MessageRunner;

/** A locally-intercepted tool: definition for the LLM + async handler. */
export interface LocalTool {
  def: OpenAI.ChatCompletionTool;
  handler: (
    args: Record<string, unknown>,
    input: ContainerInput,
  ) => Promise<string>;
}
