import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { RagCapabilitySpec } from '../types.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const DEFAULT_PORT = 6333;
const DEFAULT_HEALTH_PATH = '/healthz';
const DEFAULT_STORAGE = { sizeGi: 20, mountPath: '/qdrant/storage' };

export function buildRagQdrantYaml(spec: RagCapabilitySpec): string {
  if (spec.backend !== 'qdrant') {
    throw new Error(`buildRagQdrantYaml called with backend=${spec.backend}`);
  }
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-rag-qdrant',
    image: spec.image,
    port: spec.port ?? DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath ?? DEFAULT_HEALTH_PATH,
    storage: spec.storage ?? DEFAULT_STORAGE,
    probe: spec.probe,
    scheduling: spec.scheduling,
    podSecurity: spec.podSecurity,
  });
}
