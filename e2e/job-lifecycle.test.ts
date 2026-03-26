/**
 * K8s Job Lifecycle E2E Tests
 *
 * Verifies that JobRunner correctly monitors real Kubernetes jobs:
 *   - waitForJobCompletion() detects when a job reaches status.succeeded > 0
 *   - getJobLogs() retrieves stdout from the completed job pod
 *
 * Uses kubeclaw-agent:latest (loaded by global-setup) with a command override
 * that immediately echoes a marker string and exits.
 *
 * Requires: minikube running, kubeclaw namespace, kubeclaw-agent:latest in minikube.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { requireKubernetes, getNamespace } from './setup.js';

const NAMESPACE = getNamespace();

function createLifecycleJob(jobName: string, marker: string): boolean {
  const manifest = JSON.stringify({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: NAMESPACE },
    spec: {
      ttlSecondsAfterFinished: 120,
      activeDeadlineSeconds: 60,
      backoffLimit: 0,
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'agent',
              image: 'kubeclaw-agent:latest',
              imagePullPolicy: 'IfNotPresent',
              command: ['/bin/sh', '-c', `echo ${marker} && exit 0`],
              resources: {
                requests: { memory: '64Mi', cpu: '50m' },
                limits: { memory: '128Mi', cpu: '200m' },
              },
            },
          ],
        },
      },
    },
  });

  const result = spawnSync(
    'kubectl',
    ['apply', '-f', '-'],
    { input: manifest, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  return result.status === 0;
}

describe('K8s Job Lifecycle', () => {
  let agentImageAvailable = false;

  beforeAll(() => {
    requireKubernetes();

    // Verify kubeclaw-agent:latest is loaded in minikube
    const result = spawnSync(
      'bash',
      ['-c', 'eval $(minikube docker-env) && docker image inspect kubeclaw-agent:latest -f "{{.Id}}" 2>/dev/null'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    agentImageAvailable = result.status === 0 && result.stdout.trim().length > 0;

    if (!agentImageAvailable) {
      console.warn('⚠️  kubeclaw-agent:latest not found in minikube — job lifecycle tests will skip');
    }
  });

  it('waitForJobCompletion detects a successfully completed job', async (ctx) => {
    if (!agentImageAvailable) ctx.skip();

    const { jobRunner } = await import('../src/k8s/job-runner.js');
    const jobName = `e2e-lifecycle-${Date.now()}`;
    const marker = 'lifecycle-e2e-test';

    const created = createLifecycleJob(jobName, marker);
    expect(created).toBe(true);

    console.log(`⏳ Waiting for job ${jobName} to complete...`);

    // waitForJobCompletion polls K8s until status.succeeded > 0
    await expect(jobRunner.waitForJobCompletion(jobName, 60_000)).resolves.toBeUndefined();

    console.log(`✅ Job ${jobName} completed successfully`);
  }, 90_000);

  it('getJobLogs retrieves stdout from a completed job pod', async (ctx) => {
    if (!agentImageAvailable) ctx.skip();

    const { jobRunner } = await import('../src/k8s/job-runner.js');
    const jobName = `e2e-logs-${Date.now()}`;
    const marker = 'log-retrieval-e2e-test';

    const created = createLifecycleJob(jobName, marker);
    expect(created).toBe(true);

    // Wait for job to complete first
    await jobRunner.waitForJobCompletion(jobName, 60_000);

    const logs = await jobRunner.getJobLogs(jobName);

    expect(logs).toContain(marker);
    console.log(`✅ Job logs retrieved (${logs.length} chars), contains expected marker`);
  }, 90_000);

  it('waitForJobCompletion throws when a job exceeds activeDeadlineSeconds', async (ctx) => {
    if (!agentImageAvailable) ctx.skip();

    const { jobRunner } = await import('../src/k8s/job-runner.js');
    const jobName = `e2e-timeout-${Date.now()}`;

    // Create a job with a 5s deadline that sleeps forever
    const manifest = JSON.stringify({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: jobName, namespace: NAMESPACE },
      spec: {
        ttlSecondsAfterFinished: 60,
        activeDeadlineSeconds: 5,
        backoffLimit: 0,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'agent',
                image: 'kubeclaw-agent:latest',
                imagePullPolicy: 'IfNotPresent',
                command: ['/bin/sh', '-c', 'sleep 300'],
                resources: { requests: { memory: '32Mi', cpu: '10m' }, limits: { memory: '64Mi', cpu: '100m' } },
              },
            ],
          },
        },
      },
    });
    spawnSync('kubectl', ['apply', '-f', '-'], { input: manifest, encoding: 'utf8', stdio: 'pipe' });

    // Should throw because the job exceeds its activeDeadlineSeconds
    await expect(jobRunner.waitForJobCompletion(jobName, 30_000)).rejects.toThrow();

    console.log(`✅ waitForJobCompletion correctly threw on job deadline exceeded`);
  }, 45_000);
});
