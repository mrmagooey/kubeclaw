/**
 * Kubernetes Job Runner for KubeClaw
 * Creates and manages Kubernetes Jobs for tool job execution
 */
import {
  V1Job,
  CoreV1Api,
  BatchV1Api,
  AppsV1Api,
  KubeConfig,
  loadAllYaml,
} from '@kubernetes/client-node';

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
  REDIS_AGENT_PASSWORD,
  REDIS_TOOL_SERVER_PASSWORD,
  REDIS_ADAPTER_PASSWORD,
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
  ToolPodJobSpec,
  SidecarToolPodJobSpec,
  RawAttachment,
} from './types.js';
import type { CatalogEntry } from '../credential-broker/resolver.js';
import { ContainerOutput } from '../runtime/types.js';
import {
  getRedisSubscriber,
  getOutputChannel,
  closeRedisConnections,
} from './redis-client.js';

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
 * Credential env-var names the chart manages. In mode=sidecar these are
 * stripped (the per-pod Envoy adds Authorization on every request via
 * ext_authz); in mode=istio (auditOnly=false) they are SUBSTITUTED with
 * a placeholder so SDKs that enforce client-side key presence still
 * construct, with the real credential added by the gateway's ext_authz
 * response on each request.
 */
const STRIPPED_WHEN_INJECTED = new Set([
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'VOYAGE_API_KEY',
]);

/**
 * In mode=istio, API key envs are replaced with this literal string instead of
 * being stripped.  SDKs like the OpenAI client enforce client-side key presence
 * and throw at construction if the env is absent.  The gateway's ext_authz
 * response overwrites the Authorization header on every request, so this
 * placeholder never leaves the cluster.
 */
const ISTIO_API_KEY_PLACEHOLDER = 'injected-by-broker';

/**
 * Provider BASE_URL envs that must point at the http:// (non-TLS) hostname so
 * traffic routes through the Istio egress gateway rather than being sent
 * directly over TLS (which would bypass the gateway's ext_authz filter).
 */
const ISTIO_BASE_URLS: Record<string, string> = {
  OPENAI_BASE_URL: 'http://api.openai.com',
  ANTHROPIC_BASE_URL: 'http://api.anthropic.com',
  OPENROUTER_BASE_URL: 'http://openrouter.ai',
};

/**
 * Substitute credential envs for mode=istio workloads.
 *
 * - API key envs: replaced with the literal placeholder string so SDK
 *   constructors are satisfied, but the gateway overwrites the header before
 *   the request reaches the upstream provider.
 * - BASE_URL envs: replaced with http:// literals so the SDK targets the
 *   egress gateway listener (which expects plain HTTP from the sidecar).
 */
function applyIstioModeEnvSubstitution(
  env: Array<{ name: string; value?: string; valueFrom?: object }>,
): Array<{ name: string; value?: string; valueFrom?: object }> {
  return env.map((e) => {
    if (STRIPPED_WHEN_INJECTED.has(e.name) && e.valueFrom) {
      return { name: e.name, value: ISTIO_API_KEY_PLACEHOLDER };
    }
    if (e.name in ISTIO_BASE_URLS) {
      return { name: e.name, value: ISTIO_BASE_URLS[e.name] };
    }
    return e;
  });
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
        // Unregistered + no fallback — fail-closed literal
        value = ISTIO_API_KEY_PLACEHOLDER;
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
  private namespace: string;
  private activeSubscriptions: Map<string, () => void>;
  private catalog?: CatalogInformer;
  private secretManager?: SecretManager;

  constructor(opts: JobRunnerOpts = {}) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.batchApi = kc.makeApiClient(BatchV1Api);
    this.appsApi = kc.makeApiClient(AppsV1Api);
    this.namespace = NAMESPACE;
    this.activeSubscriptions = new Map();
    this.catalog = opts.catalog;
    this.secretManager = opts.secretManager;
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

      return {
        status: 'success',
        result: null,
        newSessionId: capturedSessionId,
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
        groupPlaceholders = await this.secretManager.getGroupPlaceholders(group.folder);
      } catch (err) {
        logger.warn({ err, group: group.folder }, 'getGroupPlaceholders failed; omitting catalog envs');
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
      // Claude-specific credentials (only injected when provider is claude)
      ...(spec.provider === 'claude'
        ? [
            {
              name: 'CLAUDE_CODE_OAUTH_TOKEN',
              valueFrom: {
                secretKeyRef: {
                  name: 'kubeclaw-secrets',
                  key: 'claude-code-oauth-token',
                  optional: true,
                },
              },
            },
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
              name: 'ANTHROPIC_AUTH_TOKEN',
              valueFrom: {
                secretKeyRef: {
                  name: 'kubeclaw-secrets',
                  key: 'anthropic-auth-token',
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

    // Claude SDK stores session state in /home/node/.claude — only mount for claude provider
    if (spec.provider === 'claude') {
      volumeMounts.push({
        name: 'sessions-pvc',
        mountPath: '/home/node/.claude',
        subPath: `${spec.groupFolder}/.claude`,
      });
    }

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

    // Add browser WebSocket endpoint to agent env when sidecar is enabled
    if (spec.browserSidecar) {
      envVars.push({
        name: 'PLAYWRIGHT_BROWSER_WS_ENDPOINT',
        value: `ws://localhost:${BROWSER_SIDECAR_PORT}`,
      });
    }

    // Credential injection env transformation.
    // - sidecar mode: strip API key envs entirely; add HTTPS_PROXY to route
    //   traffic through the per-pod Envoy sidecar.  In audit-only mode the
    //   keys are kept but HTTPS_PROXY is still set so the broker can observe.
    // - istio mode: substitute API key envs with a literal placeholder string
    //   (so SDK constructors don't throw) and set provider BASE_URL envs to
    //   http:// hostnames (so the SDK targets the egress gateway listener).
    //   The gateway's ext_authz response overwrites Authorization on every
    //   request, so the placeholder never reaches the upstream provider.
    //   In audit-only mode no substitution is performed.
    //
    // When catalog entries are present (operator has a catalog configured),
    // catalog-driven env substitution replaces hard-coded per-built-in logic.
    const injectionMode = getInjectionMode();
    const auditOnly = getAuditOnly();

    // Catalog-driven env injection: applies when spec.catalogEntries is present and
    // injection is active (any mode != off) and not in audit-only mode.
    // Catalog entries whose envVar names overlap with hard-coded built-ins take precedence.
    let baseEnvVars = envVars;
    if (spec.catalogEntries && spec.catalogEntries.length > 0 && injectionMode !== 'off' && !auditOnly) {
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
    if (injectionMode === 'istio' && !auditOnly) {
      finalEnv = applyIstioModeEnvSubstitution(baseEnvVars);
    } else if (injectionMode === 'sidecar' && !auditOnly) {
      finalEnv = [
        ...baseEnvVars.filter((e) => !STRIPPED_WHEN_INJECTED.has(e.name)),
        ...workloadEnvForSidecar({ port: CREDENTIAL_SIDECAR_PORT }),
      ];
    } else if (injectionMode === 'sidecar') {
      // auditOnly=true: keep keys, but still add HTTPS_PROXY for broker observation
      finalEnv = [
        ...baseEnvVars,
        ...workloadEnvForSidecar({ port: CREDENTIAL_SIDECAR_PORT }),
      ];
    } else {
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
            ...(podTemplateAnnotations && { annotations: podTemplateAnnotations }),
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
   * Create a tool pod job (execution or browser category)
   * Returns the K8s job name as podJobId
   */
  async createToolPodJob(spec: ToolPodJobSpec): Promise<string> {
    const jobName = buildJobName(`${spec.groupFolder}-${spec.category}`);
    const timeoutSeconds = Math.floor(spec.timeout / 1000);

    const envVars: Array<{ name: string; value?: string; valueFrom?: object }> =
      [
        { name: 'TZ', value: TIMEZONE },
        { name: 'KUBECLAW_TOOL_JOB_ID', value: spec.agentJobId },
        { name: 'KUBECLAW_CATEGORY', value: spec.category },
        { name: 'KUBECLAW_GROUP_FOLDER', value: spec.groupFolder },
        // Tool server pods authenticate as the 'tool-server' ACL user.
        {
          name: 'REDIS_URL',
          value: buildRedisUrl(
            process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
            'tool-server',
            REDIS_TOOL_SERVER_PASSWORD || process.env.REDIS_ADMIN_PASSWORD,
          ),
        },
        { name: 'IDLE_TIMEOUT', value: String(spec.timeout) },
      ];

    const volumeMounts: Array<{
      name: string;
      mountPath: string;
      subPath?: string;
    }> = [];
    const volumes: Array<any> = [];

    if (spec.category === 'execution') {
      volumeMounts.push({
        name: 'groups-pvc',
        mountPath: '/workspace/group',
        subPath: spec.groupFolder,
      });
      volumes.push(
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
      );
    }

    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          app: 'kubeclaw-tool-pod',
          'kubeclaw/group': spec.groupFolder,
          'kubeclaw/category': spec.category,
          'kubeclaw/agent-job': spec.agentJobId,
        },
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS_AFTER_FINISHED,
        activeDeadlineSeconds: timeoutSeconds,
        backoffLimit: 0,
        template: {
          metadata: { labels: { app: 'kubeclaw-tool-pod' } },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'tool-server',
                image: getContainerImage((spec.provider as any) || 'openai'),
                imagePullPolicy: 'IfNotPresent',
                command: ['node', '/app/dist/tool-server.js'],
                env: envVars,
                volumeMounts,
                resources: {
                  requests: {
                    memory: TOOL_JOB_MEMORY_REQUEST,
                    cpu: TOOL_JOB_CPU_REQUEST,
                  },
                  limits: {
                    memory: TOOL_JOB_MEMORY_LIMIT,
                    cpu: TOOL_JOB_CPU_LIMIT,
                  },
                },
              } as any,
            ],
            volumes,
          },
        },
      },
    };

    await this.batchApi.createNamespacedJob({
      namespace: this.namespace,
      body: job,
    });
    logger.info(
      { jobName, category: spec.category, agentJobId: spec.agentJobId },
      'Tool pod job created',
    );
    return jobName;
  }

  /**
   * Create a sidecar tool pod job: two-container K8s job with a tool-bridge
   * container (tool-server in http-bridge or file-bridge mode) and the user's
   * custom tool container sharing localhost (http) or an emptyDir (file).
   * Returns the K8s job name.
   */
  async createSidecarToolPodJob(spec: SidecarToolPodJobSpec): Promise<string> {
    const { toolSpec } = spec;
    assertToolImageAllowed(toolSpec.image);
    const port = toolSpec.port ?? 8080;
    const isFileBridge = toolSpec.pattern === 'file';
    const isAcpBridge = toolSpec.pattern === 'acp';
    const toolMode = isFileBridge
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

    const timeoutSeconds = Math.floor(spec.timeout / 1000);
    // Sidecar tool pods use the 'tool-server' ACL user, which has XREAD on
    // kubeclaw:toolcalls:* and XADD on kubeclaw:toolresults:* — the two
    // operations the bridge performs.  The 'adapter' user (previously used
    // here) only has read-only access to kubeclaw:input:* and cannot read
    // toolcalls or write toolresults, causing the bridge to fail silently.
    const redisUrl = buildRedisUrl(
      process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
      'tool-server',
      REDIS_TOOL_SERVER_PASSWORD || process.env.REDIS_ADMIN_PASSWORD,
    );

    const bridgeEnv = [
      { name: 'TZ', value: TIMEZONE },
      { name: 'KUBECLAW_TOOL_JOB_ID', value: spec.agentJobId },
      { name: 'KUBECLAW_CATEGORY', value: spec.toolName },
      { name: 'KUBECLAW_GROUP_FOLDER', value: spec.groupFolder },
      { name: 'KUBECLAW_TOOL_MODE', value: toolMode },
      { name: 'KUBECLAW_TOOL_PORT', value: String(port) },
      { name: 'IDLE_TIMEOUT', value: String(spec.timeout) },
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

    const userEnv = [{ name: 'PORT', value: String(port) }];

    const volumeMounts: Array<{ name: string; mountPath: string }> = [];
    const volumes: Array<any> = [];

    if (isFileBridge) {
      volumeMounts.push({ name: 'shared', mountPath: '/shared' });
      volumes.push({ name: 'shared', emptyDir: {} });
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
          metadata: { labels: { app: 'kubeclaw-sidecar-tool' } },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'kubeclaw-tool-bridge',
                image: getContainerImage('openai'),
                imagePullPolicy: 'IfNotPresent',
                command: ['node', '/app/dist/tool-server.js'],
                env: bridgeEnv,
                volumeMounts,
                resources: {
                  requests: { memory: '64Mi', cpu: '50m' },
                  limits: { memory: '128Mi', cpu: '200m' },
                },
              } as any,
              {
                name: 'user-tool',
                image: toolSpec.image,
                imagePullPolicy: toolSpec.pullPolicy ?? 'IfNotPresent',
                ...(toolSpec.command ? { command: toolSpec.command } : {}),
                env: userEnv,
                volumeMounts,
                resources: {
                  requests: {
                    memory: toolSpec.memoryRequest ?? TOOL_JOB_MEMORY_REQUEST,
                    cpu: toolSpec.cpuRequest ?? TOOL_JOB_CPU_REQUEST,
                  },
                  limits: {
                    memory: toolSpec.memoryLimit ?? TOOL_JOB_MEMORY_LIMIT,
                    cpu: toolSpec.cpuLimit ?? TOOL_JOB_CPU_LIMIT,
                  },
                },
              } as any,
            ],
            volumes,
          },
        },
      },
    };

    await this.batchApi.createNamespacedJob({
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
    return jobName;
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
