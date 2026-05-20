import type { PerGroupK8sClient } from './k8s-client.js';
import { getInstance, setReplicas, touchLastUsed } from './db.js';
import { logger } from '../logger.js';

export type ScaleUpResult =
  | { state: 'ready'; endpoint: string; coldStartMs: number }
  | { state: 'failed'; error: string };

export interface ScaleUpArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
  capabilityName: string;
  timeoutMs: number;
  port?: number;
}

export async function scaleUpInstance(
  args: ScaleUpArgs,
): Promise<ScaleUpResult> {
  const inst = getInstance(args.groupFolder, args.capabilityName);
  if (!inst) {
    return {
      state: 'failed',
      error: `no instance recorded for (${args.groupFolder}, ${args.capabilityName})`,
    };
  }
  const start = Date.now();
  const port = args.port ?? 3000;
  const endpoint = `http://${inst.serviceName}.${args.namespace}.svc.cluster.local:${port}`;

  try {
    if (inst.currentReplicas === 0) {
      await args.client.patchDeploymentReplicas(
        args.namespace,
        inst.deploymentName,
        1,
      );
      setReplicas(args.groupFolder, args.capabilityName, 1);
    }
    await args.client.waitForReady(
      args.namespace,
      inst.deploymentName,
      args.timeoutMs,
    );
    touchLastUsed(
      args.groupFolder,
      args.capabilityName,
      Math.floor(Date.now() / 1000),
    );
    const coldStartMs = Date.now() - start;
    logger.info(
      { group: args.groupFolder, capability: args.capabilityName, coldStartMs },
      'per_group_capability_scale_up',
    );
    return { state: 'ready', endpoint, coldStartMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, group: args.groupFolder, capability: args.capabilityName },
      'per_group_capability_discovery_failed',
    );
    return { state: 'failed', error: msg };
  }
}
