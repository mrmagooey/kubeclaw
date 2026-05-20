/**
 * Orchestrator-side handlers for `/capabilities add/list/remove` IPC verbs.
 *
 * These functions are called from `src/k8s/ipc-redis.ts` task-request stream
 * handlers and operate on the shared SQLite DB + K8s via PerGroupK8sClient.
 */
import type { PerGroupK8sClient } from './k8s-client.js';
import type { CapabilitySpec } from '../capabilities/types.js';
import { groupHash } from './hash.js';
import {
  renderDeployment,
  renderService,
  renderNetworkPolicy,
  instanceName,
} from './k8s-objects.js';
import {
  upsertInstance,
  getInstance,
  listInstances,
  deleteInstance,
  type PerGroupInstanceRow,
} from './db.js';
import { getScope, validateScopeFields } from './types.js';
import { logger } from '../logger.js';

export interface ProvisionDeps {
  client: PerGroupK8sClient;
  namespace: string;
  groupsPvcName: string;
  /** All capability specs known to the orchestrator (Helm + admin overrides). */
  listSpecs: () => CapabilitySpec[];
}

export interface ProvisionResult {
  ok: boolean;
  /** Deployment name (present on success). */
  deploymentName?: string;
  /** Human-readable message. */
  message: string;
  /** True when the capability was already provisioned (idempotent second call). */
  alreadyProvisioned?: boolean;
}

export interface CapabilityListEntry {
  type: string;
  deploymentName: string;
  replicas: number;
  /** Unix epoch seconds, or null if never used. */
  lastUsedAt: number | null;
  scaleDownAfterIdleSeconds: number;
}

/**
 * Provision (add) a per-group capability instance for the given group.
 *
 * Idempotent: if a row already exists for (groupFolder, capabilityName) the
 * function returns early with `alreadyProvisioned: true` without touching K8s.
 */
export async function provisionCapability(
  groupFolder: string,
  capabilityType: string,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const specs = deps.listSpecs();
  const spec = specs.find(
    (s) => s.name === capabilityType && getScope(s) === 'group',
  );

  if (!spec) {
    const groupTypes = specs
      .filter((s) => getScope(s) === 'group')
      .map((s) => s.name)
      .join(', ');
    return {
      ok: false,
      message: `Unknown capability type '${capabilityType}'. Available group-scoped types: ${groupTypes || 'none'}.`,
    };
  }

  try {
    validateScopeFields(spec);
  } catch (err) {
    return {
      ok: false,
      message: `Capability spec validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const hash = groupHash(groupFolder);
  const name = instanceName(spec.name, hash);

  // Idempotency check — return existing instance without touching K8s.
  const existing = getInstance(groupFolder, capabilityType);
  if (existing) {
    return {
      ok: true,
      deploymentName: existing.deploymentName,
      message: `Capability '${capabilityType}' is already provisioned for this group.`,
      alreadyProvisioned: true,
    };
  }

  const ctx = {
    groupFolder,
    groupHash: hash,
    namespace: deps.namespace,
    groupsPvcName: deps.groupsPvcName,
  };

  try {
    await deps.client.applyNetworkPolicy(renderNetworkPolicy(spec, ctx));
    await deps.client.applyService(renderService(spec, ctx));
    await deps.client.applyDeployment(renderDeployment(spec, ctx));
    upsertInstance({
      groupFolder,
      capabilityName: spec.name,
      groupHash: hash,
      deploymentName: name,
      serviceName: name,
    });

    logger.info(
      { groupFolder, capability: capabilityType, deploymentName: name },
      'capability.add: provisioned',
    );

    return {
      ok: true,
      deploymentName: name,
      message: `Capability '${capabilityType}' provisioned as deployment '${name}'.`,
    };
  } catch (err) {
    logger.warn(
      { err, groupFolder, capability: capabilityType },
      'capability.add: failed to provision',
    );
    return {
      ok: false,
      message: `Failed to provision '${capabilityType}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * List per-group capability instances for the given group.
 *
 * Returns an array of entries with type, replicas, lastUsedAt, and
 * scaleDownAfterIdleSeconds. Filtered strictly to the requesting groupFolder
 * (AC5: per-group isolation).
 */
export function listGroupCapabilities(
  groupFolder: string,
  deps: Pick<ProvisionDeps, 'listSpecs'>,
): CapabilityListEntry[] {
  const rows: PerGroupInstanceRow[] = listInstances(groupFolder);
  const specs = deps.listSpecs();
  const specByName = new Map<string, CapabilitySpec>();
  for (const s of specs) specByName.set(s.name, s);

  return rows.map((row) => {
    const spec = specByName.get(row.capabilityName);
    const scaleDownAfterIdleSeconds =
      spec?.scope === 'group'
        ? (spec.scaleDownAfterIdleSeconds ?? 600)
        : 600;

    return {
      type: row.capabilityName,
      deploymentName: row.deploymentName,
      replicas: row.currentReplicas,
      lastUsedAt: row.lastUsedAt,
      scaleDownAfterIdleSeconds,
    };
  });
}

/**
 * Remove a per-group capability instance for the given group.
 *
 * Deletes the K8s resources (via label selector on groupHash) then removes
 * the SQLite row. If the instance does not exist, returns ok:false.
 */
export async function removeCapabilityInstance(
  groupFolder: string,
  capabilityType: string,
  deps: ProvisionDeps,
): Promise<{ ok: boolean; message: string }> {
  const inst = getInstance(groupFolder, capabilityType);
  if (!inst) {
    return {
      ok: false,
      message: `Capability '${capabilityType}' is not provisioned for this group.`,
    };
  }

  const hash = groupHash(groupFolder);
  const selector = `kubeclaw.io/capability=${capabilityType},kubeclaw.io/group-hash=${hash}`;

  try {
    // K8s delete first, then DB row: if the K8s delete throws, the DB row
    // remains so a retried `/capabilities remove` can find it and try again.
    // The inverse ordering would orphan untracked K8s objects on partial
    // failure with no DB row to reach them from.
    await deps.client.deleteByLabel(deps.namespace, selector);
    deleteInstance(groupFolder, capabilityType);

    logger.info(
      { groupFolder, capability: capabilityType, selector },
      'capability.remove: removed',
    );

    return {
      ok: true,
      message: `Capability '${capabilityType}' removed for this group.`,
    };
  } catch (err) {
    logger.warn(
      { err, groupFolder, capability: capabilityType },
      'capability.remove: failed',
    );
    return {
      ok: false,
      message: `Failed to remove '${capabilityType}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
