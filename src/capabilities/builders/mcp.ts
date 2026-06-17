import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { McpCapabilitySpec } from '../types.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const DEFAULT_PORT = 3000;

export function buildMcpYaml(spec: McpCapabilitySpec): string {
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-mcp',
    image: spec.image,
    port: spec.port ?? DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath,
    probe: spec.probe,
    scheduling: spec.scheduling,
    podSecurity: spec.podSecurity,
  });
}
