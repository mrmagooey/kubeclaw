import os from 'os';
import path from 'path';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

// --- LLM Provider Configuration ---
export type KnownLLMProvider = 'claude' | 'openrouter';
export type LLMProvider = string; // open for extension; KnownLLMProvider for built-in dispatch

export interface LLMConfig {
  defaultProvider: LLMProvider;
  openrouter?: {
    model: string;
    baseUrl: string;
  };
}

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const KUBECLAW_MODE = (process.env.KUBECLAW_MODE || 'orchestrator') as 'orchestrator' | 'channel';
export const KUBECLAW_CHANNEL = process.env.KUBECLAW_CHANNEL || '';

export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// --- LLM Provider Configuration ---
export const DEFAULT_LLM_PROVIDER: LLMProvider =
  (process.env.DEFAULT_LLM_PROVIDER as LLMProvider) || 'openai';

export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

export const defaultLLMConfig: LLMConfig = {
  defaultProvider: DEFAULT_LLM_PROVIDER,
  openrouter: {
    model: OPENROUTER_MODEL,
    baseUrl: OPENROUTER_BASE_URL,
  },
};

// Container image selection based on LLM provider.
// Built-in providers map to known images; unknown providers look for a
// KUBECLAW_CONTAINER_IMAGE_<PROVIDER> env var and fall back to the claude image.
export function getContainerImage(provider: LLMProvider): string {
  if (provider === 'openrouter')
    return process.env.OPENROUTER_CONTAINER_IMAGE || 'kubeclaw-agent:openrouter';
  if (provider === 'claude')
    return process.env.CLAUDE_CONTAINER_IMAGE || 'kubeclaw-agent:claude';
  if (provider === 'openai')
    return process.env.OPENAI_CONTAINER_IMAGE || 'kubeclaw-agent:latest';
  const envKey = `KUBECLAW_CONTAINER_IMAGE_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return (
    process.env[envKey] ??
    process.env.KUBECLAW_CONTAINER_IMAGE ??
    'kubeclaw-agent:latest'
  );
}

/**
 * Validate if a provider string is a valid LLMProvider.
 * Returns the provider if valid (any non-empty string), null otherwise.
 */
export function validateProvider(
  provider: string | undefined | null,
): LLMProvider | null {
  return provider?.trim() || null;
}

/**
 * Check if OpenRouter configuration is present and valid.
 * Returns validation result with warnings if issues found.
 */
export function validateOpenRouterConfig(): {
  valid: boolean;
  hasKey: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const hasKey = !!process.env.OPENROUTER_API_KEY;

  if (!hasKey) {
    warnings.push('OPENROUTER_API_KEY is not set');
  } else {
    const key = process.env.OPENROUTER_API_KEY;
    // OpenRouter keys should start with 'sk-or-v1-'
    if (!key?.startsWith('sk-or-v1-')) {
      warnings.push(
        'OPENROUTER_API_KEY has unexpected format (should start with sk-or-v1-)',
      );
    }
  }

  // Validate model format if set
  const model = process.env.OPENROUTER_MODEL;
  if (model && !model.includes('/')) {
    warnings.push(
      `OPENROUTER_MODEL "${model}" should use "provider/model-name" format (e.g., "openai/gpt-4o")`,
    );
  }

  return {
    valid: hasKey,
    hasKey,
    warnings,
  };
}

/**
 * Validate and sanitize a group's provider preference.
 * Returns a valid provider or falls back to the default.
 */
export function sanitizeProvider(
  provider: string | undefined | null,
  defaultProvider: LLMProvider = DEFAULT_LLM_PROVIDER,
): LLMProvider {
  const validated = validateProvider(provider);
  if (validated) {
    return validated;
  }

  // Log warning if invalid provider was specified
  if (provider && provider !== '') {
    logger.warn(
      { provider, defaultProvider },
      'Invalid LLM provider specified, falling back to default',
    );
  }

  return defaultProvider;
}

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- Kubernetes Configuration ---
export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
export const KUBECLAW_NAMESPACE = process.env.KUBECLAW_NAMESPACE || 'default';
export const KUBECLAW_IPC_BASE =
  process.env.KUBECLAW_IPC_BASE || '/tmp/kubeclaw-ipc';

// --- Job Queue Configuration ---
export const MAX_CONCURRENT_JOBS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_JOBS || '10', 10) || 10,
);

// --- Redis ACL Configuration ---
export const REDIS_ADMIN_PASSWORD = process.env.REDIS_ADMIN_PASSWORD || '';
export const REDIS_USERNAME = process.env.REDIS_USERNAME || '';
export const REDIS_AGENT_PASSWORD = process.env.REDIS_AGENT_PASSWORD || '';
export const REDIS_TOOL_SERVER_PASSWORD = process.env.REDIS_TOOL_SERVER_PASSWORD || '';
export const REDIS_ADAPTER_PASSWORD = process.env.REDIS_ADAPTER_PASSWORD || '';
export const ACL_ENCRYPTION_KEY = process.env.ACL_ENCRYPTION_KEY || '';

// --- Tool Image Allowlist ---
// Comma-separated glob patterns for permitted sidecar tool pod images.
// Supports '*' wildcards (e.g. "kubeclaw-*:*,registry.example.com/*").
// If empty, any image is permitted (log a warning).
export const TOOL_IMAGE_ALLOWLIST: string[] =
  (process.env.TOOL_IMAGE_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Returns true if `image` matches `pattern`, where `*` is a wildcard for
 * any sequence of characters (including slashes and colons).
 */
function imageMatchesPattern(image: string, pattern: string): boolean {
  // Escape regex special chars except '*', then replace '*' with '.*'
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(image);
}

/**
 * Throws if `image` is not permitted by TOOL_IMAGE_ALLOWLIST.
 * A no-op (with a warning) when the allowlist is empty.
 */
export function assertToolImageAllowed(image: string): void {
  if (TOOL_IMAGE_ALLOWLIST.length === 0) {
    // No restriction configured — all images permitted.
    return;
  }
  const allowed = TOOL_IMAGE_ALLOWLIST.some((pattern) => imageMatchesPattern(image, pattern));
  if (!allowed) {
    throw new Error(
      `Tool image '${image}' is not in TOOL_IMAGE_ALLOWLIST. ` +
        `Permitted patterns: ${TOOL_IMAGE_ALLOWLIST.join(', ')}`,
    );
  }
}

// --- Agent Job Resource Limits (Kubernetes) ---
export const AGENT_JOB_MEMORY_REQUEST =
  process.env.AGENT_JOB_MEMORY_REQUEST || '512Mi';
export const AGENT_JOB_MEMORY_LIMIT =
  process.env.AGENT_JOB_MEMORY_LIMIT || '4Gi';
export const AGENT_JOB_CPU_REQUEST =
  process.env.AGENT_JOB_CPU_REQUEST || '250m';
export const AGENT_JOB_CPU_LIMIT = process.env.AGENT_JOB_CPU_LIMIT || '2000m';

// --- Sidecar Adapter Configuration ---
export const SIDECAR_ADAPTER_IMAGE =
  process.env.SIDECAR_ADAPTER_IMAGE || 'kubeclaw-sidecar-adapter:latest';
export const SIDECAR_POLL_INTERVAL = parseInt(
  process.env.SIDECAR_POLL_INTERVAL || '1000',
  10,
);
export const SIDECAR_ENABLED = process.env.KUBECLAW_SIDECAR_ENABLED === 'true';

// --- Sidecar HTTP Adapter Configuration ---
export const SIDECAR_HTTP_ADAPTER_IMAGE =
  process.env.SIDECAR_HTTP_ADAPTER_IMAGE || 'kubeclaw-http-adapter:latest';
export const SIDECAR_HTTP_REQUEST_TIMEOUT = 300000; // Fixed 5min
export const SIDECAR_HTTP_MAX_RETRIES = 3;
export const SIDECAR_HTTP_RETRY_DELAY = 1000; // Initial delay 1s
export const SIDECAR_HTTP_HEALTH_POLL_INTERVAL = 1000; // 1 second
export const SIDECAR_HTTP_HEALTH_POLL_TIMEOUT = 30000; // 30 seconds

// --- File Sidecar Configuration ---
export const SIDECAR_FILE_ADAPTER_IMAGE =
  process.env.SIDECAR_FILE_ADAPTER_IMAGE || 'kubeclaw-file-adapter:latest';
export const SIDECAR_FILE_POLL_INTERVAL = parseInt(
  process.env.SIDECAR_FILE_POLL_INTERVAL || '1000',
  10,
);

// --- Browser Sidecar Configuration ---
export const BROWSER_SIDECAR_IMAGE =
  process.env.BROWSER_SIDECAR_IMAGE || 'kubeclaw-browser-sidecar:latest';
export const BROWSER_SIDECAR_PORT = parseInt(
  process.env.BROWSER_SIDECAR_PORT || '9222',
  10,
);
export const BROWSER_SIDECAR_MEMORY_REQUEST =
  process.env.BROWSER_SIDECAR_MEMORY_REQUEST || '256Mi';
export const BROWSER_SIDECAR_MEMORY_LIMIT =
  process.env.BROWSER_SIDECAR_MEMORY_LIMIT || '1Gi';
export const BROWSER_SIDECAR_CPU_REQUEST =
  process.env.BROWSER_SIDECAR_CPU_REQUEST || '100m';
export const BROWSER_SIDECAR_CPU_LIMIT =
  process.env.BROWSER_SIDECAR_CPU_LIMIT || '500m';
