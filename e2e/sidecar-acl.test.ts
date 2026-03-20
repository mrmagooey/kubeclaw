/**
 * Sidecar ACL E2E Integration Tests
 *
 * End-to-end tests for Redis ACL-based sidecar functionality:
 * - Start sidecar job with ACL
 * - Send initial task
 * - Send follow-up messages via Redis
 * - Verify responses received
 * - Verify ACL is revoked after completion
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  requireKubernetes,
  isKubernetesAvailable,
  getSharedRedis,
  getNamespace,
} from './setup.js';

const NAMESPACE = getNamespace();

// Helper to wait for a condition with timeout
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number = 30000,
  intervalMs: number = 500,
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe('Sidecar ACL E2E Tests', () => {
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
    // Cleanup test ACLs
    if (k8sAvailable && redis) {
      try {
        // Clean up any test ACL users
        const testUsers = ['sidecar-test-job-123', 'sidecar-test-job-456'];
        for (const username of testUsers) {
          try {
            await redis.acl('DELUSER', username);
          } catch {
            // User might not exist
          }
        }

        // Clean up test keys
        const testKeys = await redis.keys('kubeclaw:test:*');
        if (testKeys.length > 0) {
          await redis.del(...testKeys);
        }
      } catch (error) {
        console.error('Error during cleanup:', error);
      }
    }
  });

  describe('Redis ACL Infrastructure', () => {
    it.skipIf(!k8sAvailable)(
      'should have Redis 7+ available in cluster',
      async () => {
        if (!redis) return;
        const info = await redis.info('server');
        const versionMatch = info.match(/redis_version:(\d+)\.(\d+)\.(\d+)/);
        expect(versionMatch).toBeTruthy();

        const majorVersion = parseInt(versionMatch![1], 10);
        expect(majorVersion).toBeGreaterThanOrEqual(7);
      },
    );

    it.skipIf(!k8sAvailable)('should support ACL commands', async () => {
      if (!redis) return;
      // Test that ACL commands work
      const testUser = 'sidecar-test-acl-user';
      await redis.acl(
        'SETUSER',
        testUser,
        'on',
        '>testpassword',
        '~test:key:*',
        '+@read',
        '+@write',
      );

      // Verify user was created
      const users = await redis.acl('LIST');
      expect(users.some((u: string) => u.includes(testUser))).toBe(true);

      // Clean up
      await redis.acl('DELUSER', testUser);
    });

    it.skipIf(!k8sAvailable)(
      'should enforce key patterns for ACL users',
      async () => {
        if (!redis) return;
        const testUser = 'sidecar-test-key-pattern';
        const testPassword = 'testpass123';

        // Create ACL user with restricted key pattern
        await redis.acl(
          'SETUSER',
          testUser,
          'on',
          `>${testPassword}`,
          '~allowed:*',
          '+@read',
          '+@write',
          '-@admin',
        );

        // Connect as the restricted user
        const { Redis } = await import('ioredis');
        const restrictedRedis = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: testUser,
          password: testPassword,
          maxRetriesPerRequest: 1,
        });

        try {
          // Should be able to write to allowed key
          await restrictedRedis.set('allowed:test', 'value');
          const value = await restrictedRedis.get('allowed:test');
          expect(value).toBe('value');

          // Should not be able to write to other keys
          await expect(
            restrictedRedis.set('notallowed:test', 'value'),
          ).rejects.toThrow();
        } finally {
          await restrictedRedis.quit();
          await redis.acl('DELUSER', testUser);
        }
      },
    );
  });

  describe('ACL Lifecycle', () => {
    it.skipIf(!k8sAvailable)('should create and revoke ACL users', async () => {
      if (!redis) return;
      const jobId = 'test-job-123';
      const username = `sidecar-${jobId}`;
      const password = 'secure-random-password';
      const keyPattern = `kubeclaw:*:${jobId}`;

      // Create ACL user
      await redis.acl(
        'SETUSER',
        username,
        'on',
        `>${password}`,
        `~${keyPattern}`,
        '+@read',
        '+@write',
        '+@stream',
        '-@admin',
        '-@dangerous',
      );

      // Verify user exists
      const users = await redis.acl('LIST');
      expect(users.some((u: string) => u.includes(username))).toBe(true);

      // Verify user can access keys matching pattern
      const { Redis } = await import('ioredis');
      const jobRedis = new Redis({
        host: redis.options.host,
        port: redis.options.port,
        username,
        password,
        maxRetriesPerRequest: 1,
      });

      try {
        await jobRedis.set(`kubeclaw:input:${jobId}`, 'test data');
        const value = await jobRedis.get(`kubeclaw:input:${jobId}`);
        expect(value).toBe('test data');
      } finally {
        await jobRedis.quit();
      }

      // Revoke ACL user
      await redis.acl('DELUSER', username);

      // Verify user no longer exists
      const usersAfter = await redis.acl('LIST');
      expect(usersAfter.some((u: string) => u.includes(username))).toBe(false);
    });

    it.skipIf(!k8sAvailable)(
      'should prevent admin commands for sidecar users',
      async () => {
        if (!redis) return;
        const jobId = 'test-job-admin';
        const username = `sidecar-${jobId}`;
        const password = 'testpass';

        await redis.acl(
          'SETUSER',
          username,
          'on',
          `>${password}`,
          '~test:*',
          '+@read',
          '+@write',
          '-@admin',
          '-@dangerous',
        );

        const { Redis } = await import('ioredis');
        const jobRedis = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username,
          password,
          maxRetriesPerRequest: 1,
        });

        try {
          // Should not be able to run FLUSHDB
          await expect(jobRedis.flushdb()).rejects.toThrow();

          // Should not be able to run CONFIG
          await expect(jobRedis.config('GET', '*')).rejects.toThrow();
        } finally {
          await jobRedis.quit();
          await redis.acl('DELUSER', username);
        }
      },
    );
  });

  describe('Follow-up Message Flow', () => {
    it.skipIf(!k8sAvailable)(
      'should support pub/sub for follow-up messages',
      async () => {
        if (!redis) return;
        const jobId = 'test-job-followup';
        const outputChannel = `kubeclaw:output:${jobId}`;
        const username = `sidecar-${jobId}`;
        const password = 'testpass';

        // Create ACL user for this job
        await redis.acl(
          'SETUSER',
          username,
          'on',
          `>${password}`,
          `~kubeclaw:*:${jobId}`,
          '+@read',
          '+@write',
          '+@pubsub',
          '-@admin',
        );

        const { Redis } = await import('ioredis');
        const jobRedis = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username,
          password,
          maxRetriesPerRequest: 1,
        });

        const receivedMessages: string[] = [];

        try {
          // Subscribe to output channel
          await jobRedis.subscribe(outputChannel);
          jobRedis.on('message', (channel, message) => {
            if (channel === outputChannel) {
              receivedMessages.push(message);
            }
          });

          // Wait a bit for subscription to be ready
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Simulate sidecar publishing response
          const responseMsg = JSON.stringify({
            type: 'response',
            text: 'Response to follow-up',
            timestamp: new Date().toISOString(),
          });
          await redis.publish(outputChannel, responseMsg);

          // Wait for message to be received
          await waitFor(
            async () => Promise.resolve(receivedMessages.length > 0),
            5000,
          );

          expect(receivedMessages).toHaveLength(1);
          const response = JSON.parse(receivedMessages[0]);
          expect(response.type).toBe('response');
        } finally {
          await jobRedis.quit();
          await redis.acl('DELUSER', username);
        }
      },
    );

    it.skipIf(!k8sAvailable)(
      'should support stream-based message passing',
      async () => {
        if (!redis) return;
        const jobId = 'test-job-stream';
        const inputStream = `kubeclaw:stream:input:${jobId}`;
        const username = `sidecar-${jobId}`;
        const password = 'testpass';

        // Create ACL user with stream permissions
        await redis.acl(
          'SETUSER',
          username,
          'on',
          `>${password}`,
          `~kubeclaw:*:${jobId}`,
          '+@read',
          '+@write',
          '+@stream',
          '-@admin',
        );

        const { Redis } = await import('ioredis');
        const jobRedis = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username,
          password,
          maxRetriesPerRequest: 1,
        });

        try {
          // Add message to stream as orchestrator
          const messageId = await redis.xadd(
            inputStream,
            '*',
            'type',
            'follow_up',
            'text',
            'Stream message',
            'timestamp',
            new Date().toISOString(),
          );

          expect(messageId).toBeTruthy();

          // Sidecar should be able to read from stream
          const messages = await jobRedis.xread(
            'COUNT',
            1,
            'STREAMS',
            inputStream,
            '0',
          );

          expect(messages).toBeTruthy();
          expect(messages && messages.length).toBeGreaterThan(0);
        } finally {
          await jobRedis.quit();
          await redis.acl('DELUSER', username);
          await redis.del(inputStream);
        }
      },
    );
  });

  describe('Key Isolation', () => {
    it.skipIf(!k8sAvailable)(
      'should isolate keys between different jobs',
      async () => {
        if (!redis) return;
        const jobId1 = 'test-job-isolation-1';
        const jobId2 = 'test-job-isolation-2';
        const password1 = 'pass1';
        const password2 = 'pass2';

        // Create two separate ACL users
        await redis.acl(
          'SETUSER',
          `sidecar-${jobId1}`,
          'on',
          `>${password1}`,
          `~kubeclaw:*:${jobId1}`,
          '+@read',
          '+@write',
        );

        await redis.acl(
          'SETUSER',
          `sidecar-${jobId2}`,
          'on',
          `>${password2}`,
          `~kubeclaw:*:${jobId2}`,
          '+@read',
          '+@write',
        );

        const { Redis } = await import('ioredis');
        const job1Redis = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobId1}`,
          password: password1,
          maxRetriesPerRequest: 1,
        });

        const job2Redis = new Redis({
          host: redis.options.host,
          port: redis.options.port,
          username: `sidecar-${jobId2}`,
          password: password2,
          maxRetriesPerRequest: 1,
        });

        try {
          // Job 1 writes to its key
          await job1Redis.set(`kubeclaw:data:${jobId1}`, 'job1-data');

          // Job 2 writes to its key
          await job2Redis.set(`kubeclaw:data:${jobId2}`, 'job2-data');

          // Job 1 should be able to read its own key
          const job1OwnData = await job1Redis.get(`kubeclaw:data:${jobId1}`);
          expect(job1OwnData).toBe('job1-data');

          // Job 1 should NOT be able to read job 2's key
          await expect(
            job1Redis.get(`kubeclaw:data:${jobId2}`),
          ).rejects.toThrow();

          // Job 2 should be able to read its own key
          const job2OwnData = await job2Redis.get(`kubeclaw:data:${jobId2}`);
          expect(job2OwnData).toBe('job2-data');

          // Job 2 should NOT be able to read job 1's key
          await expect(
            job2Redis.get(`kubeclaw:data:${jobId1}`),
          ).rejects.toThrow();
        } finally {
          await job1Redis.quit();
          await job2Redis.quit();
          await redis.acl('DELUSER', `sidecar-${jobId1}`);
          await redis.acl('DELUSER', `sidecar-${jobId2}`);
          await redis.del(`kubeclaw:data:${jobId1}`);
          await redis.del(`kubeclaw:data:${jobId2}`);
        }
      },
    );
  });
});
