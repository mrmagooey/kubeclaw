/**
 * Bootstrap runner — Stories 174, 175, 180.
 *
 * Responsible for:
 *   - Manifest schema validation (validateChannelManifest)
 *   - Canonical JSON hash computation (computeManifestHash, canonicalJson)
 *   - Spawning bootstrap Jobs + runtime PVCs (bootstrapChannelFromSkill)
 *   - Timeout cleanup (cleanupBootstrapResources, waitForBootstrapJobCompletion)
 *   - Orphan reconciliation on startup (reconcileOrphanedBootstrapsOnStartup)
 *   - Story 180: bootstrap_status tool implementation (bootstrapStatus,
 *     buildActiveEntry, deriveBootstrapState) and bootstrap metadata registry
 *     (registerBootstrapMeta, deregisterBootstrapMeta, getBootstrapMeta)
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { CoreV1Api, BatchV1Api } from '@kubernetes/client-node';
import { logger } from '../logger.js';
import { insertBootstrapAuditRow } from '../skills/orchestrator/bootstrap-audit.js';

// ─── Story 175 constants ──────────────────────────────────────────────────────

/**
 * Grace period (ms) added to BOOTSTRAP_SKILL_TIMEOUT_SECONDS when computing
 * the orchestrator-side poll timeout for waitForBootstrapJobCompletion.
 *
 * Rationale: the K8s Job's activeDeadlineSeconds fires on the K8s side, but
 * the Failed condition may take a few seconds to propagate before the
 * orchestrator's polling loop observes it. 60 s of headroom is ample even
 * under load.  With BOOTSTRAP_SKILL_TIMEOUT_SECONDS=60 (the e2e test override),
 * the orchestrator polls for up to 120 s while the Job deadline fires at 60 s.
 */
const BOOTSTRAP_ORCHESTRATOR_GRACE_MS = 60_000;

// ─── Canonical JSON ───────────────────────────────────────────────────────────

/**
 * Produce a deterministic JSON string with all object keys sorted recursively.
 * Arrays are preserved in their original order.
 * This is the canonical form used for manifest hash computation (see Story 176 notes).
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const rec = obj as Record<string, unknown>;
  const sorted = Object.keys(rec).sort();
  return (
    '{' +
    sorted
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
      .join(',') +
    '}'
  );
}

/**
 * Compute sha256(canonical(packageJsonStr) + '\n' + canonical(packageLockJsonStr)).
 * Matches the algorithm specified in Story 178 notes and used by commit_channel_config.
 */
export function computeManifestHash(
  packageJsonStr: string,
  packageLockJsonStr: string,
): string {
  const canonical =
    canonicalJson(JSON.parse(packageJsonStr)) +
    '\n' +
    canonicalJson(JSON.parse(packageLockJsonStr));
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Story 181: PVC version parsing helpers ───────────────────────────────────

/**
 * Parse the version number from a runtime PVC name.
 *
 * Rules:
 *   - No suffix (e.g. `kubeclaw-channel-foo-runtime`)          → 1
 *   - Suffix `-v1`                                             → 1
 *   - Suffix `-v<N>` where N is a positive integer             → N
 *   - Any other suffix (non-numeric)                           → 1
 */
export function parseRuntimePvcVersion(pvcName: string): number {
  const match = /-v(\d+)$/.exec(pvcName);
  if (!match) return 1;
  const n = parseInt(match[1], 10);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * Given the current runtime PVC name, return the next versioned name.
 *
 * Examples:
 *   `kubeclaw-channel-foo-runtime`    → `kubeclaw-channel-foo-runtime-v2`
 *   `kubeclaw-channel-foo-runtime-v1` → `kubeclaw-channel-foo-runtime-v2`
 *   `kubeclaw-channel-foo-runtime-v7` → `kubeclaw-channel-foo-runtime-v8`
 */
export function nextRuntimePvcName(currentPvcName: string): string {
  const version = parseRuntimePvcVersion(currentPvcName);
  // Strip any existing -vN suffix, then append -v(N+1)
  const base = currentPvcName.replace(/-v\d+$/, '');
  return `${base}-v${version + 1}`;
}

// ─── Manifest validation ──────────────────────────────────────────────────────

export interface ChannelManifest {
  packageJson: string;
  packageLockJson: string;
}

/**
 * Validate a channel manifest before it is used or stored.
 *
 * Rules:
 *   1. No devDependencies in package.json
 *   2. No lifecycle scripts in package.json unless in the allowlist
 *   3. No per-package lifecycle scripts in the lockfile unless in the allowlist
 *
 * @throws Error with a descriptive message on violation
 */
export function validateChannelManifest(
  manifest: ChannelManifest,
  allowedLifecycleScripts: string[] = [],
): void {
  const pkg = JSON.parse(manifest.packageJson) as Record<string, unknown>;

  if (pkg.devDependencies) {
    throw new Error('Manifest must not contain devDependencies');
  }

  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const script of Object.keys(pkg.scripts as Record<string, unknown>)) {
      if (!allowedLifecycleScripts.includes(script)) {
        throw new Error(`package.json scripts not allowed: ${script}`);
      }
    }
  }

  // Check per-package lifecycle scripts in lockfile (npm lockfile v3 schema)
  const lock = JSON.parse(manifest.packageLockJson) as Record<string, unknown>;
  const packages =
    (lock.packages as
      | Record<string, { scripts?: Record<string, string> }>
      | undefined) ?? {};
  for (const [pkgPath, pkgData] of Object.entries(packages)) {
    if (pkgData.scripts) {
      for (const script of Object.keys(pkgData.scripts)) {
        if (!allowedLifecycleScripts.includes(script)) {
          throw new Error(`lifecycle script not allowed: ${pkgPath} ${script}`);
        }
      }
    }
  }
}

// ─── Bootstrap Job spawner ────────────────────────────────────────────────────

export interface BootstrapK8sDeps {
  coreV1: CoreV1Api;
  batchV1: BatchV1Api;
}

export interface BootstrapChannelFromSkillOpts {
  skillName: string;
  channelType: string;
  instanceName: string;
  channelCredentialsHint?: string;
  k8sDeps: BootstrapK8sDeps;
  namespace: string;
  channelBaseImage: string;
  /** In-memory map shared with admin-shell: instanceName → bootstrapJobId */
  activeBootstraps: Map<string, string>;
  /** activeDeadlineSeconds for the bootstrap Job (default: BOOTSTRAP_SKILL_TIMEOUT_SECONDS || 900) */
  timeoutSeconds?: number;
  /** PVC storage size (default: '1Gi') */
  pvcSize?: string;
  // Redis / LLM env vars forwarded into the bootstrap Job
  redisUrl?: string;
  redisUsername?: string;
  redisAdminPassword?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  directLlmModel?: string;
  /**
   * Story 183: optional npm mirror registry URL. When set, the bootstrap Job's
   * container receives NPM_CONFIG_REGISTRY=<url>. When absent, falls back to
   * BOOTSTRAP_NPM_REGISTRY env var on the orchestrator pod (Helm-injected from
   * bootstrap.npmRegistry). When neither is set, no NPM_CONFIG_REGISTRY is injected
   * and npm uses its built-in default registry.
   */
  npmRegistry?: string;
  // Story 184: admin identity + audit hashes for bootstrap_audit start row.
  /** Authenticated admin username; 'anonymous' when no password configured. */
  adminIdentity?: string;
  /** Per-SSE-connection UUID, or null for direct POST /tool without SSE. */
  adminSessionId?: string | null;
  /** sha256 of skill markdown content at job-spawn time. */
  skillContentHash?: string;
  /** Pre-computed manifest hash from ConfigMap for the requested channel_type. */
  manifestHashRequested?: string;
}

export interface BootstrapChannelFromSkillResult {
  bootstrapJobId: string;
  alreadyInProgress?: true;
}

const DEFAULT_TIMEOUT_SECONDS = parseInt(
  process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS || '900',
  10,
);
const DEFAULT_PVC_SIZE = '1Gi';
const BOOTSTRAP_JOB_TTL = parseInt(
  process.env.BOOTSTRAP_JOB_TTL_SECONDS || '3600',
  10,
);

/**
 * Parse the runtime PVC accessModes from the BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES
 * env var (comma-separated). Defaults to ['ReadWriteOnce'] when absent.
 *
 * Story 182: the Helm chart injects this env var into the orchestrator pod via
 * bootstrap.runtimePvc.accessModes values. Both the bootstrap Job and upgrade Job
 * use this to create PVCs with the correct accessModes.
 */
function parseRuntimePvcAccessModes(): string[] {
  const raw = process.env.BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES;
  if (!raw || !raw.trim()) return ['ReadWriteOnce'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Spawn a bootstrap Job and its runtime PVC for a channel instance.
 *
 * - If the instance is already active (present in activeBootstraps), returns
 *   { bootstrapJobId: existing, alreadyInProgress: true } without creating anything.
 * - Otherwise creates:
 *     kubeclaw-channel-<instanceName>-runtime  (PVC, RWO, 1 GiB)
 *     kubeclaw-bootstrap-<instanceName>        (Job)
 *   and registers the instance in activeBootstraps.
 */
export async function bootstrapChannelFromSkill(
  opts: BootstrapChannelFromSkillOpts,
): Promise<BootstrapChannelFromSkillResult> {
  const {
    skillName,
    channelType,
    instanceName,
    k8sDeps,
    namespace,
    channelBaseImage,
    activeBootstraps,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    pvcSize = DEFAULT_PVC_SIZE,
  } = opts;

  // Duplicate guard
  if (activeBootstraps.has(instanceName)) {
    const existing = activeBootstraps.get(instanceName)!;
    logger.warn({ instanceName, existing }, 'bootstrap already in progress');
    return { bootstrapJobId: existing, alreadyInProgress: true };
  }

  const bootstrapJobId = randomUUID();
  const pvcName = `kubeclaw-channel-${instanceName}-runtime`;
  const jobName = `kubeclaw-bootstrap-${instanceName}`;

  // ── Create PVC ──────────────────────────────────────────────────────────────
  try {
    await k8sDeps.coreV1.readNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace,
    });
    logger.info({ pvcName }, 'Runtime PVC already exists, reusing');
  } catch {
    await k8sDeps.coreV1.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: pvcName,
          namespace,
          labels: {
            'kubeclaw-channel': instanceName,
            'kubeclaw.io/role': 'channel-runtime',
          },
        },
        spec: {
          accessModes: parseRuntimePvcAccessModes(),
          resources: { requests: { storage: pvcSize } },
        },
      },
    });
    logger.info({ pvcName, pvcSize }, 'Created runtime PVC for bootstrap');
  }

  // ── Build env vars ──────────────────────────────────────────────────────────
  const envVars: Array<{ name: string; value: string }> = [
    { name: 'KUBECLAW_SUPERUSER', value: 'true' },
    { name: 'KUBECLAW_BOOTSTRAP_SKILL', value: skillName },
    { name: 'KUBECLAW_BOOTSTRAP_CHANNEL_TYPE', value: channelType },
    { name: 'KUBECLAW_BOOTSTRAP_INSTANCE', value: instanceName },
    { name: 'KUBECLAW_BOOTSTRAP_JOB_ID', value: bootstrapJobId },
    {
      name: 'REDIS_URL',
      value:
        opts.redisUrl || process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
    },
  ];

  if (opts.redisUsername)
    envVars.push({ name: 'REDIS_USERNAME', value: opts.redisUsername });
  if (opts.redisAdminPassword)
    envVars.push({
      name: 'REDIS_ADMIN_PASSWORD',
      value: opts.redisAdminPassword,
    });
  if (opts.openaiApiKey)
    envVars.push({ name: 'OPENAI_API_KEY', value: opts.openaiApiKey });
  if (opts.openaiBaseUrl)
    envVars.push({ name: 'OPENAI_BASE_URL', value: opts.openaiBaseUrl });
  if (opts.directLlmModel)
    envVars.push({ name: 'DIRECT_LLM_MODEL', value: opts.directLlmModel });

  // Story 183: inject NPM_CONFIG_REGISTRY when a mirror is configured.
  // opts.npmRegistry (caller-supplied) takes precedence over the orchestrator
  // pod's BOOTSTRAP_NPM_REGISTRY env var (Helm-injected from bootstrap.npmRegistry).
  const npmRegistry = opts.npmRegistry || process.env.BOOTSTRAP_NPM_REGISTRY;
  if (npmRegistry) {
    envVars.push({ name: 'NPM_CONFIG_REGISTRY', value: npmRegistry });
  }

  // ── Create Job ──────────────────────────────────────────────────────────────
  const jobBody = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: {
        'kubeclaw-channel': instanceName,
        'kubeclaw.io/role': 'bootstrap',
        'kubeclaw.io/bootstrap-job-id': bootstrapJobId,
        app: 'kubeclaw-bootstrap',
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: timeoutSeconds,
      ttlSecondsAfterFinished: BOOTSTRAP_JOB_TTL,
      template: {
        metadata: {
          labels: {
            'kubeclaw-channel': instanceName,
            'kubeclaw.io/role': 'bootstrap',
            app: 'kubeclaw-bootstrap',
          },
        },
        spec: {
          serviceAccountName: 'kubeclaw-bootstrap',
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'bootstrap',
              image: channelBaseImage,
              imagePullPolicy: 'IfNotPresent',
              env: envVars,
              volumeMounts: [
                { name: 'runtime', mountPath: '/runtime' },
                { name: 'skills', mountPath: '/workspace/skills' },
                { name: 'manifests', mountPath: '/workspace/manifests' },
              ],
            },
            // Story 176: inspector sidecar — mounts the runtime PVC at /runtime-inspect
            // and runs `sleep infinity` so the orchestrator can `kubectl exec` into it
            // to independently read package.json and package-lock.json for TOCTOU defense.
            {
              name: 'inspector',
              image: channelBaseImage,
              imagePullPolicy: 'IfNotPresent',
              command: ['sleep', 'infinity'],
              volumeMounts: [
                { name: 'runtime', mountPath: '/runtime-inspect' },
              ],
            },
          ],
          volumes: [
            {
              name: 'runtime',
              persistentVolumeClaim: { claimName: pvcName },
            },
            {
              name: 'skills',
              configMap: { name: 'kubeclaw-bootstrap-skills' },
            },
            {
              name: 'manifests',
              configMap: { name: 'kubeclaw-channel-manifests' },
            },
          ],
        },
      },
    },
  };

  await k8sDeps.batchV1.createNamespacedJob({
    namespace,
    body: jobBody as any,
  });
  logger.info(
    { jobName, bootstrapJobId, instanceName, channelType },
    'Bootstrap Job created',
  );

  activeBootstraps.set(instanceName, bootstrapJobId);

  // ── Story 180 + Story 184: co-located audit inserts ───────────────────────
  // bootstrap_history terminal row is written by recordBootstrapTerminal at
  // terminal time (see CleanupBootstrapDeps.recordTerminal and admin-shell.ts).
  // bootstrap_audit start row is written here at job-spawn time.
  // Both tables are populated from this same orchestrator code path so a future
  // refactor cannot orphan one (Story 184 requirement).
  insertBootstrapAuditRow({
    bootstrapJobId,
    recordedAt: new Date().toISOString(),
    adminIdentity: opts.adminIdentity ?? 'anonymous',
    adminSessionId: opts.adminSessionId ?? null,
    channelType,
    instanceName,
    skillName,
    skillContentHash: opts.skillContentHash ?? '',
    manifestHashRequested: opts.manifestHashRequested ?? '',
    manifestHashObserved: null,
    outcome: 'in-progress',
  });

  return { bootstrapJobId };
}

// ─── Story 181: Upgrade runner ────────────────────────────────────────────────

export interface RunUpgradeOpts {
  instanceName: string;
  targetManifestHash: string;
  k8sDeps: BootstrapK8sDeps & {
    appsV1: import('@kubernetes/client-node').AppsV1Api;
  };
  namespace: string;
  channelBaseImage: string;
  /** Shared map — uses composite key `<instance>:upgrade` */
  activeBootstraps: Map<string, string>;
  timeoutSeconds?: number;
  pvcSize?: string;
  redisUrl?: string;
  redisUsername?: string;
  redisAdminPassword?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  directLlmModel?: string;
  /** Story 183: optional npm mirror registry URL. See BootstrapChannelFromSkillOpts.npmRegistry. */
  npmRegistry?: string;
}

export interface RunUpgradeResult {
  upgradeJobId: string;
  newPvcName: string;
  oldPvcName: string;
  alreadyInProgress?: 'bootstrap' | 'upgrade';
}

/**
 * Spawn the upgrade bootstrap Job and new versioned runtime PVC.
 *
 * Concurrent rejection:
 *   - Returns `{ alreadyInProgress: 'upgrade' }` if `<instance>:upgrade` is in activeBootstraps.
 *   - Returns `{ alreadyInProgress: 'bootstrap' }` if `<instance>` is in activeBootstraps.
 *
 * On success:
 *   - Creates PVC `kubeclaw-channel-<instance>-runtime-v<N+1>`
 *   - Creates Job `kubeclaw-bootstrap-<instance>-upgrade`
 *   - Registers `<instance>:upgrade` in activeBootstraps
 */
export async function runUpgrade(
  opts: RunUpgradeOpts,
): Promise<RunUpgradeResult> {
  const {
    instanceName,
    targetManifestHash,
    k8sDeps,
    namespace,
    channelBaseImage,
    activeBootstraps,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    pvcSize = DEFAULT_PVC_SIZE,
  } = opts;

  const upgradeKey = `${instanceName}:upgrade`;

  // ── Concurrent rejection ────────────────────────────────────────────────────
  if (activeBootstraps.has(upgradeKey)) {
    const existing = activeBootstraps.get(upgradeKey)!;
    logger.warn(
      { instanceName, existing },
      'runUpgrade: upgrade already in progress',
    );
    return {
      upgradeJobId: existing,
      newPvcName: '',
      oldPvcName: '',
      alreadyInProgress: 'upgrade',
    };
  }
  if (activeBootstraps.has(instanceName)) {
    const existing = activeBootstraps.get(instanceName)!;
    logger.warn(
      { instanceName, existing },
      'runUpgrade: initial bootstrap already in progress',
    );
    return {
      upgradeJobId: existing,
      newPvcName: '',
      oldPvcName: '',
      alreadyInProgress: 'bootstrap',
    };
  }

  // ── Discover current PVC from Deployment ───────────────────────────────────
  const deploymentName = `kubeclaw-channel-${instanceName}`;
  const deployment = await k8sDeps.appsV1.readNamespacedDeployment({
    name: deploymentName,
    namespace,
  });
  const volumes = deployment.spec?.template?.spec?.volumes ?? [];
  const runtimeVolume = volumes.find((v: any) => v.name === 'runtime');
  const currentPvcName =
    (runtimeVolume as any)?.persistentVolumeClaim?.claimName ??
    `kubeclaw-channel-${instanceName}-runtime`;

  const newPvcName = nextRuntimePvcName(currentPvcName);
  const upgradeJobId = randomUUID();
  const jobName = `kubeclaw-bootstrap-${instanceName}-upgrade`;

  // ── Create new PVC ──────────────────────────────────────────────────────────
  try {
    await k8sDeps.coreV1.readNamespacedPersistentVolumeClaim({
      name: newPvcName,
      namespace,
    });
    logger.info(
      { newPvcName },
      'runUpgrade: new runtime PVC already exists, reusing',
    );
  } catch {
    await k8sDeps.coreV1.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: newPvcName,
          namespace,
          labels: {
            'kubeclaw-channel': instanceName,
            'kubeclaw.io/role': 'channel-runtime',
            'kubeclaw.io/runtime': 'true',
          },
        },
        spec: {
          accessModes: parseRuntimePvcAccessModes(),
          resources: { requests: { storage: pvcSize } },
        },
      },
    });
    logger.info({ newPvcName, pvcSize }, 'runUpgrade: created new runtime PVC');
  }

  // ── Build env vars ──────────────────────────────────────────────────────────
  const envVars: Array<{ name: string; value: string }> = [
    { name: 'KUBECLAW_SUPERUSER', value: 'true' },
    { name: 'KUBECLAW_BOOTSTRAP_JOB_ID', value: upgradeJobId },
    { name: 'KUBECLAW_BOOTSTRAP_INSTANCE', value: instanceName },
    {
      name: 'KUBECLAW_BOOTSTRAP_TARGET_MANIFEST_HASH',
      value: targetManifestHash,
    },
    { name: 'KUBECLAW_UPGRADE_FROM_PVC', value: currentPvcName },
    {
      name: 'REDIS_URL',
      value:
        opts.redisUrl || process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
    },
  ];
  if (opts.redisUsername)
    envVars.push({ name: 'REDIS_USERNAME', value: opts.redisUsername });
  if (opts.redisAdminPassword)
    envVars.push({
      name: 'REDIS_ADMIN_PASSWORD',
      value: opts.redisAdminPassword,
    });
  if (opts.openaiApiKey)
    envVars.push({ name: 'OPENAI_API_KEY', value: opts.openaiApiKey });
  if (opts.openaiBaseUrl)
    envVars.push({ name: 'OPENAI_BASE_URL', value: opts.openaiBaseUrl });
  if (opts.directLlmModel)
    envVars.push({ name: 'DIRECT_LLM_MODEL', value: opts.directLlmModel });

  // Story 183: inject NPM_CONFIG_REGISTRY when a mirror is configured.
  const upgradeNpmRegistry =
    opts.npmRegistry || process.env.BOOTSTRAP_NPM_REGISTRY;
  if (upgradeNpmRegistry) {
    envVars.push({ name: 'NPM_CONFIG_REGISTRY', value: upgradeNpmRegistry });
  }

  // ── Create upgrade bootstrap Job ────────────────────────────────────────────
  const jobBody = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: {
        'kubeclaw-channel': instanceName,
        'kubeclaw.io/role': 'bootstrap',
        'kubeclaw.io/bootstrap-job-id': upgradeJobId,
        'kubeclaw.io/upgrade': 'true',
        app: 'kubeclaw-bootstrap',
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: timeoutSeconds,
      ttlSecondsAfterFinished: BOOTSTRAP_JOB_TTL,
      template: {
        metadata: {
          labels: {
            'kubeclaw-channel': instanceName,
            'kubeclaw.io/role': 'bootstrap',
            'kubeclaw.io/upgrade': 'true',
            app: 'kubeclaw-bootstrap',
          },
        },
        spec: {
          serviceAccountName: 'kubeclaw-bootstrap',
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'bootstrap',
              image: channelBaseImage,
              imagePullPolicy: 'IfNotPresent',
              env: envVars,
              volumeMounts: [
                { name: 'runtime', mountPath: '/runtime' },
                { name: 'skills', mountPath: '/workspace/skills' },
                { name: 'manifests', mountPath: '/workspace/manifests' },
              ],
            },
            {
              name: 'inspector',
              image: channelBaseImage,
              imagePullPolicy: 'IfNotPresent',
              command: ['sleep', 'infinity'],
              volumeMounts: [
                { name: 'runtime', mountPath: '/runtime-inspect' },
              ],
            },
          ],
          volumes: [
            {
              name: 'runtime',
              persistentVolumeClaim: { claimName: newPvcName },
            },
            {
              name: 'skills',
              configMap: { name: 'kubeclaw-bootstrap-skills' },
            },
            {
              name: 'manifests',
              configMap: { name: 'kubeclaw-channel-manifests' },
            },
          ],
        },
      },
    },
  };

  await k8sDeps.batchV1.createNamespacedJob({
    namespace,
    body: jobBody as any,
  });
  logger.info(
    { jobName, upgradeJobId, instanceName },
    'runUpgrade: upgrade Job created',
  );

  activeBootstraps.set(upgradeKey, upgradeJobId);
  return { upgradeJobId, newPvcName, oldPvcName: currentPvcName };
}

// ─── Story 175: Timeout cleanup ───────────────────────────────────────────────

/**
 * Dependencies injected into cleanupBootstrapResources.
 * All delete operations are expected to swallow NotFound errors internally
 * (return normally); the caller logs and continues on other errors.
 */
export interface CleanupBootstrapDeps {
  /** Delete the K8s Job by name (NotFound → return normally; others → throw). */
  deleteJob(jobName: string): Promise<void>;
  /** Delete the runtime PVC by name (NotFound → return normally; others → throw). */
  deletePvc(pvcName: string): Promise<void>;
  /** Delete the credentials Secret by name (NotFound → return normally; others → throw). */
  deleteSecret(secretName: string): Promise<void>;
  /**
   * Publish a message to the admin SSE stream via Redis pub/sub.
   * topic = 'kubeclaw:bootstrap:<bootstrapJobId>'
   * The payload is JSON-stringified before publishing.
   */
  publishSse(
    topic: string,
    payload: { type: string; text: string },
  ): Promise<void>;
  /** Shared in-memory map: instanceName → bootstrapJobId */
  activeBootstraps: Map<string, string>;
  /**
   * Story 180: Optional callback to record a terminal bootstrap outcome in SQLite.
   * Called after the SSE publish. If absent, the terminal record is skipped
   * (backward-compatible for tests that don't inject this dep).
   */
  recordTerminal?(
    instanceName: string,
    bootstrapJobId: string,
    outcome: string,
  ): void;
  /**
   * Story 184: audit context threaded from the original bootstrap_channel_from_skill call.
   * Used when writing the terminal bootstrap_audit row in cleanupBootstrapResources.
   * Both Story 180 (bootstrap_history) and Story 184 (bootstrap_audit) terminal rows are
   * written from the same code path so they cannot drift (Story 184 requirement).
   */
  auditContext?: {
    adminIdentity: string;
    adminSessionId: string | null;
    channelType: string;
    instanceName: string;
    skillName: string;
    skillContentHash: string;
    manifestHashRequested: string;
    startedAt: string;
  };
}

/**
 * Atomically clean up all resources created for a bootstrap operation.
 *
 * Execution order (each step is independent — failure does not abort subsequent steps):
 *   (a) Delete K8s Job `kubeclaw-bootstrap-<instanceName>`
 *   (b) Delete runtime PVC `kubeclaw-channel-<instanceName>-runtime`
 *   (c) Delete credentials Secret `kubeclaw-channel-<instanceName>-credentials`
 *   (d) Publish timeout SSE message to `kubeclaw:bootstrap:<bootstrapJobId>`
 *   (e) Remove `instanceName` from `activeBootstraps` (always runs, regardless of prior failures)
 *
 * Idempotent: NotFound errors on delete steps are silently swallowed (logged at debug).
 * Other errors are logged at warn level but do not abort the cleanup chain.
 */
export async function cleanupBootstrapResources(
  bootstrapJobId: string,
  instanceName: string,
  deps: CleanupBootstrapDeps,
): Promise<void> {
  const jobName = `kubeclaw-bootstrap-${instanceName}`;
  const pvcName = `kubeclaw-channel-${instanceName}-runtime`;
  const secretName = `kubeclaw-channel-${instanceName}-credentials`;
  const sseTopic = `kubeclaw:bootstrap:${bootstrapJobId}`;

  logger.info(
    { bootstrapJobId, instanceName, jobName, pvcName },
    'cleanupBootstrapResources: starting cleanup for timed-out bootstrap',
  );

  // (a) Delete the bootstrap Job — idempotent
  try {
    await deps.deleteJob(jobName);
    logger.debug({ jobName }, 'cleanupBootstrapResources: Job deleted');
  } catch (err) {
    logger.warn(
      { jobName, err },
      'cleanupBootstrapResources: failed to delete Job (non-NotFound); continuing',
    );
  }

  // (b) Delete the runtime PVC — idempotent
  try {
    await deps.deletePvc(pvcName);
    logger.debug({ pvcName }, 'cleanupBootstrapResources: PVC deleted');
  } catch (err) {
    logger.warn(
      { pvcName, err },
      'cleanupBootstrapResources: failed to delete PVC (non-NotFound); continuing',
    );
  }

  // (c) Defensively delete the credentials Secret — idempotent
  // This Secret is only created by commit_channel_config, so it will usually
  // not exist when the timeout fires. NotFound is silently swallowed.
  try {
    await deps.deleteSecret(secretName);
    logger.debug(
      { secretName },
      'cleanupBootstrapResources: credentials Secret deleted (or did not exist)',
    );
  } catch (err) {
    logger.warn(
      { secretName, err },
      'cleanupBootstrapResources: failed to delete credentials Secret (non-NotFound); continuing',
    );
  }

  // (d) Publish timeout SSE message — best-effort
  try {
    await deps.publishSse(sseTopic, {
      type: 'timeout',
      text: `Bootstrap ${bootstrapJobId} timed out; nothing was installed.`,
    });
    logger.debug(
      { sseTopic },
      'cleanupBootstrapResources: timeout SSE published',
    );
  } catch (err) {
    logger.warn(
      { sseTopic, err },
      'cleanupBootstrapResources: failed to publish timeout SSE; continuing',
    );
  }

  // (d.5) Story 180 + Story 184: record terminal rows in both tables — co-located so they
  // cannot drift. bootstrap_history written via recordTerminal; bootstrap_audit written below.
  if (deps.recordTerminal) {
    try {
      deps.recordTerminal(instanceName, bootstrapJobId, 'timed-out');
    } catch (err) {
      logger.warn(
        { err },
        'cleanupBootstrapResources: failed to record terminal; continuing',
      );
    }
  }

  // (d.6) Story 184: write terminal bootstrap_audit row (never throws).
  if (deps.auditContext) {
    const ctx = deps.auditContext;
    const terminalAt = new Date().toISOString();
    const durationSeconds = Math.round(
      (new Date(terminalAt).getTime() - new Date(ctx.startedAt).getTime()) /
        1000,
    );
    insertBootstrapAuditRow({
      bootstrapJobId,
      recordedAt: terminalAt,
      adminIdentity: ctx.adminIdentity,
      adminSessionId: ctx.adminSessionId,
      channelType: ctx.channelType,
      instanceName: ctx.instanceName,
      skillName: ctx.skillName,
      skillContentHash: ctx.skillContentHash,
      manifestHashRequested: ctx.manifestHashRequested,
      manifestHashObserved: null,
      outcome: 'timed-out',
      durationSeconds,
    });
  }

  // (e) Free the instance name — always runs
  deps.activeBootstraps.delete(instanceName);
  logger.info(
    { instanceName, bootstrapJobId },
    'cleanupBootstrapResources: instance freed from activeBootstraps',
  );
}

// ─── Story 175: Wait for bootstrap job with timeout detection ────────────────

export interface WaitForBootstrapJobOpts {
  /**
   * Injected wait function — polls the bootstrap Job until it completes
   * (succeeds or fails). Rejects with an error whose message contains
   * 'DeadlineExceeded' when the Job's activeDeadlineSeconds fires.
   *
   * In production this is `(name, ms) => jobRunner.waitForJobCompletion(name, ms)`.
   * In tests it is a vi.fn() that simulates success or DeadlineExceeded.
   */
  waitForJob(jobName: string, timeoutMs: number): Promise<void>;
  cleanupDeps: CleanupBootstrapDeps;
  /**
   * Override for BOOTSTRAP_SKILL_TIMEOUT_SECONDS (seconds).
   * Defaults to the env var value (900 s if unset).
   */
  bootstrapTimeoutSeconds?: number;
}

/**
 * Wait for a bootstrap Job to finish, then clean up on deadline expiry.
 *
 * Passes `(BOOTSTRAP_SKILL_TIMEOUT_SECONDS + 60) * 1000` to `waitForJob` as
 * the orchestrator-side poll timeout.  The +60 s grace period ensures the
 * orchestrator observes the K8s DeadlineExceeded condition before its own
 * timeout fires (see BOOTSTRAP_ORCHESTRATOR_GRACE_MS constant for rationale).
 *
 * On DeadlineExceeded: calls cleanupBootstrapResources.
 * On other errors: logs at warn; does NOT clean up (may be a transient error).
 * On success: logs at info; no cleanup.
 */
export async function waitForBootstrapJobCompletion(
  jobName: string,
  bootstrapJobId: string,
  instanceName: string,
  opts: WaitForBootstrapJobOpts,
): Promise<void> {
  const timeoutSec =
    opts.bootstrapTimeoutSeconds ??
    parseInt(process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS || '900', 10);
  const timeoutMs = timeoutSec * 1000 + BOOTSTRAP_ORCHESTRATOR_GRACE_MS;

  logger.debug(
    { jobName, bootstrapJobId, timeoutMs },
    'waitForBootstrapJobCompletion: starting to watch bootstrap Job',
  );

  try {
    await opts.waitForJob(jobName, timeoutMs);
    logger.info(
      { jobName, bootstrapJobId },
      'waitForBootstrapJobCompletion: bootstrap Job completed successfully',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('DeadlineExceeded')) {
      logger.info(
        { jobName, bootstrapJobId, instanceName },
        'waitForBootstrapJobCompletion: DeadlineExceeded detected — running cleanup',
      );
      await cleanupBootstrapResources(
        bootstrapJobId,
        instanceName,
        opts.cleanupDeps,
      );
    } else {
      logger.warn(
        { jobName, bootstrapJobId, err },
        'waitForBootstrapJobCompletion: Job wait failed with non-deadline error',
      );
    }
  }
}

// ─── Story 175: Orphan bootstrap reconciliation on startup ───────────────────

/**
 * A failed bootstrap Job discovered during startup reconciliation.
 */
export interface FailedBootstrapJob {
  /** K8s Job name, e.g. 'kubeclaw-bootstrap-my-telegram' */
  jobName: string;
  /** Instance name from kubeclaw-channel label, e.g. 'my-telegram' */
  instanceName: string;
  /** bootstrapJobId from kubeclaw.io/bootstrap-job-id label */
  bootstrapJobId: string;
  /** Failure reason from Job status conditions, e.g. 'DeadlineExceeded' */
  failureReason: string;
}

export interface ReconcileOrphanedBootstrapsDeps {
  /**
   * List bootstrap Jobs that are in terminal Failed state.
   * Implementations should query with label selector `kubeclaw.io/role=bootstrap`
   * and filter for items where status.conditions contains a Failed=True condition.
   */
  listFailedBootstrapJobs(): Promise<FailedBootstrapJob[]>;
  /** Dependencies passed through to cleanupBootstrapResources for each orphan */
  cleanup: CleanupBootstrapDeps;
  /** Wall-clock limit for the entire reconciliation pass. Default: 30 000 ms. */
  timeoutMs?: number;
}

/**
 * Reconcile orphaned bootstrap Jobs on orchestrator startup.
 *
 * Called once during startup (after registerBootstrapDeps).  Queries the cluster
 * for bootstrap Jobs in terminal Failed state. For each orphan, calls
 * cleanupBootstrapResources to delete K8s resources and notify the admin (if any
 * SSE subscriber is still connected).
 *
 * Idempotent: all delete steps swallow NotFound errors. A second restart after a
 * partial cleanup will not re-emit errors for already-deleted resources.
 *
 * Bounded by timeoutMs (default 30 s) — the same pattern used by
 * reconcileOrphanedJobsOnStartup in orphan-jobs.ts.
 */
export async function reconcileOrphanedBootstrapsOnStartup(
  deps: ReconcileOrphanedBootstrapsDeps,
): Promise<void> {
  const { listFailedBootstrapJobs, cleanup, timeoutMs = 30_000 } = deps;
  const deadline = Date.now() + timeoutMs;

  let orphans: FailedBootstrapJob[];
  try {
    orphans = await listFailedBootstrapJobs();
  } catch (err) {
    logger.warn(
      { err },
      'reconcileOrphanedBootstrapsOnStartup: failed to list failed bootstrap Jobs; skipping',
    );
    return;
  }

  if (orphans.length === 0) {
    logger.debug(
      'reconcileOrphanedBootstrapsOnStartup: no orphaned bootstrap Jobs found',
    );
    return;
  }

  logger.info(
    { count: orphans.length },
    'reconcileOrphanedBootstrapsOnStartup: found orphaned bootstrap Jobs; reconciling',
  );

  for (const orphan of orphans) {
    if (Date.now() > deadline) {
      logger.warn(
        { remaining: orphans.length },
        'reconcileOrphanedBootstrapsOnStartup: timeout reached; aborting reconciliation',
      );
      break;
    }

    const { jobName, instanceName, bootstrapJobId, failureReason } = orphan;
    logger.info(
      { jobName, instanceName, bootstrapJobId, failureReason },
      'reconcileOrphanedBootstrapsOnStartup: reconciling orphaned bootstrap Job',
    );

    try {
      await cleanupBootstrapResources(bootstrapJobId, instanceName, cleanup);
    } catch (err) {
      // cleanupBootstrapResources is designed not to throw (each step is try/catch),
      // but guard defensively so one broken orphan cannot abort the rest.
      logger.warn(
        { jobName, instanceName, err },
        'reconcileOrphanedBootstrapsOnStartup: cleanupBootstrapResources threw unexpectedly; continuing',
      );
    }
  }

  logger.info(
    'reconcileOrphanedBootstrapsOnStartup: reconciliation pass complete',
  );
}

// ─── Story 180: Bootstrap status tool ────────────────────────────────────────

export type BootstrapState =
  | 'awaiting-dialogue'
  | 'installing-packages'
  | 'validating-credentials'
  | 'committing'
  | 'done'
  | 'error';

export interface ActiveBootstrapEntry {
  bootstrapJobId: string;
  channelType: string;
  instanceName: string;
  skillName: string;
  startedAt: string;
  elapsedSeconds: number;
  state: BootstrapState;
  currentStep: string;
  podPhase: string | null;
  logsTail?: string;
}

export type BootstrapStatusResult = {
  active: ActiveBootstrapEntry[];
  recent: import('../db.js').BootstrapHistoryRow[];
};

/**
 * Metadata stored per active bootstrap instance.
 * Registered when bootstrapChannelFromSkill succeeds; freed on terminal event.
 */
export interface BootstrapMeta {
  channelType: string;
  skillName: string;
  startedAt: string;
}

export interface BootstrapStatusDeps {
  /** Read the most-recent step label for a bootstrapJobId, or undefined */
  getStepLabel(
    bootstrapJobId: string,
  ): { label: string; ts: string } | undefined;
  /** Read the K8s pod phase for a bootstrap job (returns null if not found) */
  getPodPhase(instanceName: string): Promise<string | null>;
  /** Read the last 50 log lines from the bootstrap pod (returns null if not available) */
  getPodLogs?(instanceName: string): Promise<string | null>;
  /** Retrieve metadata about an active bootstrap instance */
  getBootstrapMeta(instanceName: string): BootstrapMeta | undefined;
}

// In-memory metadata map: instanceName → BootstrapMeta
const bootstrapMetaMap: Map<string, BootstrapMeta> = new Map();

/**
 * Register metadata for an active bootstrap so bootstrapStatus can return it.
 * Called from admin-shell.ts immediately after bootstrapChannelFromSkill returns.
 */
export function registerBootstrapMeta(
  instanceName: string,
  meta: BootstrapMeta,
): void {
  bootstrapMetaMap.set(instanceName, meta);
}

/**
 * Remove bootstrap metadata when an instance is released from activeBootstraps.
 */
export function deregisterBootstrapMeta(instanceName: string): void {
  bootstrapMetaMap.delete(instanceName);
}

/**
 * Read metadata for an active bootstrap instance.
 * Used by admin-shell handler and by the terminal-recording callback.
 */
export function getBootstrapMeta(
  instanceName: string,
): BootstrapMeta | undefined {
  return bootstrapMetaMap.get(instanceName);
}

/**
 * Derive the BootstrapState for an active bootstrap entry.
 *
 * State derivation precedence (highest priority first):
 *   1. podPhase === 'Failed'                                → 'error'
 *      (pod failure overrides any Redis message)
 *   2. lastMessage?.type === 'commit_ack'                   → 'done'
 *   3. lastMessage?.type === 'commit_channel_config'        → 'committing'
 *   4. lastMessage?.type === 'step' && label has 'validat'  → 'validating-credentials'
 *   5. lastMessage?.type === 'step' && label has 'npm'      → 'installing-packages'
 *   6. lastMessage?.type === 'question'                     → 'awaiting-dialogue'
 *   7. (default)                                            → 'awaiting-dialogue'
 */
export function deriveBootstrapState(
  podPhase: string | null,
  lastMessage: { type: string; label?: string } | null,
): BootstrapState {
  if (podPhase === 'Failed') return 'error';
  if (!lastMessage) return 'awaiting-dialogue';

  const { type, label = '' } = lastMessage;
  if (type === 'commit_ack') return 'done';
  if (type === 'commit_channel_config') return 'committing';
  if (type === 'step') {
    if (label.toLowerCase().includes('validat'))
      return 'validating-credentials';
    if (label.toLowerCase().includes('npm')) return 'installing-packages';
  }
  if (type === 'question') return 'awaiting-dialogue';
  return 'awaiting-dialogue';
}

/**
 * Map a BootstrapState to a human-readable default step label, used when no
 * report_step label has been published for this bootstrapJobId.
 */
export function stateToDefaultStep(state: BootstrapState): string {
  switch (state) {
    case 'awaiting-dialogue':
      return 'Awaiting dialogue';
    case 'installing-packages':
      return 'Installing packages';
    case 'validating-credentials':
      return 'Validating credentials';
    case 'committing':
      return 'Committing channel config';
    case 'done':
      return 'Done';
    case 'error':
      return 'Error';
  }
}

/**
 * Build an ActiveBootstrapEntry for one active bootstrap job.
 * Reads pod phase from K8s (via deps) and step label from the in-memory step map.
 */
export async function buildActiveEntry(
  instanceName: string,
  bootstrapJobId: string,
  meta: BootstrapMeta,
  deps: BootstrapStatusDeps,
  includeLogs: boolean,
): Promise<ActiveBootstrapEntry> {
  const podPhase = await deps.getPodPhase(instanceName);
  const stepInfo = deps.getStepLabel(bootstrapJobId);

  // Build a minimal lastMessage shape for deriveBootstrapState.
  // We only have the most-recent step label (type='step'); if no step is present,
  // pass null so the state machine defaults to 'awaiting-dialogue'.
  const lastMessage: { type: string; label?: string } | null = stepInfo
    ? { type: 'step', label: stepInfo.label }
    : null;

  const state = deriveBootstrapState(podPhase, lastMessage);
  const elapsedSeconds = Math.floor(
    (Date.now() - new Date(meta.startedAt).getTime()) / 1000,
  );
  const currentStep = stepInfo?.label ?? stateToDefaultStep(state);

  const entry: ActiveBootstrapEntry = {
    bootstrapJobId,
    channelType: meta.channelType,
    instanceName,
    skillName: meta.skillName,
    startedAt: meta.startedAt,
    elapsedSeconds,
    state,
    currentStep,
    podPhase,
  };

  if (includeLogs && deps.getPodLogs) {
    const logs = await deps.getPodLogs(instanceName);
    if (logs !== null) entry.logsTail = logs;
  }

  return entry;
}

/**
 * Implementation of the bootstrap_status IPC tool.
 *
 * Returns all active bootstraps (from the shared activeBootstraps map) joined
 * with K8s pod phase, plus recent completed entries from bootstrap_history.
 *
 * @param activeBootstraps  The shared instanceName → bootstrapJobId map
 * @param deps              Injectable K8s + step-map dependencies
 * @param opts              Optional filter/limit/include_logs parameters
 */
export async function bootstrapStatus(
  activeBootstraps: Map<string, string>,
  deps: BootstrapStatusDeps,
  opts?: {
    limit?: number;
    channelTypeFilter?: string;
    includeLogs?: boolean;
  },
): Promise<BootstrapStatusResult | { code: string; message: string }> {
  const { limit, channelTypeFilter, includeLogs = false } = opts ?? {};

  // Validate limit
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return {
      code: 'INVALID_PARAM',
      message: 'limit must be a positive integer',
    };
  }

  // Build active[] — parallel K8s reads for each active instance
  const activeEntries = await Promise.all(
    [...activeBootstraps.entries()].map(([instanceName, bootstrapJobId]) => {
      const meta = deps.getBootstrapMeta(instanceName) ?? {
        channelType: 'unknown',
        skillName: 'unknown',
        startedAt: new Date().toISOString(),
      };
      return buildActiveEntry(
        instanceName,
        bootstrapJobId,
        meta,
        deps,
        includeLogs,
      );
    }),
  );

  const filteredActive = channelTypeFilter
    ? activeEntries.filter((e) => e.channelType === channelTypeFilter)
    : activeEntries;

  // Build recent[] from SQLite
  const { getRecentBootstrapHistory } = await import('../db.js');
  const recent = getRecentBootstrapHistory({ limit, channelTypeFilter });

  return { active: filteredActive, recent };
}
