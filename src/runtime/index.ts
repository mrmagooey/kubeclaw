/**
 * Runtime Factory for KubeClaw — Four-Tier Pod Model
 *
 * Runner selection:
 *   DirectLLMRunner           — channel pods talk to LLM directly (primary path)
 *   KubernetesToolJobRunner   — spawns short-lived K8s tool jobs (NOT full agent chats)
 *
 * The orchestrator does NOT own LLM conversations; it only manages pod
 * lifecycles and mediates discovery. Channels own conversations via
 * DirectLLMRunner.
 */

import fs from 'fs';
import path from 'path';

import { JobRunner, buildJobName } from '../k8s/job-runner.js';
import { RawAttachment } from '../k8s/types.js';
import { DirectLLMRunner } from './direct-llm-runner.js';
import {
  ContainerInput,
  ContainerOutput,
  MessageRunner,
  AgentRunner,
  AvailableGroup,
  Task,
  RunAgentOverrides,
} from './types.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

// Re-export types from runtime types for convenience
export type {
  ContainerInput,
  ContainerOutput,
  MessageRunner,
  AgentRunner,
  AvailableGroup,
  Task,
};

/**
 * Kubernetes tool-job runner.
 *
 * Dispatches short-lived K8s Jobs for specialist tasks (tool execution,
 * preprocessing). This is NOT the primary conversation path — channel pods
 * use DirectLLMRunner for that. KubernetesToolJobRunner is used by the
 * orchestrator for scheduled tasks or as a legacy fallback when no
 * DirectLLMRunner is configured.
 */
class KubernetesToolJobRunner implements MessageRunner {
  private jobRunner: JobRunner;
  private groupIpcPaths: Map<string, string>;

  constructor() {
    this.jobRunner = new JobRunner();
    this.groupIpcPaths = new Map();
  }

  async runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess?: (proc: unknown, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    _overrides: RunAgentOverrides = {},
  ): Promise<ContainerOutput> {
    // Add job ID if not present
    const jobInput = {
      ...input,
      jobId: buildJobName(group.folder),
    };

    try {
      const result = await this.jobRunner.runToolJob(
        group,
        jobInput,
        onProcess ? (jobName) => onProcess(jobName, jobName) : undefined,
        onOutput,
      );

      return {
        status: result.status,
        result: result.result,
        newSessionId: result.newSessionId,
        error: result.error,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { group: group.name, error: errorMessage },
        'Kubernetes job failed',
      );
      return {
        status: 'error',
        result: null,
        error: errorMessage,
      };
    }
  }

  async runPreprocessingJob(
    group: RegisteredGroup,
    attachments: RawAttachment[],
    opts?: { groupsPvc?: string },
  ): Promise<boolean> {
    return this.jobRunner.runPreprocessingJob(group, attachments, opts);
  }

  writeTasksSnapshot(
    groupFolder: string,
    isMain: boolean,
    tasks: Task[],
  ): void {
    // In Kubernetes mode, tasks are written to the group's IPC directory
    // which is mounted via PVC. This allows tool jobs to read task state.
    const groupIpcDir = this.getGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));

    logger.debug(
      { groupFolder, taskCount: tasks.length },
      'Written tasks snapshot (K8s)',
    );
  }

  writeGroupsSnapshot(
    groupFolder: string,
    isMain: boolean,
    groups: AvailableGroup[],
    _registeredJids: Set<string>,
  ): void {
    const groupIpcDir = this.getGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    // Main sees all groups; others see nothing
    const visibleGroups = isMain ? groups : [];

    const groupsFile = path.join(groupIpcDir, 'available_groups.json');
    fs.writeFileSync(
      groupsFile,
      JSON.stringify(
        {
          groups: visibleGroups,
          lastSync: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    logger.debug(
      { groupFolder, isMain, groupCount: visibleGroups.length },
      'Written groups snapshot (K8s)',
    );
  }

  async shutdown(): Promise<void> {
    await this.jobRunner.cleanup();
    logger.info('Kubernetes runtime shutdown complete');
  }

  private getGroupIpcPath(folder: string): string {
    // Use the cached path if available
    if (this.groupIpcPaths.has(folder)) {
      return this.groupIpcPaths.get(folder)!;
    }

    // KUBECLAW_IPC_BASE must point to the orchestrator's mount of the sessions PVC.
    // The tool job mounts sessions PVC subPath "${folder}/ipc" at /workspace/ipc,
    // so this path must resolve to the same location on the shared volume.
    // In the orchestrator pod: set KUBECLAW_IPC_BASE to the sessions PVC mountPath
    // (e.g. /data/sessions). Default falls back to a local temp dir for testing.
    const ipcBaseDir = process.env.KUBECLAW_IPC_BASE || '/tmp/kubeclaw-ipc';
    const ipcPath = path.join(ipcBaseDir, folder, 'ipc');

    this.groupIpcPaths.set(folder, ipcPath);
    return ipcPath;
  }
}

// Two lazy singletons — one per runner type
let k8sRunner: KubernetesToolJobRunner | null = null;
let directLLMRunner: DirectLLMRunner | null = null;

function getK8sRunner(): KubernetesToolJobRunner {
  if (!k8sRunner) k8sRunner = new KubernetesToolJobRunner();
  return k8sRunner;
}

export function getDirectLLMRunner(): DirectLLMRunner {
  if (!directLLMRunner) directLLMRunner = new DirectLLMRunner();
  return directLLMRunner;
}

/**
 * Select the correct runner for a group based on its containerConfig.
 *
 * Routing rules (checked in order):
 *   direct  → DirectLLMRunner          (in-process LLM — primary path for channels)
 *   neither → KubernetesToolJobRunner  (short-lived tool jobs / scheduled tasks)
 */
export function getRunnerForGroup(group: RegisteredGroup): MessageRunner {
  const config = group.containerConfig ?? {};
  if ('userImage' in config) {
    logger.warn(
      { group: group.name },
      'containerConfig.userImage is no longer supported (legacy sidecar runners were removed); routing to the K8s tool-job runner',
    );
  }
  const { direct } = config as { direct?: boolean };
  if (direct) {
    logger.debug({ group: group.name }, 'Using direct LLM runner');
    return getDirectLLMRunner();
  }
  logger.debug({ group: group.name }, 'Using Kubernetes tool-job runner');
  return getK8sRunner();
}

/**
 * Returns the K8s tool-job runner — for call sites that have no group context
 * (e.g. writing groups snapshots from the orchestrator).
 *
 * @deprecated Prefer getRunnerForGroup(group) when a group is available.
 */
export function getToolJobRunner(): MessageRunner {
  return getK8sRunner();
}

/**
 * Backwards-compatible alias for getToolJobRunner().
 * @deprecated Use getToolJobRunner() or getRunnerForGroup(group).
 */
export const getAgentRunner = getToolJobRunner;

/**
 * Shut down all active runner instances.
 */
export async function shutdownAllRunners(): Promise<void> {
  await Promise.all([k8sRunner?.shutdown(), directLLMRunner?.shutdown()]);
  k8sRunner = directLLMRunner = null;
}

/**
 * Reset all singleton instances (for testing).
 */
export function resetRunners(): void {
  k8sRunner = directLLMRunner = null;
}

/**
 * Backwards-compatible alias for resetRunners().
 * @deprecated Use resetRunners().
 */
export const resetAgentRunner = resetRunners;
