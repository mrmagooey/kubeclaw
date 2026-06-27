/**
 * Kubernetes Job Runner for KubeClaw
 * Creates and manages Kubernetes Jobs for tool job execution
 */
import crypto from 'crypto';
import {
  V1Job,
  CoreV1Api,
  BatchV1Api,
  AppsV1Api,
  CustomObjectsApi,
  KubeConfig,
  loadAllYaml,
} from '@kubernetes/client-node';
import {
  hardenedPodSecurityContext,
  hardenedContainerSecurityContext,
} from './security-context.js';
import {
  makeEgressApplier,
  type EgressApplier,
  type CustomObjectsClient,
} from './egress/apply.js';
import { detectEgressSubstrate } from './egress/substrate.js';

import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import type { CatalogInformer } from './catalog.js';
import type { SecretManager } from './secret-manager.js';
import {
  getContainerImage,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  IDLE_TIMEOUT,
  KUBECLAW_NAMESPACE,
  TOOL_JOB_MEMORY_REQUEST,
  TOOL_JOB_MEMORY_LIMIT,
  TOOL_JOB_CPU_REQUEST,
  TOOL_JOB_CPU_LIMIT,
  TIMEZONE,
  BROWSER_SIDECAR_IMAGE,
  BROWSER_SIDECAR_PORT,
  BROWSER_SIDECAR_MEMORY_REQUEST,
  BROWSER_SIDECAR_MEMORY_LIMIT,
  BROWSER_SIDECAR_CPU_REQUEST,
  BROWSER_SIDECAR_CPU_LIMIT,
  assertToolImageAllowed,
  assertGroupMountAllowed,
  REDIS_AGENT_PASSWORD,
  REDIS_TOOL_SERVER_PASSWORD,
  getInjectionMode,
  getAuditOnly,
  CREDENTIAL_SIDECAR_IMAGE,
  CREDENTIAL_SIDECAR_PORT,
} from '../config.js';
import { workloadEnvForSidecar } from '../credential-injection/workload-env.js';
import {
  sidecarContainerSpec,
  sidecarVolumes,
} from '../credential-injection/sidecar-spec.js';
import {
  JobInput,
  JobOutput,
  ToolJobSpec,
  AgentOutputMessage,
  SidecarToolPodJobSpec,
  RawAttachment,
  ToolSpec,
} from './types.js';
import type { CatalogEntry } from '../credential-broker/resolver.js';
import { ContainerOutput } from '../runtime/types.js';
import {
  getRedisSubscriber,
  getRedisClient,
  getOutputChannel,
  closeRedisConnections,
  getToolCallsStream,
  getToolResultsStream,
} from './redis-client.js';
import { getACLManager } from './acl-manager.js';
import type { OrchestratorMetrics } from '../metrics/orchestrator.js';
import { resolveToolJob } from '../db.js';

/**
 * Sentinel error thrown by `waitForJobCompletion` when the K8s Job transitions
 * to `status.conditions[].type=Failed` with `reason=DeadlineExceeded`.
 * Distinct from generic failures so callers can handle it specifically.
 */
export class DeadlineExceededError extends Error {
  public readonly jobName: string;
  constructor(jobName: string) {
    super(
      `DeadlineExceeded: Job ${jobName} exceeded its activeDeadlineSeconds`,
    );
    this.name = 'DeadlineExceededError';
    this.jobName = jobName;
  }
}

/**
 * Publisher interface for the tool-job timeout notice — mirrors
 * `OrphanJobPublisher` from orphan-jobs.ts so the same Redis-backed
 * implementation can be reused.
 */
export interface ToolJobTimeoutPublisher {
  /**
   * Publish a JSON-encoded `{ type: 'message', chatJid, text, persist, noticeId }`
   * payload to `kubeclaw:messages:<groupFolder>`.
   */
  publish(
    groupFolder: string,
    chatJid: string,
    text: string,
    noticeId: string,
  ): Promise<void>;
}

/**
 * Format the user-visible timeout notice for a DeadlineExceeded job.
 * The message must contain "timed out" (case-insensitive) and reference
 * the group folder so operators can correlate log entries.
 */
export function formatTimeoutNotice(
  groupFolder: string,
  jobName: string,
): string {
  return (
    `Your request timed out: the tool job for group "${groupFolder}" ` +
    `(job ${jobName}) exceeded its time limit and was terminated by Kubernetes. ` +
    `Please re-send your message to try again.`
  );
}

/**
 * Sentinel error thrown by `waitForJobCompletion` when the pod backing a K8s
 * Job was terminated with `containerStatuses[].lastState.terminated.reason ===
 * 'OOMKilled'`.  Distinct from generic failures and DeadlineExceeded so
 * callers can publish a specific "out of memory" notice.
 */
export class OOMKilledError extends Error {
  public readonly jobName: string;
  constructor(jobName: string) {
    super(`OOMKilled: Job ${jobName} container was killed by the OOM killer`);
    this.name = 'OOMKilledError';
    this.jobName = jobName;
  }
}

/**
 * Format the user-visible OOM notice.  The message must contain "out of
 * memory" (case-insensitive) so AC1 can be asserted with a simple
 * case-insensitive substring check.
 */
export function formatOomKillNotice(
  groupFolder: string,
  jobName: string,
): string {
  return (
    `Your request ran out of memory: the tool job for group "${groupFolder}" ` +
    `(job ${jobName}) was killed by the Kubernetes OOM killer because it exceeded ` +
    `its container memory limit. Try a simpler request or contact your administrator.`
  );
}

/**
 * Build Redis URL with embedded ACL credentials if provided and URL doesn't
 * already contain credentials.
 * - redis://host:port + username + password → redis://username:password@host:port
 * - redis://host:port + no username + password → redis://:password@host:port
 * - redis://:existing@host:port + any → leave unchanged (already has auth)
 * - any URL + no password → return URL unchanged
 */
function buildRedisUrl(
  base: string,
  username?: string,
  password?: string,
): string {
  if (!password) return base;
  if (base.includes('@')) return base;
  const userPart = username ? encodeURIComponent(username) : '';
  return base.replace(
    /^(redis:\/\/)/,
    `$1${userPart}:${encodeURIComponent(password)}@`,
  );
}

/**
 * Build a valid Kubernetes Job name from a group folder.
 * K8s names must be lowercase alphanumeric + hyphens, max 63 chars.
 */
export function buildJobName(folder: string): string {
  const sanitized = folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 6-char base36 suffix gives ~2 billion unique IDs per folder
  const suffix = Date.now().toString(36).slice(-6);
  const prefix = 'nc';
  // "nc-<folder>-<suffix>": prefix(2) + dash(1) + folder + dash(1) + suffix(6) = 10 + folder
  const maxFolderLen = 63 - prefix.length - 2 - suffix.length;
  const truncated = sanitized.slice(0, maxFolderLen);
  return `${prefix}-${truncated}-${suffix}`;
}

/**
 * Heuristic: does a log/error string look like a kernel-level egress denial?
 * NetworkPolicy drops manifest as ECONNREFUSED / EHOSTUNREACH / ENETUNREACH
 * at the connecting process; these keywords are a best-effort signal.
 */
function isEgressViolation(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('econnrefused') ||
    lower.includes('ehostunreach') ||
    lower.includes('enetunreach') ||
    lower.includes('network policy') ||
    lower.includes('connection refused') ||
    lower.includes('connection denied')
  );
}

/** Markers written by the agent-runner to stdout to delimit the final JSON result block. */
const KUBECLAW_OUTPUT_START_MARKER = '---KUBECLAW_OUTPUT_START---';
const KUBECLAW_OUTPUT_END_MARKER = '---KUBECLAW_OUTPUT_END---';

/** Valid values for ContainerOutput.status. */
const VALID_STATUSES = new Set(['success', 'error', 'timeout', 'oomkill']);

/**
 * Extract the LAST KUBECLAW_OUTPUT block from agent pod logs and parse it as
 * ContainerOutput. Returns null if absent/malformed. Never throws.
 */
export function parseContainerOutputFromLogs(
  logs: string,
): ContainerOutput | null {
  try {
    const startIdx = logs.lastIndexOf(KUBECLAW_OUTPUT_START_MARKER);
    if (startIdx === -1) return null;
    const contentStart = startIdx + KUBECLAW_OUTPUT_START_MARKER.length;
    const endIdx = logs.indexOf(KUBECLAW_OUTPUT_END_MARKER, contentStart);
    if (endIdx === -1) return null;
    const content = logs.slice(contentStart, endIdx).trim();
    const parsed = JSON.parse(content);
    // Validate shape: must have status and result
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.status !== 'string' ||
      !('result' in parsed)
    ) {
      return null;
    }
    // Enforce status is a known union member
    if (!VALID_STATUSES.has(parsed.status)) return null;
    const result = parsed.result;
    if (result !== null && typeof result !== 'string') return null;
    return parsed as ContainerOutput;
  } catch {
    return null;
  }
}

/** Sentinel stamped when a catalog entry has `allowOperatorFallback: true` and the group
 * has not registered its own credential. The broker maps this to the operator's key from
 * `kubeclaw-secrets` at request time. */
const FALLBACK_SENTINEL_PREFIX = 'KC_PH_FALLBACK_';

/**
 * Build the catalog-driven env list for a tool-job pod.
 *
 * For each catalog entry:
 *   - credentialFields: env value = per-group placeholder | fallback sentinel | "injected-by-broker"
 *   - baseUrlEnvs: stamped unconditionally with the operator-configured URL value
 *
 * Returns both the new envs and the set of env var names that the catalog covers,
 * so the caller can remove duplicate hardcoded built-in entries.
 */
function buildCatalogEnvs(
  catalogEntries: CatalogEntry[],
  groupPlaceholders: Record<string, Record<string, string>>,
): {
  envs: Array<{ name: string; value: string }>;
  coveredEnvNames: Set<string>;
} {
  const envs: Array<{ name: string; value: string }> = [];
  const coveredEnvNames = new Set<string>();

  for (const entry of catalogEntries) {
    const fieldPlaceholders = groupPlaceholders[entry.id] ?? {};

    for (const field of entry.credentialFields) {
      coveredEnvNames.add(field.envVar);
      let value: string;
      if (fieldPlaceholders[field.name]) {
        // Group has a registered credential — use its per-field placeholder
        value = fieldPlaceholders[field.name];
      } else if (entry.allowOperatorFallback) {
        // Unregistered + operator fallback allowed — static sentinel; broker maps to operator key
        value = `${FALLBACK_SENTINEL_PREFIX}${entry.id}`;
      } else {
        // Unregistered + no fallback — fail-closed literal; broker won't substitute
        value = 'injected-by-broker';
      }
      envs.push({ name: field.envVar, value });
    }

    for (const [envName, envValue] of Object.entries(entry.baseUrlEnvs)) {
      coveredEnvNames.add(envName);
      envs.push({ name: envName, value: envValue });
    }
  }

  return { envs, coveredEnvNames };
}

// Job constants
const JOB_TTL_SECONDS_AFTER_FINISHED = 3600;
const JOB_ACTIVE_DEADLINE_SECONDS = 1800; // 30 min
const JOB_BACKOFF_LIMIT = 0;
const JOB_LABELS = { app: 'kubeclaw-agent' };
const NAMESPACE = KUBECLAW_NAMESPACE;

export interface JobRunnerOpts {
  /** Optional catalog informer; when provided, generateJobManifest stamps catalog-driven envs. */
  catalog?: CatalogInformer;
  /** Optional secret manager; when provided (with catalog), per-group placeholders are fetched. */
  secretManager?: SecretManager;
}

export class JobRunner {
  private coreApi: CoreV1Api;
  private batchApi: BatchV1Api;
  private appsApi: AppsV1Api;
  private customObjectsApi: CustomObjectsApi;
  private namespace: string;
  private activeSubscriptions: Map<string, () => void>;
  private catalog?: CatalogInformer;
  private secretManager?: SecretManager;
  metrics?: OrchestratorMetrics;
  /** Optional publisher for DeadlineExceeded timeout notices. Set from ipc-redis.ts after construction. */
  timeoutPublisher?: ToolJobTimeoutPublisher;
  /** Optional publisher for OOMKill notices. Uses the same interface as timeoutPublisher. */
  oomKillPublisher?: ToolJobTimeoutPublisher;
  /** Egress applier — injectable for tests; defaults to a substrate-detecting real applier. */
  egressApplier: EgressApplier;

  constructor(opts: JobRunnerOpts = {}) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.batchApi = kc.makeApiClient(BatchV1Api);
    this.appsApi = kc.makeApiClient(AppsV1Api);
    this.customObjectsApi = kc.makeApiClient(CustomObjectsApi);
    this.namespace = NAMESPACE;
    this.activeSubscriptions = new Map();
    this.catalog = opts.catalog;
    this.secretManager = opts.secretManager;

    // Build a CustomObjectsClient adapter over the k8s CustomObjectsApi
    const coApi = this.customObjectsApi;
    const customObjectsClient: CustomObjectsClient = {
      create: (group, version, namespace, plural, body) =>
        coApi
          .createNamespacedCustomObject({
            group,
            version,
            namespace,
            plural,
            body,
          })
          .then(() => undefined),
      delete: (group, version, namespace, plural, name) =>
        coApi
          .deleteNamespacedCustomObject({
            group,
            version,
            namespace,
            plural,
            name,
          })
          .then(() => undefined),
    };

    this.egressApplier = makeEgressApplier({
      substrate: detectEgressSubstrate(),
      customObjects: customObjectsClient,
      redisNamespace: NAMESPACE,
    });
  }

  /**
   * Apply multi-document YAML to Kubernetes (create or update).
   * Supports Deployment, Service, and PersistentVolumeClaim resources.
   */
  async applyYamlToK8s(yamlContent: string): Promise<void> {
    const docs = (loadAllYaml(yamlContent) as any[]).filter(
      (d) => d?.kind && d?.metadata?.name,
    );
    for (const doc of docs) {
      const ns = doc.metadata?.namespace || this.namespace;
      const name = doc.metadata?.name;
      switch (doc.kind) {
        case 'Deployment':
          try {
            await this.appsApi.createNamespacedDeployment({
              namespace: ns,
              body: doc,
            });
          } catch {
            await this.appsApi.replaceNamespacedDeployment({
              name,
              namespace: ns,
              body: doc,
            });
          }
          logger.info(
            { kind: 'Deployment', name, namespace: ns },
            'Applied K8s resource',
          );
          break;
        case 'PersistentVolumeClaim':
          try {
            await this.coreApi.createNamespacedPersistentVolumeClaim({
              namespace: ns,
              body: doc,
            });
            logger.info(
              { kind: 'PersistentVolumeClaim', name, namespace: ns },
              'Applied K8s resource',
            );
          } catch {
            logger.debug(
              { kind: 'PersistentVolumeClaim', name },
              'PVC already exists, skipping',
            );
          }
          break;
        case 'Service':
          try {
            await this.coreApi.createNamespacedService({
              namespace: ns,
              body: doc,
            });
          } catch {
            await this.coreApi.replaceNamespacedService({
              name,
              namespace: ns,
              body: doc,
            });
          }
          logger.info(
            { kind: 'Service', name, namespace: ns },
            'Applied K8s resource',
          );
          break;
        default:
          logger.warn(
            { kind: doc.kind, name },
            'Unsupported resource kind in applyYamlToK8s',
          );
      }
    }
  }

  /**
   * Run a tool job in Kubernetes
   * Creates a K8s Job, streams output via Redis, and waits for completion
   */
  async runToolJob(
    group: RegisteredGroup,
    input: JobInput,
    onProcess?: (jobName: string) => void,
    onOutput?: (output: JobOutput) => Promise<void>,
  ): Promise<JobOutput> {
    const startTime = Date.now();
    const jobId = input.jobId || buildJobName(group.folder);

    logger.info(
      {
        group: group.name,
        jobId,
        isMain: input.isMain,
      },
      'Creating Kubernetes job for tool job',
    );

    try {
      // Generate and create the job
      const jobSpec = await this.buildToolJobSpec(group, input, jobId);
      const jobManifest = this.generateJobManifest(jobSpec);

      logger.debug(
        { jobName: jobId, namespace: this.namespace },
        'Creating Kubernetes job',
      );

      const createdJob = await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: jobManifest,
      });
      this.metrics?.recordToolJobSpawn({
        image: getContainerImage(group.llmProvider ?? 'openai'),
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

      // Track session ID from streamed outputs so we can return it
      let capturedSessionId: string | undefined;
      const wrappedOnOutput = onOutput
        ? async (output: JobOutput) => {
            if (output.newSessionId) capturedSessionId = output.newSessionId;
            return onOutput(output);
          }
        : undefined;

      // Compute effective timeout for streaming and wait
      const effectiveTimeoutMs = Math.max(
        group.containerConfig?.timeout || CONTAINER_TIMEOUT,
        IDLE_TIMEOUT + 30_000,
      );

      // Start streaming output from Redis
      const streamingPromise = this.streamOutput(
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
        'Kubernetes job completed',
      );
      this.metrics?.recordToolJobDuration({
        image: getContainerImage(group.llmProvider ?? 'openai'),
        success: true,
        durationMs: duration,
      });

      // Parse the agent's final result from pod logs.  getJobLogs never throws
      // (it returns an error string on failure); parseContainerOutputFromLogs
      // returns null for any non-parseable string, so the fallback below is safe.
      const logs = await this.getJobLogs(jobName);
      const parsed = parseContainerOutputFromLogs(logs);
      if (!parsed)
        logger.debug(
          { jobName },
          'runToolJob: no parseable agent output block in logs; returning null result',
        );

      return {
        status: parsed?.status ?? 'success',
        result: parsed?.result ?? null,
        newSessionId: parsed?.newSessionId ?? capturedSessionId,
        error: parsed?.error,
        jobId,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const image = getContainerImage(group.llmProvider ?? 'openai');

      // Story 43: DeadlineExceeded — K8s terminated the job because it exceeded
      // activeDeadlineSeconds.  Publish a user-visible "timed out" notice, mark
      // the DB row as 'timeout', and record the failure metric.
      if (error instanceof DeadlineExceededError) {
        const jobName = error.jobName;
        logger.error(
          { event: 'tool_job_timeout', groupFolder: group.folder, jobName },
          'Tool job timed out (DeadlineExceeded)',
        );

        // Mark DB row as timed-out (best-effort). Done BEFORE the publish so
        // an orchestrator crash mid-handler doesn't leave the row 'active'
        // and re-trigger via orphan reconciliation (Story 37).
        try {
          resolveToolJob(jobId, 'timeout');
        } catch (dbErr) {
          logger.warn(
            { jobId, dbErr },
            'tool_job_timeout: failed to mark job as timeout in DB',
          );
        }

        // Publish timeout notice to the channel's pub/sub channel (best-effort).
        // Note: timeoutPublisher is wired from ipc-redis.ts during
        // startToolJobSpawnWatcher boot — a job that times out before that
        // wiring completes silently drops the notice (rare boot-race).
        if (this.timeoutPublisher) {
          const noticeId = `timeout-notice-${jobId}`;
          const notice = formatTimeoutNotice(group.folder, jobName);
          try {
            await this.timeoutPublisher.publish(
              group.folder,
              input.chatJid,
              notice,
              noticeId,
            );
          } catch (pubErr) {
            logger.warn(
              { jobId, groupFolder: group.folder, pubErr },
              'tool_job_timeout: failed to publish timeout notice',
            );
          }
        }

        // Record metrics for the timeout path.
        this.metrics?.recordToolJobFailure({
          image,
          reason: 'deadline_exceeded',
        });
        this.metrics?.recordToolJobDuration({
          image,
          success: false,
          durationMs: duration,
        });

        return {
          status: 'timeout',
          result: null,
          error: error.message,
          jobId,
        };
      }

      // Story 46: OOMKilled — the container was terminated by the kernel OOM
      // killer because it exceeded its memory limit.  Publish a user-visible
      // "out of memory" notice, mark the DB row as 'error', and record the
      // failure metric.
      if (error instanceof OOMKilledError) {
        const jobName = error.jobName;
        logger.error(
          { event: 'tool_job_oomkill', groupFolder: group.folder, jobName },
          'Tool job killed by OOM killer',
        );

        // Mark DB row as oomkill (best-effort). Done BEFORE the publish so
        // an orchestrator crash mid-handler doesn't leave the row 'active'.
        try {
          resolveToolJob(jobId, 'oomkill');
        } catch (dbErr) {
          logger.warn(
            { jobId, dbErr },
            'tool_job_oomkill: failed to mark job as oomkill in DB',
          );
        }

        // Publish OOM notice to the channel's pub/sub channel (best-effort).
        if (this.oomKillPublisher) {
          const noticeId = `oomkill-notice-${jobId}`;
          const notice = formatOomKillNotice(group.folder, jobName);
          try {
            await this.oomKillPublisher.publish(
              group.folder,
              input.chatJid,
              notice,
              noticeId,
            );
          } catch (pubErr) {
            logger.warn(
              { jobId, groupFolder: group.folder, pubErr },
              'tool_job_oomkill: failed to publish OOM notice',
            );
          }
        }

        // Record metrics for the OOM path.
        this.metrics?.recordToolJobFailure({ image, reason: 'oomkilled' });
        this.metrics?.recordToolJobDuration({
          image,
          success: false,
          durationMs: duration,
        });

        return {
          status: 'oomkill',
          result: null,
          error: error.message,
          jobId,
        };
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { group: group.name, jobId, error: errorMessage },
        'Kubernetes job failed',
      );
      this.metrics?.recordToolJobFailure({
        image,
        reason: 'error',
      });
      this.metrics?.recordToolJobDuration({
        image,
        success: false,
        durationMs: duration,
      });

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
   * Build the ToolJobSpec from input parameters
   */
  private async buildToolJobSpec(
    group: RegisteredGroup,
    input: JobInput,
    jobId: string,
  ): Promise<ToolJobSpec> {
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;

    // Fetch catalog and per-group placeholders if the optional dependencies are wired in.
    const catalogEntries = this.catalog?.getCatalog()
      ? [...this.catalog.getCatalog()]
      : undefined;
    let groupPlaceholders: Record<string, Record<string, string>> | undefined;
    if (this.secretManager && group.folder) {
      try {
        groupPlaceholders = await this.secretManager.getGroupPlaceholders(
          group.folder,
        );
      } catch (err) {
        logger.warn(
          { err, group: group.folder },
          'getGroupPlaceholders failed; omitting catalog envs',
        );
      }
    }

    return {
      name: jobId,
      groupFolder: group.folder,
      chatJid: input.chatJid,
      isMain: input.isMain,
      prompt: input.prompt,
      sessionId: input.sessionId,
      assistantName: input.assistantName,
      timeout: Math.max(configTimeout, IDLE_TIMEOUT + 30_000),
      provider: group.llmProvider || 'openai',
      browserSidecar: group.containerConfig?.browserSidecar,
      nodeSelector: group.containerConfig?.nodeSelector,
      tolerations: group.containerConfig?.tolerations,
      affinity: group.containerConfig?.affinity,
      priorityClassName: group.containerConfig?.priorityClassName,
      deviceRequests: group.containerConfig?.deviceRequests,
      imagePullSecrets: group.containerConfig?.imagePullSecrets,
      securityContext: group.containerConfig?.securityContext,
      additionalMounts: group.containerConfig?.additionalMounts,
      groupsPvc: input.groupsPvc,
      sessionsPvc: input.sessionsPvc,
      ownerGroup: group.folder,
      catalogEntries,
      groupPlaceholders,
    };
  }

  /**
   * Generate the Kubernetes Job manifest
   */
  generateJobManifest(spec: ToolJobSpec): V1Job {
    const timeoutSeconds = Math.floor(
      (spec.timeout || CONTAINER_TIMEOUT) / 1000,
    );

    // Environment variables for the container
    const envVars = [
      { name: 'TZ', value: TIMEZONE },
      { name: 'KUBECLAW_GROUP_FOLDER', value: spec.groupFolder },
      { name: 'KUBECLAW_CHAT_JID', value: spec.chatJid },
      { name: 'KUBECLAW_IS_MAIN', value: String(spec.isMain) },
      { name: 'KUBECLAW_PROMPT', value: spec.prompt },
      { name: 'KUBECLAW_SESSION_ID', value: spec.sessionId || '' },
      { name: 'KUBECLAW_ASSISTANT_NAME', value: spec.assistantName || 'Andy' },
      { name: 'KUBECLAW_JOB_ID', value: spec.name },
      { name: 'KUBECLAW_LLM_PROVIDER', value: spec.provider || 'openai' },
      {
        name: 'CONTAINER_MAX_OUTPUT_SIZE',
        value: String(CONTAINER_MAX_OUTPUT_SIZE),
      },
      { name: 'IDLE_TIMEOUT', value: String(IDLE_TIMEOUT) },
      // Tool jobs authenticate as the 'agent' ACL user for least-privilege access.
      {
        name: 'REDIS_URL',
        value: buildRedisUrl(
          process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
          'agent',
          REDIS_AGENT_PASSWORD || process.env.REDIS_ADMIN_PASSWORD,
        ),
      },
      // Credentials from kubeclaw-secrets — key names use hyphens to match the
      // secret template in k8s/05-secrets.yaml.
      {
        name: 'OPENAI_API_KEY',
        valueFrom: {
          secretKeyRef: {
            name: 'kubeclaw-secrets',
            key: 'openai-api-key',
            optional: true,
          },
        },
      },
      {
        name: 'OPENAI_BASE_URL',
        valueFrom: {
          secretKeyRef: {
            name: 'kubeclaw-secrets',
            key: 'openai-base-url',
            optional: true,
          },
        },
      },
      {
        name: 'OPENAI_MODEL',
        valueFrom: {
          secretKeyRef: {
            name: 'kubeclaw-secrets',
            key: 'openai-model',
            optional: true,
          },
        },
      },
      {
        name: 'OPENROUTER_API_KEY',
        valueFrom: {
          secretKeyRef: {
            name: 'kubeclaw-secrets',
            key: 'openrouter-api-key',
            optional: true,
          },
        },
      },
      {
        name: 'OPENROUTER_MODEL',
        valueFrom: {
          secretKeyRef: {
            name: 'kubeclaw-secrets',
            key: 'openrouter-model',
            optional: true,
          },
        },
      },
      {
        name: 'OPENROUTER_BASE_URL',
        valueFrom: {
          secretKeyRef: {
            name: 'kubeclaw-secrets',
            key: 'openrouter-base-url',
            optional: true,
          },
        },
      },
      // Ollama-specific config (plain values, no credentials)
      ...(spec.provider === 'ollama'
        ? [
            {
              name: 'OLLAMA_HOST',
              value: process.env.OLLAMA_HOST || 'http://ollama:11434',
            },
            {
              name: 'OLLAMA_MODEL',
              value: process.env.OLLAMA_MODEL || 'llama3.2',
            },
          ]
        : []),
      // Anthropic (claude provider) config — API-key auth via pi-ai's native
      // anthropic-messages API. Only injected when provider is claude.
      ...(spec.provider === 'claude'
        ? [
            {
              name: 'ANTHROPIC_API_KEY',
              valueFrom: {
                secretKeyRef: {
                  name: 'kubeclaw-secrets',
                  key: 'anthropic-api-key',
                  optional: true,
                },
              },
            },
            {
              name: 'ANTHROPIC_BASE_URL',
              valueFrom: {
                secretKeyRef: {
                  name: 'kubeclaw-secrets',
                  key: 'anthropic-base-url',
                  optional: true,
                },
              },
            },
            {
              name: 'ANTHROPIC_MODEL',
              valueFrom: {
                secretKeyRef: {
                  name: 'kubeclaw-secrets',
                  key: 'anthropic-model',
                  optional: true,
                },
              },
            },
          ]
        : []),
    ];

    // Volume mounts using PVCs
    const volumeMounts: Array<{
      name: string;
      mountPath: string;
      subPath?: string;
      readOnly?: boolean;
    }> = [
      {
        name: 'groups-pvc',
        mountPath: '/workspace/group',
        subPath: spec.groupFolder,
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
          claimName: spec.groupsPvc ?? 'kubeclaw-groups',
        },
      },
      {
        name: 'sessions-pvc',
        persistentVolumeClaim: {
          claimName: spec.sessionsPvc ?? 'kubeclaw-sessions',
        },
      },
    ];

    // Add project PVC for main
    if (spec.isMain) {
      volumes.push({
        name: 'project-pvc',
        persistentVolumeClaim: {
          claimName: 'kubeclaw-project',
        },
      });
    }

    // Add additional volumes (configmap, secret, tmpfs) from spec
    if (spec.additionalMounts) {
      for (const mount of spec.additionalMounts) {
        const mountType = mount.type || 'hostpath';
        if (mountType === 'hostpath') continue; // hostpath not supported in K8s mode

        const volumeName = `extra-${mount.configMapName || mount.secretName || 'tmpfs'}-${volumes.length}`;
        const containerPath =
          mount.containerPath ||
          mount.configMapName ||
          mount.secretName ||
          'tmpfs';

        if (mountType === 'configmap' && mount.configMapName) {
          volumes.push({
            name: volumeName,
            configMap: { name: mount.configMapName },
          } as any);
          volumeMounts.push({
            name: volumeName,
            mountPath: `/workspace/extra/${containerPath}`,
            readOnly: mount.readonly !== false,
          } as any);
        } else if (mountType === 'secret' && mount.secretName) {
          volumes.push({
            name: volumeName,
            secret: { secretName: mount.secretName },
          } as any);
          volumeMounts.push({
            name: volumeName,
            mountPath: `/workspace/extra/${containerPath}`,
            readOnly: mount.readonly !== false,
          } as any);
        } else if (mountType === 'tmpfs') {
          volumes.push({
            name: volumeName,
            emptyDir: {
              medium: 'Memory',
              ...(mount.sizeLimit && { sizeLimit: mount.sizeLimit }),
            },
          } as any);
          volumeMounts.push({
            name: volumeName,
            mountPath: `/workspace/extra/${containerPath || 'tmpfs'}`,
          } as any);
        }
      }
    }

    // Mount the merged specialists ConfigMap (optional — absent before first reconcile)
    volumes.push({
      name: 'specialists-catalog',
      configMap: { name: 'kubeclaw-specialists', optional: true },
    } as any);
    volumeMounts.push({
      name: 'specialists-catalog',
      mountPath: '/etc/kubeclaw/specialists',
      readOnly: true,
    } as any);

    // Mount the merged tool catalog ConfigMap so the agent-runner can read tools.json
    // and route tool execution by name (same catalog the channel pods mount).
    volumes.push({
      name: 'tools-catalog',
      configMap: { name: 'kubeclaw-tools', optional: true },
    } as any);
    volumeMounts.push({
      name: 'tools-catalog',
      mountPath: '/etc/kubeclaw/tools',
      readOnly: true,
    } as any);

    // Add browser WebSocket endpoint to agent env when sidecar is enabled
    if (spec.browserSidecar) {
      envVars.push({
        name: 'PLAYWRIGHT_BROWSER_WS_ENDPOINT',
        value: `ws://localhost:${BROWSER_SIDECAR_PORT}`,
      });
    }

    // Credential injection env transformation.
    // LLM provider keys (openai/anthropic/openrouter/voyage) are now catalog entries.
    // buildCatalogEnvs replaces their raw secretKeyRef envs with KC_PH_… placeholders
    // when injection is on and not in audit-only mode.  In audit-only mode, raw keys
    // are preserved so the broker can observe them.
    //
    // sidecar mode: adds HTTPS_PROXY so Node fetch routes through the per-pod Envoy.
    //   In audit-only mode the raw secretKeyRef keys are kept; HTTPS_PROXY is still set.
    // istio mode: baseEnvVars already contain the catalog placeholders (or raw keys in
    //   audit-only) — no per-key substitution needed; Istio iptables handles routing.
    const injectionMode = getInjectionMode();
    const auditOnly = getAuditOnly();

    // Catalog-driven env injection: applies when spec.catalogEntries is present and
    // injection is active (any mode != off) and not in audit-only mode.
    // Catalog entries whose envVar names overlap with hard-coded built-ins take precedence.
    let baseEnvVars = envVars;
    if (
      spec.catalogEntries &&
      spec.catalogEntries.length > 0 &&
      injectionMode !== 'off' &&
      !auditOnly
    ) {
      const { envs: catalogEnvs, coveredEnvNames } = buildCatalogEnvs(
        spec.catalogEntries,
        spec.groupPlaceholders ?? {},
      );
      // Remove built-in hardcoded entries whose names the catalog now covers
      baseEnvVars = envVars.filter((e) => !coveredEnvNames.has(e.name));
      // Append catalog-driven envs
      baseEnvVars = [...baseEnvVars, ...catalogEnvs];
    }

    let finalEnv: Array<{ name: string; value?: string; valueFrom?: object }>;
    if (injectionMode === 'sidecar') {
      // sidecar (active or audit-only): always add HTTPS_PROXY so the per-pod Envoy
      // can observe / intercept traffic.  In audit-only the raw keys survive; active
      // mode has already had them replaced by catalog placeholders above.
      finalEnv = [
        ...baseEnvVars,
        ...workloadEnvForSidecar({ port: CREDENTIAL_SIDECAR_PORT }),
      ];
    } else {
      // istio (transparent) or off: baseEnvVars already has the right keys
      finalEnv = baseEnvVars;
    }

    // Stamp owner-group annotation on the pod template so the broker can resolve
    // the group for identity propagation. Stamped whenever ownerGroup is set,
    // regardless of injection mode. Skipped in audit-only mode to preserve
    // existing behaviour.
    const podTemplateAnnotations: Record<string, string> | undefined =
      spec.ownerGroup && !auditOnly
        ? { 'kubeclaw.io/owner-group': spec.ownerGroup }
        : undefined;

    // Build resource limits — include GPU/device requests when specified
    const resourceLimits: Record<string, string> = {
      memory: TOOL_JOB_MEMORY_LIMIT,
      cpu: TOOL_JOB_CPU_LIMIT,
      ...(spec.deviceRequests || {}),
    };

    const agentContainer = {
      name: 'agent',
      image: getContainerImage(spec.provider || 'claude'),
      imagePullPolicy: 'IfNotPresent',
      env: finalEnv,
      volumeMounts,
      resources: {
        requests: {
          memory: TOOL_JOB_MEMORY_REQUEST,
          cpu: TOOL_JOB_CPU_REQUEST,
        },
        limits: resourceLimits,
      },
      ...(spec.securityContext && { securityContext: spec.securityContext }),
    } as any;

    // Browser sidecar as K8s 1.29+ sidecar init container (starts before agent, restarts on failure)
    const initContainers = spec.browserSidecar
      ? [
          {
            name: 'browser',
            image: BROWSER_SIDECAR_IMAGE,
            ports: [{ containerPort: BROWSER_SIDECAR_PORT }],
            readinessProbe: {
              httpGet: { path: '/json/version', port: BROWSER_SIDECAR_PORT },
              initialDelaySeconds: 2,
              periodSeconds: 2,
              failureThreshold: 10,
            },
            resources: {
              requests: {
                memory: BROWSER_SIDECAR_MEMORY_REQUEST,
                cpu: BROWSER_SIDECAR_CPU_REQUEST,
              },
              limits: {
                memory: BROWSER_SIDECAR_MEMORY_LIMIT,
                cpu: BROWSER_SIDECAR_CPU_LIMIT,
              },
            },
            restartPolicy: 'Always', // K8s 1.29+ sidecar pattern
          },
        ]
      : undefined;

    // Build final containers and volumes arrays, appending credential sidecar when active
    const containers: any[] = [agentContainer];
    const finalVolumes: any[] = [...volumes];
    if (injectionMode === 'sidecar') {
      containers.push(
        sidecarContainerSpec({
          image: CREDENTIAL_SIDECAR_IMAGE,
          port: CREDENTIAL_SIDECAR_PORT,
        }),
      );
      finalVolumes.push(...sidecarVolumes());
    }

    // Service account: use dedicated SA for tool jobs when injection is active
    const podServiceAccountName =
      injectionMode !== 'off' ? 'kubeclaw-tool-job' : '';

    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: spec.name,
        namespace: this.namespace,
        labels: {
          ...JOB_LABELS,
          'kubeclaw/group': spec.groupFolder,
          'kubeclaw/chat-jid': spec.chatJid.replace(/[^a-zA-Z0-9-]/g, '-'),
        },
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS_AFTER_FINISHED,
        activeDeadlineSeconds: timeoutSeconds,
        backoffLimit: JOB_BACKOFF_LIMIT,
        template: {
          metadata: {
            labels: JOB_LABELS,
            ...(podTemplateAnnotations && {
              annotations: podTemplateAnnotations,
            }),
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: podServiceAccountName,
            automountServiceAccountToken: false,
            ...(initContainers && { initContainers }),
            containers,
            volumes: finalVolumes,
            ...(spec.nodeSelector && { nodeSelector: spec.nodeSelector }),
            ...(spec.tolerations && { tolerations: spec.tolerations }),
            ...(spec.affinity && { affinity: spec.affinity }),
            ...(spec.priorityClassName && {
              priorityClassName: spec.priorityClassName,
            }),
            ...(spec.imagePullSecrets && {
              imagePullSecrets: spec.imagePullSecrets.map((name) => ({ name })),
            }),
          },
        },
      },
    };

    return job;
  }

  /**
   * Stream output from Redis pub/sub channel
   * Subscribes to kubeclaw:messages:${groupFolder} and calls callback for each message
   */
  async streamOutput(
    jobName: string,
    groupFolder: string,
    onOutput?: (output: JobOutput) => Promise<void>,
    timeoutMs: number = JOB_ACTIVE_DEADLINE_SECONDS * 1000,
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
  unsubscribeFromOutput(jobName: string): void {
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
          const failedCondition = status.conditions?.find(
            (c: { type: string; reason?: string }) => c.type === 'Failed',
          );
          const reason = failedCondition?.reason || 'Unknown';
          const message =
            status.conditions?.find(
              (c: { type: string; message?: string }) => c.type === 'Failed',
            )?.message || 'Job failed';

          // Story 43: DeadlineExceeded gets a distinct error so callers can
          // publish a user-visible timeout notice rather than a generic error.
          if (reason === 'DeadlineExceeded') {
            throw new DeadlineExceededError(jobName);
          }

          // K8s poll race: reason may still be 'Unknown' when the Failed
          // condition message already contains the deadline indicator.
          if (message.toLowerCase().includes('deadline')) {
            throw new DeadlineExceededError(jobName);
          }

          // K8s poll race fallback: reason and message may not yet reflect
          // DeadlineExceeded, so use elapsed wall-clock time as a tiebreaker.
          // Only fires when activeDeadlineSeconds is configured AND the job
          // has been running at least (activeDeadlineSeconds - 2) seconds.
          // Log at warn so operators can distinguish K8s-race classification
          // from a potential false positive (a job that legitimately failed
          // near its deadline).
          if (job.spec?.activeDeadlineSeconds && job.status?.startTime) {
            const deadlineSeconds = job.spec.activeDeadlineSeconds;
            const startMs = new Date(job.status.startTime).getTime();
            const elapsedSeconds = (Date.now() - startMs) / 1000;
            if (elapsedSeconds >= deadlineSeconds - 2) {
              logger.warn(
                { jobName, elapsedSeconds, deadlineSeconds, reason },
                'waitForJobCompletion: elapsed-time fallback detected DeadlineExceeded ' +
                  '(K8s condition reason not yet populated)',
              );
              throw new DeadlineExceededError(jobName);
            }
          }

          // Story 46: Check if the job failure was due to an OOMKilled container.
          // The Job-level condition won't say "OOMKilled" — it typically says
          // "BackoffLimitExceeded".  We must inspect pod containerStatuses to
          // determine the actual termination reason.
          if (await this.isOOMKilled(jobName)) {
            throw new OOMKilledError(jobName);
          }

          throw new Error(`${reason}: ${message}`);
        }

        // Check for active deadline exceeded via conditions (belt-and-suspenders:
        // some K8s versions set conditions without incrementing failed count).
        const conditions = status?.conditions || [];
        for (const condition of conditions) {
          if (condition.type === 'Failed' && condition.status === 'True') {
            if (condition.reason === 'DeadlineExceeded') {
              throw new DeadlineExceededError(jobName);
            }
            // Belt-and-suspenders OOMKill check for the conditions-only path.
            if (await this.isOOMKilled(jobName)) {
              throw new OOMKilledError(jobName);
            }
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
   * Return true if any container in the pod(s) backing `jobName` was
   * terminated with reason=OOMKilled.
   *
   * Checks `containerStatuses[].lastState.terminated.reason` and
   * `containerStatuses[].state.terminated.reason` (the latter covers the
   * case where the pod has already exited by the time we query).
   *
   * Returns false on any API error so callers fall through to generic failure.
   */
  async isOOMKilled(jobName: string): Promise<boolean> {
    try {
      const pods = await this.coreApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `job-name=${jobName}`,
      });

      for (const pod of pods.items ?? []) {
        const containerStatuses = pod.status?.containerStatuses ?? [];
        for (const cs of containerStatuses) {
          if (
            cs.lastState?.terminated?.reason === 'OOMKilled' ||
            cs.state?.terminated?.reason === 'OOMKilled'
          ) {
            logger.debug(
              { jobName, container: cs.name, reason: 'OOMKilled' },
              'OOMKilled container detected in pod',
            );
            return true;
          }
        }
      }
    } catch (err) {
      logger.warn(
        { jobName, err },
        'isOOMKilled: failed to list pods; treating as non-OOM failure',
      );
    }
    return false;
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
   * Spawn a short-lived preprocessing K8s Job to resize images / extract PDF text.
   * Waits for completion via K8s API polling. Returns true on success, false on failure.
   */
  async runPreprocessingJob(
    group: RegisteredGroup,
    attachments: RawAttachment[],
    opts?: { groupsPvc?: string },
  ): Promise<boolean> {
    const jobName = buildJobName(`${group.folder}-preproc`);
    const claimName = opts?.groupsPvc ?? 'kubeclaw-groups';

    const job: V1Job = {
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: { app: 'kubeclaw-preproc', 'kubeclaw/group': group.folder },
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS_AFTER_FINISHED,
        activeDeadlineSeconds: 120,
        backoffLimit: 0,
        template: {
          spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'preprocessor',
                image: getContainerImage(group.llmProvider ?? 'openai'),
                command: ['node', '/app/dist/attachment-preprocessor.js'],
                env: [
                  { name: 'TZ', value: TIMEZONE },
                  { name: 'KUBECLAW_GROUP_FOLDER', value: group.folder },
                  {
                    name: 'KUBECLAW_ATTACHMENTS',
                    value: JSON.stringify(attachments),
                  },
                ],
                volumeMounts: [
                  {
                    name: 'groups-pvc',
                    mountPath: '/workspace/group',
                    subPath: group.folder,
                  },
                ],
                resources: {
                  requests: { memory: '128Mi', cpu: '100m' },
                  limits: { memory: '512Mi', cpu: '500m' },
                },
              },
            ],
            volumes: [
              {
                name: 'groups-pvc',
                persistentVolumeClaim: { claimName },
              },
            ],
          },
        },
      },
    };

    await this.batchApi.createNamespacedJob({
      namespace: this.namespace,
      body: job,
    });

    try {
      await this.waitForJobCompletion(jobName, 120_000);
      return true;
    } catch (err) {
      logger.warn(
        { jobName, group: group.folder, err },
        'Preprocessing job failed',
      );
      return false;
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

  /**
   * Create a sidecar tool pod job: two-container K8s job with a tool-bridge
   * container (tool-server in http-bridge or file-bridge mode) and the user's
   * custom tool container sharing localhost (http) or an emptyDir (file).
   * Returns the K8s job name.
   */
  /**
   * Build the sidecar tool pod Job manifest and derived job name.
   * Extracted so `createSidecarToolPodJob` and `buildSidecarToolPodJobForTest`
   * can share the manifest-construction logic without duplicating it.
   */
  private async buildSidecarToolPodManifest(
    spec: SidecarToolPodJobSpec,
  ): Promise<{ job: V1Job; jobName: string; toolMode: string }> {
    const { toolSpec } = spec;
    assertToolImageAllowed(toolSpec.image);
    const port = toolSpec.port ?? 8080;
    const isFileBridge = toolSpec.pattern === 'file';
    const isAcpBridge = toolSpec.pattern === 'acp';
    const isCdpBridge = toolSpec.pattern === 'cdp';
    const toolMode = isCdpBridge
      ? 'cdp-bridge'
      : isFileBridge
        ? 'file-bridge'
        : isAcpBridge
          ? 'acp-bridge'
          : 'http-bridge';

    // Keep job name under 63 chars: "kubeclaw-stool-" (15) + 8-char suffix + "-" + toolName (truncated)
    const agentSuffix = spec.agentJobId
      .slice(-8)
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();
    const safeTool = spec.toolName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .slice(0, 35);
    const jobName = `kubeclaw-stool-${agentSuffix}-${safeTool}`;

    // A per-tool catalog timeout (toolSpec.timeout, ms) overrides the caller default.
    const effectiveTimeoutMs = spec.toolSpec.timeout ?? spec.timeout;
    const timeoutSeconds = Math.floor(effectiveTimeoutMs / 1000);
    // Prefer a per-job ACL user scoped to exactly this job's two streams
    // (ported from the legacy adapter security model). Fall back to the
    // shared 'tool-server' user if minting fails (e.g. Redis < 7), matching
    // the legacy runners' degrade-gracefully behavior.
    let redisUsername = 'tool-server';
    let redisPassword =
      REDIS_TOOL_SERVER_PASSWORD || process.env.REDIS_ADMIN_PASSWORD;
    try {
      const creds = await getACLManager().createToolPodACL(
        jobName,
        spec.agentJobId,
        spec.toolName,
        spec.groupFolder,
        timeoutSeconds + 900, // outlive the pod by 15 min; sweep revokes after
      );
      redisUsername = creds.username;
      redisPassword = creds.password;
    } catch (err) {
      logger.warn(
        { jobName, err },
        'Per-job ACL minting failed; falling back to shared tool-server Redis user',
      );
    }
    const redisUrl = buildRedisUrl(
      process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
      redisUsername,
      redisPassword,
    );

    const bridgeEnv = [
      { name: 'TZ', value: TIMEZONE },
      { name: 'KUBECLAW_TOOL_JOB_ID', value: spec.agentJobId },
      { name: 'KUBECLAW_CATEGORY', value: spec.toolName },
      { name: 'KUBECLAW_GROUP_FOLDER', value: spec.groupFolder },
      { name: 'KUBECLAW_TOOL_MODE', value: toolMode },
      { name: 'KUBECLAW_TOOL_PORT', value: String(port) },
      { name: 'IDLE_TIMEOUT', value: String(effectiveTimeoutMs) },
      { name: 'REDIS_URL', value: redisUrl },
    ];

    if (isAcpBridge) {
      bridgeEnv.push(
        {
          name: 'KUBECLAW_ACP_AGENT_NAME',
          value: toolSpec.acpAgentName || spec.toolName,
        },
        { name: 'KUBECLAW_ACP_MODE', value: toolSpec.acpMode || 'sync' },
      );
    }

    if (isCdpBridge) {
      bridgeEnv.push({
        name: 'KUBECLAW_CDP_URL',
        value: `http://localhost:${port}`,
      });
    }

    if (toolSpec.healthPath) {
      bridgeEnv.push({
        name: 'KUBECLAW_TOOL_HEALTH_PATH',
        value: toolSpec.healthPath,
      });
    }

    if (toolSpec.requestMapping) {
      bridgeEnv.push({
        name: 'KUBECLAW_TOOL_REQUEST_MAPPING',
        value: JSON.stringify(toolSpec.requestMapping),
      });
    }

    if (isFileBridge && toolSpec.run) {
      bridgeEnv.push({
        name: 'KUBECLAW_TOOL_FIELDS',
        value: Object.keys(
          (toolSpec.parameters as { properties?: Record<string, unknown> })
            ?.properties ?? {},
        ).join(','),
      });
    }

    const bridgeMounts: Array<{
      name: string;
      mountPath: string;
      readOnly?: boolean;
    }> = [];
    const userMounts: Array<{
      name: string;
      mountPath: string;
      readOnly?: boolean;
      subPath?: string;
    }> = [];
    const volumes: Array<any> = [];

    let workEnv: { name: string; value: string }[] = [];
    if (isFileBridge) {
      bridgeMounts.push({ name: 'shared', mountPath: '/shared' });
      userMounts.push({ name: 'shared', mountPath: '/shared' });
      // Optional wrapper script: lets stock images (sh + jq) serve file-bridge
      // tools via command: ["/bin/sh", "/kubeclaw/tool-wrapper.sh", "<cmd>"]
      userMounts.push({
        name: 'tool-wrapper',
        mountPath: '/kubeclaw',
        readOnly: true,
      });
      volumes.push({ name: 'shared', emptyDir: {} });
      volumes.push({
        name: 'tool-wrapper',
        configMap: {
          name: 'kubeclaw-tool-wrapper',
          defaultMode: 0o755,
          optional: true,
        },
      });

      const mount = toolSpec.mount ?? 'none';
      if (mount === 'scratch') {
        userMounts.push({ name: 'work', mountPath: '/work' });
        volumes.push({ name: 'work', emptyDir: {} });
        workEnv = [{ name: 'WORKDIR', value: '/work' }];
      } else if (mount === 'group') {
        if (!spec.groupFolder) {
          throw new Error(
            'groupFolder must be set for a group-mounted tool (refusing to mount the group PVC root)',
          );
        }
        assertGroupMountAllowed(toolSpec.image); // throws if not allowlisted
        userMounts.push({
          name: 'work',
          mountPath: '/work',
          subPath: spec.groupFolder,
          readOnly: toolSpec.mountReadOnly ?? false,
        });
        volumes.push({
          name: 'work',
          persistentVolumeClaim: {
            claimName: spec.groupsPvc ?? 'kubeclaw-groups',
          },
        });
        workEnv = [{ name: 'WORKDIR', value: '/work' }];
      } else {
        workEnv = [{ name: 'WORKDIR', value: '/tmp' }];
      }
    }

    // --- CDP: chromium native sidecar + /dev/shm volume ---
    const cdpInitContainers = isCdpBridge
      ? [
          {
            name: 'chromium',
            image: toolSpec.image,
            imagePullPolicy: toolSpec.pullPolicy ?? 'IfNotPresent',
            ...(toolSpec.command ? { command: toolSpec.command } : {}),
            ports: [{ containerPort: port }],
            readinessProbe: {
              httpGet: { path: '/json/version', port },
              initialDelaySeconds: 2,
              periodSeconds: 2,
              failureThreshold: 15,
            },
            resources: {
              requests: {
                memory: toolSpec.memoryRequest ?? '256Mi',
                cpu: toolSpec.cpuRequest ?? '100m',
              },
              limits: {
                memory: toolSpec.memoryLimit ?? '1Gi',
                cpu: toolSpec.cpuLimit ?? '500m',
              },
            },
            volumeMounts: [{ name: 'dshm', mountPath: '/dev/shm' }],
            restartPolicy: 'Always',
          },
        ]
      : undefined;
    if (isCdpBridge) {
      volumes.push({
        name: 'dshm',
        emptyDir: { medium: 'Memory', sizeLimit: '256Mi' },
      });
    }

    const userEnv: { name: string; value: string }[] = [
      { name: 'PORT', value: String(port) },
      ...(isFileBridge && toolSpec.run
        ? [{ name: 'KUBECLAW_TOOL_RUN', value: toolSpec.run }, ...workEnv]
        : []),
    ];

    // --- Credential injection (gated on the tool declaring credentials) ---
    const injectionMode = getInjectionMode();
    const auditOnly = getAuditOnly();
    const wantsCreds =
      (toolSpec.credentials?.length ?? 0) > 0 && injectionMode !== 'off';
    const credEnv: { name: string; value: string }[] = [];
    const credContainers: unknown[] = [];
    const credVolumes: unknown[] = [];
    let credServiceAccount: string | undefined;
    let credAnnotations: Record<string, string> | undefined;
    if (wantsCreds) {
      // SA is set whenever injection is active (mirrors generateJobManifest: mode!=='off' → kubeclaw-tool-job).
      credServiceAccount = 'kubeclaw-tool-job';
      // auditOnly observes egress without injecting: skip the placeholder envs + owner-group annotation.
      if (!auditOnly) {
        const ids = new Set(toolSpec.credentials);
        const entries = (this.catalog?.getCatalog() ?? []).filter((e) =>
          ids.has(e.id),
        );
        if ((toolSpec.credentials?.length ?? 0) > 0 && entries.length === 0) {
          logger.warn(
            { credentials: toolSpec.credentials },
            'tool declares credentials but no catalog entries matched; no placeholder env injected',
          );
        }
        let groupPlaceholders: Record<string, Record<string, string>> = {};
        if (this.secretManager) {
          try {
            groupPlaceholders = await this.secretManager.getGroupPlaceholders(
              spec.groupFolder,
            );
          } catch (err) {
            logger.warn(
              { err },
              'getGroupPlaceholders failed for sidecar tool pod; using empty',
            );
          }
        }
        const { envs } = buildCatalogEnvs(entries, groupPlaceholders);
        credEnv.push(...envs);
        credAnnotations = { 'kubeclaw.io/owner-group': spec.groupFolder };
      }
      if (injectionMode === 'sidecar') {
        credEnv.push(
          ...workloadEnvForSidecar({ port: CREDENTIAL_SIDECAR_PORT }),
        );
        credContainers.push(
          sidecarContainerSpec({
            image: CREDENTIAL_SIDECAR_IMAGE,
            port: CREDENTIAL_SIDECAR_PORT,
          }),
        );
        credVolumes.push(...sidecarVolumes());
      }
    }

    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          app: 'kubeclaw-sidecar-tool',
          'kubeclaw/group': spec.groupFolder,
          'kubeclaw/tool': spec.toolName,
          'kubeclaw/agent-job': spec.agentJobId,
        },
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS_AFTER_FINISHED,
        activeDeadlineSeconds: timeoutSeconds,
        backoffLimit: 0,
        template: {
          metadata: {
            labels: { app: 'kubeclaw-sidecar-tool' },
            ...(credAnnotations && { annotations: credAnnotations }),
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: credServiceAccount ?? '',
            ...(credServiceAccount
              ? { automountServiceAccountToken: false }
              : {}),
            // hardenedPodSecurityContext() sets runAsNonRoot, runAsUser 65534,
            // fsGroup 2000 (so emptyDir /shared is group-owned by GID 2000 and
            // both containers get GID 2000 as a supplementary group — without this
            // whichever container creates /shared/req first owns it exclusively and
            // the other UID gets EACCES on rename()), fsGroupChangePolicy:
            // OnRootMismatch (avoids recursive chown on every pod start, preventing
            // chowning the group PVC for bash_persist), and seccompProfile:RuntimeDefault.
            securityContext: hardenedPodSecurityContext(),
            ...(cdpInitContainers && { initContainers: cdpInitContainers }),
            containers: [
              {
                name: 'kubeclaw-tool-bridge',
                image: getContainerImage('openai'),
                imagePullPolicy: 'IfNotPresent',
                command: ['node', '/app/dist/tool-server.js'],
                env: bridgeEnv,
                volumeMounts: bridgeMounts,
                resources: {
                  requests: { memory: '64Mi', cpu: '50m' },
                  limits: { memory: '128Mi', cpu: '200m' },
                },
              } as any,
              ...(isCdpBridge
                ? []
                : [
                    {
                      name: 'user-tool',
                      image: toolSpec.image,
                      imagePullPolicy: toolSpec.pullPolicy ?? 'IfNotPresent',
                      ...(isFileBridge && toolSpec.run
                        ? { command: ['/bin/sh', '/kubeclaw/tool-wrapper.sh'] }
                        : toolSpec.command
                          ? { command: toolSpec.command }
                          : {}),
                      env: [...userEnv, ...credEnv],
                      volumeMounts: userMounts,
                      securityContext: hardenedContainerSecurityContext(),
                      resources: {
                        requests: {
                          memory:
                            toolSpec.memoryRequest ?? TOOL_JOB_MEMORY_REQUEST,
                          cpu: toolSpec.cpuRequest ?? TOOL_JOB_CPU_REQUEST,
                        },
                        limits: {
                          memory: toolSpec.memoryLimit ?? TOOL_JOB_MEMORY_LIMIT,
                          cpu: toolSpec.cpuLimit ?? TOOL_JOB_CPU_LIMIT,
                        },
                      },
                    } as any,
                  ]),
              ...credContainers,
            ],
            volumes: [...volumes, ...credVolumes],
          },
        },
      },
    };

    return { job, jobName, toolMode };
  }

  /**
   * Create a sidecar tool pod job: two-container K8s job with a tool-bridge
   * container (tool-server in http-bridge or file-bridge mode) and the user's
   * custom tool container sharing localhost (http) or an emptyDir (file).
   * Returns the K8s job name.
   */
  async createSidecarToolPodJob(spec: SidecarToolPodJobSpec): Promise<string> {
    const { job, jobName, toolMode } =
      await this.buildSidecarToolPodManifest(spec);

    const createdJob = await this.batchApi.createNamespacedJob({
      namespace: this.namespace,
      body: job,
    });
    logger.info(
      {
        jobName,
        toolName: spec.toolName,
        toolMode,
        agentJobId: spec.agentJobId,
      },
      'Sidecar tool pod job created',
    );

    const createdJobName = createdJob.metadata?.name ?? jobName;
    const createdJobUid = createdJob.metadata?.uid;

    await this.egressApplier.applyForJob({
      jobName,
      jobLabel: spec.agentJobId,
      namespace: this.namespace,
      allowedEgress: spec.toolSpec.allowedEgress ?? [],
      ...(createdJobUid && {
        ownerRef: { name: createdJobName, uid: createdJobUid },
      }),
    });

    return jobName;
  }

  /**
   * Test-only: build the sidecar pod manifest and invoke the injected
   * egressApplier without submitting the job to Kubernetes.
   * Set `runner.egressApplier` to a spy before calling.
   */
  async buildSidecarToolPodJobForTest(
    spec: SidecarToolPodJobSpec,
  ): Promise<V1Job> {
    const { job, jobName } = await this.buildSidecarToolPodManifest(spec);

    await this.egressApplier.applyForJob({
      jobName,
      jobLabel: spec.agentJobId,
      namespace: this.namespace,
      allowedEgress: spec.toolSpec.allowedEgress ?? [],
    });

    return job;
  }

  /**
   * Run a one-shot sandboxed probe job for the given ToolSpec.
   *
   * Reuses createSidecarToolPodJob (→ buildSidecarToolPodManifest) to get:
   *   - Phase-2 hardened securityContexts (always applied by the manifest builder)
   *   - No credential sidecar (gated on toolSpec.credentials; caller must strip them)
   *   - Per-pod egress policy derived from toolSpec.allowedEgress (default-deny otherwise)
   *
   * Input is published to the bridge's Redis toolcalls stream BEFORE the job
   * starts so the bridge picks it up with lastId='0-0' on first XREAD.
   * Result is read back from the toolresults stream.
   *
   * egressViolation is detected best-effort: if the bridge returns an error
   * message containing kernel-level denial keywords (ECONNREFUSED, EHOSTUNREACH,
   * etc.) we surface it as egressViolation=true.  A live hard-substrate signal
   * (NetworkPolicy deny) manifests exactly this way at the pod's syscall layer.
   * Definitive verification is covered by the Task 10 e2e test.
   */
  async runProbeToolJob(args: {
    toolSpec: ToolSpec;
    input: Record<string, string>;
    timeoutMs: number;
  }): Promise<{
    ok: boolean;
    output?: string;
    egressViolation?: boolean;
    error?: string;
  }> {
    const { toolSpec, input, timeoutMs } = args;
    // Hard guarantee at the SEAM: a probe pod must NEVER receive credentials,
    // even if a future caller bypasses probeTool (which also strips them). The
    // credential-injection gate keys off toolSpec.credentials, so stripping it
    // here forces wantsCreds=false and no credential sidecar downstream.
    const strippedSpec: ToolSpec = { ...toolSpec, credentials: undefined };
    // Unique IDs for this probe run
    const probeJobId = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const requestId = crypto.randomUUID();

    const callsStream = getToolCallsStream(probeJobId, strippedSpec.name);
    const resultsStream = getToolResultsStream(probeJobId, strippedSpec.name);
    const redis = getRedisClient();

    // Write tool call BEFORE creating the job so the bridge picks it up with
    // lastId='0-0' on startup — matches the pattern in direct-llm-runner.ts.
    await redis.xadd(
      callsStream,
      '*',
      'requestId',
      requestId,
      'tool',
      strippedSpec.name,
      'input',
      JSON.stringify(input),
    );

    // Create job via existing plumbing.  The stripped spec has no credentials so
    // the credential-injection gate (wantsCreds) stays false and no sidecar is attached.
    let jobName: string;
    try {
      jobName = await this.createSidecarToolPodJob({
        agentJobId: probeJobId,
        groupFolder: 'probe',
        toolName: strippedSpec.name,
        toolSpec: strippedSpec,
        timeout: timeoutMs,
      });
    } catch (err) {
      return { ok: false, error: `probe job creation failed: ${String(err)}` };
    }

    logger.info({ jobName, toolName: strippedSpec.name }, 'probe job created');

    // Wait for the tool result on the Redis results stream.
    const deadline = Date.now() + timeoutMs;
    let lastId = '0-0';

    while (Date.now() < deadline) {
      const blockMs = Math.min(deadline - Date.now(), 5_000);
      if (blockMs <= 0) break;
      try {
        const response = await redis.xread(
          'COUNT',
          10,
          'BLOCK',
          blockMs,
          'STREAMS',
          resultsStream,
          lastId,
        );
        if (!response) continue;

        for (const [, messages] of response as [
          string,
          [string, string[]][],
        ][]) {
          for (const [msgId, fields] of messages) {
            lastId = msgId;
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2)
              obj[fields[i]] = fields[i + 1];
            if (obj['requestId'] !== requestId) continue;

            if (obj['error']) {
              const egressViolation = isEgressViolation(obj['error'])
                ? true
                : undefined;
              return { ok: false, egressViolation, error: obj['error'] };
            }
            return { ok: true, output: obj['result'] ?? '' };
          }
        }
      } catch (err) {
        logger.warn(
          { err, jobName },
          'probe: error reading tool results stream',
        );
      }
    }

    // Timed out waiting for result — try pod logs for a best-effort egress signal.
    try {
      const logs = await this.getJobLogs(jobName);
      const egressViolation = isEgressViolation(logs) ? true : undefined;
      return { ok: false, egressViolation, error: 'probe timed out' };
    } catch {
      return { ok: false, error: 'probe timed out' };
    }
  }

  /**
   * Delete a Deployment by name.
   */
  async deleteDeployment(name: string, namespace?: string): Promise<void> {
    const ns = namespace || this.namespace;
    try {
      await this.appsApi.deleteNamespacedDeployment({ name, namespace: ns });
      logger.info(
        { kind: 'Deployment', name, namespace: ns },
        'Deleted K8s resource',
      );
    } catch (err: unknown) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status === 404) {
        logger.debug(
          { kind: 'Deployment', name },
          'Resource not found, nothing to delete',
        );
      } else {
        throw err;
      }
    }
  }

  /**
   * Delete a Service by name.
   */
  async deleteService(name: string, namespace?: string): Promise<void> {
    const ns = namespace || this.namespace;
    try {
      await this.coreApi.deleteNamespacedService({ name, namespace: ns });
      logger.info(
        { kind: 'Service', name, namespace: ns },
        'Deleted K8s resource',
      );
    } catch (err: unknown) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status === 404) {
        logger.debug(
          { kind: 'Service', name },
          'Resource not found, nothing to delete',
        );
      } else {
        throw err;
      }
    }
  }

  /**
   * Delete a PersistentVolumeClaim by name.
   */
  async deletePersistentVolumeClaim(
    name: string,
    namespace?: string,
  ): Promise<void> {
    const ns = namespace || this.namespace;
    try {
      await this.coreApi.deleteNamespacedPersistentVolumeClaim({
        name,
        namespace: ns,
      });
      logger.info(
        { kind: 'PersistentVolumeClaim', name, namespace: ns },
        'Deleted K8s resource',
      );
    } catch (err: unknown) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status === 404) {
        logger.debug(
          { kind: 'PersistentVolumeClaim', name },
          'Resource not found, nothing to delete',
        );
      } else {
        throw err;
      }
    }
  }
}

// Export singleton instance
export const jobRunner = new JobRunner();
