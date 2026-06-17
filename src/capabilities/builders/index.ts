import { KUBECLAW_NAMESPACE } from '../../config.js';
import type {
  CapabilitySpec,
  RagCapabilitySpec,
  TranscriptionCapabilitySpec,
} from '../types.js';
import { buildMcpYaml } from './mcp.js';
import { buildHttpYaml } from './http.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const RAG_DEFAULT_PORT = 6333;
const RAG_DEFAULT_STORAGE = { sizeGi: 20, mountPath: '/qdrant/storage' };
const RAG_DEFAULT_HEALTH_PATH = '/healthz';

const TRANSCRIPTION_DEFAULT_PORT = 9000;
const TRANSCRIPTION_DEFAULT_HEALTH_PATH = '/health';

function buildRagYaml(spec: RagCapabilitySpec): string {
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-rag',
    image: spec.image,
    port: spec.port ?? RAG_DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath ?? RAG_DEFAULT_HEALTH_PATH,
    storage: spec.storage ?? RAG_DEFAULT_STORAGE,
    probe: spec.probe,
    scheduling: spec.scheduling,
    podSecurity: spec.podSecurity,
  });
}

function buildTranscriptionYaml(spec: TranscriptionCapabilitySpec): string {
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-transcription',
    image: spec.image,
    port: spec.port ?? TRANSCRIPTION_DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath ?? TRANSCRIPTION_DEFAULT_HEALTH_PATH,
    storage: spec.storage,
    probe: spec.probe,
    scheduling: spec.scheduling,
    podSecurity: spec.podSecurity,
  });
}

export function buildYaml(spec: CapabilitySpec): string {
  switch (spec.kind) {
    case 'mcp':
      return buildMcpYaml(spec);
    case 'http':
      return buildHttpYaml(spec);
    case 'rag':
      return buildRagYaml(spec);
    case 'transcription':
      return buildTranscriptionYaml(spec);
    default: {
      const _exhaustive: never = spec;
      void _exhaustive;
      throw new Error('Unknown capability kind');
    }
  }
}
