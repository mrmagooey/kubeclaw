import type { V1Secret } from '@kubernetes/client-node';
import type { PerGroupK8sClient } from './k8s-client.js';
import { groupHash } from './hash.js';
import { credsSecretName } from './k8s-objects.js';

export interface SetCredentialArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
  capabilityName: string;
  envName: string;
  value: string;
}

export interface UnsetCredentialArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
  capabilityName: string;
  envName: string;
}

function labels(capabilityName: string, hash: string): Record<string, string> {
  return {
    'kubeclaw.io/scope': 'group',
    'kubeclaw.io/capability': capabilityName,
    'kubeclaw.io/group-hash': hash,
    'kubeclaw.io/managed-by': 'kubeclaw-orchestrator',
  };
}

export async function setGroupCredential(args: SetCredentialArgs): Promise<void> {
  const hash = groupHash(args.groupFolder);
  const name = credsSecretName(args.capabilityName, hash);
  const existing = await args.client.readSecret(args.namespace, name);
  const data = { ...(existing?.data ?? {}) };
  data[args.envName] = Buffer.from(args.value).toString('base64');
  const sec: V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace: args.namespace,
      labels: labels(args.capabilityName, hash),
    },
    type: 'Opaque',
    data,
  };
  await args.client.applySecret(sec);
}

export async function unsetGroupCredential(args: UnsetCredentialArgs): Promise<void> {
  const hash = groupHash(args.groupFolder);
  const name = credsSecretName(args.capabilityName, hash);
  const existing = await args.client.readSecret(args.namespace, name);
  if (!existing) return;
  const data = { ...(existing.data ?? {}) };
  delete data[args.envName];
  if (Object.keys(data).length === 0) {
    await args.client.deleteSecret(args.namespace, name);
    return;
  }
  await args.client.applySecret({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: existing.metadata,
    type: 'Opaque',
    data,
  });
}
