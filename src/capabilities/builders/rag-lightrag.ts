import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { RagCapabilitySpec } from '../types.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const DEFAULT_PORT = 9621;
const DEFAULT_HEALTH_PATH = '/health';
const DEFAULT_STORAGE = { sizeGi: 20, mountPath: '/app/data' };

export function buildRagLightRagYaml(spec: RagCapabilitySpec): string {
  if (spec.backend !== 'lightrag') {
    throw new Error(`buildRagLightRagYaml called with backend=${spec.backend}`);
  }
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-rag-lightrag',
    image: spec.image,
    port: spec.port ?? DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath ?? DEFAULT_HEALTH_PATH,
    storage: spec.storage ?? DEFAULT_STORAGE,
  });
}
