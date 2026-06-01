/**
 * E2E Redis Helper
 *
 * Executes Redis commands inside the minikube Redis pod using kubectl exec.
 * This ensures ACL users are created in the cluster Redis that jobs connect to.
 */
import { execSync } from 'child_process';
import { getNamespace } from '../setup.js';

const NAMESPACE = getNamespace();
const REDIS_POD = 'kubeclaw-redis-0';

/**
 * Parse Redis admin credentials from KUBECLAW_REDIS_URL set by global-setup.
 * Handles both:
 *   redis://:password@host:port        (no username — legacy format)
 *   redis://username:password@host:port (with username — standard URL format)
 */
function getAdminCredentials(): { username: string; password: string } {
  const raw = process.env.KUBECLAW_REDIS_URL || process.env.REDIS_URL || '';
  try {
    const parsed = new URL(raw);
    return {
      username: parsed.username || '',
      password: parsed.password || '',
    };
  } catch {
    // Fallback: plain regex for malformed URLs
    const match = raw.match(/redis:\/\/(?:([^:@]+):)?([^@]+)@/);
    return {
      username: match?.[1] || '',
      password: match?.[2] || '',
    };
  }
}

/**
 * Execute a Redis CLI command inside the minikube Redis pod (authenticated).
 * Throws if Redis returns an error response (e.g. NOAUTH, WRONGPASS, ERR).
 */
export function execRedisCommand(command: string): string {
  const { username, password } = getAdminCredentials();
  const authArgs =
    username && password
      ? `--user ${username} -a ${password}`
      : password
        ? `-a ${password}`
        : '';
  try {
    const result = execSync(
      `kubectl exec -n ${NAMESPACE} ${REDIS_POD} -- redis-cli ${authArgs} ${command}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    ).trim();
    // redis-cli exits 0 even when Redis returns an error response. Detect and
    // surface those failures so callers don't silently swallow them.
    if (/^\(error\)\s/.test(result)) {
      throw new Error(`Redis returned error: ${result}`);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Redis command failed: ${message}`);
  }
}

/**
 * Execute a Redis CLI command with AUTH
 */
export function execRedisCommandAuth(
  command: string,
  username?: string,
  password?: string,
): string {
  let authFlag = '';
  if (username && password) {
    authFlag = `--user ${username} --pass ${password}`;
  } else if (password) {
    authFlag = `-a ${password}`;
  }

  try {
    const result = execSync(
      `kubectl exec -n ${NAMESPACE} ${REDIS_POD} -- redis-cli ${authFlag} ${command}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
    return result.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Redis command failed: ${message}`);
  }
}

/**
 * Create an ACL user for a job in the cluster Redis
 */
export function createClusterACLUser(
  jobId: string,
  password: string,
  groupFolder: string,
): void {
  const username = `sidecar-${jobId}`;
  const keyPattern = `kubeclaw:*:${jobId}`;
  // In Redis 7+, channel access is controlled separately from key access.
  // Adapters publish job output to kubeclaw:messages:{groupFolder} so we
  // must grant access to that channel (not a job-id-specific channel).
  const channelPattern = `kubeclaw:messages:${groupFolder}`;

  // Build ACL SETUSER command - password must be quoted to prevent shell interpretation
  const aclCommand = `ACL SETUSER ${username} on ">${password}" "~${keyPattern}" "&${channelPattern}" +@read +@write +@stream +@pubsub -@admin -@dangerous`;

  execRedisCommand(aclCommand);
}

/**
 * Delete an ACL user from the cluster Redis
 */
export function deleteClusterACLUser(jobId: string): void {
  const username = `sidecar-${jobId}`;
  try {
    execRedisCommand(`ACL DELUSER ${username}`);
  } catch {
    // User might not exist, ignore error
  }
}

/**
 * Verify Redis version in the cluster
 */
export function verifyClusterRedisVersion(): void {
  const info = execRedisCommand('INFO server');
  const versionMatch = info.match(/redis_version:(\d+)\.(\d+)\.(\d+)/);

  if (!versionMatch) {
    throw new Error('Could not determine Redis version from cluster');
  }

  const majorVersion = parseInt(versionMatch[1], 10);
  if (majorVersion < 7) {
    throw new Error(
      `Cluster Redis version ${majorVersion}.x is not supported. Redis 7+ required for ACL support.`,
    );
  }
}

/**
 * Get credentials for e2e tests - uses kubectl exec instead of direct Redis connection
 * This ensures we're using the same Redis instance as the jobs
 */
export function getE2ERedisCredentials(jobId: string): {
  username: string;
  password: string;
  keyPattern: string;
} {
  return {
    username: `sidecar-${jobId}`,
    password: generateTestPassword(),
    keyPattern: `kubeclaw:*:${jobId}`,
  };
}

/**
 * Generate a test password
 */
function generateTestPassword(): string {
  // Use only alphanumeric characters to avoid shell escaping issues
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < 32; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * Clean up test ACL users matching a pattern
 */
export function cleanupTestACLUsers(pattern: string = 'sidecar-*'): void {
  try {
    const users = execRedisCommand('ACL LIST');
    const testUsers = users
      .split('\n')
      .filter((line) => line.includes(pattern))
      .map((line) => {
        const match = line.match(/user:(\S+)/);
        return match ? match[1] : null;
      })
      .filter((user): user is string => user !== null);

    for (const username of testUsers) {
      try {
        execRedisCommand(`ACL DELUSER ${username}`);
      } catch {
        // Ignore errors
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clean up test keys matching a pattern
 */
export function cleanupTestKeys(pattern: string = 'kubeclaw:*'): void {
  try {
    const keys = execRedisCommand(`KEYS ${pattern}`);
    if (keys && keys !== '(empty array)') {
      const keyList = keys.split('\n').filter((k) => k);
      if (keyList.length > 0) {
        execRedisCommand(`DEL ${keyList.join(' ')}`);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}
