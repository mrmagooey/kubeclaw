/**
 * Redis ACL Manager for sidecar containers
 * Manages dynamic ACL users for job-specific Redis access
 */
import crypto from 'crypto';
import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import {
  storeJobACL,
  getJobACL,
  getJobACLByGroup,
  revokeJobACL,
  cleanupExpiredACLs,
} from '../db.js';
import { JobACL } from '../types.js';
import {
  REDIS_ADMIN_PASSWORD,
  ACL_ENCRYPTION_KEY,
  REDIS_URL,
} from '../config.js';

const REDIS_MAJOR_VERSION_REQUIRED = 7;

export class RedisACLManager {
  private redis: Redis | null = null;
  private initialized = false;

  constructor() {
    // Lazy initialization - connect only when needed
  }

  /**
   * Initialize the Redis connection with admin credentials
   */
  private async ensureConnection(): Promise<Redis> {
    if (this.redis && this.initialized) {
      return this.redis;
    }

    const url = new URL(REDIS_URL);
    const host = url.hostname;
    const port = parseInt(url.port || '6379', 10);

    this.redis = new Redis({
      host,
      port,
      password: REDIS_ADMIN_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        logger.debug({ attempt: times, delay }, 'ACL Redis retry');
        return delay;
      },
    });

    this.redis.on('error', (err) => {
      logger.error({ error: err.message }, 'ACL Redis connection error');
    });

    this.initialized = true;
    logger.info('ACL Redis connection established');
    return this.redis;
  }

  /**
   * Verify Redis version is 7+ for ACL support
   * @throws Error if Redis version is too old
   */
  async verifyRedisVersion(): Promise<void> {
    const redis = await this.ensureConnection();
    const info = await redis.info('server');
    const versionMatch = info.match(/redis_version:(\d+)\.(\d+)\.(\d+)/);

    if (!versionMatch) {
      throw new Error('Could not determine Redis version from INFO');
    }

    const majorVersion = parseInt(versionMatch[1], 10);

    if (majorVersion < REDIS_MAJOR_VERSION_REQUIRED) {
      throw new Error(
        `Redis version ${majorVersion}.x is not supported. Redis ${REDIS_MAJOR_VERSION_REQUIRED}+ required for ACL support.`,
      );
    }

    logger.info(
      { version: versionMatch[0].replace('redis_version:', '') },
      'Redis version verified',
    );
  }

  /**
   * Create a new ACL user for a job
   * @param jobId Unique job identifier
   * @param groupFolder Group folder for lookup
   * @param ttlSeconds TTL for the ACL (default: 1 hour)
   */
  async createJobACL(
    jobId: string,
    groupFolder: string,
    ttlSeconds: number = 3600,
  ): Promise<void> {
    await this.verifyRedisVersion();

    const username = `sidecar-${jobId}`;
    const password = this.generatePassword();
    const encryptedPassword = this.encryptPassword(password);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const acl: JobACL = {
      jobId,
      groupFolder,
      username,
      password: encryptedPassword,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
    };

    const redis = await this.ensureConnection();

    // Build ACL rules - job-specific keys only
    const keyPattern = `kubeclaw:*:${jobId}`;
    const aclRules = [
      `~${keyPattern}`,
      '+@read',
      '+@write',
      '+@stream',
      '+@pubsub',
      '-@admin',
      '-@dangerous',
    ];

    try {
      // Create the ACL user
      await redis.acl('SETUSER', username, 'on', `>${password}`, ...aclRules);
      logger.info({ jobId, username, groupFolder }, 'Created ACL user for job');

      // Store in SQLite
      storeJobACL(acl);
      logger.debug({ jobId }, 'Stored ACL credentials in database');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error({ jobId, error: errorMessage }, 'Failed to create ACL user');
      throw new Error(`Failed to create ACL user: ${errorMessage}`);
    }
  }

  /**
   * Get credentials for a job
   * @returns Username and decrypted password, or null if not found
   */
  getJobCredentials(
    jobId: string,
  ): { username: string; password: string } | null {
    const acl = getJobACL(jobId);

    if (!acl || acl.status !== 'active') {
      return null;
    }

    // Check if expired
    if (new Date(acl.expiresAt) < new Date()) {
      logger.warn({ jobId }, 'ACL credentials expired');
      return null;
    }

    try {
      const password = this.decryptPassword(acl.password);
      return {
        username: acl.username,
        password,
      };
    } catch (error) {
      logger.error({ jobId, error }, 'Failed to decrypt ACL password');
      return null;
    }
  }

  /**
   * Revoke ACL for a job (removes from Redis and marks as revoked in DB)
   */
  async revokeJobACL(jobId: string): Promise<void> {
    const acl = getJobACL(jobId);

    if (!acl) {
      logger.warn({ jobId }, 'No ACL found to revoke');
      return;
    }

    try {
      const redis = await this.ensureConnection();
      await redis.acl('DELUSER', acl.username);
      logger.info(
        { jobId, username: acl.username },
        'Removed ACL user from Redis',
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        { jobId, error: errorMessage },
        'Failed to remove ACL user from Redis',
      );
      // Continue to mark as revoked in DB even if Redis removal fails
    }

    revokeJobACL(jobId);
    logger.info({ jobId }, 'Marked ACL as revoked in database');
  }

  /**
   * Clean up expired ACLs
   * @returns Array of revoked job IDs
   */
  async cleanupExpired(): Promise<string[]> {
    const expiredJobIds = cleanupExpiredACLs();

    if (expiredJobIds.length === 0) {
      return [];
    }

    logger.info({ count: expiredJobIds.length }, 'Cleaning up expired ACLs');

    const redis = await this.ensureConnection();
    const failedDeletions: string[] = [];

    for (const jobId of expiredJobIds) {
      const acl = getJobACL(jobId);
      if (acl && acl.status === 'revoked') {
        try {
          await redis.acl('DELUSER', acl.username);
          logger.debug(
            { jobId, username: acl.username },
            'Removed expired ACL user',
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            { jobId, error: errorMessage },
            'Failed to remove expired ACL user',
          );
          failedDeletions.push(jobId);
        }
      }
    }

    if (failedDeletions.length > 0) {
      logger.warn(
        { count: failedDeletions.length },
        'Some expired ACLs could not be removed from Redis',
      );
    }

    return expiredJobIds;
  }

  /**
   * Close the Redis connection
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.initialized = false;
      logger.info('ACL Redis connection closed');
    }
  }

  /**
   * Generate a secure random password
   */
  private generatePassword(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Encrypt a password using AES-256-GCM
   */
  private encryptPassword(password: string): string {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(password, 'utf8', 'base64url');
    encrypted += cipher.final('base64url');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    return `${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted}`;
  }

  /**
   * Decrypt a password using AES-256-GCM
   */
  private decryptPassword(encryptedData: string): string {
    const key = this.getEncryptionKey();
    const parts = encryptedData.split(':');

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted password format');
    }

    const [ivBase64, authTagBase64, encrypted] = parts;
    const iv = Buffer.from(ivBase64, 'base64url');
    const authTag = Buffer.from(authTagBase64, 'base64url');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'base64url', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Get or derive the encryption key
   */
  private getEncryptionKey(): Buffer {
    if (!ACL_ENCRYPTION_KEY) {
      logger.warn(
        'ACL_ENCRYPTION_KEY not set, using derived key - this is insecure!',
      );
      // Derive a key from a constant for development only
      return crypto.scryptSync('kubeclaw-default-key', 'salt', 32);
    }

    // Use the provided key, hash it to ensure 32 bytes
    return crypto.createHash('sha256').update(ACL_ENCRYPTION_KEY).digest();
  }
}

// Singleton instance
let aclManagerInstance: RedisACLManager | null = null;

export function getACLManager(): RedisACLManager {
  if (!aclManagerInstance) {
    aclManagerInstance = new RedisACLManager();
  }
  return aclManagerInstance;
}

export function resetACLManager(): void {
  aclManagerInstance = null;
}
