import type { CapabilitySpec } from '../capabilities/types.js';
import type { PerGroupK8sClient } from './k8s-client.js';
import { listInstancesAtReplicas, setReplicas } from './db.js';
import { resolveGroupCapability, getScope } from './types.js';
import { logger } from '../logger.js';

export interface SweepArgs {
  client: PerGroupK8sClient;
  namespace: string;
  specs: CapabilitySpec[];
  /** Override for tests. */
  nowSeconds?: () => number;
}

export async function sweepIdleInstances(args: SweepArgs): Promise<void> {
  const now = args.nowSeconds
    ? args.nowSeconds()
    : Math.floor(Date.now() / 1000);
  const specByName = new Map<string, CapabilitySpec>();
  for (const s of args.specs) {
    if (getScope(s) === 'group') specByName.set(s.name, s);
  }

  const live = listInstancesAtReplicas(1);
  for (const inst of live) {
    const spec = specByName.get(inst.capabilityName);
    if (!spec) continue;
    if (resolveGroupCapability(spec).pinned) continue;
    const threshold = resolveGroupCapability(spec).scaleDownAfterIdleSeconds;
    const idleFor = inst.lastUsedAt === null ? Infinity : now - inst.lastUsedAt;
    if (idleFor < threshold) continue;
    try {
      await args.client.patchDeploymentReplicas(
        args.namespace,
        inst.deploymentName,
        0,
      );
      setReplicas(inst.groupFolder, inst.capabilityName, 0);
      logger.info(
        {
          group: inst.groupFolder,
          capability: inst.capabilityName,
          idleSeconds: idleFor === Infinity ? -1 : idleFor,
        },
        'per_group_capability_scale_down',
      );
    } catch (err) {
      logger.warn(
        { err, deployment: inst.deploymentName },
        'sweepIdleInstances: scale-down failed',
      );
    }
  }
}

export interface SweeperLoopHandle {
  stop(): void;
}

export function startSweeperLoop(
  args: SweepArgs & { intervalMs: number },
): SweeperLoopHandle {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await sweepIdleInstances(args);
    } catch (err) {
      logger.warn({ err }, 'sweepIdleInstances threw');
    }
    if (!stopped)
      setTimeout(() => {
        void tick();
      }, args.intervalMs);
  };
  setTimeout(() => {
    void tick();
  }, args.intervalMs);
  return {
    stop() {
      stopped = true;
    },
  };
}
