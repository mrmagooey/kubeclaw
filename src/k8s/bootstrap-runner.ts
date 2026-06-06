/**
 * Bootstrap runner — Story 174.
 *
 * Responsible for:
 *   - Manifest schema validation (validateChannelManifest)
 *   - Canonical JSON hash computation (computeManifestHash, canonicalJson)
 *   - Spawning bootstrap Jobs + runtime PVCs (bootstrapChannelFromSkill)
 *
 * Stories 175-184 will extend this file with timeout cleanup, orphan reconciliation,
 * and independent PVC hash verification.
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { CoreV1Api, BatchV1Api } from '@kubernetes/client-node';
import { logger } from '../logger.js';

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
          accessModes: ['ReadWriteOnce'],
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
  return { bootstrapJobId };
}
