export interface K8sToleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

export interface K8sAffinity {
  nodeAffinity?: Record<string, unknown>;
  podAffinity?: Record<string, unknown>;
  podAntiAffinity?: Record<string, unknown>;
}

export interface ContainerSecurityContext {
  runAsUser?: number;
  runAsGroup?: number;
  runAsNonRoot?: boolean;
  readOnlyRootFilesystem?: boolean;
  allowPrivilegeEscalation?: boolean;
  fsGroup?: number;
}

export interface AdditionalMount {
  /** Volume type. Defaults to 'hostpath' for backward compatibility. */
  type?: 'hostpath' | 'configmap' | 'secret' | 'tmpfs';
  /** Absolute path on host (supports ~ for home). Required for type 'hostpath'. */
  hostPath?: string;
  /** Mount destination in container. Defaults to basename of hostPath / resource name. Mounted at /workspace/extra/{value} */
  containerPath?: string;
  readonly?: boolean; // Default: true for safety
  /** ConfigMap name. Required for type 'configmap'. */
  configMapName?: string;
  /** Secret name. Required for type 'secret'. */
  secretName?: string;
  /** Size limit for tmpfs (e.g. '512Mi'). Optional for type 'tmpfs'. */
  sizeLimit?: string;
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  // File sidecar configuration
  userImage?: string; // Container image for file-based sidecar mode
  userCommand?: string[]; // Command to run in user container
  userArgs?: string[]; // Arguments for user container command
  filePollInterval?: number; // Poll interval in ms (default: 1000)
  memoryRequest?: string; // K8s memory request (e.g., "512Mi")
  memoryLimit?: string; // K8s memory limit (e.g., "4Gi")
  cpuRequest?: string; // K8s CPU request (e.g., "250m")
  cpuLimit?: string; // K8s CPU limit (e.g., "2000m")
  browserSidecar?: boolean; // Run Chromium as a sidecar container (Kubernetes only)
  // Node scheduling
  nodeSelector?: Record<string, string>; // e.g. { "nvidia.com/gpu.present": "true" }
  tolerations?: K8sToleration[]; // For tainted nodes (spot, GPU, etc.)
  affinity?: K8sAffinity; // Pod/node affinity rules
  priorityClassName?: string; // K8s PriorityClass name
  // GPU / accelerator device requests
  deviceRequests?: Record<string, string>; // e.g. { "nvidia.com/gpu": "1" }
  // Private registry support
  imagePullSecrets?: string[]; // Names of K8s Secrets of type dockerconfigjson
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never'; // For user images
  // Security context
  securityContext?: ContainerSecurityContext;
}

export type LLMProvider = 'claude' | 'openrouter';

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  llmProvider?: LLMProvider; // Override default LLM provider for this group
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

// --- Redis ACL Types ---

export interface JobACL {
  jobId: string; // Primary key
  groupFolder: string; // For lookup
  username: string; // ACL username (sidecar-{jobId})
  password: string; // ACL password (encrypted at rest)
  createdAt: string; // ISO timestamp
  expiresAt: string; // ISO timestamp
  status: 'active' | 'revoked';
}
