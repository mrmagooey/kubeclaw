/**
 * Kubernetes Sidecar Job Runner for NanoClaw
 *
 * Creates Kubernetes Jobs with two containers:
 * - kubeclaw-adapter: Handles NanoClaw protocol via file-based IPC
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
  KUBECLAW_NAMESPACE,
  SIDECAR_ADAPTER_IMAGE,
  SIDECAR_POLL_INTERVAL,
  AGENT_JOB_MEMORY_REQUEST,
  AGENT_JOB_MEMORY_LIMIT,
  AGENT_JOB_CPU_REQUEST,
  AGENT_JOB_CPU_LIMIT,
  TIMEZONE,
  REDIS_URL,
  REDIS_ADMIN_PASSWORD,
} from '../config.js';
import { JobInput, JobOutput, SidecarJobSpec } from './types.js';
import { jobRunner } from './job-runner.js';
import { ContainerOutput } from '../runtime/types.js';
import { parseSidecarLogBuffer } from './sidecar-log-parser.js';

// Job constants
const JOB_TTL_SECONDS_AFTER_FINISHED = 3600;
const JOB_ACTIVE_DEADLINE_SECONDS = 1800; // 30 min
const JOB_BACKOFF_LIMIT = 0;
const JOB_LABELS = { app: 'kubeclaw-sidecar-agent' };
const NAMESPACE = KUBECLAW_NAMESPACE;

export class SidecarJobRunner {
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
   * Run an agent job using sidecar pattern
   * Creates a K8s Job with two containers sharing an emptyDir volume
   */
  async runAgentJob(
    group: RegisteredGroup,
    input: JobInput,
    spec: SidecarJobSpec,
    onProcess?: (jobName: string) => void,
    onOutput?: (output: JobOutput) => Promise<void>,
  ): Promise<JobOutput> {
    const startTime = Date.now();
    const jobId = input.jobId || `kubeclaw-${group.folder}-${Date.now()}`;

    logger.info(
      {
        group: group.name,
        jobId,
        userImage: spec.userImage,
        isMain: input.isMain,
      },
      'Creating Kubernetes sidecar job',
    );

    try {
      // Generate and create the job
      const jobManifest = this.generateSidecarJobManifest(
        group,
        input,
        spec,
        jobId,
      );

      logger.debug(
        { jobName: jobId, namespace: this.namespace },
        'Creating sidecar Kubernetes job',
      );

      const createdJob = await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: jobManifest,
      });

      const jobName = createdJob.metadata?.name || jobId;

      logger.info(
        { jobName, namespace: this.namespace, userImage: spec.userImage },
        'Sidecar job created',
      );

      // Notify about process start
      if (onProcess) {
        onProcess(jobName);
      }

      const effectiveTimeoutMs = spec.timeout || CONTAINER_TIMEOUT;

      // Wrap onOutput to capture newSessionId from Redis-delivered output
      let capturedSessionId: string | undefined;
      const wrappedOnOutput = onOutput
        ? async (output: JobOutput) => {
            if (output.newSessionId) capturedSessionId = output.newSessionId;
            return onOutput(output);
          }
        : undefined;

      // Stream output via Redis pub/sub
      const streamingPromise = jobRunner.streamOutput(
        jobName,
        group.folder,
        wrappedOnOutput,
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
        'Sidecar job completed',
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
        'Sidecar job failed',
      );

      return {
        status: 'error',
        result: null,
        error: errorMessage,
        jobId,
      };
    } finally {
      jobRunner.unsubscribeFromOutput(jobId);
    }
  }

  /**
   * Generate the Kubernetes Job manifest with sidecar pattern
   */
  generateSidecarJobManifest(
    group: RegisteredGroup,
    input: JobInput,
    spec: SidecarJobSpec,
    jobId: string,
  ): V1Job {
    const timeoutSeconds = Math.floor(
      (spec.timeout || CONTAINER_TIMEOUT) / 1000,
    );

    const safeChatJid = input.chatJid.replace(/[^a-zA-Z0-9-]/g, '-');

    // Shared emptyDir volume for file-based IPC
    const sharedVolume = {
      name: 'shared-workspace',
      emptyDir: {},
    };

    // Volume mounts for both containers
    const adapterVolumeMounts = [
      {
        name: 'shared-workspace',
        mountPath: '/workspace',
      },
    ];

    const userVolumeMounts = [
      {
        name: 'shared-workspace',
        mountPath: '/workspace',
      },
    ];

    // Environment variables for the sidecar adapter
    const adapterEnvVars = [
      { name: 'TZ', value: TIMEZONE },
      { name: 'KUBECLAW_GROUP_FOLDER', value: input.groupFolder },
      { name: 'KUBECLAW_CHAT_JID', value: input.chatJid },
      { name: 'KUBECLAW_IS_MAIN', value: String(input.isMain) },
      { name: 'KUBECLAW_PROMPT', value: input.prompt },
      { name: 'KUBECLAW_SESSION_ID', value: input.sessionId || '' },
      { name: 'KUBECLAW_ASSISTANT_NAME', value: input.assistantName || 'Andy' },
      { name: 'KUBECLAW_JOB_ID', value: jobId },
      { name: 'KUBECLAW_INPUT_DIR', value: '/workspace/input' },
      { name: 'KUBECLAW_OUTPUT_DIR', value: '/workspace/output' },
      { name: 'KUBECLAW_POLL_INTERVAL', value: String(SIDECAR_POLL_INTERVAL) },
      {
        name: 'KUBECLAW_TIMEOUT',
        value: String(spec.timeout || CONTAINER_TIMEOUT),
      },
      // Idle timeout for follow-up message handling
      { name: 'IDLE_TIMEOUT', value: String(IDLE_TIMEOUT) },
      // Redis credentials for output delivery and follow-up support
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
      { name: 'KUBECLAW_INPUT_DIR', value: '/workspace/input' },
      { name: 'KUBECLAW_OUTPUT_DIR', value: '/workspace/output' },
      { name: 'KUBECLAW_POLL_INTERVAL', value: '1' }, // User container polls every second
      // Optional user command from spec
      ...(spec.userCommand
        ? [{ name: 'KUBECLAW_USER_COMMAND', value: spec.userCommand.join(' ') }]
        : []),
    ];

    // Volumes from PVCs (for groups, sessions, IPC)
    const pvcVolumes = [
      {
        name: 'groups-pvc',
        persistentVolumeClaim: {
          claimName: 'kubeclaw-groups',
        },
      },
      {
        name: 'sessions-pvc',
        persistentVolumeClaim: {
          claimName: 'kubeclaw-sessions',
        },
      },
    ];

    // Add project PVC for main
    if (input.isMain) {
      pvcVolumes.push({
        name: 'project-pvc',
        persistentVolumeClaim: {
          claimName: 'kubeclaw-project',
        },
      } as any);
    }

    // Mount PVCs into sidecar adapter for access to group data
    const adapterPvcMounts = [
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
      adapterPvcMounts.push({
        name: 'project-pvc',
        mountPath: '/workspace/project',
        readOnly: true,
      } as any);
    }

    // Wrapper script ConfigMap for user container
    const wrapperVolume = {
      name: 'runner-wrapper',
      configMap: {
        name: 'kubeclaw-runner-wrapper',
        defaultMode: 0o755,
      },
    };

    const wrapperVolumeMount = {
      name: 'runner-wrapper',
      mountPath: '/scripts',
      readOnly: true,
    };

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
          'nanoclaw/type': 'sidecar',
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
            volumes: [sharedVolume, wrapperVolume, ...pvcVolumes],
            ...(spec.nodeSelector && { nodeSelector: spec.nodeSelector }),
            ...(spec.tolerations && { tolerations: spec.tolerations }),
            ...(spec.affinity && { affinity: spec.affinity }),
            ...(spec.priorityClassName && {
              priorityClassName: spec.priorityClassName,
            }),
            ...(spec.imagePullSecrets && {
              imagePullSecrets: spec.imagePullSecrets.map((name) => ({ name })),
            }),
            containers: [
              // Sidecar adapter container (handles NanoClaw protocol)
              {
                name: 'kubeclaw-adapter',
                image: SIDECAR_ADAPTER_IMAGE,
                env: adapterEnvVars,
                volumeMounts: [...adapterVolumeMounts, ...adapterPvcMounts],
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
                command: spec.userCommand,
                args: spec.userArgs,
                env: userEnvVars,
                volumeMounts: [...userVolumeMounts, wrapperVolumeMount],
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
   * @deprecated Use jobRunner.streamOutput() instead — output now flows through Redis
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

    logger.debug({ jobName, groupFolder }, 'Starting sidecar log stream');

    const startTime = Date.now();
    const maxWaitTime = timeoutMs;
    const pollInterval = 1000; // Check for logs every second

    let parseBuffer = '';
    let newSessionId: string | undefined;
    // Track the timestamp of the last poll so each fetch returns only new lines.
    // Using sinceTime avoids both the tailLines truncation problem and duplicate
    // accumulation from re-fetching the same tail on every poll.
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

          // Capture timestamp before the fetch so we don't miss lines written
          // between the API response and the next poll.
          const pollTime = new Date();

          // Fetch only log lines since the last poll (or all lines on first poll).
          const logs = await this.coreApi.readNamespacedPodLog({
            name: podName,
            namespace: this.namespace,
            container: 'kubeclaw-adapter',
            ...(sinceTime ? { sinceTime } : {}),
          });

          sinceTime = pollTime;

          // Append only the newly fetched lines to the parse buffer.
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

              // Call onOutput (fire and forget - maintain chain for order)
              await onOutput(output);

              // Check if this is a completion marker (null result with success status)
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
        reject(new Error('Timeout waiting for sidecar output'));
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
    logger.info({ jobName }, 'Stopping sidecar job');

    try {
      await this.batchApi.deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        gracePeriodSeconds: 0,
      });

      logger.info({ jobName }, 'Sidecar job stopped');
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
          container: 'kubeclaw-adapter',
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
export const sidecarJobRunner = new SidecarJobRunner();
