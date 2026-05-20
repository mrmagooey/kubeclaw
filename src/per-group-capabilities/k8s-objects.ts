import type {
  V1Deployment,
  V1Service,
  V1NetworkPolicy,
  V1Secret,
} from '@kubernetes/client-node';
import type { CapabilitySpec } from '../capabilities/types.js';
import { resolveGroupCapability } from './types.js';

export const COMMON_LABELS_KEYS = [
  'kubeclaw.io/scope',
  'kubeclaw.io/capability',
  'kubeclaw.io/group-hash',
  'kubeclaw.io/managed-by',
] as const;

export interface RenderContext {
  groupFolder: string;
  groupHash: string;
  namespace: string;
  /** Name of the shared PVC that holds all groups. */
  groupsPvcName: string;
}

export function instanceName(
  capabilityName: string,
  groupHash: string,
): string {
  return `mcp-${capabilityName}-${groupHash}`;
}

export function credsSecretName(
  capabilityName: string,
  groupHash: string,
): string {
  return `${instanceName(capabilityName, groupHash)}-creds`;
}

function commonLabels(
  spec: CapabilitySpec,
  ctx: RenderContext,
): Record<string, string> {
  return {
    'kubeclaw.io/scope': 'group',
    'kubeclaw.io/capability': spec.name,
    'kubeclaw.io/group-hash': ctx.groupHash,
    'kubeclaw.io/managed-by': 'kubeclaw-orchestrator',
  };
}

export function renderDeployment(
  spec: CapabilitySpec,
  ctx: RenderContext,
): V1Deployment {
  const resolved = resolveGroupCapability(spec);
  const name = instanceName(spec.name, ctx.groupHash);
  const port = spec.port ?? 3000;
  const labels = commonLabels(spec, ctx);

  const env = Object.entries(spec.env ?? {}).map(([k, v]) => ({
    name: k,
    value: v,
  }));
  const envFrom =
    resolved.credentialsFrom === 'secret'
      ? [
          {
            secretRef: {
              name: credsSecretName(spec.name, ctx.groupHash),
              optional: true,
            },
          },
        ]
      : undefined;

  const volumeMounts = resolved.volumeFromGroupPvc
    ? [
        {
          name: 'groups',
          mountPath: '/data',
          subPath: `groups/${ctx.groupFolder}`,
        },
      ]
    : [];

  const volumes = resolved.volumeFromGroupPvc
    ? [
        {
          name: 'groups',
          persistentVolumeClaim: { claimName: ctx.groupsPvcName },
        },
      ]
    : [];

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: ctx.namespace, labels },
    spec: {
      replicas: 0,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'mcp',
              image: spec.image,
              ports: [{ containerPort: port }],
              ...(spec.command ? { command: spec.command } : {}),
              ...(spec.args ? { args: spec.args } : {}),
              env,
              envFrom,
              volumeMounts,
              readinessProbe: {
                httpGet: { path: '/health', port },
                initialDelaySeconds: 1,
                periodSeconds: 2,
                failureThreshold: 15,
              },
              resources: {
                requests: {
                  memory: spec.resources?.memoryRequest ?? '64Mi',
                  cpu: spec.resources?.cpuRequest ?? '50m',
                },
                limits: {
                  memory: spec.resources?.memoryLimit ?? '256Mi',
                  cpu: spec.resources?.cpuLimit ?? '500m',
                },
              },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                allowPrivilegeEscalation: false,
              },
            },
          ],
          volumes,
        },
      },
    },
  };
}

export function renderService(
  spec: CapabilitySpec,
  ctx: RenderContext,
): V1Service {
  const name = instanceName(spec.name, ctx.groupHash);
  const port = spec.port ?? 3000;
  const labels = commonLabels(spec, ctx);
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: ctx.namespace, labels },
    spec: {
      selector: labels,
      ports: [{ port, targetPort: port, protocol: 'TCP' }],
      type: 'ClusterIP',
    },
  };
}

export function renderNetworkPolicy(
  spec: CapabilitySpec,
  ctx: RenderContext,
): V1NetworkPolicy {
  const name = instanceName(spec.name, ctx.groupHash);
  const port = spec.port ?? 3000;
  const labels = commonLabels(spec, ctx);
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace: ctx.namespace, labels },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          _from: [
            { podSelector: { matchLabels: { 'kubeclaw.io/role': 'channel' } } },
            {
              podSelector: {
                matchLabels: { 'kubeclaw.io/role': 'orchestrator' },
              },
            },
          ],
          ports: [{ protocol: 'TCP', port }],
        },
      ],
      egress: [
        {
          to: [
            { podSelector: { matchLabels: { 'kubeclaw.io/role': 'redis' } } },
          ],
          ports: [{ protocol: 'TCP', port: 6379 }],
        },
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
              },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    },
  };
}

export function renderEmptySecret(
  spec: CapabilitySpec,
  ctx: RenderContext,
): V1Secret {
  const name = credsSecretName(spec.name, ctx.groupHash);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace: ctx.namespace,
      labels: commonLabels(spec, ctx),
    },
    type: 'Opaque',
    data: {},
  };
}
