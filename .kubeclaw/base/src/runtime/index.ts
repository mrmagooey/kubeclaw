/**
 * Runtime Factory for NanoClaw
 * Selects between Docker and Kubernetes runtimes
 */

import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { JobRunner } from '../k8s/job-runner.js';
import {
  ContainerInput,
  ContainerOutput,
  AgentRunner,
  AvailableGroup,
  Task,
} from './types.js';
import {
  ContainerInput as DockerContainerInput,
  ContainerOutput as DockerContainerOutput,
  runContainerAgent,
  writeTasksSnapshot as dockerWriteTasksSnapshot,
  writeGroupsSnapshot as dockerWriteGroupsSnapshot,
  AvailableGroup as DockerAvailableGroup,
} from '../container-runner.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { RUNTIME_MODE } from '../config.js';

// Re-export types from runtime types for convenience
export type {
  ContainerInput,
  ContainerOutput,
  AgentRunner,
  AvailableGroup,
  Task,
};

/**
 * Docker runtime implementation using container-runner.ts
 */
class DockerAgentRunner implements AgentRunner {
  async runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess?: (proc: unknown, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    // Cast the input to Docker's expected type (they're compatible)
    const dockerInput: DockerContainerInput = {
      ...input,
    };

    // Cast the onOutput callback to match Docker's expected signature
    const dockerOnOutput = onOutput
      ? async (output: DockerContainerOutput) => {
          await onOutput(output as ContainerOutput);
        }
      : undefined;

    // Cast the onProcess callback
    const dockerOnProcess = onProcess
      ? (proc: ChildProcess, containerName: string) => {
          onProcess(proc, containerName);
        }
      : () => {}; // No-op function when not provided

    return runContainerAgent(
      group,
      dockerInput,
      dockerOnProcess,
      dockerOnOutput,
    );
  }

  writeTasksSnapshot(
    groupFolder: string,
    isMain: boolean,
    tasks: Task[],
  ): void {
    // Convert Task array to the format expected by container-runner
    const dockerTasks = tasks.map((t) => ({
      id: t.id,
      groupFolder: t.groupFolder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    }));
    dockerWriteTasksSnapshot(groupFolder, isMain, dockerTasks);
  }

  writeGroupsSnapshot(
    groupFolder: string,
    isMain: boolean,
    groups: AvailableGroup[],
    registeredJids: Set<string>,
  ): void {
    // Convert AvailableGroup array to the format expected by container-runner
    const dockerGroups: DockerAvailableGroup[] = groups.map((g) => ({
      jid: g.jid,
      name: g.name,
      lastActivity: g.lastActivity,
      isRegistered: g.isRegistered,
    }));
    dockerWriteGroupsSnapshot(
      groupFolder,
      isMain,
      dockerGroups,
      registeredJids,
    );
  }

  async shutdown(): Promise<void> {
    // Docker runtime doesn't require explicit cleanup
    // Containers are cleaned up automatically via --rm flag
    logger.info('Docker runtime shutdown (no cleanup required)');
  }
}

/**
 * Kubernetes runtime implementation using k8s/job-runner.ts
 */
class KubernetesAgentRunner implements AgentRunner {
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
  ): Promise<ContainerOutput> {
    // Add job ID if not present
    const jobInput = {
      ...input,
      jobId: `nanoclaw-${group.folder}-${Date.now()}`,
    };

    try {
      const result = await this.jobRunner.runAgentJob(
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

  writeTasksSnapshot(
    groupFolder: string,
    isMain: boolean,
    tasks: Task[],
  ): void {
    // In Kubernetes mode, tasks are written to the group's IPC directory
    // which is mounted via PVC. This allows agent jobs to read task state.
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

    // In K8s mode, we use a shared PVC path structure
    // The path should match the volume mount configuration in job-runner.ts
    const ipcBaseDir = process.env.NANOCLAW_IPC_BASE || '/tmp/nanoclaw-ipc';
    const ipcPath = path.join(ipcBaseDir, folder);

    this.groupIpcPaths.set(folder, ipcPath);
    return ipcPath;
  }
}

/**
 * Factory function to create the appropriate AgentRunner based on runtime mode
 */
export function createAgentRunner(): AgentRunner {
  if (RUNTIME_MODE === 'kubernetes') {
    logger.info('Creating Kubernetes Agent Runner');
    return new KubernetesAgentRunner();
  }

  logger.info('Creating Docker Agent Runner');
  return new DockerAgentRunner();
}

/**
 * Singleton instance for convenience
 */
let agentRunnerInstance: AgentRunner | null = null;

export function getAgentRunner(): AgentRunner {
  if (!agentRunnerInstance) {
    agentRunnerInstance = createAgentRunner();
  }
  return agentRunnerInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetAgentRunner(): void {
  agentRunnerInstance = null;
}
