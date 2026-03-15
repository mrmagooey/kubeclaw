import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { RegisteredGroup } from '../types.js';
import type { JobInput, AgentOutputMessage } from './types.js';

// Mock config
vi.mock('../config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
  NANOCLAW_NAMESPACE: 'nanoclaw',
  AGENT_JOB_MEMORY_REQUEST: '512Mi',
  AGENT_JOB_MEMORY_LIMIT: '4Gi',
  AGENT_JOB_CPU_REQUEST: '250m',
  AGENT_JOB_CPU_LIMIT: '2000m',
  getContainerImage: vi.fn((provider: string) => {
    if (provider === 'openrouter') {
      return 'nanoclaw-agent:openrouter';
    }
    return 'nanoclaw-agent:claude';
  }),
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock Redis client
vi.mock('./redis-client.js', () => {
  const mockSubscriber = new EventEmitter() as any;
  mockSubscriber.subscribe = vi.fn(
    (_channel: string, cb: (err: Error | null) => void) => {
      cb(null);
    },
  );
  mockSubscriber.unsubscribe = vi.fn();
  mockSubscriber.off = vi.fn();
  mockSubscriber.quit = vi.fn().mockResolvedValue('OK');

  return {
    getRedisSubscriber: vi.fn(() => mockSubscriber),
    getOutputChannel: vi.fn(
      (groupFolder: string) => `nanoclaw:messages:${groupFolder}`,
    ),
    closeRedisConnections: vi.fn().mockResolvedValue(undefined),
    __mockSubscriber: mockSubscriber,
  };
});

// Mock Kubernetes client - use vi.hoisted to access mocks after setup
const { mockBatchApi, mockCoreApi } = vi.hoisted(() => {
  const mockBatchApi = {
    createNamespacedJob: vi.fn(),
    readNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn(),
  };

  const mockCoreApi = {
    listNamespacedPod: vi.fn(),
    readNamespacedPodLog: vi.fn(),
  };

  return { mockBatchApi, mockCoreApi };
});

vi.mock('@kubernetes/client-node', () => {
  return {
    KubeConfig: class KubeConfig {
      loadFromDefault = vi.fn();
      makeApiClient = vi.fn((apiClass: any) => {
        if (apiClass === 'CoreV1Api') return mockCoreApi;
        if (apiClass === 'BatchV1Api') return mockBatchApi;
        return {};
      });
    },
    CoreV1Api: 'CoreV1Api',
    BatchV1Api: 'BatchV1Api',
  };
});

// Now import after mocks are set up
import { JobRunner } from './job-runner.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput: JobInput = {
  prompt: 'Hello, test agent',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
  sessionId: 'session-123',
  assistantName: 'Andy',
};

describe('JobRunner', () => {
  let jobRunner: JobRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    jobRunner = new JobRunner();
  });

  afterEach(() => {
    // Clean up any pending promises that might cause unhandled rejection warnings
    vi.useRealTimers();
  });

  describe('generateJobManifest', () => {
    it('should generate a valid K8s job manifest', () => {
      const spec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test prompt',
        sessionId: 'session-123',
        assistantName: 'Andy',
        timeout: 1800000,
        provider: 'claude' as const,
      };

      const manifest = jobRunner.generateJobManifest(spec);

      expect(manifest.apiVersion).toBe('batch/v1');
      expect(manifest.kind).toBe('Job');
      expect(manifest.metadata?.name).toBe('test-job');
      expect(manifest.metadata?.namespace).toBe('nanoclaw');
      expect(manifest.spec?.template?.spec?.containers?.[0]?.image).toBe(
        'nanoclaw-agent:claude',
      );
      expect(manifest.spec?.template?.spec?.restartPolicy).toBe('Never');
    });

    it('should include environment variables', () => {
      const spec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test prompt',
        sessionId: 'session-123',
        assistantName: 'Andy',
        timeout: 1800000,
        provider: 'claude' as const,
      };

      const manifest = jobRunner.generateJobManifest(spec);
      const envVars = manifest.spec?.template?.spec?.containers?.[0]?.env || [];

      expect(
        envVars.some(
          (e) => e.name === 'NANOCLAW_GROUP_FOLDER' && e.value === 'test-group',
        ),
      ).toBe(true);
      expect(
        envVars.some(
          (e) => e.name === 'NANOCLAW_PROMPT' && e.value === 'Test prompt',
        ),
      ).toBe(true);
      expect(
        envVars.some(
          (e) => e.name === 'NANOCLAW_SESSION_ID' && e.value === 'session-123',
        ),
      ).toBe(true);
    });

    it('should add main project mount when isMain is true', () => {
      const spec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: true,
        prompt: 'Test prompt',
        timeout: 1800000,
        provider: 'claude' as const,
      };

      const manifest = jobRunner.generateJobManifest(spec);
      const volumeMounts =
        manifest.spec?.template?.spec?.containers?.[0]?.volumeMounts || [];
      const volumes = manifest.spec?.template?.spec?.volumes || [];

      expect(
        volumeMounts.some((v) => v.mountPath === '/workspace/project'),
      ).toBe(true);
      expect(volumes.some((v) => v.name === 'project-pvc')).toBe(true);
    });

    it('should use openrouter image when provider is openrouter', () => {
      const spec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test prompt',
        timeout: 1800000,
        provider: 'openrouter' as const,
      };

      const manifest = jobRunner.generateJobManifest(spec);
      expect(manifest.spec?.template?.spec?.containers?.[0]?.image).toBe(
        'nanoclaw-agent:openrouter',
      );
    });

    it('should include resource limits and requests', () => {
      const spec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test prompt',
        timeout: 1800000,
        provider: 'claude' as const,
      };

      const manifest = jobRunner.generateJobManifest(spec);
      const resources =
        manifest.spec?.template?.spec?.containers?.[0]?.resources;

      expect(resources?.requests?.memory).toBe('512Mi');
      expect(resources?.limits?.memory).toBe('4Gi');
      expect(resources?.requests?.cpu).toBe('250m');
      expect(resources?.limits?.cpu).toBe('2000m');
    });
  });

  describe('streamOutput', () => {
    let mockSubscriber: any;

    beforeEach(async () => {
      vi.useFakeTimers();
      mockSubscriber = new EventEmitter();
      mockSubscriber.subscribe = vi.fn(
        (_channel: string, cb: (err: Error | null) => void) => {
          cb(null);
        },
      );
      mockSubscriber.unsubscribe = vi.fn();
      mockSubscriber.off = vi.fn();
      mockSubscriber.quit = vi.fn().mockResolvedValue('OK');

      const { getRedisSubscriber } = await import('./redis-client.js');
      (getRedisSubscriber as any).mockReturnValue(mockSubscriber);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should resolve without callback', async () => {
      const result = jobRunner.streamOutput('test-job', 'test-group');
      await expect(result).resolves.toBeUndefined();
    });

    it('should handle output messages', async () => {
      const onOutput = vi.fn().mockResolvedValue(undefined);

      const streamPromise = jobRunner.streamOutput(
        'test-job',
        'test-group',
        onOutput,
      );

      // Emit an output message
      const outputMessage: AgentOutputMessage = {
        type: 'output',
        jobId: 'test-job',
        groupFolder: 'test-group',
        timestamp: new Date().toISOString(),
        payload: {
          status: 'success',
          result: 'Test result',
        },
      };

      mockSubscriber.emit(
        'message',
        'nanoclaw:messages:test-group',
        JSON.stringify(outputMessage),
      );

      // Emit completed status to resolve the promise
      const statusMessage: AgentOutputMessage = {
        type: 'status',
        jobId: 'test-job',
        groupFolder: 'test-group',
        timestamp: new Date().toISOString(),
        payload: {
          status: 'completed',
          message: 'Job completed',
        },
      };

      mockSubscriber.emit(
        'message',
        'nanoclaw:messages:test-group',
        JSON.stringify(statusMessage),
      );

      await vi.runAllTimersAsync();
      await expect(streamPromise).resolves.toBeUndefined();
      expect(onOutput).toHaveBeenCalled();
    });

    it('should handle status messages', async () => {
      const onOutput = vi.fn().mockResolvedValue(undefined);

      const streamPromise = jobRunner.streamOutput(
        'test-job',
        'test-group',
        onOutput,
      );

      // Emit a completed status message
      const statusMessage: AgentOutputMessage = {
        type: 'status',
        jobId: 'test-job',
        groupFolder: 'test-group',
        timestamp: new Date().toISOString(),
        payload: {
          status: 'completed',
          message: 'Job completed',
        },
      };

      mockSubscriber.emit(
        'message',
        'nanoclaw:messages:test-group',
        JSON.stringify(statusMessage),
      );

      await vi.runAllTimersAsync();
      await expect(streamPromise).resolves.toBeUndefined();
    });

    it('should reject on failed status', async () => {
      vi.useFakeTimers();

      const onOutput = vi.fn().mockResolvedValue(undefined);

      const streamPromise = jobRunner.streamOutput(
        'test-job',
        'test-group',
        onOutput,
      );

      // Emit a failed status message
      const statusMessage: AgentOutputMessage = {
        type: 'status',
        jobId: 'test-job',
        groupFolder: 'test-group',
        timestamp: new Date().toISOString(),
        payload: {
          status: 'failed',
          message: 'Job failed',
        },
      };

      // Attach rejection handler before emitting so it's never unhandled
      const expectation = expect(streamPromise).rejects.toThrow('Job failed');

      mockSubscriber.emit(
        'message',
        'nanoclaw:messages:test-group',
        JSON.stringify(statusMessage),
      );

      // Wait for promise chain to resolve
      await vi.runAllTimersAsync();
      await expectation;

      vi.useRealTimers();
    });

    it('should handle invalid JSON gracefully', async () => {
      const onOutput = vi.fn().mockResolvedValue(undefined);

      const streamPromise = jobRunner.streamOutput(
        'test-job',
        'test-group',
        onOutput,
      );

      // Emit invalid JSON
      mockSubscriber.emit(
        'message',
        'nanoclaw:messages:test-group',
        'invalid json',
      );

      // Emit completed status to resolve the promise
      const statusMessage: AgentOutputMessage = {
        type: 'status',
        jobId: 'test-job',
        groupFolder: 'test-group',
        timestamp: new Date().toISOString(),
        payload: {
          status: 'completed',
          message: 'Job completed',
        },
      };

      mockSubscriber.emit(
        'message',
        'nanoclaw:messages:test-group',
        JSON.stringify(statusMessage),
      );

      await vi.runAllTimersAsync();
      await expect(streamPromise).resolves.toBeUndefined();
    });
  });

  describe('waitForJobCompletion', () => {
    it('should resolve when job succeeds', async () => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({
        status: {
          succeeded: 1,
        },
      });

      await expect(
        jobRunner.waitForJobCompletion('test-job'),
      ).resolves.toBeUndefined();
    });

    it('should throw when job fails', async () => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({
        status: {
          failed: 1,
          conditions: [
            {
              type: 'Failed',
              reason: 'BackoffLimitExceeded',
              message: 'Job failed due to backoff limit',
            },
          ],
        },
      });

      await expect(jobRunner.waitForJobCompletion('test-job')).rejects.toThrow(
        'BackoffLimitExceeded',
      );
    });

    it('should poll until completion', async () => {
      vi.useFakeTimers();

      let callCount = 0;
      mockBatchApi.readNamespacedJob.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({
            status: {
              active: 1,
            },
          });
        }
        return Promise.resolve({
          status: {
            succeeded: 1,
          },
        });
      });

      const promise = jobRunner.waitForJobCompletion('test-job');

      // Advance time to trigger polling
      await vi.advanceTimersByTimeAsync(10000);
      await vi.advanceTimersByTimeAsync(10000);

      await expect(promise).resolves.toBeUndefined();
      expect(mockBatchApi.readNamespacedJob).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('should handle NotFound error gracefully', async () => {
      mockBatchApi.readNamespacedJob.mockRejectedValue(new Error('NotFound'));

      await expect(
        jobRunner.waitForJobCompletion('test-job'),
      ).resolves.toBeUndefined();
    });

    it('should throw on timeout', async () => {
      vi.useFakeTimers();

      mockBatchApi.readNamespacedJob.mockResolvedValue({
        status: {
          active: 1,
        },
      });

      const promise = jobRunner.waitForJobCompletion('test-job');

      // Attach rejection handler before advancing time so it's never unhandled
      const expectation = expect(promise).rejects.toThrow('Timeout');

      // Advance time beyond max wait time (30 min = 1800000ms)
      await vi.advanceTimersByTimeAsync(1800001);
      await expectation;

      vi.useRealTimers();
    });
  });

  describe('stopJob', () => {
    it('should delete the job successfully', async () => {
      mockBatchApi.deleteNamespacedJob.mockResolvedValue({});

      await expect(jobRunner.stopJob('test-job')).resolves.toBeUndefined();
      expect(mockBatchApi.deleteNamespacedJob).toHaveBeenCalledWith({
        name: 'test-job',
        namespace: 'nanoclaw',
        gracePeriodSeconds: 0,
      });
    });

    it('should handle NotFound error gracefully', async () => {
      mockBatchApi.deleteNamespacedJob.mockRejectedValue(new Error('NotFound'));

      await expect(jobRunner.stopJob('test-job')).resolves.toBeUndefined();
    });

    it('should rethrow other errors', async () => {
      mockBatchApi.deleteNamespacedJob.mockRejectedValue(
        new Error('Server error'),
      );

      await expect(jobRunner.stopJob('test-job')).rejects.toThrow(
        'Server error',
      );
    });
  });

  describe('getJobLogs', () => {
    it('should return pod logs', async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'test-job-abc123',
            },
          },
        ],
      });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue('Pod log content');

      const logs = await jobRunner.getJobLogs('test-job');
      expect(logs).toBe('Pod log content');
    });

    it('should return message when no pods found', async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [],
      });

      const logs = await jobRunner.getJobLogs('test-job');
      expect(logs).toBe('No pods found for job');
    });

    it('should return message when pod name not found', async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          {
            metadata: {},
          },
        ],
      });

      const logs = await jobRunner.getJobLogs('test-job');
      expect(logs).toBe('Pod name not found');
    });

    it('should handle errors and return error message', async () => {
      mockCoreApi.listNamespacedPod.mockRejectedValue(new Error('API error'));

      const logs = await jobRunner.getJobLogs('test-job');
      expect(logs).toContain('Error getting logs');
    });
  });

  describe('cleanup', () => {
    it('should close all connections', async () => {
      // Simulate active subscription
      const unsubscribe = vi.fn();
      (jobRunner as any).activeSubscriptions.set('job1', unsubscribe);

      await expect(jobRunner.cleanup()).resolves.toBeUndefined();
      expect(unsubscribe).toHaveBeenCalled();
      expect((jobRunner as any).activeSubscriptions.size).toBe(0);
    });
  });

  describe('runAgentJob', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should create job and return success', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({
        metadata: {
          name: 'nanoclaw-test-group-123',
        },
      });
      mockBatchApi.readNamespacedJob.mockResolvedValue({
        status: {
          succeeded: 1,
        },
      });

      const onProcess = vi.fn();
      const result = await jobRunner.runAgentJob(
        testGroup,
        testInput,
        onProcess,
      );

      expect(result.status).toBe('success');
      expect(result.jobId).toBeDefined();
      expect(mockBatchApi.createNamespacedJob).toHaveBeenCalled();
      expect(onProcess).toHaveBeenCalled();
    });

    it('should return error on job creation failure', async () => {
      mockBatchApi.createNamespacedJob.mockRejectedValue(
        new Error('K8s API error'),
      );

      const result = await jobRunner.runAgentJob(testGroup, testInput);

      expect(result.status).toBe('error');
      expect(result.error).toBe('K8s API error');
    });

    it('should use custom jobId when provided', async () => {
      const inputWithJobId = { ...testInput, jobId: 'custom-job-id' };
      mockBatchApi.createNamespacedJob.mockResolvedValue({
        metadata: {
          name: 'custom-job-id',
        },
      });
      mockBatchApi.readNamespacedJob.mockResolvedValue({
        status: {
          succeeded: 1,
        },
      });

      const result = await jobRunner.runAgentJob(testGroup, inputWithJobId);

      expect(result.jobId).toBe('custom-job-id');
    });

    it('should use group folder in job name', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({
        metadata: {
          name: 'nanoclaw-test-group-123',
        },
      });
      mockBatchApi.readNamespacedJob.mockResolvedValue({
        status: {
          succeeded: 1,
        },
      });

      await jobRunner.runAgentJob(testGroup, testInput);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      expect(callArgs.body.metadata.name).toContain('test-group');
    });
  });
});
