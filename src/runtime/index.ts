/**
 * Runtime Factory for NanoClaw
 * Kubernetes runtime
 */

import fs from 'fs';
import path from 'path';

import { JobRunner, buildJobName } from '../k8s/job-runner.js';
import { SidecarJobRunner } from '../k8s/sidecar-job-runner.js';
import { FileSidecarJobRunner } from '../k8s/file-sidecar-runner.js';
import { HttpSidecarJobRunner } from '../k8s/http-sidecar-runner.js';
import {
  ContainerInput,
  ContainerOutput,
  AgentRunner,
  AvailableGroup,
  Task,
} from './types.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { SIDECAR_ENABLED } from '../config.js';
import { getACLManager, RedisACLManager } from '../k8s/acl-manager.js';

// Re-export types from runtime types for convenience
export type {
  ContainerInput,
  ContainerOutput,
  AgentRunner,
  AvailableGroup,
  Task,
};

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
      jobId: buildJobName(group.folder),
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

    // NANOCLAW_IPC_BASE must point to the orchestrator's mount of the sessions PVC.
    // The agent job mounts sessions PVC subPath "${folder}/ipc" at /workspace/ipc,
    // so this path must resolve to the same location on the shared volume.
    // In the orchestrator pod: set NANOCLAW_IPC_BASE to the sessions PVC mountPath
    // (e.g. /data/sessions). Default falls back to a local temp dir for testing.
    const ipcBaseDir = process.env.NANOCLAW_IPC_BASE || '/tmp/nanoclaw-ipc';
    const ipcPath = path.join(ipcBaseDir, folder, 'ipc');

    this.groupIpcPaths.set(folder, ipcPath);
    return ipcPath;
  }
}

/**
 * File-based sidecar runtime implementation using k8s/file-sidecar-runner.ts
 * Enables running arbitrary containers without HTTP interfaces
 */
class FileSidecarAgentRunner implements AgentRunner {
  private jobRunner: FileSidecarJobRunner;
  private groupIpcPaths: Map<string, string>;
  private aclManager: RedisACLManager;
  private activeJobs: Map<string, { groupFolder: string; jobId: string }>;
  private sendMessageHandler?: (
    groupFolder: string,
    text: string,
  ) => Promise<boolean>;

  constructor() {
    this.jobRunner = new FileSidecarJobRunner();
    this.groupIpcPaths = new Map();
    this.aclManager = getACLManager();
    this.activeJobs = new Map();
  }

  /**
   * Set the message handler for sending follow-up messages to sidecars
   */
  setSendMessageHandler(
    handler: (groupFolder: string, text: string) => Promise<boolean>,
  ): void {
    this.sendMessageHandler = handler;
  }

  /**
   * Send a message to an active sidecar job
   * @param groupFolder The group folder
   * @param text The message text to send
   * @returns true if message was sent successfully
   */
  async sendMessage(groupFolder: string, text: string): Promise<boolean> {
    const activeJob = this.getActiveJobByGroup(groupFolder);
    if (!activeJob) {
      logger.debug({ groupFolder }, 'No active sidecar job found for group');
      return false;
    }

    const credentials = this.aclManager.getJobCredentials(activeJob.jobId);
    if (!credentials) {
      logger.warn(
        { jobId: activeJob.jobId },
        'No ACL credentials found for active job',
      );
      return false;
    }

    logger.debug(
      { groupFolder, jobId: activeJob.jobId },
      'Routing follow-up message to active sidecar',
    );

    if (this.sendMessageHandler) {
      return await this.sendMessageHandler(groupFolder, text);
    }

    return false;
  }

  /**
   * Get active job by group folder
   */
  private getActiveJobByGroup(
    groupFolder: string,
  ): { groupFolder: string; jobId: string } | undefined {
    for (const job of this.activeJobs.values()) {
      if (job.groupFolder === groupFolder) {
        return job;
      }
    }
    return undefined;
  }

  async runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess?: (proc: unknown, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    // Get container configuration from group
    const userImage = group.containerConfig?.userImage as string | undefined;
    const userCommand = group.containerConfig?.userCommand as
      | string[]
      | undefined;
    const userArgs = group.containerConfig?.userArgs as string[] | undefined;
    const filePollInterval = group.containerConfig?.filePollInterval as
      | number
      | undefined;

    if (!userImage) {
      return {
        status: 'error',
        result: null,
        error: 'File sidecar mode requires containerConfig.userImage to be set',
      };
    }

    // Add job ID if not present
    const jobInput = {
      ...input,
      jobId: buildJobName(group.folder),
    };

    // Build spec from group configuration
    const spec = {
      name: jobInput.jobId!,
      groupFolder: group.folder,
      chatJid: input.chatJid,
      isMain: input.isMain,
      prompt: input.prompt,
      sessionId: input.sessionId,
      assistantName: input.assistantName,
      timeout: group.containerConfig?.timeout as number | undefined,
      userImage,
      userCommand,
      userArgs,
      filePollInterval,
      memoryRequest: group.containerConfig?.memoryRequest as string | undefined,
      memoryLimit: group.containerConfig?.memoryLimit as string | undefined,
      cpuRequest: group.containerConfig?.cpuRequest as string | undefined,
      cpuLimit: group.containerConfig?.cpuLimit as string | undefined,
      secrets: input.secrets,
    };

    // Create ACL credentials for this job
    let credentials: { username: string; password: string } | undefined;
    try {
      await this.aclManager.createJobACL(jobInput.jobId!, group.folder);
      const creds = this.aclManager.getJobCredentials(jobInput.jobId!);
      if (creds) {
        credentials = creds;
        logger.info(
          {
            jobId: jobInput.jobId,
            groupFolder: group.folder,
            username: credentials.username,
          },
          'Created ACL credentials for file sidecar job',
        );
      }
    } catch (aclError) {
      const errorMessage =
        aclError instanceof Error ? aclError.message : String(aclError);
      logger.error(
        { jobId: jobInput.jobId, error: errorMessage },
        'Failed to create ACL credentials for file sidecar job',
      );
      // Continue without ACL - the job will still run but won't have secure Redis access
    }

    // Track this as an active job for follow-up routing
    this.activeJobs.set(jobInput.jobId!, {
      groupFolder: group.folder,
      jobId: jobInput.jobId!,
    });

    try {
      // Add credentials to spec for the sidecar adapter
      const specWithCredentials = {
        ...spec,
        credentials,
      };

      const result = await this.jobRunner.runAgentJob(
        group,
        jobInput,
        specWithCredentials,
        onProcess ? (jobName) => onProcess(jobName, jobName) : undefined,
        onOutput,
      );

      // Job completed - remove from active jobs and revoke ACL
      this.activeJobs.delete(jobInput.jobId!);
      try {
        await this.aclManager.revokeJobACL(jobInput.jobId!);
      } catch (revokeError) {
        logger.warn(
          { jobId: jobInput.jobId, error: revokeError },
          'Failed to revoke ACL after job completion',
        );
      }

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
        'File sidecar job failed',
      );

      // Job failed - clean up
      this.activeJobs.delete(jobInput.jobId!);
      try {
        await this.aclManager.revokeJobACL(jobInput.jobId!);
      } catch (revokeError) {
        logger.warn(
          { jobId: jobInput.jobId, error: revokeError },
          'Failed to revoke ACL after job failure',
        );
      }

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
    const groupIpcDir = this.getGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));

    logger.debug(
      { groupFolder, taskCount: tasks.length },
      'Written tasks snapshot (File Sidecar)',
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
      'Written groups snapshot (File Sidecar)',
    );
  }

  async shutdown(): Promise<void> {
    // Revoke all active ACLs
    for (const [jobId] of this.activeJobs) {
      try {
        await this.aclManager.revokeJobACL(jobId);
      } catch (error) {
        logger.warn({ jobId, error }, 'Failed to revoke ACL during shutdown');
      }
    }
    this.activeJobs.clear();

    // Close ACL manager connection
    await this.aclManager.close();

    logger.info('File sidecar runtime shutdown complete');
  }

  private getGroupIpcPath(folder: string): string {
    if (this.groupIpcPaths.has(folder)) {
      return this.groupIpcPaths.get(folder)!;
    }

    const ipcBaseDir = process.env.NANOCLAW_IPC_BASE || '/tmp/nanoclaw-ipc';
    const ipcPath = path.join(ipcBaseDir, folder, 'ipc');

    this.groupIpcPaths.set(folder, ipcPath);
    return ipcPath;
  }
}

/**
 * HTTP sidecar runtime implementation using k8s/http-sidecar-runner.ts
 * Enables running arbitrary containers with HTTP REST API interfaces
 */
class HttpSidecarAgentRunner implements AgentRunner {
  private jobRunner: HttpSidecarJobRunner;
  private groupIpcPaths: Map<string, string>;
  private aclManager: RedisACLManager;
  private activeJobs: Map<string, { groupFolder: string; jobId: string }>;
  private sendMessageHandler?: (
    groupFolder: string,
    text: string,
  ) => Promise<boolean>;

  constructor() {
    this.jobRunner = new HttpSidecarJobRunner();
    this.groupIpcPaths = new Map();
    this.aclManager = getACLManager();
    this.activeJobs = new Map();
  }

  /**
   * Set the message handler for sending follow-up messages to sidecars
   */
  setSendMessageHandler(
    handler: (groupFolder: string, text: string) => Promise<boolean>,
  ): void {
    this.sendMessageHandler = handler;
  }

  /**
   * Send a message to an active sidecar job
   * @param groupFolder The group folder
   * @param text The message text to send
   * @returns true if message was sent successfully
   */
  async sendMessage(groupFolder: string, text: string): Promise<boolean> {
    const activeJob = this.getActiveJobByGroup(groupFolder);
    if (!activeJob) {
      logger.debug(
        { groupFolder },
        'No active HTTP sidecar job found for group',
      );
      return false;
    }

    const credentials = this.aclManager.getJobCredentials(activeJob.jobId);
    if (!credentials) {
      logger.warn(
        { jobId: activeJob.jobId },
        'No ACL credentials found for active job',
      );
      return false;
    }

    logger.debug(
      { groupFolder, jobId: activeJob.jobId },
      'Routing follow-up message to active HTTP sidecar',
    );

    if (this.sendMessageHandler) {
      return await this.sendMessageHandler(groupFolder, text);
    }

    return false;
  }

  /**
   * Get active job by group folder
   */
  private getActiveJobByGroup(
    groupFolder: string,
  ): { groupFolder: string; jobId: string } | undefined {
    for (const job of this.activeJobs.values()) {
      if (job.groupFolder === groupFolder) {
        return job;
      }
    }
    return undefined;
  }

  async runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess?: (proc: unknown, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    // Get container configuration from group
    const userImage = group.containerConfig?.userImage as string | undefined;
    const userPort = (group.containerConfig as Record<string, unknown>)
      ?.userPort as number | undefined;
    const healthEndpoint = (group.containerConfig as Record<string, unknown>)
      ?.healthEndpoint as string | undefined;

    if (!userImage) {
      return {
        status: 'error',
        result: null,
        error: 'HTTP sidecar mode requires containerConfig.userImage to be set',
      };
    }

    // Add job ID if not present
    const jobInput = {
      ...input,
      jobId: buildJobName(group.folder),
    };

    // Build spec from group configuration
    const spec = {
      name: jobInput.jobId!,
      groupFolder: group.folder,
      chatJid: input.chatJid,
      isMain: input.isMain,
      prompt: input.prompt,
      sessionId: input.sessionId,
      assistantName: input.assistantName,
      timeout: group.containerConfig?.timeout as number | undefined,
      userImage,
      userPort,
      healthEndpoint,
      memoryRequest: group.containerConfig?.memoryRequest as string | undefined,
      memoryLimit: group.containerConfig?.memoryLimit as string | undefined,
      cpuRequest: group.containerConfig?.cpuRequest as string | undefined,
      cpuLimit: group.containerConfig?.cpuLimit as string | undefined,
    };

    // Create ACL credentials for this job
    let credentials: { username: string; password: string } | undefined;
    try {
      await this.aclManager.createJobACL(jobInput.jobId!, group.folder);
      const creds = this.aclManager.getJobCredentials(jobInput.jobId!);
      if (creds) {
        credentials = creds;
        logger.info(
          {
            jobId: jobInput.jobId,
            groupFolder: group.folder,
            username: credentials.username,
          },
          'Created ACL credentials for HTTP sidecar job',
        );
      }
    } catch (aclError) {
      const errorMessage =
        aclError instanceof Error ? aclError.message : String(aclError);
      logger.error(
        { jobId: jobInput.jobId, error: errorMessage },
        'Failed to create ACL credentials for HTTP sidecar job',
      );
      // Continue without ACL - the job will still run but won't have secure Redis access
    }

    // Track this as an active job for follow-up routing
    this.activeJobs.set(jobInput.jobId!, {
      groupFolder: group.folder,
      jobId: jobInput.jobId!,
    });

    try {
      // Add credentials to spec for the sidecar adapter
      const specWithCredentials = {
        ...spec,
        credentials,
      };

      const result = await this.jobRunner.runAgentJob(
        group,
        jobInput,
        specWithCredentials,
        onProcess ? (jobName) => onProcess(jobName, jobName) : undefined,
        onOutput,
      );

      // Job completed - remove from active jobs and revoke ACL
      this.activeJobs.delete(jobInput.jobId!);
      try {
        await this.aclManager.revokeJobACL(jobInput.jobId!);
      } catch (revokeError) {
        logger.warn(
          { jobId: jobInput.jobId, error: revokeError },
          'Failed to revoke ACL after job completion',
        );
      }

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
        'HTTP sidecar job failed',
      );

      // Job failed - clean up
      this.activeJobs.delete(jobInput.jobId!);
      try {
        await this.aclManager.revokeJobACL(jobInput.jobId!);
      } catch (revokeError) {
        logger.warn(
          { jobId: jobInput.jobId, error: revokeError },
          'Failed to revoke ACL after job failure',
        );
      }

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
    const groupIpcDir = this.getGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));

    logger.debug(
      { groupFolder, taskCount: tasks.length },
      'Written tasks snapshot (HTTP Sidecar)',
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
      'Written groups snapshot (HTTP Sidecar)',
    );
  }

  async shutdown(): Promise<void> {
    // Revoke all active ACLs
    for (const [jobId] of this.activeJobs) {
      try {
        await this.aclManager.revokeJobACL(jobId);
      } catch (error) {
        logger.warn({ jobId, error }, 'Failed to revoke ACL during shutdown');
      }
    }
    this.activeJobs.clear();

    // Close ACL manager connection
    await this.aclManager.close();

    logger.info('HTTP sidecar runtime shutdown complete');
  }

  private getGroupIpcPath(folder: string): string {
    if (this.groupIpcPaths.has(folder)) {
      return this.groupIpcPaths.get(folder)!;
    }

    const ipcBaseDir = process.env.NANOCLAW_IPC_BASE || '/tmp/nanoclaw-ipc';
    const ipcPath = path.join(ipcBaseDir, folder, 'ipc');

    this.groupIpcPaths.set(folder, ipcPath);
    return ipcPath;
  }
}

// Export types for sidecar runners
export interface SidecarRunner {
  sendMessage(groupFolder: string, text: string): Promise<boolean>;
}

/**
 * Factory function to create the appropriate AgentRunner
 */
export function createAgentRunner(): AgentRunner {
  logger.info('Creating Kubernetes Agent Runner');
  return new KubernetesAgentRunner();
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

// Re-export ACL manager for orchestrator integration
export { getACLManager, RedisACLManager } from '../k8s/acl-manager.js';
