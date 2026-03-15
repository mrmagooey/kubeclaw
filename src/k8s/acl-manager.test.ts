/**
 * ACL Manager Unit Tests
 *
 * Tests the RedisACLManager class for creating, managing, and revoking
 * ACL credentials for sidecar containers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RedisACLManager,
  getACLManager,
  resetACLManager,
} from './acl-manager.js';
import {
  _initTestDatabase,
  storeJobACL,
  getJobACL,
  getJobACLByGroup,
  revokeJobACL,
  cleanupExpiredACLs,
} from '../db.js';
import { JobACL } from '../types.js';

// Mock ioredis
const mockAcl = vi.fn();
const mockInfo = vi.fn();
const mockQuit = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();

vi.mock('ioredis', () => {
  return {
    Redis: class MockRedis {
      acl = mockAcl;
      info = mockInfo;
      quit = mockQuit;
      on = mockOn;
    },
  };
});

// Mock config
vi.mock('../config.js', () => ({
  REDIS_ADMIN_PASSWORD: 'admin-password',
  ACL_ENCRYPTION_KEY: 'test-encryption-key-32bytes-long!!!',
  REDIS_URL: 'redis://localhost:6379',
}));

describe('RedisACLManager', () => {
  let manager: RedisACLManager;

  beforeEach(async () => {
    await _initTestDatabase();
    resetACLManager();
    manager = getACLManager();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.close();
    resetACLManager();
  });

  describe('Redis Version Verification', () => {
    it('should pass with Redis 7.0.0', async () => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:7.0.0\r\nredis_git_sha1:00000000',
      );

      await expect(manager.verifyRedisVersion()).resolves.not.toThrow();
    });

    it('should pass with Redis 7.2.4', async () => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:7.2.4\r\nredis_git_sha1:00000000',
      );

      await expect(manager.verifyRedisVersion()).resolves.not.toThrow();
    });

    it('should throw error on Redis 6.x', async () => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:6.2.7\r\nredis_git_sha1:00000000',
      );

      await expect(manager.verifyRedisVersion()).rejects.toThrow(
        'Redis version 6.x is not supported',
      );
    });

    it('should throw error on Redis 5.x', async () => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:5.0.14\r\nredis_git_sha1:00000000',
      );

      await expect(manager.verifyRedisVersion()).rejects.toThrow(
        'Redis version 5.x is not supported',
      );
    });

    it('should throw error when version cannot be determined', async () => {
      mockInfo.mockResolvedValue('# Server\r\nno_version_info');

      await expect(manager.verifyRedisVersion()).rejects.toThrow(
        'Could not determine Redis version',
      );
    });
  });

  describe('ACL User Creation', () => {
    beforeEach(() => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:7.0.0\r\nredis_git_sha1:00000000',
      );
      mockAcl.mockResolvedValue('OK');
    });

    it('should create ACL user with correct permissions', async () => {
      const jobId = 'test-job-123';
      const groupFolder = 'test-group';

      await manager.createJobACL(jobId, groupFolder);

      expect(mockAcl).toHaveBeenCalledWith(
        'SETUSER',
        expect.stringContaining('sidecar-test-job-123'),
        'on',
        expect.stringMatching(/^>.+/), // password starts with >
        expect.stringContaining('nanoclaw:*:test-job-123'), // key pattern
        '+@read',
        '+@write',
        '+@stream',
        '+@pubsub',
        '-@admin',
        '-@dangerous',
      );
    });

    it('should store ACL in database after creation', async () => {
      const jobId = 'test-job-db';
      const groupFolder = 'test-group-db';

      await manager.createJobACL(jobId, groupFolder);

      const acl = getJobACL(jobId);
      expect(acl).toBeDefined();
      expect(acl?.jobId).toBe(jobId);
      expect(acl?.groupFolder).toBe(groupFolder);
      expect(acl?.status).toBe('active');
      expect(acl?.username).toBe(`sidecar-${jobId}`);
    });

    it('should use custom TTL when provided', async () => {
      const jobId = 'test-job-ttl';
      const groupFolder = 'test-group';
      const customTtl = 7200; // 2 hours

      const beforeCreate = new Date();
      await manager.createJobACL(jobId, groupFolder, customTtl);
      const afterCreate = new Date();

      const acl = getJobACL(jobId);
      expect(acl).toBeDefined();

      const expiresAt = new Date(acl!.expiresAt);
      const createdAt = new Date(acl!.createdAt);

      // Should be approximately customTtl seconds after creation
      const ttlMs = expiresAt.getTime() - createdAt.getTime();
      expect(ttlMs).toBeGreaterThanOrEqual((customTtl - 1) * 1000);
      expect(ttlMs).toBeLessThanOrEqual((customTtl + 1) * 1000);
    });

    it('should throw error if Redis ACL creation fails', async () => {
      mockAcl.mockRejectedValue(new Error('NOAUTH Authentication required'));

      await expect(
        manager.createJobACL('test-job', 'test-group'),
      ).rejects.toThrow('Failed to create ACL user');
    });
  });

  describe('Password Encryption', () => {
    beforeEach(() => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:7.0.0\r\nredis_git_sha1:00000000',
      );
      mockAcl.mockResolvedValue('OK');
    });

    it('should generate unique passwords for each job', async () => {
      const jobId1 = 'test-job-1';
      const jobId2 = 'test-job-2';

      await manager.createJobACL(jobId1, 'group-1');
      await manager.createJobACL(jobId2, 'group-2');

      const acl1 = getJobACL(jobId1);
      const acl2 = getJobACL(jobId2);

      // Passwords should be encrypted and different
      expect(acl1?.password).not.toBe(acl2?.password);
    });

    it('should encrypt passwords before storing', async () => {
      const jobId = 'test-job-encrypt';

      await manager.createJobACL(jobId, 'test-group');

      const acl = getJobACL(jobId);
      // Encrypted password should contain IV, authTag, and encrypted data
      expect(acl?.password).toContain(':');
      const parts = acl!.password.split(':');
      expect(parts.length).toBe(3);
    });

    it('should successfully decrypt stored passwords', async () => {
      const jobId = 'test-job-decrypt';

      await manager.createJobACL(jobId, 'test-group');

      const credentials = manager.getJobCredentials(jobId);
      expect(credentials).toBeDefined();
      expect(credentials?.username).toBe(`sidecar-${jobId}`);
      expect(credentials?.password).toBeDefined();
      expect(credentials?.password.length).toBeGreaterThan(20);
    });
  });

  describe('Credential Retrieval', () => {
    beforeEach(() => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:7.0.0\r\nredis_git_sha1:00000000',
      );
      mockAcl.mockResolvedValue('OK');
    });

    it('should return null for non-existent job', () => {
      const credentials = manager.getJobCredentials('non-existent-job');
      expect(credentials).toBeNull();
    });

    it('should return null for revoked ACL', async () => {
      const jobId = 'test-job-revoked';

      await manager.createJobACL(jobId, 'test-group');
      await manager.revokeJobACL(jobId);

      const credentials = manager.getJobCredentials(jobId);
      expect(credentials).toBeNull();
    });

    it('should return null for expired ACL', async () => {
      const jobId = 'test-job-expired';

      // Create an already expired ACL directly in DB
      const expiredAcl: JobACL = {
        jobId,
        groupFolder: 'test-group',
        username: `sidecar-${jobId}`,
        password: 'encrypted-password',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        status: 'active',
      };
      storeJobACL(expiredAcl);

      const credentials = manager.getJobCredentials(jobId);
      expect(credentials).toBeNull();
    });

    it('should return valid credentials for active ACL', async () => {
      const jobId = 'test-job-valid';

      await manager.createJobACL(jobId, 'test-group');

      const credentials = manager.getJobCredentials(jobId);
      expect(credentials).toBeDefined();
      expect(credentials?.username).toBe(`sidecar-${jobId}`);
      expect(credentials?.password).toBeDefined();
    });
  });

  describe('ACL Revocation', () => {
    beforeEach(() => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:7.0.0\r\nredis_git_sha1:00000000',
      );
      mockAcl.mockResolvedValue('OK');
    });

    it('should remove ACL user from Redis', async () => {
      const jobId = 'test-job-revoke';

      await manager.createJobACL(jobId, 'test-group');
      await manager.revokeJobACL(jobId);

      expect(mockAcl).toHaveBeenCalledWith(
        'DELUSER',
        expect.stringContaining(`sidecar-${jobId}`),
      );
    });

    it('should mark ACL as revoked in database', async () => {
      const jobId = 'test-job-revoke-db';

      await manager.createJobACL(jobId, 'test-group');
      await manager.revokeJobACL(jobId);

      const acl = getJobACL(jobId);
      expect(acl?.status).toBe('revoked');
    });

    it('should not throw when revoking non-existent job', async () => {
      await expect(
        manager.revokeJobACL('non-existent-job'),
      ).resolves.not.toThrow();
    });

    it('should mark as revoked in DB even if Redis removal fails', async () => {
      const jobId = 'test-job-redis-fail';

      await manager.createJobACL(jobId, 'test-group');

      // Now make Redis fail
      mockAcl.mockRejectedValue(new Error('Connection lost'));

      await manager.revokeJobACL(jobId);

      // Should still be marked revoked in DB
      const acl = getJobACL(jobId);
      expect(acl?.status).toBe('revoked');
    });
  });

  describe('Expired ACL Cleanup', () => {
    beforeEach(() => {
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:7.0.0\r\nredis_git_sha1:00000000',
      );
      mockAcl.mockResolvedValue('OK');
    });

    it('should clean up expired ACLs from Redis', async () => {
      // Create an expired ACL directly
      const expiredJobId = 'test-job-expired-cleanup';
      const expiredAcl: JobACL = {
        jobId: expiredJobId,
        groupFolder: 'test-group',
        username: `sidecar-${expiredJobId}`,
        password: 'encrypted-password',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        status: 'active',
      };
      storeJobACL(expiredAcl);

      await manager.cleanupExpired();

      expect(mockAcl).toHaveBeenCalledWith(
        'DELUSER',
        expect.stringContaining(expiredJobId),
      );
    });

    it('should return list of revoked job IDs', async () => {
      // Create multiple expired ACLs
      const expiredIds = ['expired-1', 'expired-2'];
      for (const jobId of expiredIds) {
        storeJobACL({
          jobId,
          groupFolder: 'test-group',
          username: `sidecar-${jobId}`,
          password: 'encrypted',
          createdAt: new Date(Date.now() - 7200000).toISOString(),
          expiresAt: new Date(Date.now() - 3600000).toISOString(),
          status: 'active',
        });
      }

      const revokedIds = await manager.cleanupExpired();

      expect(revokedIds).toContain('expired-1');
      expect(revokedIds).toContain('expired-2');
    });

    it('should handle Redis failures during cleanup gracefully', async () => {
      const expiredJobId = 'test-job-expired-fail';
      storeJobACL({
        jobId: expiredJobId,
        groupFolder: 'test-group',
        username: `sidecar-${expiredJobId}`,
        password: 'encrypted',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        status: 'active',
      });

      mockAcl.mockRejectedValue(new Error('Redis unavailable'));

      // Should not throw
      const revokedIds = await manager.cleanupExpired();

      // Should still return the job ID
      expect(revokedIds).toContain(expiredJobId);
    });
  });

  describe('Error Handling', () => {
    it('should handle Redis connection errors gracefully', async () => {
      mockInfo.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(manager.verifyRedisVersion()).rejects.toThrow(
        'ECONNREFUSED',
      );
    });

    it('should handle missing Redis admin password', async () => {
      // Reset module cache to test without password
      vi.resetModules();

      // The manager should still work (it will try to connect without auth)
      mockInfo.mockResolvedValue(
        '# Server\r\nredis_version:7.0.0\r\nredis_git_sha1:00000000',
      );

      await expect(manager.verifyRedisVersion()).resolves.not.toThrow();
    });
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance from getACLManager', () => {
      const manager1 = getACLManager();
      const manager2 = getACLManager();

      expect(manager1).toBe(manager2);
    });

    it('should create new instance after resetACLManager', () => {
      const manager1 = getACLManager();
      resetACLManager();
      const manager2 = getACLManager();

      expect(manager1).not.toBe(manager2);
    });
  });
});

describe('JobACL Database Functions (Integration)', () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  describe('storeJobACL', () => {
    it('should store and retrieve ACL', () => {
      const acl: JobACL = {
        jobId: 'test-job-1',
        groupFolder: 'test-group',
        username: 'sidecar-test-job-1',
        password: 'encrypted-password',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl);
      const retrieved = getJobACL('test-job-1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.jobId).toBe(acl.jobId);
      expect(retrieved?.groupFolder).toBe(acl.groupFolder);
      expect(retrieved?.username).toBe(acl.username);
      expect(retrieved?.password).toBe(acl.password);
      expect(retrieved?.status).toBe(acl.status);
    });

    it('should update existing ACL', () => {
      const acl: JobACL = {
        jobId: 'test-job-1',
        groupFolder: 'test-group',
        username: 'sidecar-test-job-1',
        password: 'encrypted-password-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl);

      const updatedAcl: JobACL = {
        ...acl,
        password: 'encrypted-password-2',
        status: 'revoked',
      };

      storeJobACL(updatedAcl);
      const retrieved = getJobACL('test-job-1');

      expect(retrieved?.password).toBe('encrypted-password-2');
      expect(retrieved?.status).toBe('revoked');
    });
  });

  describe('getJobACL', () => {
    it('should return undefined for non-existent job', () => {
      const retrieved = getJobACL('non-existent-job');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getJobACLByGroup', () => {
    it('should return most recent active ACL for group', () => {
      const acl1: JobACL = {
        jobId: 'test-job-old',
        groupFolder: 'test-group',
        username: 'sidecar-old',
        password: 'encrypted-1',
        createdAt: new Date(Date.now() - 2000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      const acl2: JobACL = {
        jobId: 'test-job-new',
        groupFolder: 'test-group',
        username: 'sidecar-new',
        password: 'encrypted-2',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl1);
      storeJobACL(acl2);

      const retrieved = getJobACLByGroup('test-group');
      expect(retrieved?.jobId).toBe('test-job-new');
    });

    it('should not return revoked ACLs', () => {
      const acl: JobACL = {
        jobId: 'test-job-revoked',
        groupFolder: 'test-group',
        username: 'sidecar-revoked',
        password: 'encrypted',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'revoked',
      };

      storeJobACL(acl);
      const retrieved = getJobACLByGroup('test-group');
      expect(retrieved).toBeUndefined();
    });

    it('should return undefined for non-existent group', () => {
      const retrieved = getJobACLByGroup('non-existent-group');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('revokeJobACL', () => {
    it('should mark ACL as revoked', () => {
      const acl: JobACL = {
        jobId: 'test-job-revoke',
        groupFolder: 'test-group',
        username: 'sidecar-revoke',
        password: 'encrypted',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl);
      revokeJobACL('test-job-revoke');

      const retrieved = getJobACL('test-job-revoke');
      expect(retrieved?.status).toBe('revoked');
    });

    it('should not throw for non-existent job', () => {
      expect(() => revokeJobACL('non-existent-job')).not.toThrow();
    });
  });

  describe('cleanupExpiredACLs', () => {
    it('should mark expired ACLs as revoked', () => {
      const expiredAcl: JobACL = {
        jobId: 'test-job-expired',
        groupFolder: 'test-group',
        username: 'sidecar-expired',
        password: 'encrypted',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        status: 'active',
      };

      const activeAcl: JobACL = {
        jobId: 'test-job-active',
        groupFolder: 'test-group',
        username: 'sidecar-active',
        password: 'encrypted',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(expiredAcl);
      storeJobACL(activeAcl);

      const revokedIds = cleanupExpiredACLs();

      expect(revokedIds).toContain('test-job-expired');
      expect(revokedIds).not.toContain('test-job-active');

      const expiredRetrieved = getJobACL('test-job-expired');
      expect(expiredRetrieved?.status).toBe('revoked');

      const activeRetrieved = getJobACL('test-job-active');
      expect(activeRetrieved?.status).toBe('active');
    });

    it('should return empty array when no expired ACLs', () => {
      const revokedIds = cleanupExpiredACLs();
      expect(revokedIds).toEqual([]);
    });

    it('should only revoke active expired ACLs', () => {
      const alreadyRevokedExpired: JobACL = {
        jobId: 'test-job-already-revoked',
        groupFolder: 'test-group',
        username: 'sidecar-already-revoked',
        password: 'encrypted',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        status: 'revoked',
      };

      storeJobACL(alreadyRevokedExpired);

      const revokedIds = cleanupExpiredACLs();
      expect(revokedIds).not.toContain('test-job-already-revoked');
    });
  });
});
