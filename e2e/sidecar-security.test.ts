/**
 * Sidecar Security Tests
 *
 * Security constraint tests for Redis ACL-based sidecars:
 * - Sidecar A cannot access keys of Sidecar B
 * - Sidecar cannot run admin commands (CONFIG, FLUSHDB)
 * - Sidecar can only access its own input/output keys
 * - Invalid credentials are rejected
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  requireKubernetes,
  isKubernetesAvailable,
  getSharedRedis,
  getNamespace,
} from './setup.js';

const NAMESPACE = getNamespace();

describe('Sidecar Security Tests', () => {
  let redis: Awaited<ReturnType<typeof getSharedRedis>> | null = null;
  let k8sAvailable = false;

  beforeAll(async () => {
    try {
      k8sAvailable = isKubernetesAvailable();
      if (k8sAvailable) {
        requireKubernetes();
        redis = await getSharedRedis();
      }
    } catch {
      k8sAvailable = false;
    }
  });

  afterAll(async () => {
    if (k8sAvailable && redis) {
      try {
        // Clean up any test ACL users
        const allUsers = await redis.acl('LIST');
        const testUsers = allUsers
          .filter((u: string) => u.startsWith('sidecar-security-test'))
          .map((u: string) => u.split(' ')[1]);

        for (const username of testUsers) {
          try {
            await redis.acl('DELUSER', username);
          } catch {
            // User might not exist
          }
        }

        // Clean up test keys
        const testKeys = await redis.keys('kubeclaw:security-test:*');
        if (testKeys.length > 0) {
          await redis.del(...testKeys);
        }
      } catch (error) {
        console.error('Error during cleanup:', error);
      }
    }
  });

  describe('Key Isolation Between Sidecars', () => {
    it.skipIf(!k8sAvailable)(
      'should prevent sidecar A from accessing sidecar B keys',
      async () => {
        if (!redis) return;
        const { Redis } = await import('ioredis');

        // Create two sidecar users
        const jobIdA = 'security-test-job-a';
        const jobIdB = 'security-test-job-b';
        const passwordA = 'password-a-123';
        const passwordB = 'password-b-456';

        // Create ACL for Sidecar A
        await redis.acl(
          'SETUSER',
          `sidecar-${jobIdA}`,
          'on',
          `>${passwordA}`,
          `~kubeclaw:*:${jobIdA}`,
          '+@read',
          '+@write',
          '+@stream',
          '+@pubsub',
        );

        // Create ACL for Sidecar B
        await redis.acl(
          'SETUSER',
          `sidecar-${jobIdB}`,
          'on',
          `>${passwordB}`,
          `~kubeclaw:*:${jobIdB}`,
          '+@read',
          '+@write',
          '+@stream',
          '+@pubsub',
        );

        // Connect as Sidecar A
        const sidecarA = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobIdA}`,
          password: passwordA,
          maxRetriesPerRequest: 1,
        });

        // Connect as Sidecar B
        const sidecarB = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobIdB}`,
          password: passwordB,
          maxRetriesPerRequest: 1,
        });

        try {
          // Sidecar A writes to its own keys
          await sidecarA.set(`kubeclaw:input:${jobIdA}`, 'data-a');
          await sidecarA.set(`kubeclaw:output:${jobIdA}`, 'output-a');

          // Sidecar B writes to its own keys
          await sidecarB.set(`kubeclaw:input:${jobIdB}`, 'data-b');
          await sidecarB.set(`kubeclaw:output:${jobIdB}`, 'output-b');

          // Sidecar A can read its own keys
          const ownInput = await sidecarA.get(`kubeclaw:input:${jobIdA}`);
          const ownOutput = await sidecarA.get(`kubeclaw:output:${jobIdA}`);
          expect(ownInput).toBe('data-a');
          expect(ownOutput).toBe('output-a');

          // Sidecar A CANNOT read Sidecar B's keys
          await expect(
            sidecarA.get(`kubeclaw:input:${jobIdB}`),
          ).rejects.toThrow();
          await expect(
            sidecarA.get(`kubeclaw:output:${jobIdB}`),
          ).rejects.toThrow();

          // Sidecar B can read its own keys
          const bOwnInput = await sidecarB.get(`kubeclaw:input:${jobIdB}`);
          expect(bOwnInput).toBe('data-b');

          // Sidecar B CANNOT read Sidecar A's keys
          await expect(
            sidecarB.get(`kubeclaw:input:${jobIdA}`),
          ).rejects.toThrow();
        } finally {
          await sidecarA.quit();
          await sidecarB.quit();
          await redis.acl('DELUSER', `sidecar-${jobIdA}`);
          await redis.acl('DELUSER', `sidecar-${jobIdB}`);
        }
      },
    );

    it.skipIf(!k8sAvailable)(
      'should prevent wildcard access to other job keys',
      async () => {
        if (!redis) return;
        const { Redis } = await import('ioredis');

        const jobId = 'security-test-wildcard';
        const password = 'wildcard-test-pass';

        // Create ACL with specific key pattern
        await redis.acl(
          'SETUSER',
          `sidecar-${jobId}`,
          'on',
          `>${password}`,
          `~kubeclaw:*:${jobId}`,
          '+@read',
          '+@write',
        );

        const sidecar = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobId}`,
          password: password,
          maxRetriesPerRequest: 1,
        });

        try {
          // Create multiple keys matching other patterns
          await redis.set('kubeclaw:input:other-job-1', 'secret1');
          await redis.set('kubeclaw:input:other-job-2', 'secret2');
          await redis.set('kubeclaw:data:another-job', 'secret3');

          // Sidecar should not be able to use KEYS command on other patterns
          // Note: KEYS is a dangerous command, ACL might block it
          try {
            const keys = await sidecar.keys('kubeclaw:*');
            // If KEYS is allowed, it should only see its own keys
            expect(keys.every((k) => k.includes(jobId))).toBe(true);
          } catch {
            // KEYS might be blocked, which is also fine
          }

          // Verify it cannot access specific other keys
          await expect(
            sidecar.get('kubeclaw:input:other-job-1'),
          ).rejects.toThrow();
          await expect(
            sidecar.get('kubeclaw:input:other-job-2'),
          ).rejects.toThrow();
        } finally {
          await sidecar.quit();
          await redis.acl('DELUSER', `sidecar-${jobId}`);
          await redis.del('kubeclaw:input:other-job-1');
          await redis.del('kubeclaw:input:other-job-2');
          await redis.del('kubeclaw:data:another-job');
        }
      },
    );
  });

  describe('Admin Command Restrictions', () => {
    it.skipIf(!k8sAvailable)(
      'should block FLUSHDB command for sidecars',
      async () => {
        if (!redis) return;
        const { Redis } = await import('ioredis');

        const jobId = 'security-test-flushdb';
        const password = 'flushdb-test-pass';

        // Create ACL without dangerous commands
        await redis.acl(
          'SETUSER',
          `sidecar-${jobId}`,
          'on',
          `>${password}`,
          `~kubeclaw:*:${jobId}`,
          '+@read',
          '+@write',
          '+@stream',
          '+@pubsub',
          '-@admin',
          '-@dangerous',
        );

        const sidecar = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobId}`,
          password: password,
          maxRetriesPerRequest: 1,
        });

        try {
          // Should not be able to FLUSHDB
          await expect(sidecar.flushdb()).rejects.toThrow();

          // Should not be able to FLUSHALL
          await expect(sidecar.flushall()).rejects.toThrow();
        } finally {
          await sidecar.quit();
          await redis.acl('DELUSER', `sidecar-${jobId}`);
        }
      },
    );

    it.skipIf(!k8sAvailable)(
      'should block CONFIG command for sidecars',
      async () => {
        if (!redis) return;
        const { Redis } = await import('ioredis');

        const jobId = 'security-test-config';
        const password = 'config-test-pass';

        // Create ACL without admin commands
        await redis.acl(
          'SETUSER',
          `sidecar-${jobId}`,
          'on',
          `>${password}`,
          `~kubeclaw:*:${jobId}`,
          '+@read',
          '+@write',
          '-@admin',
        );

        const sidecar = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobId}`,
          password: password,
          maxRetriesPerRequest: 1,
        });

        try {
          // Should not be able to read config
          await expect(sidecar.config('GET', '*')).rejects.toThrow();

          // Should not be able to set config
          await expect(
            sidecar.config('SET', 'maxclients', '100'),
          ).rejects.toThrow();
        } finally {
          await sidecar.quit();
          await redis.acl('DELUSER', `sidecar-${jobId}`);
        }
      },
    );

    it.skipIf(!k8sAvailable)(
      'should block ACL manipulation commands',
      async () => {
        if (!redis) return;
        const { Redis } = await import('ioredis');

        const jobId = 'security-test-acl-manip';
        const password = 'acl-manip-test-pass';

        // Create ACL without admin commands
        await redis.acl(
          'SETUSER',
          `sidecar-${jobId}`,
          'on',
          `>${password}`,
          `~kubeclaw:*:${jobId}`,
          '+@read',
          '+@write',
          '-@admin',
        );

        const sidecar = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobId}`,
          password: password,
          maxRetriesPerRequest: 1,
        });

        try {
          // Should not be able to list ACL users
          await expect(sidecar.acl('LIST')).rejects.toThrow();

          // Should not be able to create new ACL users
          await expect(
            sidecar.acl('SETUSER', 'hacker', 'on', '>badpass', '~*', '+@all'),
          ).rejects.toThrow();
        } finally {
          await sidecar.quit();
          await redis.acl('DELUSER', `sidecar-${jobId}`);
        }
      },
    );

    it.skipIf(!k8sAvailable)('should block dangerous commands', async () => {
      if (!redis) return;
      const { Redis } = await import('ioredis');

      const jobId = 'security-test-dangerous';
      const password = 'dangerous-test-pass';

      // Create ACL with dangerous commands blocked
      await redis.acl(
        'SETUSER',
        `sidecar-${jobId}`,
        'on',
        `>${password}`,
        `~kubeclaw:*:${jobId}`,
        '+@read',
        '+@write',
        '-@dangerous',
      );

      const sidecar = new Redis({
        host: redis.options.host,
        port: redis.options.port,
        username: `sidecar-${jobId}`,
        password: password,
        maxRetriesPerRequest: 1,
      });

      try {
        // Should not be able to use DEBUG command
        await expect(sidecar.debug('OBJECT', 'key')).rejects.toThrow();

        // Should not be able to use SHUTDOWN
        await expect(sidecar.shutdown()).rejects.toThrow();

        // Should not be able to use SAVE/BGSAVE
        await expect(sidecar.save()).rejects.toThrow();
        await expect(sidecar.bgsave()).rejects.toThrow();
      } finally {
        await sidecar.quit();
        await redis.acl('DELUSER', `sidecar-${jobId}`);
      }
    });
  });

  describe('Authentication', () => {
    it.skipIf(!k8sAvailable)('should reject invalid credentials', async () => {
      if (!redis) return;
      const { Redis } = await import('ioredis');

      const jobId = 'security-test-auth';
      const correctPassword = 'correct-pass';

      // Create ACL user
      await redis.acl(
        'SETUSER',
        `sidecar-${jobId}`,
        'on',
        `>${correctPassword}`,
        `~kubeclaw:*:${jobId}`,
        '+@read',
        '+@write',
      );

      // Try to connect with wrong password
      const wrongPasswordRedis = new Redis({
        host: redis.options.host,
        port: redis.options.port,
        username: `sidecar-${jobId}`,
        password: 'wrong-password',
        maxRetriesPerRequest: 1,
      });

      try {
        await expect(wrongPasswordRedis.ping()).rejects.toThrow();
      } finally {
        await wrongPasswordRedis.quit();
        await redis.acl('DELUSER', `sidecar-${jobId}`);
      }
    });

    it.skipIf(!k8sAvailable)('should reject non-existent users', async () => {
      if (!redis) return;
      const { Redis } = await import('ioredis');

      // Try to connect with non-existent user
      const nonExistentRedis = new Redis({
        host: redis.options.host,
        port: redis.options.port,
        username: 'sidecar-non-existent-user',
        password: 'some-password',
        maxRetriesPerRequest: 1,
      });

      try {
        await expect(nonExistentRedis.ping()).rejects.toThrow();
      } finally {
        await nonExistentRedis.quit();
      }
    });

    it.skipIf(!k8sAvailable)('should reject expired credentials', async () => {
      if (!redis) return;
      const { Redis } = await import('ioredis');

      const jobId = 'security-test-expired';
      const password = 'expired-pass';

      // Create ACL user with noexpire flag (simulating expired)
      // Note: Redis ACL doesn't have built-in expiration, but we can simulate
      // by creating then immediately deleting the user
      await redis.acl(
        'SETUSER',
        `sidecar-${jobId}`,
        'on',
        `>${password}`,
        `~kubeclaw:*:${jobId}`,
        '+@read',
        '+@write',
      );

      // Verify user works
      const validRedis = new Redis({
        host: redis.options.host,
        port: redis.options.port,
        username: `sidecar-${jobId}`,
        password: password,
        maxRetriesPerRequest: 1,
      });

      try {
        const pingResult = await validRedis.ping();
        expect(pingResult).toBe('PONG');
      } finally {
        await validRedis.quit();
      }

      // Delete the user (simulating expiration)
      await redis.acl('DELUSER', `sidecar-${jobId}`);

      // Try to connect again - should fail
      const expiredRedis = new Redis({
        host: redis.options.host,
        port: redis.options.port,
        username: `sidecar-${jobId}`,
        password: password,
        maxRetriesPerRequest: 1,
      });

      try {
        await expect(expiredRedis.ping()).rejects.toThrow();
      } finally {
        await expiredRedis.quit();
      }
    });
  });

  describe('Command Whitelist', () => {
    it.skipIf(!k8sAvailable)(
      'should only allow explicitly permitted commands',
      async () => {
        if (!redis) return;
        const { Redis } = await import('ioredis');

        const jobId = 'security-test-whitelist';
        const password = 'whitelist-test-pass';

        // Create ACL with only specific commands allowed
        await redis.acl(
          'SETUSER',
          `sidecar-${jobId}`,
          'on',
          `>${password}`,
          `~kubeclaw:*:${jobId}`,
          '+get',
          '+set',
          '+del',
          '+subscribe',
          '+publish',
        );

        const sidecar = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobId}`,
          password: password,
          maxRetriesPerRequest: 1,
        });

        try {
          // Allowed commands should work
          await sidecar.set(`kubeclaw:test:${jobId}`, 'value');
          const value = await sidecar.get(`kubeclaw:test:${jobId}`);
          expect(value).toBe('value');

          // Disallowed commands should fail
          await expect(
            sidecar.lpush(`kubeclaw:list:${jobId}`, 'item'),
          ).rejects.toThrow();
          await expect(
            sidecar.sadd(`kubeclaw:set:${jobId}`, 'member'),
          ).rejects.toThrow();
          await expect(
            sidecar.hset(`kubeclaw:hash:${jobId}`, 'field', 'value'),
          ).rejects.toThrow();
        } finally {
          await sidecar.quit();
          await redis.acl('DELUSER', `sidecar-${jobId}`);
        }
      },
    );
  });
});
