import type { PerGroupK8sClient } from './k8s-client.js';
import { groupHash } from './hash.js';
import { deleteInstancesByGroup, listInstances } from './db.js';
import { logger } from '../logger.js';

export interface GcArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
}

export async function gcGroup(args: GcArgs): Promise<void> {
  const hash = groupHash(args.groupFolder);
  const selector = `kubeclaw.io/group-hash=${hash}`;
  const instanceCount = listInstances(args.groupFolder).length;
  try {
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
