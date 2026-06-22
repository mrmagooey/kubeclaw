/**
 * Orchestrator-side handler for `commit_channel_config` IPC message (Story 174).
 *
 * When the bootstrap pod finishes gathering credentials and running `npm ci`,
 * it calls `commit_channel_config` over Redis. This module handles that call:
 *   1. Gets the expected manifest hash from the ConfigMap
 *   2. Independently reads package.json + package-lock.json from the runtime PVC
 *      via the inspector sidecar (Story 176 — TOCTOU defense)
 *   3. Computes the actual hash and hard-rejects on mismatch (MANIFEST_DIVERGENCE)
 *   4. On match: creates the credentials Secret and steady-state channel Deployment
 *   5. Replies to the bootstrap pod
 *   6. Notifies the admin via SSE
 *   7. Releases the instance name from activeBootstraps
 */

import type {
  V1Deployment,
  V1Service,
  V1NetworkPolicy,
} from '@kubernetes/client-node';
import type { SidecarSpec } from '../skills/orchestrator/channel-manifest-registry.js';
import { logger } from '../logger.js';
import { computeManifestHash, nextRuntimePvcName } from './bootstrap-runner.js';

// ─── Story 182: replica cap helper ────────────────────────────────────────────

/**
 * Determine the replica count for the steady-state channel Deployment.
 *
 * Story 182 rules:
 *   - If accessModes does NOT include ReadWriteMany → always 1 (RWO cap)
 *   - If accessModes includes ReadWriteMany → use BOOTSTRAP_STEADY_STATE_REPLICAS
 *     (parsed as integer, minimum 1, default 1)
 *
 * Both env vars are injected by the Helm chart via the orchestrator Deployment's
 * env block (orchestrator.yaml, Story 182).
 */
export function resolveSteadyStateReplicas(): number {
  const accessModesRaw = process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES ?? '';
  const isRwx = accessModesRaw
    .split(',')
    .map((s) => s.trim())
    .includes('ReadWriteMany');
  if (!isRwx) return 1;

  const replicasRaw = process.env.BOOTSTRAP_STEADY_STATE_REPLICAS;
  const replicas = parseInt(replicasRaw ?? '1', 10);
  return Number.isInteger(replicas) && replicas >= 1 ? replicas : 1;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CommitChannelConfigPayload {
  type: 'commit_channel_config';
  bootstrapJobId: string;
  channel_type: string;
  instance_name: string;
  secret_data: Record<string, string>;
  /**
   * Advisory field only — the agent's self-reported hash after `npm ci`.
   * Story 176: this value is LOGGED but NEVER used for the comparison.
   * The orchestrator independently reads the PVC and compares against
   * the ConfigMap hash, closing the TOCTOU window.
   */
  runtime_pvc_lock_hash?: string;
  /**
   * Story 181 (upgrade path): when present, this payload is for an in-flight
   * upgrade rather than an initial bootstrap. Contains the OLD runtime PVC name
   * (e.g. `kubeclaw-channel-foo-runtime-v1`). The commit path will patch the
   * Deployment and schedule the old PVC for deletion instead of creating a new
   * Deployment.
   */
  upgradeFromPvc?: string;
}

export interface CommitChannelConfigDeps {
  /** Create or update a K8s Secret (creates if not exists, patches if exists) */
  createSecret(name: string, data: Record<string, string>): Promise<void>;
  /** Create or replace a K8s Deployment */
  createDeployment(body: V1Deployment): Promise<void>;
  /** Publish a reply to the bootstrap pod's reply channel */
  publishReply(
    replyChannel: string,
    payload: { ok: boolean; error?: string; code?: string },
  ): Promise<void>;
  /** Publish a message to the admin's SSE stream via Redis */
  publishSse(topic: string, text: string): Promise<void>;
  /** Look up the expected manifest hash for a channel type from the ConfigMap (null if unknown) */
  getManifestHash(channelType: string): Promise<string | null>;
  /** Remove the instance name from the activeBootstraps Map */
  releaseBootstrap(instanceName: string): void;
  /**
   * Story 176: Independently read package.json and package-lock.json from the
   * runtime PVC by exec-ing into the inspector sidecar of the bootstrap Job pod.
   * This is the TOCTOU-closing read — the agent's self-reported hash is never
   * used for the comparison.
   */
  readPvcFiles(instanceName: string): Promise<{
    packageJson: string;
    packageLockJson: string;
  }>;
  /** Delete the bootstrap Job by name (NotFound → return normally) */
  deleteJob(jobName: string): Promise<void>;
  /** Delete the runtime PVC by name (NotFound → return normally) */
  deletePvc(pvcName: string): Promise<void>;
  /** Increment kubeclaw_bootstrap_manifest_mismatch_total{channel_type} (Story 176) */
  recordMismatch(labels: { channel_type: string }): void;
  /**
   * Story 180: Record a terminal bootstrap outcome in bootstrap_history.
   * Optional for backward compatibility with existing tests that don't inject it.
   */
  recordTerminal?(args: {
    instanceName: string;
    bootstrapJobId: string;
    outcome:
      | 'succeeded'
      | 'timed-out'
      | 'manifest-divergence'
      | 'rejected'
      | 'error';
    errorCode?: string;
    errorMessage?: string;
  }): void;
  /**
   * Story 181 (upgrade path): patch the Deployment's runtime volume to newPvcName.
   * Only required when the payload contains `upgradeFromPvc`.
   */
  patchDeployment?(instanceName: string, newPvcName: string): Promise<void>;
  /**
   * Story 181 (upgrade path): wait for the Deployment rollout to complete.
   */
  waitForRollout?(deploymentName: string): Promise<void>;
  /**
   * Story 181 (upgrade path): schedule deletion of the old PVC after the
   * grace period. Called synchronously — implementation uses setTimeout.
   */
  scheduleOldPvcDeletion?(oldPvcName: string): void;
  /**
   * Push the registered channel source files onto the bootstrap pod's /runtime
   * while it is still alive (RW mount). The steady-state pod mounts the same
   * PVC read-only and imports /runtime/channel-entry.js.
   */
  writeChannelSource(instanceName: string, channelType: string): Promise<void>;
  /** Read the channel manifest's hostMode (default 'standalone'). */
  getChannelHostMode(channelType: string): Promise<'standalone' | 'channel-runner'>;
  /**
   * Image for channel-runner-mode pods. channel-runner.js (the resident host)
   * lives in the ORCHESTRATOR image (WORKDIR /app), not the agent image
   * (channelBaseImage, WORKDIR /workspace/group, which has only channel-loader.js).
   * Standalone echo channels keep channelBaseImage.
   */
  getChannelRunnerImage(): Promise<string>;
  /** Create a PVC (idempotent; NotFound-create, AlreadyExists-ignore). */
  createPvc(name: string, sizeGi: number): Promise<void>;
  /**
   * Return the HTTP port for a channel-runner-mode channel type (from the
   * kubeclaw-channel-manifests ConfigMap `.httpPort` field), or null when the
   * channel has no HTTP port (e.g. IRC) or the manifest is absent.
   */
  getChannelHttpPort(channelType: string): Promise<number | null>;
  /**
   * Return the sidecar spec for a channel-runner-mode channel type (from the
   * kubeclaw-channel-manifests ConfigMap `.sidecar` field), or undefined when
   * the channel has no sidecar or the manifest is absent.
   */
  getChannelSidecar(channelType: string): Promise<SidecarSpec | undefined>;
  /** Create or replace a K8s Service (idempotent; AlreadyExists → replace). */
  createService(body: V1Service): Promise<void>;
  /** Create or replace a K8s NetworkPolicy (idempotent; AlreadyExists → replace). */
  createNetworkPolicy(body: V1NetworkPolicy): Promise<void>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Process a `commit_channel_config` payload received from a bootstrap pod.
 *
 * Story 176 adds independent PVC hash verification:
 *   - Reads package.json + package-lock.json from the runtime PVC via the
 *     inspector sidecar (kubectl exec).
 *   - Computes sha256(canonical(pkg) + '\n' + canonical(lock)).
 *   - Hard-rejects with MANIFEST_DIVERGENCE if the independently computed hash
 *     does not match the ConfigMap's expected hash.
 *   - The agent's runtime_pvc_lock_hash is logged as advisory only; it is never
 *     used for the comparison (TOCTOU defense).
 */
export async function processCommitChannelConfig(
  payload: CommitChannelConfigPayload,
  deps: CommitChannelConfigDeps,
  namespace: string,
  channelBaseImage: string,
): Promise<void | { ok: false; code: string; error?: string }> {
  const {
    bootstrapJobId,
    channel_type,
    instance_name,
    secret_data,
    runtime_pvc_lock_hash,
  } = payload;

  if (!bootstrapJobId || !channel_type || !instance_name || !secret_data) {
    logger.error({ payload }, 'commit_channel_config: missing required fields');
    if (bootstrapJobId) {
      await deps
        .publishReply(`kubeclaw:bootstrap-reply:${bootstrapJobId}`, {
          ok: false,
          error: 'Missing required fields in commit_channel_config payload',
        })
        .catch(() => {});
    }
    return;
  }

  const secretName = `kubeclaw-channel-${instance_name}-credentials`;
  const deploymentName = `kubeclaw-channel-${instance_name}`;
  const pvcName = `kubeclaw-channel-${instance_name}-runtime`;
  // For upgrade path, the bootstrap Job uses a versioned PVC (the new one).
  // On MANIFEST_DIVERGENCE we must delete the Job's PVC, not the base-name PVC.
  const jobPvcName = payload.upgradeFromPvc
    ? nextRuntimePvcName(payload.upgradeFromPvc)
    : pvcName;
  const jobName = payload.upgradeFromPvc
    ? `kubeclaw-bootstrap-${instance_name}-upgrade`
    : `kubeclaw-bootstrap-${instance_name}`;
  const replyChannel = `kubeclaw:bootstrap-reply:${bootstrapJobId}`;
  const sseTopic = `kubeclaw:bootstrap:${bootstrapJobId}`;

  logger.info(
    {
      bootstrapJobId,
      channel_type,
      instance_name,
      advisory_hash: runtime_pvc_lock_hash,
    },
    'commit_channel_config received — runtime_pvc_lock_hash is advisory only; orchestrator reads PVC independently',
  );

  try {
    // ── Step 1: Get expected hash from ConfigMap ──────────────────────────────
    const expectedHash = await deps.getManifestHash(channel_type);

    // ── Step 2: Independently read PVC contents via inspector sidecar ─────────
    // Only perform the check when a manifest hash is registered for this type.
    // If null (no manifest in ConfigMap), skip the check and proceed to happy path.
    if (expectedHash !== null) {
      const { packageJson: actualPkgJson, packageLockJson: actualLockJson } =
        await deps.readPvcFiles(instance_name);

      const actualHash = computeManifestHash(actualPkgJson, actualLockJson);

      logger.info(
        { channel_type, instance_name, expectedHash, actualHash },
        'commit_channel_config: independently computed PVC hash',
      );

      // ── Step 3: Hard-reject on mismatch ────────────────────────────────────
      if (actualHash !== expectedHash) {
        logger.warn(
          { channel_type, instance_name, expectedHash, actualHash },
          'commit_channel_config: MANIFEST_DIVERGENCE — hard-rejecting commit',
        );

        const divergenceError = JSON.stringify({
          code: 'MANIFEST_DIVERGENCE',
          expected_hash: expectedHash,
          actual_hash: actualHash,
          channel_type,
        });

        // (a) Reply to bootstrap pod with structured error
        await deps
          .publishReply(replyChannel, { ok: false, error: divergenceError })
          .catch((e) =>
            logger.warn({ e }, 'Failed to publish MANIFEST_DIVERGENCE reply'),
          );

        // (b) Delete the bootstrap Job's runtime PVC — idempotent (NotFound OK).
        // For upgrades, jobPvcName is the new versioned PVC; for initial bootstrap
        // it is the base-name PVC. The old PVC is never touched on mismatch.
        await deps
          .deletePvc(jobPvcName)
          .catch((e) =>
            logger.warn(
              { e, jobPvcName },
              'Failed to delete PVC on mismatch; continuing',
            ),
          );

        // (c) Terminate the bootstrap Job — idempotent (NotFound OK)
        // For upgrades, jobName is kubeclaw-bootstrap-<instance>-upgrade.
        await deps
          .deleteJob(jobName)
          .catch((e) =>
            logger.warn(
              { e, jobName },
              'Failed to delete Job on mismatch; continuing',
            ),
          );

        // (d) Increment metric
        deps.recordMismatch({ channel_type });

        // (e) Emit SSE message to admin
        const sseText = [
          `Bootstrap rejected: runtime PVC packages don't match the \`${channel_type}\` manifest.`,
          `Expected hash \`${expectedHash}\`, got \`${actualHash}\`.`,
          `No channel was created.`,
        ].join(' ');
        await deps
          .publishSse(sseTopic, sseText)
          .catch((e) => logger.warn({ e }, 'Failed to publish mismatch SSE'));

        // (f) Release instance name so a retry can reuse it (Story 176 AC5)
        deps.releaseBootstrap(instance_name);

        // (f.5) Story 180: record terminal outcome in bootstrap_history
        deps.recordTerminal?.({
          instanceName: instance_name,
          bootstrapJobId,
          outcome: 'manifest-divergence',
          errorCode: 'MANIFEST_DIVERGENCE',
          errorMessage: `Expected ${expectedHash}, got ${actualHash}`,
        });

        // (g) Return early — no Secret or Deployment created
        return;
      }
    }

    // ── Hash matched (or no manifest registered) — proceed with happy path ────

    if (payload.upgradeFromPvc) {
      // ── UPGRADE PATH (Story 181) ─────────────────────────────────────────
      // Patch Deployment to new PVC; wait for rollout; schedule old PVC deletion.
      // Secret is preserved — credentials belong to the instance, not the PVC version.

      const oldPvcName = payload.upgradeFromPvc;

      if (
        !deps.patchDeployment ||
        !deps.waitForRollout ||
        !deps.scheduleOldPvcDeletion
      ) {
        throw new Error(
          'commit_channel_config upgrade path requires patchDeployment, waitForRollout, and scheduleOldPvcDeletion deps',
        );
      }

      await deps.patchDeployment(instance_name, pvcName);
      logger.info(
        { deploymentName, newPvcName: pvcName },
        'Upgrade: Deployment patched to new PVC',
      );

      await deps.waitForRollout(deploymentName);
      logger.info({ deploymentName }, 'Upgrade: rollout complete');

      deps.scheduleOldPvcDeletion(oldPvcName);
      logger.info({ oldPvcName }, 'Upgrade: old PVC deletion scheduled');

      deps.releaseBootstrap(instance_name);

      deps.recordTerminal?.({
        instanceName: instance_name,
        bootstrapJobId,
        outcome: 'succeeded',
      });

      await deps.publishReply(replyChannel, { ok: true });

      await deps.publishSse(
        sseTopic,
        `Channel ${channel_type}/${instance_name} upgraded and ready. Deployment patched to ${pvcName}. Old PVC ${oldPvcName} will be deleted after grace period.`,
      );

      logger.info(
        { deploymentName, bootstrapJobId, channel_type, instance_name },
        'commit_channel_config (upgrade): channel upgraded successfully',
      );
    } else {
      // ── INITIAL BOOTSTRAP PATH (existing, unchanged) ─────────────────────

      // 1. Create credentials Secret
      await deps.createSecret(secretName, secret_data);
      logger.info(
        { secretName, instance_name },
        'Channel credentials Secret created',
      );

      // 2. Deterministically deliver the channel's source onto /runtime while the
      // bootstrap pod is still alive (RW mount). The steady-state pod mounts the
      // same PVC read-only and imports /runtime/channel-entry.js.
      try {
        await deps.writeChannelSource(instance_name, channel_type);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        logger.error(
          { instance_name, channel_type, error },
          'commit_channel_config: channel source push failed',
        );
        await deps
          .publishReply(replyChannel, {
            ok: false,
            code: 'CHANNEL_SOURCE_PUSH_FAILED',
            error,
          })
          .catch((e) =>
            logger.warn(
              { e },
              'Failed to publish CHANNEL_SOURCE_PUSH_FAILED reply',
            ),
          );
        return { ok: false, code: 'CHANNEL_SOURCE_PUSH_FAILED', error };
      }

      // 3a. Determine hostMode and prepare extra PVCs for channel-runner mode
      const hostMode = await deps.getChannelHostMode(channel_type);
      const channelRunnerMode = hostMode === 'channel-runner';
      // HTTP port for channel-runner pods that expose an HTTP endpoint.
      // null means no HTTP exposure (e.g. IRC, standalone echo channels).
      const httpPort = channelRunnerMode
        ? await deps.getChannelHttpPort(channel_type)
        : null;
      // Sidecar aux-backend spec (channel-runner mode only).
      // undefined means no sidecar for this channel type.
      const sidecar = channelRunnerMode
        ? await deps.getChannelSidecar(channel_type)
        : undefined;
      // channel-runner.js lives only in the orchestrator image (WORKDIR /app);
      // the agent image (channelBaseImage) has channel-loader.js for standalone.
      const channelImage = channelRunnerMode
        ? await deps.getChannelRunnerImage()
        : channelBaseImage;

      const extraVolumes: Array<{ name: string; claimName: string; mountPath: string; sizeGi: number }> = channelRunnerMode
        ? [
            { name: 'groups', claimName: `kubeclaw-channel-${instance_name}-groups`, mountPath: '/app/groups', sizeGi: 2 },
            { name: 'store', claimName: `kubeclaw-channel-${instance_name}-store`, mountPath: '/app/store', sizeGi: 1 },
            { name: 'sessions', claimName: `kubeclaw-channel-${instance_name}-sessions`, mountPath: '/data/sessions', sizeGi: 1 },
          ]
        : [];
      for (const v of extraVolumes) await deps.createPvc(v.claimName, v.sizeGi);

      // Session PVC for the sidecar aux-backend (channel-runner mode only).
      // Mounted exclusively on the sidecar container — NOT on the channel container.
      const auxSessionPvcName = `kubeclaw-channel-${instance_name}-auxsession`;
      if (sidecar) {
        await deps.createPvc(auxSessionPvcName, sidecar.sessionStorageGi);
      }

      // channel-runner mode runs the full resident host (dist/channel-runner.js),
      // which needs the same env + catalog mounts that helm-installed channel
      // pods get — Redis ACL auth, the LLM provider config, mode/version, and the
      // specialists/tools catalog ConfigMaps it fs.watches. Without these the host
      // crash-loops (e.g. Redis auth failure) on startup. Standalone channels
      // (echo demos via channel-loader.js) keep the minimal env.
      // channel-runner mode runs the resident host (channel-runner.js), which
      // needs the same env helm-installed channel pods get. CRITICALLY it
      // connects to Redis as the RESTRICTED `channel` ACL identity (~kubeclaw:*,
      // small command allow-list) — NOT the orchestrator's full-admin identity.
      // Secrets are referenced via secretKeyRef (never copied as literals into
      // the Deployment spec). Mirrors helm/kubeclaw/templates/channel-pods.yaml.
      type EnvEntry = {
        name: string;
        value?: string;
        valueFrom?: {
          secretKeyRef: { name: string; key: string; optional?: boolean };
        };
      };
      const passEnv = (k: string): EnvEntry[] =>
        process.env[k] !== undefined ? [{ name: k, value: process.env[k] }] : [];
      const channelRunnerEnv: EnvEntry[] = channelRunnerMode
        ? [
            { name: 'KUBECLAW_MODE', value: 'channel' },
            ...passEnv('KUBECLAW_VERSION'),
            // Restricted Redis ACL identity + channel password (NOT admin).
            { name: 'REDIS_USERNAME', value: 'channel' },
            {
              name: 'REDIS_ADMIN_PASSWORD',
              valueFrom: {
                secretKeyRef: { name: 'kubeclaw-redis', key: 'channel-password' },
              },
            },
            // LLM provider config via secretKeyRef (optional in some modes).
            {
              name: 'OPENAI_API_KEY',
              valueFrom: {
                secretKeyRef: { name: 'kubeclaw-secrets', key: 'openai-api-key', optional: true },
              },
            },
            {
              name: 'OPENAI_BASE_URL',
              valueFrom: {
                secretKeyRef: { name: 'kubeclaw-secrets', key: 'openai-base-url', optional: true },
              },
            },
            {
              name: 'DIRECT_LLM_MODEL',
              valueFrom: {
                secretKeyRef: { name: 'kubeclaw-secrets', key: 'direct-llm-model', optional: true },
              },
            },
            ...passEnv('TOOL_JOBS_PRUNE_INTERVAL_MS'),
            ...passEnv('TOOL_JOBS_RETENTION_DAYS'),
          ]
        : [];
      // Catalog ConfigMaps the resident host mounts + fs.watches. Created by the
      // orchestrator's startup reconcilers, so they always exist in-cluster.
      const channelRunnerConfigVolumes: Array<{
        name: string;
        configMapName: string;
        mountPath: string;
      }> = channelRunnerMode
        ? [
            {
              name: 'specialists-catalog',
              configMapName: 'kubeclaw-specialists',
              mountPath: '/etc/kubeclaw/specialists',
            },
            {
              name: 'tools-catalog',
              configMapName: 'kubeclaw-tools',
              mountPath: '/etc/kubeclaw/tools',
            },
          ]
        : [];

      // 3. Build steady-state Deployment spec

      // API-URL env to inject into the channel container when a sidecar is present
      // and apiUrlEnv is set — wires the channel adapter to the in-pod backend.
      const sidecarApiUrlEnv: Array<{ name: string; value: string }> =
        sidecar?.apiUrlEnv
          ? [{ name: sidecar.apiUrlEnv, value: `http://localhost:${sidecar.port}` }]
          : [];

      // Sidecar container definition (rendered only when sidecar is present).
      const sidecarContainer = sidecar
        ? {
            name: `${channel_type}-backend`,
            image: sidecar.image,
            ports: [{ containerPort: sidecar.port }],
            env: sidecar.env ?? [],
            securityContext: {
              allowPrivilegeEscalation: false,
              // The third-party backend needs a writable root FS for its runtime;
              // durable data lives on the session PVC (auxsession mount).
              readOnlyRootFilesystem: false,
              // runAsNonRoot/runAsUser: opt-in via sidecar.runAsUser.
              // When set, enforce non-root with the given UID.
              // When absent, let the image's own USER directive apply (no forced UID).
              ...(sidecar.runAsUser !== undefined
                ? { runAsUser: sidecar.runAsUser, runAsNonRoot: true }
                : {}),
              capabilities: { drop: ['ALL'] },
              seccompProfile: { type: 'RuntimeDefault' },
            },
            ...(sidecar.healthPath
              ? {
                  readinessProbe: {
                    httpGet: { path: sidecar.healthPath, port: sidecar.port },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    httpGet: { path: sidecar.healthPath, port: sidecar.port },
                    initialDelaySeconds: 15,
                    periodSeconds: 30,
                  },
                }
              : {}),
            volumeMounts: [
              {
                name: 'auxsession',
                mountPath: sidecar.sessionMountPath,
                readOnly: false,
              },
            ],
          }
        : null;

      const deployment: V1Deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: deploymentName,
          namespace,
          labels: {
            app: `kubeclaw-channel-${instance_name}`,
            'kubeclaw/channel': instance_name,
            'kubeclaw.io/role': 'channel',
            'kubeclaw.io/bootstrap-installed': 'true',
          },
        },
        spec: {
          replicas: resolveSteadyStateReplicas(),
          selector: {
            matchLabels: { app: `kubeclaw-channel-${instance_name}` },
          },
          template: {
            metadata: {
              labels: {
                app: `kubeclaw-channel-${instance_name}`,
                'kubeclaw/channel': instance_name,
                'kubeclaw.io/role': 'channel',
              },
            },
            spec: {
              automountServiceAccountToken: false,
              // fsGroup: 1000 makes the session PVC writable by the backend's non-root user.
              // Required only when a sidecar is present; without it signal-cli cannot write
              // its session data to a freshly-provisioned PVC.
              ...(sidecar ? { securityContext: { fsGroup: 1000 } } : {}),
              // No KUBECLAW_SUPERUSER — must be absent from steady-state pod (AC5)
              // No KUBECLAW_BOOTSTRAP_SKILL — must be absent from steady-state pod (AC5)
              containers: [
                {
                  name: 'channel',
                  image: channelImage,
                  imagePullPolicy: 'IfNotPresent',
                  command: channelRunnerMode
                    ? ['node', 'dist/channel-runner.js']
                    : ['node', '/app/channel-loader.js'],
                  env: [
                    { name: 'KUBECLAW_CHANNEL', value: instance_name },
                    { name: 'KUBECLAW_CHANNEL_TYPE', value: channel_type },
                    {
                      name: 'REDIS_URL',
                      value:
                        process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
                    },
                    ...channelRunnerEnv,
                    // Inject backend URL into channel container when sidecar has apiUrlEnv set
                    ...sidecarApiUrlEnv,
                  ],
                  envFrom: [{ secretRef: { name: secretName } }],
                  ...(channelRunnerMode && httpPort != null
                    ? {
                        ports: [
                          { name: 'http', containerPort: httpPort },
                          { name: 'health', containerPort: 9090 },
                        ],
                        livenessProbe: {
                          httpGet: { path: '/liveness', port: 'health' },
                          initialDelaySeconds: 15,
                          periodSeconds: 30,
                          failureThreshold: 3,
                          timeoutSeconds: 5,
                        },
                        readinessProbe: {
                          httpGet: { path: '/readyz', port: 'http' },
                          initialDelaySeconds: 5,
                          periodSeconds: 10,
                          failureThreshold: 3,
                          timeoutSeconds: 5,
                        },
                      }
                    : {}),
                  volumeMounts: [
                    // Runtime PVC mounted READ-ONLY (AC5)
                    { name: 'runtime', mountPath: '/runtime', readOnly: true },
                    // extraVolumes mount on the CHANNEL container only (groups/store/sessions PVCs)
                    ...extraVolumes.map((v) => ({ name: v.name, mountPath: v.mountPath })),
                    ...channelRunnerConfigVolumes.map((v) => ({
                      name: v.name,
                      mountPath: v.mountPath,
                      readOnly: true,
                    })),
                    // NOTE: auxsession is intentionally NOT mounted here — it goes on the sidecar only.
                  ],
                },
                // Sidecar aux-backend container (only when sidecar spec is present)
                ...(sidecarContainer ? [sidecarContainer] : []),
              ],
              volumes: [
                {
                  name: 'runtime',
                  persistentVolumeClaim: {
                    claimName: pvcName,
                    // readOnly flag on PVC spec is advisory; the container-level readOnly
                    // in volumeMounts is the binding enforcement. Both are set for clarity.
                  } as any,
                },
                ...extraVolumes.map((v) => ({ name: v.name, persistentVolumeClaim: { claimName: v.claimName } })),
                ...channelRunnerConfigVolumes.map((v) => ({
                  name: v.name,
                  configMap: { name: v.configMapName },
                })),
                // Sidecar session PVC volume (only when sidecar spec is present)
                ...(sidecar
                  ? [{ name: 'auxsession', persistentVolumeClaim: { claimName: auxSessionPvcName } }]
                  : []),
              ],
            },
          },
        },
      };

      // 4. Create steady-state Deployment
      await deps.createDeployment(deployment);
      logger.info(
        { deploymentName, channelImage, instance_name },
        'Steady-state Deployment created',
      );

      // 4a. When channel-runner mode exposes an HTTP port, create the Service
      // and ingress NetworkPolicy so the port is reachable within the cluster.
      if (channelRunnerMode && httpPort != null) {
        // No metadata.namespace on the Service/NetworkPolicy bodies — the
        // createNamespacedService/NetworkPolicy calls supply the namespace
        // (KUBECLAW_NAMESPACE). Hardcoding it mismatches the request namespace
        // (e.g. kubeclaw-live in e2e) and K8s rejects with HTTP 400. This
        // mirrors the Deployment body, which also omits metadata.namespace.
        await deps.createService({
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: `kubeclaw-channel-${instance_name}`,
            labels: { app: `kubeclaw-channel-${instance_name}` },
          },
          spec: {
            type: 'ClusterIP',
            selector: { app: `kubeclaw-channel-${instance_name}` },
            ports: [
              { name: 'http', port: 80, targetPort: 'http' as any, protocol: 'TCP' },
            ],
          },
        });
        logger.info(
          { instance_name, httpPort },
          'Channel Service created',
        );

        await deps.createNetworkPolicy({
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: {
            name: `kubeclaw-channel-${instance_name}-ingress`,
          },
          spec: {
            podSelector: { matchLabels: { app: `kubeclaw-channel-${instance_name}` } },
            policyTypes: ['Ingress'],
            ingress: [{ _from: [], ports: [{ protocol: 'TCP', port: httpPort as any }] }],
          },
        });
        logger.info(
          { instance_name, httpPort },
          'Channel ingress NetworkPolicy created',
        );
      }

      // 5. Release instance name from active bootstraps
      deps.releaseBootstrap(instance_name);

      // 5.5. Story 180: record terminal outcome in bootstrap_history
      deps.recordTerminal?.({
        instanceName: instance_name,
        bootstrapJobId,
        outcome: 'succeeded',
      });

      // 6. Reply success to bootstrap pod
      await deps.publishReply(replyChannel, { ok: true });

      // 7. Notify admin via SSE
      await deps.publishSse(
        sseTopic,
        `Channel ${channel_type}/${instance_name} ready. Steady-state Deployment "${deploymentName}" created.`,
      );

      logger.info(
        { deploymentName, bootstrapJobId, channel_type, instance_name },
        'commit_channel_config: channel deployed successfully',
      );
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, bootstrapJobId, instance_name },
      'commit_channel_config failed',
    );

    await deps
      .publishReply(replyChannel, { ok: false, error: errorMsg })
      .catch((e) => logger.warn({ e }, 'Failed to publish failure reply'));

    await deps
      .publishSse(sseTopic, `Bootstrap failed: ${errorMsg}`)
      .catch((e) => logger.warn({ e }, 'Failed to publish failure SSE'));

    // Story 180: record terminal outcome in bootstrap_history
    deps.recordTerminal?.({
      instanceName: instance_name,
      bootstrapJobId,
      outcome: 'error',
      errorMessage: errorMsg,
    });
  }
}
