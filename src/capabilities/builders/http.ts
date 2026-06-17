import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { HttpCapabilitySpec } from '../types.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const DEFAULT_PORT = 8080;

export function buildHttpYaml(spec: HttpCapabilitySpec): string {
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-http',
    image: spec.image,
    port: spec.port ?? DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath,
    storage: spec.storage,
    probe: spec.probe,
    scheduling: spec.scheduling,
    podSecurity: spec.podSecurity,
  });
}
