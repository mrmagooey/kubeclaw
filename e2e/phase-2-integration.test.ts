import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { requireKubernetes } from './setup.js';

/**
 * Phase 2: Integration Tests
 *
 * These tests verify that components integrate correctly:
 * - Orchestrator deployment
 * - Agent job spawning
 * - Message routing
 */
describe('Phase 2: Integration', () => {
  const namespace = 'nanoclaw';

  beforeAll(async () => {
    // Require Kubernetes for all integration tests
    requireKubernetes();
  });

  afterAll(async () => {
    // Cleanup integration test resources
  });

  describe('Orchestrator', () => {
    it('should have orchestrator deployment', async () => {
      const { execSync } = await import('child_process');

      try {
        const output = execSync(
          `kubectl get deployment nanoclaw-orchestrator --namespace=${namespace}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
        expect(output).toContain('nanoclaw-orchestrator');
      } catch {
        console.warn('⚠️  Orchestrator deployment not found');
        expect.fail(
          'Orchestrator deployment should exist in nanoclaw namespace',
        );
      }
    });

    it('should have orchestrator pods (may not be Running without channels configured)', async () => {
      const { execSync } = await import('child_process');

      try {
        const output = execSync(
          `kubectl get pods --namespace=${namespace} -l app=nanoclaw-orchestrator`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
        expect(output).toContain('nanoclaw-orchestrator');
      } catch {
        console.warn('⚠️  No orchestrator pods found');
        expect.fail('Orchestrator pods should exist in nanoclaw namespace');
      }
    });
  });

  describe('Redis Integration', () => {
    it('should have Redis deployment', async () => {
      const { execSync } = await import('child_process');

      try {
        const output = execSync(
          `kubectl get statefulset nanoclaw-redis --namespace=${namespace}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
        expect(output).toContain('nanoclaw-redis');
      } catch {
        console.warn('⚠️  Redis statefulset not found');
        expect.fail('Redis statefulset should exist in nanoclaw namespace');
      }
    });

    it('should have Redis service', async () => {
      const { execSync } = await import('child_process');

      try {
        const output = execSync(
          `kubectl get service nanoclaw-redis --namespace=${namespace}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
        expect(output).toContain('nanoclaw-redis');
      } catch {
        console.warn('⚠️  Redis service not found');
        expect.fail('Redis service should exist in nanoclaw namespace');
      }
    });
  });

  describe('Storage', () => {
    it('should have PersistentVolumeClaims', async () => {
      const { execSync } = await import('child_process');

      try {
        const output = execSync(`kubectl get pvc --namespace=${namespace}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        expect(output.length).toBeGreaterThan(0);
      } catch {
        console.warn('⚠️  No PVCs found');
        expect.fail(
          'PersistentVolumeClaims should exist in nanoclaw namespace',
        );
      }
    });
  });
});
