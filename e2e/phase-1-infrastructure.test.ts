import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isKubernetesAvailable, requireKubernetes } from './setup.js';

/**
 * Phase 1: Infrastructure Tests
 *
 * These tests verify that the infrastructure components are available
 * and configured correctly before running integration tests.
 */
describe('Phase 1: Infrastructure', () => {
  describe('Kubernetes Cluster', () => {
    it('should have Kubernetes cluster accessible', () => {
      // This will throw an error if Kubernetes is not available, failing the test
      requireKubernetes();

      // If we get here, Kubernetes is available
      expect(isKubernetesAvailable()).toBe(true);
    });

    it('should have nanoclaw namespace', async () => {
      // Require Kubernetes - will throw and fail test if not available
      requireKubernetes();

      const { execSync } = await import('child_process');

      try {
        const output = execSync('kubectl get namespace nanoclaw', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        expect(output).toContain('nanoclaw');
      } catch {
        console.warn('⚠️  nanoclaw namespace not found');
        // Fail if namespace doesn't exist
        expect.fail('nanoclaw namespace should exist in Kubernetes cluster');
      }
    });

    it('should have required RBAC permissions', async () => {
      // Require Kubernetes - will throw and fail test if not available
      requireKubernetes();

      const { execSync } = await import('child_process');

      try {
        // Check if we can create jobs
        const canCreate = execSync(
          'kubectl auth can-i create jobs --namespace=nanoclaw',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
        expect(canCreate.trim()).toBe('yes');
      } catch {
        console.warn('⚠️  RBAC permissions check failed');
        expect.fail(
          'Should have permission to create jobs in nanoclaw namespace',
        );
      }
    });
  });

  describe('Redis', () => {
    it('should have Redis connection available', async () => {
      const { default: Redis } = await import('ioredis');

      const redis = new Redis(
        process.env.REDIS_URL || 'redis://localhost:6379',
        {
          connectTimeout: 5000,
          maxRetriesPerRequest: 1,
          lazyConnect: true,
        },
      );

      try {
        await redis.connect();
        const pong = await redis.ping();
        expect(pong).toBe('PONG');
      } catch (error) {
        console.warn(
          '⚠️  Redis not available:',
          error instanceof Error ? error.message : 'unknown error',
        );
        // Fail if Redis isn't available
        expect.fail(
          `Redis should be available at ${process.env.REDIS_URL || 'redis://localhost:6379'}`,
        );
      } finally {
        await redis.quit().catch(() => {});
      }
    });

    it('should support basic Redis operations', async () => {
      const { default: Redis } = await import('ioredis');

      const redis = new Redis(
        process.env.REDIS_URL || 'redis://localhost:6379',
        {
          connectTimeout: 5000,
          maxRetriesPerRequest: 1,
          lazyConnect: true,
        },
      );

      try {
        await redis.connect();

        // Test basic operations
        await redis.set('e2e-test-key', 'value', 'EX', 10);
        const value = await redis.get('e2e-test-key');
        expect(value).toBe('value');

        await redis.del('e2e-test-key');
      } catch (error) {
        console.warn('⚠️  Redis operations test failed');
        expect.fail(
          `Redis operations should work: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      } finally {
        await redis.quit().catch(() => {});
      }
    });
  });

  describe('Docker', () => {
    it('should have Docker available', async () => {
      const { execSync } = await import('child_process');

      try {
        const version = execSync('docker --version', { encoding: 'utf8' });
        expect(version).toContain('Docker version');
      } catch {
        console.warn('⚠️  Docker not available');
        expect.fail('Docker should be available for E2E tests');
      }
    });

    it('should have Docker images available', async () => {
      const { execSync } = await import('child_process');

      try {
        const images = execSync('docker images --format "{{.Repository}}"', {
          encoding: 'utf8',
        });
        const hasOrchestrator = images.includes('nanoclaw-orchestrator');
        const hasAgent = images.includes('nanoclaw-agent');

        if (!hasOrchestrator || !hasAgent) {
          console.warn('⚠️  Required images not found. Run: make build-images');
          expect.fail(
            `Required Docker images not found. Missing: ${!hasOrchestrator ? 'nanoclaw-orchestrator ' : ''}${!hasAgent ? 'nanoclaw-agent' : ''}`,
          );
        }

        expect(hasOrchestrator).toBe(true);
        expect(hasAgent).toBe(true);
      } catch {
        console.warn('⚠️  Could not check Docker images');
        expect.fail('Failed to check Docker images');
      }
    });
  });
});
