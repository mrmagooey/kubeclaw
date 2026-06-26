import type { PerGroupK8sClient } from './k8s-client.js';
import { groupHash } from './hash.js';
import { deleteInstancesByGroup, listInstances } from './db.js';
import { logger } from '../logger.js';

export interface GcArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
}

// v1 simplification vs spec: the spec describes a Redis DEL of `last_used` keys
// during GC. v1 doesn't write any Redis `last_used` keys (touchLastUsed writes
// SQLite only), so there's nothing to DEL. If a future change introduces a Redis
// hot-path for last_used timestamps, add the matching DEL here.
export async function gcGroup(args: GcArgs): Promise<void> {
  const hash = groupHash(args.groupFolder);
  const selector = `kubeclaw.io/group-hash=${hash}`;
  const instanceCount = listInstances(args.groupFolder).length;
  try {
    // deleteByLabel removes Deployments, Services, NetworkPolicies, and Secrets
    // carrying the group-hash label. It intentionally does NOT delete
    // PersistentVolumeClaims — dedicated PVCs carry the annotation
    // kubeclaw.io/retain: "true" and are not in the collections targeted here.
    // This means a group's database PVC (and its data) survives group deletion
    // and must be cleaned up manually when the data is no longer needed.
    await args.client.deleteByLabel(args.namespace, selector);
  } catch (err) {
    logger.warn(
      { err, group: args.groupFolder, selector },
      'per_group_capability_gc: deleteByLabel partial failure',
    );
  }
  deleteInstancesByGroup(args.groupFolder);
  logger.info(
    { group: args.groupFolder, instances_removed: instanceCount },
    'per_group_capability_gc',
  );
}
