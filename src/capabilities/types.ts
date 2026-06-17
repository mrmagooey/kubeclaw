/**
 * Unified Capability type system.
 *
 * A capability is a long-lived, low-priv pod the orchestrator manages on
 * behalf of channels. Every capability is declared as a CapabilitySpec
 * (a discriminated union by `kind`). The orchestrator persists the spec,
 * reconciles it to Kubernetes, health-probes the endpoint, and answers
 * channel discovery requests with a typed entry.
 */

export interface CapabilityResources {
  memoryRequest?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  /** Whole-number GPUs; renders nvidia.com/gpu into requests AND limits. */
  gpu?: number;
}

export interface CapabilityScheduling {
  nodeSelector?: Record<string, string>;
  /** Raw K8s toleration objects, rendered verbatim. */
  tolerations?: Array<Record<string, unknown>>;
  runtimeClassName?: string;
}

export interface CapabilityPodSecurity {
  runAsUser?: number;
  runAsGroup?: number;
  /** Pod-level fsGroup — required for stateful images to own a mounted PVC. */
  fsGroup?: number;
  runAsNonRoot?: boolean;
}

export interface CapabilityStorage {
  /** PVC size in GiB. */
  sizeGi: number;
  /** Container path the PVC mounts to. */
  mountPath: string;
}

export interface ProbeConfig {
  /** Probe mechanism. Default 'http'. */
  type?: 'http' | 'tcp';
  /** HTTP path (http type only). Default '/health'. */
  path?: string;
  /** Probe port. Default: the container port. */
  port?: number;
  /** Applies to BOTH readiness and liveness; unset keeps per-probe defaults. */
  initialDelaySeconds?: number;
  periodSeconds?: number;
  failureThreshold?: number;
  timeoutSeconds?: number;
  /** Optional startupProbe — guards liveness/readiness during warm-up. */
  startup?: {
    initialDelaySeconds?: number;
    periodSeconds?: number;
    failureThreshold?: number;
  };
}

export interface CapabilityBase {
  /** Cluster-unique identifier. Becomes part of the Deployment name. */
  name: string;
  /** Container image (with tag). */
  image: string;
  /** Container port the service exposes. Defaults set per kind. */
  port?: number;
  /** Plain env values. */
  env?: Record<string, string>;
  /** Names of K8s Secrets to envFrom. Each must already exist in the kubeclaw namespace. */
  envFromSecrets?: string[];
  /** ACL: empty/undefined = all channels. */
  channels?: string[];
  /** Resource requests/limits. */
  resources?: CapabilityResources;
  /** Optional PVC. */
  storage?: CapabilityStorage;
  /**
   * @deprecated Use `probe.path`. HTTP path the orchestrator probes for
   * liveness. Default: '/health'. Honored only when `probe` is absent.
   */
  healthPath?: string;
  /** Probe configuration. Overrides `healthPath` when present. */
  probe?: ProbeConfig;
  /** Optional command override. */
  command?: string[];
  /** Optional args. */
  args?: string[];
  /** Pod scheduling controls (GPU nodes, taints, runtime class). */
  scheduling?: CapabilityScheduling;
  /** Pod/container security context overrides. */
  podSecurity?: CapabilityPodSecurity;
  /** Deployment scope. Default 'cluster'. */
  scope?: 'cluster' | 'group';
  /** Group-scope only: seconds of idle before scale-to-zero. Min 60. Default 600. */
  scaleDownAfterIdleSeconds?: number;
  /** Group-scope only: mount the group's PVC subPath at /data inside the pod. */
  volumeFromGroupPvc?: boolean;
  /** Group-scope only: where per-group credentials come from. Default 'none'. */
  credentialsFrom?: 'none' | 'secret';
}

export interface McpCapabilitySpec extends CapabilityBase {
  kind: 'mcp';
  /** MCP endpoint path. Default: '/mcp'. */
  path?: string;
  /** Optional whitelist of tool names exposed by this MCP server. */
  allowedTools?: string[];
}

export interface RagCapabilitySpec extends CapabilityBase {
  kind: 'rag';
  /** RAG backend implementation. */
  backend: 'qdrant' | 'lightrag';
}

export interface HttpCapabilitySpec extends CapabilityBase {
  kind: 'http';
}

export type CapabilitySpec =
  | McpCapabilitySpec
  | RagCapabilitySpec
  | HttpCapabilitySpec;

export type CapabilityKind = CapabilitySpec['kind'];

/**
 * Persisted lifecycle status for a capability.
 * `pending`: in DB but reconciler hasn't deployed yet.
 * `ready`: most recent health probe succeeded.
 * `unhealthy`: most recent health probe failed.
 * `removing`: marked for deletion, K8s resources being torn down.
 */
export type CapabilityLifecycle =
  | 'pending'
  | 'ready'
  | 'unhealthy'
  | 'removing';

export interface CapabilityStatus {
  name: string;
  lifecycle: CapabilityLifecycle;
  /** ISO timestamp of the last health probe (success or failure). */
  lastProbeAt: string | null;
  /** Last probe error message, if any. */
  lastError: string | null;
}

/**
 * Entry returned to a channel via discovery. The kindMetadata field
 * carries kind-specific data (allowedTools for MCP, backend for RAG).
 *
 * `state` is unset for cluster-scoped capabilities (treat as `'ready'`).
 * Set explicitly for group-scoped discovery responses where the orchestrator
 * scaled a pod up on demand. `'warming'` is reserved for future non-blocking
 * variants — Phase A always blocks until ready or failed.
 */
export type CapabilityDiscoveryEntry =
  | {
      name: string;
      kind: 'mcp';
      endpoint: string;
      kindMetadata: { path: string; allowedTools?: string[] };
      state?: 'ready' | 'warming' | 'failed';
      error?: string;
    }
  | {
      name: string;
      kind: 'rag';
      endpoint: string;
      kindMetadata: { backend: 'qdrant' | 'lightrag' };
      state?: 'ready' | 'warming' | 'failed';
      error?: string;
    }
  | {
      name: string;
      kind: 'http';
      endpoint: string;
      kindMetadata: Record<string, never>;
      state?: 'ready' | 'warming' | 'failed';
      error?: string;
    }
  | GroupMcpEntry;

// Re-export from schema-cache so consumers don't need to know about
// per-group-capabilities/ to use this type.
export type { McpToolSchema } from '../per-group-capabilities/schema-cache.js';

/**
 * Discovery entry for a per-group MCP capability.
 *
 * Endpoint is intentionally absent — group-scoped capabilities resolve their
 * endpoint per-call via the discovery RPC (orchestrator scales the per-group
 * Deployment up on demand). Tool schemas come from the orchestrator-side
 * scrape cache.
 */
export interface GroupMcpEntry {
  name: string;
  kind: 'mcp-group';
  /** Lifecycle state of the orchestrator-side schema scrape. */
  state: 'ready' | 'pending-schema' | 'failed';
  /** Present iff state === 'ready'. */
  toolSchemas?: import('../per-group-capabilities/schema-cache.js').McpToolSchema[];
  /** Optional filter declared on the capability spec. */
  allowedTools?: string[];
  /** Present iff state === 'failed'. */
  error?: string;
}
