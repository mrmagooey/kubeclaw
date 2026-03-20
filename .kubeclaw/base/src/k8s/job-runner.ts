/**
 * Kubernetes Job Runner for NanoClaw
 * Creates and manages Kubernetes Jobs for agent execution
 */
import {
  V1Job,
  CoreV1Api,
  BatchV1Api,
  KubeConfig,
} from '@kubernetes/client-node';

import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  getContainerImage,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  IDLE_TIMEOUT,
  NANOCLAW_NAMESPACE,
  AGENT_JOB_MEMORY_REQUEST,
  AGENT_JOB_MEMORY_LIMIT,
  AGENT_JOB_CPU_REQUEST,
  AGENT_JOB_CPU_LIMIT,
  TIMEZONE,
} from '../config.js';
import {
  JobInput,
  JobOutput,
  AgentJobSpec,
  AgentOutputMessage,
} from './types.js';
import { ContainerOutput } from '../container-runner.js';
import {
  getRedisSubscriber,
  getOutputChannel,
  closeRedisConnections,
} from './redis-client.js';

// Job constants
const JOB_TTL_SECONDS_AFTER_FINISHED = 3600;
const JOB_ACTIVE_DEADLINE_SECONDS = 1800; // 30 min
const JOB_BACKOFF_LIMIT = 0;
const JOB_LABELS = { app: 'nanoclaw-agent' };
const NAMESPACE = NANOCLAW_NAMESPACE;

export class JobRunner {
  private coreApi: CoreV1Api;
  private batchApi: BatchV1Api;
  private namespace: string;
  private activeSubscriptions: Map<string, () => void>;

  constructor() {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.batchApi = kc.makeApiClient(BatchV1Api);
    this.namespace = NAMESPACE;
    this.activeSubscriptions = new Map();
  }

  /**
   * Run an agent job in Kubernetes
   * Creates a K8s Job, streams output via Redis, and waits for completion
   */
  async runAgentJob(
    group: RegisteredGroup,
    input: JobInput,
    onProcess?: (jobName: string) => void,
    onOutput?: (output: JobOutput) => Promise<void>,
  ): Promise<JobOutput> {
    const startTime = Date.now();
    const jobId = input.jobId || `nanoclaw-${group.folder}-${Date.now()}`;

    logger.info(
      {
        group: group.name,
        jobId,
        isMain: input.isMain,
      },
      'Creating Kubernetes job for agent',
    );

    try {
      // Generate and create the job
      const jobSpec = this.buildAgentJobSpec(group, input, jobId);
      const jobManifest = this.generateJobManifest(jobSpec);

      logger.debug(
        { jobName: jobId, namespace: this.namespace },
        'Creating Kubernetes job',
      );

      const createdJob = await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: jobManifest,
      });

      const jobName = createdJob.metadata?.name || jobId;

      logger.info(
        { jobName, namespace: this.namespace },
        'Kubernetes job created',
      );

      // Notify about process start
      if (onProcess) {
        onProcess(jobName);
      }

      // Start streaming output from Redis
      const streamingPromise = this.streamOutput(
        jobName,
        group.folder,
        onOutput,
      );

      // Wait for job completion
      const completionPromise = this.waitForJobCompletion(jobName);

      // Race between streaming and completion
      await Promise.all([streamingPromise, completionPromise]);

      const duration = Date.now() - startTime;

      logger.info(
        { jobName, duration, group: group.name },
        'Kubernetes job completed',
      );

      return {
        status: 'success',
        result: null,
        jobId,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { group: group.name, jobId, error: errorMessage },
        'Kubernetes job failed',
      );

      return {
        status: 'error',
        result: null,
        error: errorMessage,
        jobId,
      };
    } finally {
      // Clean up subscription
      this.unsubscribeFromOutput(jobId);
    }
  }

  /**
   * Build the AgentJobSpec from input parameters
   */
  private buildAgentJobSpec(
    group: RegisteredGroup,
    input: JobInput,
    jobId: string,
  ): AgentJobSpec {
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;

    return {
      name: jobId,
      groupFolder: group.folder,
      chatJid: input.chatJid,
      isMain: input.isMain,
      prompt: input.prompt,
      sessionId: input.sessionId,
      assistantName: input.assistantName,
      timeout: Math.max(configTimeout, IDLE_TIMEOUT + 30_000),
      provider: group.llmProvider || 'claude',
    };
  }

  /**
   * Generate the Kubernetes Job manifest
   */
  generateJobManifest(spec: AgentJobSpec): V1Job {
    const timeoutSeconds = Math.floor(
      (spec.timeout || CONTAINER_TIMEOUT) / 1000,
    );

    // Environment variables for the container
    const envVars = [
      { name: 'TZ', value: TIMEZONE },
      { name: 'NANOCLAW_GROUP_FOLDER', value: spec.groupFolder },
      { name: 'NANOCLAW_CHAT_JID', value: spec.chatJid },
      { name: 'NANOCLAW_IS_MAIN', value: String(spec.isMain) },
      { name: 'NANOCLAW_PROMPT', value: spec.prompt },
      { name: 'NANOCLAW_SESSION_ID', value: spec.sessionId || '' },
      { name: 'NANOCLAW_ASSISTANT_NAME', value: spec.assistantName || 'Andy' },
      { name: 'NANOCLAW_JOB_ID', value: spec.name },
      {
        name: 'CONTAINER_MAX_OUTPUT_SIZE',
        value: String(CONTAINER_MAX_OUTPUT_SIZE),
      },
      { name: 'IDLE_TIMEOUT', value: String(IDLE_TIMEOUT) },
      // Redis configuration
      {
        name: 'REDIS_URL',
        valueFrom: {
          secretKeyRef: {
            name: 'nanoclaw-redis',
            key: 'url',
            optional: true,
          },
        },
      },
      // Secrets from Kubernetes secrets
      {
        name: 'CLAUDE_CODE_OAUTH_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: 'nanoclaw-secrets',
            key: 'CLAUDE_CODE_OAUTH_TOKEN',
            optional: true,
          },
        },
      },
      {
        name: 'ANTHROPIC_API_KEY',
        valueFrom: {
          secretKeyRef: {
            name: 'nanoclaw-secrets',
            key: 'ANTHROPIC_API_KEY',
            optional: true,
          },
        },
      },
      {
        name: 'ANTHROPIC_BASE_URL',
        valueFrom: {
          secretKeyRef: {
            name: 'nanoclaw-secrets',
            key: 'ANTHROPIC_BASE_URL',
            optional: true,
          },
        },
      },
      {
        name: 'ANTHROPIC_AUTH_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: 'nanoclaw-secrets',
            key: 'ANTHROPIC_AUTH_TOKEN',
            optional: true,
          },
        },
      },
      {
        name: 'OPENROUTER_API_KEY',
        valueFrom: {
          secretKeyRef: {
            name: 'nanoclaw-secrets',
            key: 'OPENROUTER_API_KEY',
            optional: true,
          },
        },
      },
      {
        name: 'OPENROUTER_MODEL',
        valueFrom: {
          secretKeyRef: {
            name: 'nanoclaw-secrets',
            key: 'OPENROUTER_MODEL',
            optional: true,
          },
        },
      },
      {
        name: 'OPENROUTER_BASE_URL',
        valueFrom: {
          secretKeyRef: {
            name: 'nanoclaw-secrets',
            key: 'OPENROUTER_BASE_URL',
            optional: true,
          },
        },
      },
    ];

    // Volume mounts using PVCs
    const volumeMounts = [
      {
        name: 'groups-pvc',
        mountPath: '/workspace/group',
        subPath: spec.groupFolder,
      },
      {
        name: 'sessions-pvc',
        mountPath: '/home/node/.claude',
        subPath: `${spec.groupFolder}/.claude`,
      },
      {
        name: 'sessions-pvc',
        mountPath: '/workspace/ipc',
        subPath: `${spec.groupFolder}/ipc`,
      },
      {
        name: 'sessions-pvc',
        mountPath: '/app/src',
        subPath: `${spec.groupFolder}/agent-runner-src`,
      },
    ];

    // Add main project mount if this is the main group
    if (spec.isMain) {
      volumeMounts.push({
        name: 'project-pvc',
        mountPath: '/workspace/project',
        readOnly: true,
      } as any);
    }

    // Volumes
    const volumes = [
      {
        name: 'groups-pvc',
        persistentVolumeClaim: {
          claimName: 'nanoclaw-groups',
        },
      },
      {
        name: 'sessions-pvc',
        persistentVolumeClaim: {
          claimName: 'nanoclaw-sessions',
        },
      },
    ];

    // Add project PVC for main
    if (spec.isMain) {
      volumes.push({
        name: 'project-pvc',
        persistentVolumeClaim: {
          claimName: 'nanoclaw-project',
        },
      });
    }

    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: spec.name,
        namespace: this.namespace,
        labels: {
          ...JOB_LABELS,
          'nanoclaw/group': spec.groupFolder,
          'nanoclaw/chat-jid': spec.chatJid.replace(/[^a-zA-Z0-9-]/g, '-'),
        },
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS_AFTER_FINISHED,
        activeDeadlineSeconds: Math.min(
          timeoutSeconds,
          JOB_ACTIVE_DEADLINE_SECONDS,
        ),
        backoffLimit: JOB_BACKOFF_LIMIT,
        template: {
          metadata: {
            labels: JOB_LABELS,
          },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'agent',
                image: getContainerImage(spec.provider || 'claude'),
                env: envVars,
                volumeMounts,
                resources: {
                  requests: {
                    memory: AGENT_JOB_MEMORY_REQUEST,
                    cpu: AGENT_JOB_CPU_REQUEST,
                  },
                  limits: {
                    memory: AGENT_JOB_MEMORY_LIMIT,
                    cpu: AGENT_JOB_CPU_LIMIT,
                  },
                },
              },
            ],
            volumes,
          },
        },
      },
    };

    return job;
  }

  /**
   * Stream output from Redis pub/sub channel
   * Subscribes to nanoclaw:messages:${groupFolder} and calls callback for each message
   */
  async streamOutput(
    jobName: string,
    groupFolder: string,
    onOutput?: (output: JobOutput) => Promise<void>,
  ): Promise<void> {
    if (!onOutput) {
      return;
    }

    const channel = getOutputChannel(groupFolder);
    const subscriber = getRedisSubscriber();

    logger.debug(
      { jobName, channel, groupFolder },
      'Starting Redis output stream',
    );

    return new Promise((resolve, reject) => {
      let completed = false;
      let outputChain = Promise.resolve();

      // Handle incoming messages
      const messageHandler = (messageChannel: string, message: string) => {
        if (messageChannel !== channel) return;

        try {
          const parsed: AgentOutputMessage = JSON.parse(message);

          // Handle different message types
          if (parsed.type === 'output') {
            const output = parsed.payload as ContainerOutput;

            const jobOutput: JobOutput = {
              ...output,
              jobId: parsed.jobId,
            };

            // Chain outputs to maintain order
            outputChain = outputChain.then(() => onOutput(jobOutput));
          } else if (parsed.type === 'status') {
            const status = parsed.payload as {
              status: string;
              message?: string;
            };

            if (status.status === 'completed') {
              completed = true;
              outputChain.then(() => {
                resolve();
              });
            } else if (status.status === 'failed') {
              outputChain.then(() => {
                reject(new Error(status.message || 'Job failed'));
              });
            }
          }
        } catch (err) {
          logger.warn(
            { jobName, error: err, message },
            'Failed to parse Redis message',
          );
        }
      };

      // Subscribe to channel
      subscriber.subscribe(channel, (err) => {
        if (err) {
          logger.error(
            { jobName, channel, error: err },
            'Failed to subscribe to Redis channel',
          );
          reject(err);
        } else {
          logger.debug({ jobName, channel }, 'Subscribed to Redis channel');
        }
      });

      subscriber.on('message', messageHandler);

      // Store unsubscribe function
      this.activeSubscriptions.set(jobName, () => {
        subscriber.unsubscribe(channel);
        subscriber.off('message', messageHandler);
      });

      // Timeout fallback
      const timeoutMs = JOB_ACTIVE_DEADLINE_SECONDS * 1000;
      setTimeout(() => {
        if (!completed) {
          logger.warn({ jobName, timeoutMs }, 'Redis output stream timeout');
          resolve();
        }
      }, timeoutMs);
    });
  }

  /**
   * Unsubscribe from output channel
   */
  private unsubscribeFromOutput(jobName: string): void {
    const unsubscribe = this.activeSubscriptions.get(jobName);
    if (unsubscribe) {
      unsubscribe();
      this.activeSubscriptions.delete(jobName);
      logger.debug({ jobName }, 'Unsubscribed from Redis channel');
    }
  }

  /**
   * Wait for a Kubernetes Job to complete
   * Polls the K8s API for job status
   */
  async waitForJobCompletion(jobName: string): Promise<void> {
    const pollInterval = 5000; // 5 seconds
    const maxWaitTime = JOB_ACTIVE_DEADLINE_SECONDS * 1000;
    const startTime = Date.now();

    logger.debug({ jobName }, 'Waiting for job completion');

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const job = await this.batchApi.readNamespacedJob({
          name: jobName,
          namespace: this.namespace,
        });

        const status = job.status;

        // Check for completion
        if (status?.succeeded && status.succeeded > 0) {
          logger.info({ jobName }, 'Job completed successfully');
          return;
        }

        // Check for failure
        if (status?.failed && status.failed > 0) {
          const reason =
            status.conditions?.find(
              (c: { type: string; reason?: string }) => c.type === 'Failed',
            )?.reason || 'Unknown';
          const message =
            status.conditions?.find(
              (c: { type: string; message?: string }) => c.type === 'Failed',
            )?.message || 'Job failed';
          throw new Error(`${reason}: ${message}`);
        }

        // Check for active deadline exceeded
        const conditions = status?.conditions || [];
        for (const condition of conditions) {
          if (condition.type === 'Failed' && condition.status === 'True') {
            throw new Error(
              `Job failed: ${condition.reason} - ${condition.message}`,
            );
          }
        }

        // Job still running, wait and poll again
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        // If the job doesn't exist, it might have been cleaned up
        if (error instanceof Error && error.message.includes('NotFound')) {
          logger.warn({ jobName }, 'Job not found, may have been cleaned up');
          return;
        }
        throw error;
      }
    }

    throw new Error(`Timeout waiting for job ${jobName} to complete`);
  }

  /**
   * Stop a running Kubernetes Job
   */
  async stopJob(jobName: string): Promise<void> {
    logger.info({ jobName }, 'Stopping Kubernetes job');

    try {
      // Delete the job (this will cascade delete pods)
      await this.batchApi.deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        gracePeriodSeconds: 0, // immediate
      });

      // Clean up subscription
      this.unsubscribeFromOutput(jobName);

      logger.info({ jobName }, 'Kubernetes job stopped');
    } catch (error) {
      // Job may not exist, which is fine
      if (error instanceof Error && error.message.includes('NotFound')) {
        logger.debug({ jobName }, 'Job already deleted');
        return;
      }

      logger.error(
        {
          jobName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to stop job',
      );
      throw error;
    }
  }

  /**
   * Get pod logs for a job
   */
  async getJobLogs(jobName: string): Promise<string> {
    try {
      // Find the pod for this job
      const pods = await this.coreApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `job-name=${jobName}`,
      });

      if (!pods.items || pods.items.length === 0) {
        return 'No pods found for job';
      }

      const pod = pods.items[0];
      const podName = pod.metadata?.name;

      if (!podName) {
        return 'Pod name not found';
      }

      // Get logs from the pod
      const logs = await this.coreApi.readNamespacedPodLog({
        name: podName,
        namespace: this.namespace,
        container: 'agent',
      });

      return logs;
    } catch (error) {
      logger.error(
        {
          jobName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to get job logs',
      );
      return `Error getting logs: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Cleanup method to close all connections
   */
  async cleanup(): Promise<void> {
    // Unsubscribe from all channels
    for (const [jobName, unsubscribe] of this.activeSubscriptions.entries()) {
      unsubscribe();
      logger.debug({ jobName }, 'Unsubscribed during cleanup');
    }
    this.activeSubscriptions.clear();

    // Close Redis connections
    await closeRedisConnections();

    logger.info('JobRunner cleanup completed');
  }
}

// Export singleton instance
export const jobRunner = new JobRunner();
