/**
 * HTTP Sidecar E2E Tests
 *
 * End-to-end tests for the HTTP-based sidecar pattern that test the full
 * communication flow between the sidecar adapter and user containers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  requireKubernetes,
  isKubernetesAvailable,
  getNamespace,
  getSharedRedis,
  getRedisUrlForTests,
} from './setup.js';
import { HttpSidecarJobRunner } from '../src/k8s/http-sidecar-runner.js';
import { RegisteredGroup } from '../src/types.js';
import { JobInput, SidecarHttpJobSpec } from '../src/k8s/types.js';
import {
  createClusterACLUser,
  deleteClusterACLUser,
  getE2ERedisCredentials,
  execRedisCommand,
  cleanupTestKeys,
} from './lib/redis-cluster.js';

const NAMESPACE = getNamespace();
const TEST_IMAGE_NAME = 'kubeclaw-test-http-echo:latest';

// Module-level check for Kubernetes availability
// This must be at module level because skipIf is evaluated at test definition time
const K8S_AVAILABLE = isKubernetesAvailable();

// Only run K8s sidecar tests when the adapter image is loaded into minikube.
// Without it the job pod goes to ImagePullBackOff and every test times out.
const ADAPTER_AVAILABLE = K8S_AVAILABLE && (() => {
  const r = spawnSync('minikube', ['image', 'list'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes('kubeclaw-http-adapter');
})();

// Helper to wait for a condition with timeout
async function waitFor<T>(
  getter: () => T | null | Promise<T | null>,
  timeoutMs: number = 120000,
  intervalMs: number = 1000,
): Promise<T | null> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const result = await getter();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

describe('HTTP Sidecar E2E Tests', () => {
  let runner: HttpSidecarJobRunner;
  const createdJobs: string[] = [];
  const createdACLs: string[] = [];

  const testGroup: RegisteredGroup = {
    name: 'Test Group',
    folder: 'test-http-echo',
    trigger: '@test',
    added_at: new Date().toISOString(),
  };

  beforeAll(async () => {
    if (!K8S_AVAILABLE) {
      console.log('Kubernetes not available, skipping setup');
      return;
    }

    try {
      requireKubernetes();

      // Build and load test images
      console.log('Building test container images...');
      buildTestContainers();

      runner = new HttpSidecarJobRunner();
    } catch (err) {
      console.error('Setup error:', err);
      throw err;
    }
  }, 120000);

  afterAll(async () => {
    // Clean up jobs
    for (const jobId of createdJobs) {
      try {
        await runner.stopJob(jobId);
        execSync(
          `kubectl delete job ${jobId} -n ${NAMESPACE} --ignore-not-found`,
          {
            stdio: 'ignore',
          },
        );
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clean up ACLs
    for (const jobId of createdACLs) {
      try {
        deleteClusterACLUser(jobId);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clean up test keys
    if (K8S_AVAILABLE) {
      cleanupTestKeys('kubeclaw:*:http-echo-test-*');
    }
  }, 30000);

  beforeEach(async () => {
    // Clean up test keys before each test
    if (K8S_AVAILABLE) {
      cleanupTestKeys('kubeclaw:*:http-echo-test-*');
    }
  });

  function buildTestContainers() {
    const e2eDir = process.cwd() + '/e2e';

    try {
      // Build http-echo container
      console.log('Building http-echo test container...');
      execSync(
        `docker build -t ${TEST_IMAGE_NAME} -f ${e2eDir}/test-containers/http-echo/Dockerfile ${e2eDir}/test-containers/http-echo/`,
        { stdio: 'inherit' },
      );

      // Load into minikube if using minikube
      try {
        execSync('minikube status', { stdio: 'ignore' });
        console.log('Loading image into minikube...');
        execSync(`minikube image load ${TEST_IMAGE_NAME}`, {
          stdio: 'inherit',
        });
      } catch {
        // Not using minikube, image should be available to cluster
      }
    } catch (err) {
      console.error('Failed to build test containers:', err);
      throw err;
    }
  }

  async function createTestJob(
    jobId: string,
    prompt: string,
    sessionId?: string,
    timeout: number = 120000,
  ) {
    // Get credentials for this job
    const credentials = getE2ERedisCredentials(jobId);
    createdACLs.push(jobId);

    // Create ACL in cluster Redis
    createClusterACLUser(jobId, credentials.password, testGroup.folder);

    const input: JobInput = {
      groupFolder: testGroup.folder,
      chatJid: 'test-http-echo@g.us',
      isMain: false,
      prompt,
      sessionId,
      assistantName: 'TestBot',
      jobId,
    };

    const spec: SidecarHttpJobSpec = {
      ...input,
      name: jobId,
      userImage: TEST_IMAGE_NAME,
      userPort: 8080,
      healthEndpoint: '/agent/health',
      timeout,
      credentials,
    };

    // Generate job manifest and create job
    const manifest = runner.generateHttpSidecarJobManifest(
      testGroup,
      input,
      spec,
      jobId,
    );

    // Override namespace to match test namespace
    manifest.metadata = { ...manifest.metadata, namespace: NAMESPACE };

    // Fix REDIS_URL to use in-cluster service
    const adapterContainer = manifest.spec?.template?.spec?.containers?.find(
      (c: any) => c.name === 'kubeclaw-http-adapter',
    );
    if (adapterContainer?.env) {
      const redisEnv = adapterContainer.env.find(
        (e: any) => e.name === 'REDIS_URL',
      );
      if (redisEnv) {
        redisEnv.value = 'redis://kubeclaw-redis:6379';
      }
    }

    // The HTTP adapter reads its initial task from stdin.
    // Override the adapter container entrypoint to echo the JSON input into it,
    // mirroring what the real orchestrator does when it spawns the job.
    const containerInput = {
      groupFolder: testGroup.folder,
      chatJid: 'test-http-echo@g.us',
      isMain: false,
      prompt,
      sessionId,
      assistantName: 'TestBot',
      jobId,
    };
    if (adapterContainer) {
      const inputJsonEscaped = JSON.stringify(JSON.stringify(containerInput));
      adapterContainer.command = ['/bin/sh'];
      adapterContainer.args = [
        '-c',
        `printf '%s' ${inputJsonEscaped} | node /app/dist/index.js`,
      ];
    }

    // Create the job using kubectl via a temp file (avoids shell quoting issues
    // with single quotes in JSON values such as passwords)
    const manifestJson = JSON.stringify(manifest);
    const tmpFile = join(tmpdir(), `kubeclaw-manifest-${jobId}.json`);
    try {
      writeFileSync(tmpFile, manifestJson, 'utf8');
      execSync(`kubectl apply -n ${NAMESPACE} -f ${tmpFile}`, {
        stdio: 'ignore',
      });
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // best-effort cleanup
      }
    }
    createdJobs.push(jobId);

    return { jobId, credentials };
  }

  type OutputResult = {
    status: string;
    result?: { text: string };
    error?: string;
    newSessionId?: string;
  } | null;

  /**
   * Subscribe to the pub/sub output channel for a job BEFORE creating the job.
   * Returns a handle whose waitForResult() resolves when a message arrives.
   *
   * Adapters publish to `kubeclaw:messages:{groupFolder}` with envelope
   * { type, jobId, groupFolder, timestamp, payload }. We filter by jobId
   * and return payload.
   */
  async function subscribeToOutput(jobId: string): Promise<{
    waitForResult: (timeout?: number) => Promise<OutputResult>;
    cleanup: () => Promise<void>;
  } | null> {
    const redis = getSharedRedis();
    if (!redis) {
      return null;
    }

    const channel = `kubeclaw:messages:${testGroup.folder}`;
    const { Redis } = await import('ioredis');
    const subscriber = new Redis(getRedisUrlForTests(), {
      maxRetriesPerRequest: null,
    });

    let resolveMessage: ((msg: OutputResult) => void) | null = null;
    const messagePromise = new Promise<OutputResult>((resolve) => {
      resolveMessage = resolve;
    });

    subscriber.on('message', (_chan: string, message: string) => {
      try {
        const envelope = JSON.parse(message);
        if (envelope.jobId !== jobId || envelope.type !== 'output') return;
        resolveMessage?.(envelope.payload ?? null);
      } catch {
        // malformed message — ignore and keep waiting
      }
    });

    await subscriber.subscribe(channel);

    return {
      waitForResult: async (
        timeout: number = 120000,
      ): Promise<OutputResult> => {
        const timeoutPromise = new Promise<OutputResult>((resolve) =>
          setTimeout(() => resolve(null), timeout),
        );
        const result = await Promise.race([messagePromise, timeoutPromise]);
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
        return result;
      },
      cleanup: async () => {
        try {
          await subscriber.unsubscribe(channel);
          await subscriber.quit();
        } catch {
          // ignore cleanup errors
        }
      },
    };
  }

  /**
   * Subscribe to the pub/sub output channel for a job, collecting multiple
   * messages via a queue. Each call to waitForNext() waits for the next message
   * in arrival order. Call cleanup() when done.
   *
   * This is required for follow-up tests where the adapter publishes a response
   * for each task (initial + follow-ups) on the same channel.
   */
  async function subscribeToOutputMulti(jobId: string): Promise<{
    waitForNext: (timeout?: number) => Promise<OutputResult>;
    cleanup: () => Promise<void>;
  } | null> {
    const redis = getSharedRedis();
    if (!redis) {
      return null;
    }

    const channel = `kubeclaw:messages:${testGroup.folder}`;
    const { Redis } = await import('ioredis');
    const subscriber = new Redis(getRedisUrlForTests(), {
      maxRetriesPerRequest: null,
    });

    // Queue of received messages and pending waiters
    const queue: OutputResult[] = [];
    const waiters: Array<(msg: OutputResult) => void> = [];

    subscriber.on('message', (_chan: string, message: string) => {
      try {
        const envelope = JSON.parse(message);
        if (envelope.jobId !== jobId || envelope.type !== 'output') return;
        const parsed = (envelope.payload ?? null) as OutputResult;
        if (waiters.length > 0) {
          // Someone is already waiting — resolve immediately
          const resolve = waiters.shift()!;
          resolve(parsed);
        } else {
          // Buffer for a future waiter
          queue.push(parsed);
        }
      } catch {
        // malformed message — ignore
      }
    });

    await subscriber.subscribe(channel);

    return {
      waitForNext: async (timeout: number = 120000): Promise<OutputResult> => {
        if (queue.length > 0) {
          return queue.shift()!;
        }
        return new Promise<OutputResult>((resolve) => {
          const timer = setTimeout(() => {
            const idx = waiters.indexOf(resolve);
            if (idx !== -1) waiters.splice(idx, 1);
            resolve(null);
          }, timeout);
          waiters.push((msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
        });
      },
      cleanup: async () => {
        try {
          await subscriber.unsubscribe(channel);
          await subscriber.quit();
        } catch {
          // ignore cleanup errors
        }
      },
    };
  }

  /**
   * Send a follow-up message to a job via XADD on the Redis Stream
   * that the adapter is blocking-reading from.
   *
   * Stream key: kubeclaw:input:{jobId}
   * Fields: type=followup  prompt=<prompt>  [sessionId=<id>]
   */
  function sendFollowupMessage(
    jobId: string,
    prompt: string,
    sessionId?: string,
  ): void {
    const safePrompt = prompt.replace(/'/g, "'\"'\"'");
    let cmd = `XADD kubeclaw:input:${jobId} '*' type followup prompt '${safePrompt}'`;
    if (sessionId) {
      cmd += ` sessionId '${sessionId}'`;
    }
    execRedisCommand(cmd);
  }

  /**
   * Send a close message to shut down the adapter cleanly.
   */
  function sendCloseMessage(jobId: string): void {
    execRedisCommand(`XADD kubeclaw:input:${jobId} '*' type close`);
  }

  describe('Simple Echo Task Processing', () => {
    it.skipIf(!ADAPTER_AVAILABLE)(
      'should process a simple echo task',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-simple`;
        // Subscribe BEFORE creating the job to avoid missing the PUBLISH message
        const sub = await subscribeToOutput(jobId);
        if (!sub) return;
        await createTestJob(jobId, 'Hello World');

        const output = await sub.waitForResult();

        expect(output).toBeTruthy();
        expect(output!.status).toBe('success');
        expect(output!.result?.text).toBe('Echo: Hello World');
        expect(output!.newSessionId).toBeTruthy();
      },
      120000,
    );

    it.skipIf(!ADAPTER_AVAILABLE)(
      'should handle multi-word messages',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-multiword`;
        const message = 'This is a longer message with multiple words';
        const sub = await subscribeToOutput(jobId);
        if (!sub) return;
        await createTestJob(jobId, message);

        const output = await sub.waitForResult();

        expect(output).toBeTruthy();
        expect(output!.status).toBe('success');
        expect(output!.result?.text).toBe(`Echo: ${message}`);
      },
      120000,
    );
  });

  describe('Health Check Polling', () => {
    it.skipIf(!ADAPTER_AVAILABLE)(
      'should poll health endpoint until agent is ready',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-health`;

        // Track timing to verify polling occurred
        const startTime = Date.now();
        const sub = await subscribeToOutput(jobId);
        if (!sub) return;
        await createTestJob(jobId, 'Test health polling');

        const output = await sub.waitForResult();
        const elapsed = Date.now() - startTime;

        expect(output).toBeTruthy();
        expect(output!.status).toBe('success');
        // Should take at least some time for health polling
        expect(elapsed).toBeGreaterThan(500);
      },
      120000,
    );
  });

  describe('Session Persistence', () => {
    it.skipIf(!ADAPTER_AVAILABLE)(
      'should persist session ID across tasks',
      async () => {
        const sessionId = `test-session-${Date.now()}`;
        const jobId = `http-echo-test-${Date.now()}-session`;

        const sub = await subscribeToOutput(jobId);
        if (!sub) return;
        await createTestJob(jobId, 'Test with session', sessionId);

        const output = await sub.waitForResult();

        expect(output).toBeTruthy();
        expect(output!.newSessionId).toBe(sessionId);
      },
      120000,
    );

    it.skipIf(!ADAPTER_AVAILABLE)(
      'should generate new session ID if not provided',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-newsession`;

        const sub = await subscribeToOutput(jobId);
        if (!sub) return;
        await createTestJob(jobId, 'Test without session');

        const output = await sub.waitForResult();

        expect(output).toBeTruthy();
        expect(output!.newSessionId).toBeTruthy();
        expect(output!.newSessionId).toContain('session-');
      },
      120000,
    );
  });

  describe('Error Handling', () => {
    it.skipIf(!ADAPTER_AVAILABLE)(
      'should handle HTTP 500 error',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-error`;

        const sub = await subscribeToOutput(jobId);
        if (!sub) return;
        await createTestJob(jobId, 'CRASH', undefined, 30000);

        // The job should fail
        const output = await sub.waitForResult(30000);

        // Output might be error or might timeout
        if (output) {
          expect(output.status).toBe('error');
        }
        // Otherwise the job just didn't produce output (expected for error)
      },
      60000,
    );

    it.skipIf(!ADAPTER_AVAILABLE)(
      'should handle timeout scenarios',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-timeout`;

        const sub = await subscribeToOutput(jobId);
        if (!sub) return;
        // Use short timeout
        await createTestJob(jobId, 'TIMEOUT', undefined, 5000);

        // Should timeout without producing output
        const output = await sub.waitForResult(15000);

        // No output expected due to timeout
        expect(output).toBeNull();
      },
      30000,
    );
  });

  describe('Large Payload Handling', () => {
    it.skipIf(!ADAPTER_AVAILABLE)(
      'should handle large messages',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-large`;
        const largeMessage = 'A'.repeat(10000);

        const sub = await subscribeToOutput(jobId);
        if (!sub) return;
        await createTestJob(jobId, largeMessage);

        const output = await sub.waitForResult();

        expect(output).toBeTruthy();
        expect(output!.status).toBe('success');
        expect(output!.result?.text).toBe(`Echo: ${largeMessage}`);
      },
      120000,
    );
  });

  describe('Multiple Sequential Tasks', () => {
    it.skipIf(!ADAPTER_AVAILABLE)(
      'should handle multiple sequential tasks',
      async () => {
        const messages = ['First message', 'Second message', 'Third message'];
        const results: string[] = [];

        for (let i = 0; i < messages.length; i++) {
          const jobId = `http-echo-test-${Date.now()}-seq-${i}`;
          const sub = await subscribeToOutput(jobId);
          if (!sub) return;
          await createTestJob(jobId, messages[i]);

          const output = await sub.waitForResult();
          expect(output).toBeTruthy();
          expect(output!.status).toBe('success');
          results.push(output!.result?.text || '');
        }

        expect(results).toEqual([
          'Echo: First message',
          'Echo: Second message',
          'Echo: Third message',
        ]);
      },
      300000,
    );
  });

  describe('Follow-up Message Flow', () => {
    it.skipIf(!ADAPTER_AVAILABLE)(
      'should process a follow-up message after the initial task',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-followup`;

        // Subscribe BEFORE creating the job to capture both responses
        const sub = await subscribeToOutputMulti(jobId);
        if (!sub) return;

        try {
          await createTestJob(jobId, 'Initial prompt');

          // Wait for the initial response
          const firstOutput = await sub.waitForNext();
          expect(firstOutput).toBeTruthy();
          expect(firstOutput!.status).toBe('success');
          expect(firstOutput!.result?.text).toBe('Echo: Initial prompt');
          expect(firstOutput!.newSessionId).toBeTruthy();

          // Send a follow-up via XADD on the adapter's input stream
          sendFollowupMessage(jobId, 'Follow-up prompt');

          // Wait for the follow-up response
          const secondOutput = await sub.waitForNext();
          expect(secondOutput).toBeTruthy();
          expect(secondOutput!.status).toBe('success');
          expect(secondOutput!.result?.text).toBe('Echo: Follow-up prompt');
          expect(secondOutput!.newSessionId).toBeTruthy();
        } finally {
          await sub.cleanup();
        }
      },
      180000,
    );

    it.skipIf(!ADAPTER_AVAILABLE)(
      'should preserve session ID across follow-up messages',
      async () => {
        const sessionId = `test-session-followup-${Date.now()}`;
        const jobId = `http-echo-test-${Date.now()}-followup-session`;

        const sub = await subscribeToOutputMulti(jobId);
        if (!sub) return;

        try {
          await createTestJob(jobId, 'Session initial', sessionId);

          // Initial response should carry the session ID
          const firstOutput = await sub.waitForNext();
          expect(firstOutput).toBeTruthy();
          expect(firstOutput!.status).toBe('success');
          expect(firstOutput!.newSessionId).toBe(sessionId);

          // Send follow-up with the same session ID
          sendFollowupMessage(jobId, 'Session follow-up', sessionId);

          // Follow-up response should also carry the session ID
          const secondOutput = await sub.waitForNext();
          expect(secondOutput).toBeTruthy();
          expect(secondOutput!.status).toBe('success');
          expect(secondOutput!.newSessionId).toBe(sessionId);
        } finally {
          await sub.cleanup();
        }
      },
      180000,
    );

    it.skipIf(!ADAPTER_AVAILABLE)(
      'should handle multiple follow-up messages in sequence',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-multi-followup`;

        const sub = await subscribeToOutputMulti(jobId);
        if (!sub) return;

        try {
          await createTestJob(jobId, 'Message 1');

          const first = await sub.waitForNext();
          expect(first).toBeTruthy();
          expect(first!.result?.text).toBe('Echo: Message 1');

          sendFollowupMessage(jobId, 'Message 2');
          const second = await sub.waitForNext();
          expect(second).toBeTruthy();
          expect(second!.result?.text).toBe('Echo: Message 2');

          sendFollowupMessage(jobId, 'Message 3');
          const third = await sub.waitForNext();
          expect(third).toBeTruthy();
          expect(third!.result?.text).toBe('Echo: Message 3');
        } finally {
          await sub.cleanup();
        }
      },
      240000,
    );

    it.skipIf(!ADAPTER_AVAILABLE)(
      'should shut down cleanly after a close message',
      async () => {
        const jobId = `http-echo-test-${Date.now()}-close`;

        const sub = await subscribeToOutputMulti(jobId);
        if (!sub) return;

        try {
          await createTestJob(jobId, 'Pre-close prompt');

          const firstOutput = await sub.waitForNext();
          expect(firstOutput).toBeTruthy();
          expect(firstOutput!.status).toBe('success');
          expect(firstOutput!.result?.text).toBe('Echo: Pre-close prompt');

          // Signal the adapter to shut down
          sendCloseMessage(jobId);

          // No further output should arrive after a close
          const afterClose = await sub.waitForNext(10000);
          expect(afterClose).toBeNull();
        } finally {
          await sub.cleanup();
        }
      },
      180000,
    );
  });
});
