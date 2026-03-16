/**
 * File Sidecar Job Runner for NanoClaw
 *
 * Creates Kubernetes Jobs with two containers:
 * - nanoclaw-file-adapter: Handles NanoClaw protocol via file-based IPC
 * - user-agent: User's arbitrary container image
 *
 * Uses emptyDir volume for file-based IPC between containers.
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
  CONTAINER_TIMEOUT,
  IDLE_TIMEOUT,
  NANOCLAW_NAMESPACE,
  SIDECAR_FILE_ADAPTER_IMAGE,
  SIDECAR_FILE_POLL_INTERVAL,
  AGENT_JOB_MEMORY_REQUEST,
  AGENT_JOB_MEMORY_LIMIT,
  AGENT_JOB_CPU_REQUEST,
  AGENT_JOB_CPU_LIMIT,
  TIMEZONE,
  REDIS_URL,
  REDIS_ADMIN_PASSWORD,
} from '../config.js';
import { JobInput, JobOutput, SidecarFileJobSpec } from './types.js';
import { ContainerOutput } from '../runtime/types.js';
import { parseSidecarLogBuffer } from './sidecar-log-parser.js';

// Job constants
const JOB_TTL_SECONDS_AFTER_FINISHED = 3600;
const JOB_ACTIVE_DEADLINE_SECONDS = 1800; // 30 min
const JOB_BACKOFF_LIMIT = 0;
const JOB_LABELS = { app: 'nanoclaw-file-sidecar-agent' };
const NAMESPACE = NANOCLAW_NAMESPACE;

export class FileSidecarJobRunner {
  private coreApi: CoreV1Api;
  private batchApi: BatchV1Api;
  private namespace: string;

  constructor() {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.batchApi = kc.makeApiClient(BatchV1Api);
    this.namespace = NAMESPACE;
  }

  /**
   * Run an agent job using file-based sidecar pattern
   * Creates a K8s Job with two containers sharing an emptyDir volume
   */
  async runAgentJob(
    group: RegisteredGroup,
    input: JobInput,
    spec: SidecarFileJobSpec,
    onProcess?: (jobName: string) => void,
    onOutput?: (output: JobOutput) => Promise<void>,
  ): Promise<JobOutput> {
    const startTime = Date.now();
    const jobId = input.jobId || `nanoclaw-file-${group.folder}-${Date.now()}`;

    logger.info(
      {
        group: group.name,
        jobId,
        userImage: spec.userImage,
        isMain: input.isMain,
      },
      'Creating file-based sidecar job',
    );

    try {
      // Generate and create the job
      const jobManifest = this.generateFileSidecarJobManifest(
        group,
        input,
        spec,
        jobId,
      );

      logger.debug(
        { jobName: jobId, namespace: this.namespace },
        'Creating file sidecar Kubernetes job',
      );

      const createdJob = await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: jobManifest,
      });

      const jobName = createdJob.metadata?.name || jobId;

      logger.info(
        { jobName, namespace: this.namespace, userImage: spec.userImage },
        'File sidecar job created',
      );

      // Notify about process start
      if (onProcess) {
        onProcess(jobName);
      }

      const effectiveTimeoutMs = spec.timeout || CONTAINER_TIMEOUT;

      // Stream output from the sidecar container logs
      const streamingPromise = this.streamSidecarLogs(
        jobName,
        group.folder,
        onOutput,
        effectiveTimeoutMs,
      );

      // Wait for job completion
      const completionPromise = this.waitForJobCompletion(
        jobName,
        effectiveTimeoutMs,
      );

      // Race between streaming and completion
      await Promise.all([streamingPromise, completionPromise]);

      const duration = Date.now() - startTime;

      logger.info(
        { jobName, duration, group: group.name },
        'File sidecar job completed',
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
        'File sidecar job failed',
      );

      return {
        status: 'error',
        result: null,
        error: errorMessage,
        jobId,
      };
    }
  }

  /**
   * Generate the Kubernetes Job manifest with file-based sidecar pattern
   */
  generateFileSidecarJobManifest(
    group: RegisteredGroup,
    input: JobInput,
    spec: SidecarFileJobSpec,
    jobId: string,
  ): V1Job {
    const timeoutSeconds = Math.floor(
      (spec.timeout || CONTAINER_TIMEOUT) / 1000,
    );

    const safeChatJid = input.chatJid.replace(/[^a-zA-Z0-9-]/g, '-');

    // Shared emptyDir volume for file-based IPC
    const workspaceVolume = {
      name: 'workspace',
      emptyDir: {},
    };

    // Wrapper script ConfigMap volume
    const wrapperVolume = {
      name: 'wrapper-script',
      configMap: {
        name: 'nanoclaw-wrapper-script',
        defaultMode: 0o755,
      },
    };

    // Environment variables for the sidecar adapter
    const adapterEnvVars = [
      { name: 'TZ', value: TIMEZONE },
      { name: 'NANOCLAW_GROUP_FOLDER', value: input.groupFolder },
      { name: 'NANOCLAW_CHAT_JID', value: input.chatJid },
      { name: 'NANOCLAW_IS_MAIN', value: String(input.isMain) },
      { name: 'NANOCLAW_PROMPT', value: input.prompt },
      { name: 'NANOCLAW_SESSION_ID', value: input.sessionId || '' },
      { name: 'NANOCLAW_ASSISTANT_NAME', value: input.assistantName || 'Andy' },
      { name: 'NANOCLAW_JOB_ID', value: jobId },
      { name: 'NANOCLAW_INPUT_DIR', value: '/workspace/input' },
      { name: 'NANOCLAW_OUTPUT_DIR', value: '/workspace/output' },
      {
        name: 'NANOCLAW_POLL_INTERVAL',
        value: String(spec.filePollInterval || SIDECAR_FILE_POLL_INTERVAL),
      },
      {
        name: 'NANOCLAW_TIMEOUT',
        value: String(spec.timeout || CONTAINER_TIMEOUT),
      },
      { name: 'IDLE_TIMEOUT', value: String(IDLE_TIMEOUT) },
      // Redis ACL credentials for follow-up support
      { name: 'REDIS_URL', value: REDIS_URL },
      ...(spec.credentials
        ? [
            { name: 'REDIS_USERNAME', value: spec.credentials.username },
            { name: 'REDIS_PASSWORD', value: spec.credentials.password },
          ]
        : REDIS_ADMIN_PASSWORD
          ? [
              { name: 'REDIS_USERNAME', value: 'default' },
              { name: 'REDIS_PASSWORD', value: REDIS_ADMIN_PASSWORD },
            ]
          : []),
    ];

    // Environment variables for the user container
    const userEnvVars = [
      { name: 'NANOCLAW_INPUT_DIR', value: '/workspace/input' },
      { name: 'NANOCLAW_OUTPUT_DIR', value: '/workspace/output' },
      { name: 'NANOCLAW_POLL_INTERVAL', value: '1' },
      ...(spec.userCommand
        ? [{ name: 'NANOCLAW_USER_COMMAND', value: spec.userCommand.join(' ') }]
        : []),
      // Pass secrets as environment variables
      ...(spec.secrets
        ? Object.entries(spec.secrets).map(([key, value]) => ({
            name: key,
            value: String(value),
          }))
        : []),
    ];

    // Volumes from PVCs (for groups, sessions)
    const pvcVolumes = [
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
    if (input.isMain) {
      pvcVolumes.push({
        name: 'project-pvc',
        persistentVolumeClaim: {
          claimName: 'nanoclaw-project',
        },
      } as any);
    }

    // Mount PVCs into sidecar adapter for access to group data
    const adapterVolumeMounts = [
      {
        name: 'workspace',
        mountPath: '/workspace',
      },
      {
        name: 'groups-pvc',
        mountPath: '/workspace/group',
        subPath: input.groupFolder,
      },
      {
        name: 'sessions-pvc',
        mountPath: '/home/node/.claude',
        subPath: `${input.groupFolder}/.claude`,
      },
    ];

    // Add project mount for main
    if (input.isMain) {
      adapterVolumeMounts.push({
        name: 'project-pvc',
        mountPath: '/workspace/project',
        readOnly: true,
      } as any);
    }

    // User container volume mounts
    const userVolumeMounts = [
      {
        name: 'workspace',
        mountPath: '/workspace',
      },
      {
        name: 'wrapper-script',
        mountPath: '/workspace/runner-wrapper.sh',
        subPath: 'runner-wrapper.sh',
      },
    ];

    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobId,
        namespace: this.namespace,
        labels: {
          ...JOB_LABELS,
          'nanoclaw/group': input.groupFolder,
          'nanoclaw/chat-jid': safeChatJid,
          'nanoclaw/type': 'file-sidecar',
        },
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS_AFTER_FINISHED,
        activeDeadlineSeconds: timeoutSeconds,
        backoffLimit: JOB_BACKOFF_LIMIT,
        template: {
          metadata: {
            labels: JOB_LABELS,
          },
          spec: {
            restartPolicy: 'Never',
            volumes: [workspaceVolume, wrapperVolume, ...pvcVolumes],
            ...(spec.nodeSelector && { nodeSelector: spec.nodeSelector }),
            ...(spec.tolerations && { tolerations: spec.tolerations }),
            ...(spec.affinity && { affinity: spec.affinity }),
            ...(spec.priorityClassName && { priorityClassName: spec.priorityClassName }),
            ...(spec.imagePullSecrets && {
              imagePullSecrets: spec.imagePullSecrets.map((name) => ({ name })),
            }),
            containers: [
              // Sidecar adapter container (handles NanoClaw protocol)
              {
                name: 'nanoclaw-file-adapter',
                image: SIDECAR_FILE_ADAPTER_IMAGE,
                imagePullPolicy: 'IfNotPresent',
                env: adapterEnvVars,
                volumeMounts: adapterVolumeMounts,
                resources: {
                  requests: {
                    memory: '128Mi',
                    cpu: '50m',
                  },
                  limits: {
                    memory: '256Mi',
                    cpu: '250m',
                  },
                },
                stdin: true, // Accept input from orchestrator
              },
              // User agent container (arbitrary user image)
              {
                name: 'user-agent',
                image: spec.userImage,
                imagePullPolicy: spec.userImagePullPolicy || 'IfNotPresent',
                command: spec.userCommand || ['/bin/sh'],
                args: spec.userArgs || ['-c', '/workspace/runner-wrapper.sh'],
                env: userEnvVars,
                volumeMounts: userVolumeMounts,
                resources: {
                  requests: {
                    memory: spec.memoryRequest || AGENT_JOB_MEMORY_REQUEST,
                    cpu: spec.cpuRequest || AGENT_JOB_CPU_REQUEST,
                  },
                  limits: {
                    memory: spec.memoryLimit || AGENT_JOB_MEMORY_LIMIT,
                    cpu: spec.cpuLimit || AGENT_JOB_CPU_LIMIT,
                  },
                },
              },
            ],
          },
        },
      },
    };

    return job;
  }

  /**
   * Stream output from the sidecar container logs
   * Parses NanoClaw marker output from log stream
   */
  async streamSidecarLogs(
    jobName: string,
    groupFolder: string,
    onOutput?: (output: JobOutput) => Promise<void>,
    timeoutMs: number = JOB_ACTIVE_DEADLINE_SECONDS * 1000,
  ): Promise<void> {
    if (!onOutput) {
      return;
    }

    logger.debug({ jobName, groupFolder }, 'Starting file sidecar log stream');

    const startTime = Date.now();
    const maxWaitTime = timeoutMs;
    const pollInterval = 1000; // Check for logs every second

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let sinceTime: Date | undefined;

    return new Promise(async (resolve, reject) => {
      let completed = false;

      while (Date.now() - startTime < maxWaitTime && !completed) {
        try {
          // Get pod for this job
          const pods = await this.coreApi.listNamespacedPod({
            namespace: this.namespace,
            labelSelector: `job-name=${jobName}`,
          });

          if (!pods.items || pods.items.length === 0) {
            await new Promise((r) => setTimeout(r, pollInterval));
            continue;
          }

          const pod = pods.items[0];
          const podName = pod.metadata?.name;

          if (!podName) {
            await new Promise((r) => setTimeout(r, pollInterval));
            continue;
          }

          const pollTime = new Date();

          const logs = await this.coreApi.readNamespacedPodLog({
            name: podName,
            namespace: this.namespace,
            container: 'nanoclaw-file-adapter',
            ...(sinceTime ? { sinceTime } : {}),
          });

          sinceTime = pollTime;

          parseBuffer += logs;

          const { extracted, remaining } = parseSidecarLogBuffer(parseBuffer);
          parseBuffer = remaining;

          for (const jsonStr of extracted) {
            try {
              const parsed: ContainerOutput = JSON.parse(jsonStr);

              if (parsed.newSessionId) {
                newSessionId = parsed.newSessionId;
              }

              const output: JobOutput = {
                status: parsed.status,
                result: parsed.result,
                error: parsed.error,
                newSessionId,
                jobId: jobName,
              };

              // Call onOutput
              await onOutput(output);

              // Check if this is a completion marker
              if (parsed.status === 'success' && parsed.result === null) {
                completed = true;
                resolve();
                return;
              }
            } catch (err) {
              logger.warn(
                { jobName, error: err, jsonStr },
                'Failed to parse output marker',
              );
            }
          }

          // Check if job is still running
          const job = await this.batchApi.readNamespacedJob({
            name: jobName,
            namespace: this.namespace,
          });

          const status = job.status;
          if (status?.succeeded && status.succeeded > 0) {
            completed = true;
            resolve();
            return;
          }

          if (status?.failed && status.failed > 0) {
            reject(new Error('Job failed'));
            return;
          }

          // Wait before polling again
          await new Promise((r) => setTimeout(r, pollInterval));
        } catch (error) {
          // Pod might not exist yet, that's ok
          await new Promise((r) => setTimeout(r, pollInterval));
        }
      }

      if (!completed) {
        reject(new Error('Timeout waiting for file sidecar output'));
      }
    });
  }

  /**
   * Wait for a Kubernetes Job to complete
   */
  async waitForJobCompletion(
    jobName: string,
    timeoutMs: number = JOB_ACTIVE_DEADLINE_SECONDS * 1000,
  ): Promise<void> {
    const pollInterval = 5000; // 5 seconds
    const maxWaitTime = timeoutMs;
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
    logger.info({ jobName }, 'Stopping file sidecar job');

    try {
      await this.batchApi.deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        gracePeriodSeconds: 0,
      });

      logger.info({ jobName }, 'File sidecar job stopped');
    } catch (error) {
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
   * Get pod logs for debugging
   */
  async getJobLogs(
    jobName: string,
  ): Promise<{ adapter: string; user: string }> {
    try {
      const pods = await this.coreApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `job-name=${jobName}`,
      });

      if (!pods.items || pods.items.length === 0) {
        return { adapter: 'No pods found', user: 'No pods found' };
      }

      const pod = pods.items[0];
      const podName = pod.metadata?.name;

      if (!podName) {
        return { adapter: 'Pod name not found', user: 'Pod name not found' };
      }

      // Get logs from both containers
      let adapterLogs = '';
      let userLogs = '';

      try {
        adapterLogs = await this.coreApi.readNamespacedPodLog({
          name: podName,
          namespace: this.namespace,
          container: 'nanoclaw-file-adapter',
        });
      } catch (e) {
        adapterLogs = `Error getting adapter logs: ${e instanceof Error ? e.message : String(e)}`;
      }

      try {
        userLogs = await this.coreApi.readNamespacedPodLog({
          name: podName,
          namespace: this.namespace,
          container: 'user-agent',
        });
      } catch (e) {
        userLogs = `Error getting user logs: ${e instanceof Error ? e.message : String(e)}`;
      }

      return { adapter: adapterLogs, user: userLogs };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { adapter: `Error: ${errorMsg}`, user: `Error: ${errorMsg}` };
    }
  }
}

// Export singleton instance
export const fileSidecarJobRunner = new FileSidecarJobRunner();
