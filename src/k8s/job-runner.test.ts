import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { RegisteredGroup } from '../types.js';
import type { JobInput, AgentOutputMessage, ToolPodJobSpec } from './types.js';

// Store original env vars for cleanup
const originalRedisUrl = process.env.REDIS_URL;
const originalRedisPassword = process.env.REDIS_ADMIN_PASSWORD;

// Mock config
vi.mock('../config.js', () => ({
  CONTAINER_IMAGE: 'kubeclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
  KUBECLAW_NAMESPACE: 'nanoclaw',
  AGENT_JOB_MEMORY_REQUEST: '512Mi',
  AGENT_JOB_MEMORY_LIMIT: '4Gi',
  AGENT_JOB_CPU_REQUEST: '250m',
  AGENT_JOB_CPU_LIMIT: '2000m',
  REDIS_AGENT_PASSWORD: '',
  REDIS_TOOL_SERVER_PASSWORD: '',
  REDIS_ADAPTER_PASSWORD: '',
  assertToolImageAllowed: vi.fn(),
  getContainerImage: vi.fn((provider: string) => {
    if (provider === 'openrouter') {
      return 'kubeclaw-agent:openrouter';
    }
    return 'kubeclaw-agent:claude';
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
      (groupFolder: string) => `kubeclaw:messages:${groupFolder}`,
    ),
    closeRedisConnections: vi.fn().mockResolvedValue(undefined),
    __mockSubscriber: mockSubscriber,
  };
});

// Mock Kubernetes client - use vi.hoisted to access mocks after setup
const { mockBatchApi, mockCoreApi, mockAppsApi, mockLoadAllYaml } = vi.hoisted(
  () => {
    const mockBatchApi = {
      createNamespacedJob: vi.fn(),
      readNamespacedJob: vi.fn(),
      deleteNamespacedJob: vi.fn(),
    };

    const mockCoreApi = {
      listNamespacedPod: vi.fn(),
      readNamespacedPodLog: vi.fn(),
      createNamespacedPersistentVolumeClaim: vi.fn(),
      createNamespacedService: vi.fn(),
      replaceNamespacedService: vi.fn(),
    };

    const mockAppsApi = {
      createNamespacedDeployment: vi.fn(),
      replaceNamespacedDeployment: vi.fn(),
    };

    const mockLoadAllYaml = vi.fn(() => []);

    return { mockBatchApi, mockCoreApi, mockAppsApi, mockLoadAllYaml };
  },
);

vi.mock('@kubernetes/client-node', () => {
  return {
    KubeConfig: class KubeConfig {
      loadFromDefault = vi.fn();
      makeApiClient = vi.fn((apiClass: any) => {
        if (apiClass === 'CoreV1Api') return mockCoreApi;
        if (apiClass === 'BatchV1Api') return mockBatchApi;
        if (apiClass === 'AppsV1Api') return mockAppsApi;
        return {};
      });
    },
    CoreV1Api: 'CoreV1Api',
    BatchV1Api: 'BatchV1Api',
    AppsV1Api: 'AppsV1Api',
    loadAllYaml: mockLoadAllYaml,
  };
});

// Now import after mocks are set up
import { JobRunner, buildJobName } from './job-runner.js';

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
    // Clean up Redis env vars
    if (originalRedisUrl !== undefined) {
      process.env.REDIS_URL = originalRedisUrl;
    } else {
      delete process.env.REDIS_URL;
    }
    if (originalRedisPassword !== undefined) {
      process.env.REDIS_ADMIN_PASSWORD = originalRedisPassword;
    } else {
      delete process.env.REDIS_ADMIN_PASSWORD;
    }
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
        'kubeclaw-agent:claude',
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
          (e) => e.name === 'KUBECLAW_GROUP_FOLDER' && e.value === 'test-group',
        ),
      ).toBe(true);
      expect(
        envVars.some(
          (e) => e.name === 'KUBECLAW_PROMPT' && e.value === 'Test prompt',
        ),
      ).toBe(true);
      expect(
        envVars.some(
          (e) => e.name === 'KUBECLAW_SESSION_ID' && e.value === 'session-123',
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
        'kubeclaw-agent:openrouter',
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

  describe('REDIS_URL in generateJobManifest', () => {
    it('should return base URL unchanged when REDIS_ADMIN_PASSWORD is not set', () => {
      delete process.env.REDIS_ADMIN_PASSWORD;
      process.env.REDIS_URL = 'redis://kubeclaw-redis:6379';

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
      const envVars = manifest.spec?.template?.spec?.containers?.[0]?.env || [];
      const redisUrl = envVars.find((e) => e.name === 'REDIS_URL')?.value;

      expect(redisUrl).toBe('redis://kubeclaw-redis:6379');
    });

    it('should embed password when REDIS_ADMIN_PASSWORD is set', () => {
      process.env.REDIS_ADMIN_PASSWORD = 'secretpassword';
      process.env.REDIS_URL = 'redis://kubeclaw-redis:6379';

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
      const envVars = manifest.spec?.template?.spec?.containers?.[0]?.env || [];
      const redisUrl = envVars.find((e) => e.name === 'REDIS_URL')?.value;

      expect(redisUrl).toBe('redis://agent:secretpassword@kubeclaw-redis:6379');
    });

    it('should not double-embed password when URL already contains @', () => {
      process.env.REDIS_ADMIN_PASSWORD = 'newpassword';
      process.env.REDIS_URL = 'redis://:existing@kubeclaw-redis:6379';

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
      const envVars = manifest.spec?.template?.spec?.containers?.[0]?.env || [];
      const redisUrl = envVars.find((e) => e.name === 'REDIS_URL')?.value;

      // Should remain unchanged since it already has credentials
      expect(redisUrl).toBe('redis://:existing@kubeclaw-redis:6379');
    });

    it('should percent-encode special characters in password', () => {
      process.env.REDIS_ADMIN_PASSWORD = 'p@ss#';
      process.env.REDIS_URL = 'redis://kubeclaw-redis:6379';

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
      const envVars = manifest.spec?.template?.spec?.containers?.[0]?.env || [];
      const redisUrl = envVars.find((e) => e.name === 'REDIS_URL')?.value;

      // @ becomes %40, # becomes %23; agent username prepended
      expect(redisUrl).toBe('redis://agent:p%40ss%23@kubeclaw-redis:6379');
    });
  });

  describe('buildJobName', () => {
    it('should return a string starting with nc-', () => {
      const name = buildJobName('test-group');
      expect(name).toMatch(/^nc-/);
    });

    it('should return result with ≤ 63 characters', () => {
      const name = buildJobName('test-group');
      expect(name.length).toBeLessThanOrEqual(63);
    });

    it('should truncate long folder names to keep total ≤ 63 chars', () => {
      const longFolder = 'a'.repeat(100);
      const name = buildJobName(longFolder);
      expect(name.length).toBeLessThanOrEqual(63);
      // Should still start with nc- and have suffix
      expect(name).toMatch(/^nc-.*-[a-z0-9]{6}$/);
    });

    it('should replace special characters with hyphens', () => {
      const name = buildJobName('test@group#name!');
      expect(name).toMatch(/^nc-test-group-name-/);
    });

    it('should strip leading hyphens from sanitized folder', () => {
      const name = buildJobName('@test-group');
      // Leading @ becomes hyphen which should be stripped
      expect(name).toMatch(/^nc-test-group-/);
      expect(name).not.toMatch(/^nc--/);
    });

    it('should strip trailing hyphens from sanitized folder', () => {
      const name = buildJobName('test-group@');
      // Trailing @ becomes hyphen which should be stripped
      expect(name).toMatch(/^nc-test-group-/);
      // Make sure there are no trailing hyphens before the suffix dash
      expect(name).not.toMatch(/test-group--[a-z0-9]/);
    });

    it('should return different names for two calls with same folder', () => {
      vi.useFakeTimers();

      const name1 = buildJobName('test-group');

      // Advance time to ensure different suffix
      vi.advanceTimersByTime(1000);

      const name2 = buildJobName('test-group');

      expect(name1).not.toBe(name2);

      vi.useRealTimers();
    });

    it('should convert uppercase letters to lowercase', () => {
      const name = buildJobName('Test-Group');
      expect(name).toBe(name.toLowerCase());
    });

    it('should handle multiple consecutive special chars as single hyphen', () => {
      const name = buildJobName('test@@@group');
      // Multiple @ should be collapsed to single hyphens by replace
      expect(name).toMatch(/^nc-test-group-/);
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
        'kubeclaw:messages:test-group',
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
        'kubeclaw:messages:test-group',
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
        'kubeclaw:messages:test-group',
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
        'kubeclaw:messages:test-group',
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
        'kubeclaw:messages:test-group',
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
        'kubeclaw:messages:test-group',
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
          name: 'kubeclaw-test-group-123',
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
          name: 'kubeclaw-test-group-123',
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

  describe('createToolPodJob', () => {
    it('should create a job with correct labels', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'execution',
        timeout: 300000,
      };

      await jobRunner.createToolPodJob(spec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const labels = callArgs.body.metadata?.labels;

      expect(labels?.app).toBe('kubeclaw-tool-pod');
      expect(labels?.['nanoclaw/group']).toBe('test-group');
      expect(labels?.['nanoclaw/category']).toBe('execution');
      expect(labels?.['nanoclaw/agent-job']).toBe('agent-job-123');
    });

    it('should run container with node /app/dist/tool-server.js command', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'execution',
        timeout: 300000,
      };

      await jobRunner.createToolPodJob(spec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const container = callArgs.body.spec?.template?.spec?.containers?.[0];

      expect(container?.command).toEqual(['node', '/app/dist/tool-server.js']);
    });

    it('should set KUBECLAW_AGENT_JOB_ID and KUBECLAW_CATEGORY env vars', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'browser',
        timeout: 300000,
      };

      await jobRunner.createToolPodJob(spec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const envVars =
        callArgs.body.spec?.template?.spec?.containers?.[0]?.env || [];

      expect(
        envVars.find(
          (e: { name: string }) => e.name === 'KUBECLAW_AGENT_JOB_ID',
        )?.value,
      ).toBe('agent-job-123');
      expect(
        envVars.find((e: { name: string }) => e.name === 'KUBECLAW_CATEGORY')
          ?.value,
      ).toBe('browser');
    });

    it('should set REDIS_URL env var', async () => {
      delete process.env.REDIS_ADMIN_PASSWORD;
      process.env.REDIS_URL = 'redis://kubeclaw-redis:6379';

      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'execution',
        timeout: 300000,
      };

      await jobRunner.createToolPodJob(spec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const envVars =
        callArgs.body.spec?.template?.spec?.containers?.[0]?.env || [];

      expect(
        envVars.find((e: { name: string }) => e.name === 'REDIS_URL')?.value,
      ).toBe('redis://kubeclaw-redis:6379');
    });

    it('should set REDIS_URL with password when REDIS_ADMIN_PASSWORD is set', async () => {
      process.env.REDIS_ADMIN_PASSWORD = 'toolpassword';
      process.env.REDIS_URL = 'redis://kubeclaw-redis:6379';

      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'execution',
        timeout: 300000,
      };

      await jobRunner.createToolPodJob(spec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const envVars =
        callArgs.body.spec?.template?.spec?.containers?.[0]?.env || [];

      expect(
        envVars.find((e: { name: string }) => e.name === 'REDIS_URL')?.value,
      ).toBe('redis://tool-server:toolpassword@kubeclaw-redis:6379');
    });

    it('should return the job name string on success', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'execution',
        timeout: 300000,
      };

      const result = await jobRunner.createToolPodJob(spec);

      expect(typeof result).toBe('string');
      expect(result).toMatch(/^nc-test-group-execution-/);
    });

    it('should throw when batchApi.createNamespacedJob rejects', async () => {
      mockBatchApi.createNamespacedJob.mockRejectedValue(
        new Error('K8s API error'),
      );

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'execution',
        timeout: 300000,
      };

      await expect(jobRunner.createToolPodJob(spec)).rejects.toThrow(
        'K8s API error',
      );
    });

    it('should include volume mounts for execution category', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'execution',
        timeout: 300000,
      };

      await jobRunner.createToolPodJob(spec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const volumeMounts =
        callArgs.body.spec?.template?.spec?.containers?.[0]?.volumeMounts || [];

      expect(
        volumeMounts.some(
          (v: { mountPath: string }) => v.mountPath === '/workspace/group',
        ),
      ).toBe(true);
    });

    it('should not include volume mounts for browser category', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'browser',
        timeout: 300000,
      };

      await jobRunner.createToolPodJob(spec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const volumeMounts =
        callArgs.body.spec?.template?.spec?.containers?.[0]?.volumeMounts || [];

      expect(volumeMounts.length).toBe(0);
    });

    it('should include correct volumes for execution category', async () => {
      mockBatchApi.createNamespacedJob.mockResolvedValue({});

      const spec: ToolPodJobSpec = {
        agentJobId: 'agent-job-123',
        groupFolder: 'test-group',
        category: 'execution',
        timeout: 300000,
      };

      await jobRunner.createToolPodJob(spec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const volumes = callArgs.body.spec?.template?.spec?.volumes || [];

      expect(
        volumes.some((v: { name: string }) => v.name === 'groups-pvc'),
      ).toBe(true);
      expect(
        volumes.some((v: { name: string }) => v.name === 'sessions-pvc'),
      ).toBe(true);
    });
  });

  describe('generateJobManifest — service account', () => {
    it('sets automountServiceAccountToken: false on all agent jobs', () => {
      const manifest = jobRunner.generateJobManifest({
        name: 'nc-test-abc',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'hello',
        provider: 'openai',
      });

      const podSpec = manifest.spec?.template?.spec as any;
      expect(podSpec.automountServiceAccountToken).toBe(false);
      expect(podSpec.serviceAccountName).toBe('');
    });

    it('does not mount plugins PVC on agent jobs', () => {
      const manifest = jobRunner.generateJobManifest({
        name: 'nc-test-abc',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'hello',
        provider: 'openai',
      });

      const volumes = manifest.spec?.template?.spec?.volumes as any[];
      expect(volumes?.some((v: any) => v.name === 'plugins-pvc')).toBeFalsy();
      const volumeMounts = manifest.spec?.template?.spec?.containers?.[0]
        ?.volumeMounts as any[];
      expect(
        volumeMounts?.some((m: any) => m.mountPath === '/workspace/plugins'),
      ).toBeFalsy();
    });
  });

  describe('applyYamlToK8s', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('creates a Deployment', async () => {
      mockLoadAllYaml.mockReturnValue([
        {
          kind: 'Deployment',
          metadata: { name: 'my-deploy', namespace: 'kubeclaw' },
        },
      ]);
      mockAppsApi.createNamespacedDeployment.mockResolvedValue({});

      await jobRunner.applyYamlToK8s('kind: Deployment');

      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledWith({
        namespace: 'kubeclaw',
        body: expect.objectContaining({ kind: 'Deployment' }),
      });
    });

    it('replaces a Deployment when it already exists', async () => {
      mockLoadAllYaml.mockReturnValue([
        {
          kind: 'Deployment',
          metadata: { name: 'my-deploy', namespace: 'kubeclaw' },
        },
      ]);
      mockAppsApi.createNamespacedDeployment.mockRejectedValue(
        new Error('AlreadyExists'),
      );
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      await jobRunner.applyYamlToK8s('kind: Deployment');

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledWith({
        name: 'my-deploy',
        namespace: 'kubeclaw',
        body: expect.objectContaining({ kind: 'Deployment' }),
      });
    });

    it('creates a PVC and skips replace if already exists', async () => {
      mockLoadAllYaml.mockReturnValue([
        {
          kind: 'PersistentVolumeClaim',
          metadata: { name: 'my-pvc', namespace: 'kubeclaw' },
        },
      ]);
      mockCoreApi.createNamespacedPersistentVolumeClaim.mockRejectedValue(
        new Error('AlreadyExists'),
      );

      // Should not throw
      await expect(
        jobRunner.applyYamlToK8s('kind: PVC'),
      ).resolves.toBeUndefined();
    });

    it('creates a Service', async () => {
      mockLoadAllYaml.mockReturnValue([
        {
          kind: 'Service',
          metadata: { name: 'my-svc', namespace: 'kubeclaw' },
        },
      ]);
      mockCoreApi.createNamespacedService.mockResolvedValue({});

      await jobRunner.applyYamlToK8s('kind: Service');

      expect(mockCoreApi.createNamespacedService).toHaveBeenCalledWith({
        namespace: 'kubeclaw',
        body: expect.objectContaining({ kind: 'Service' }),
      });
    });

    it('replaces a Service when it already exists', async () => {
      mockLoadAllYaml.mockReturnValue([
        {
          kind: 'Service',
          metadata: { name: 'my-svc', namespace: 'kubeclaw' },
        },
      ]);
      mockCoreApi.createNamespacedService.mockRejectedValue(
        new Error('AlreadyExists'),
      );
      mockCoreApi.replaceNamespacedService.mockResolvedValue({});

      await jobRunner.applyYamlToK8s('kind: Service');

      expect(mockCoreApi.replaceNamespacedService).toHaveBeenCalled();
    });

    it('handles multi-document YAML', async () => {
      mockLoadAllYaml.mockReturnValue([
        {
          kind: 'Deployment',
          metadata: { name: 'deploy', namespace: 'kubeclaw' },
        },
        { kind: 'Service', metadata: { name: 'svc', namespace: 'kubeclaw' } },
      ]);
      mockAppsApi.createNamespacedDeployment.mockResolvedValue({});
      mockCoreApi.createNamespacedService.mockResolvedValue({});

      await jobRunner.applyYamlToK8s('multi-doc');

      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1);
      expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(1);
    });

    it('skips documents without kind', async () => {
      mockLoadAllYaml.mockReturnValue([
        null,
        { metadata: { name: 'no-kind' } },
        {
          kind: 'Deployment',
          metadata: { name: 'valid', namespace: 'kubeclaw' },
        },
      ]);
      mockAppsApi.createNamespacedDeployment.mockResolvedValue({});

      await jobRunner.applyYamlToK8s('yaml');

      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1);
    });

    it('uses orchestrator namespace as fallback when doc has no namespace', async () => {
      mockLoadAllYaml.mockReturnValue([
        { kind: 'Deployment', metadata: { name: 'my-deploy' } },
      ]);
      mockAppsApi.createNamespacedDeployment.mockResolvedValue({});

      await jobRunner.applyYamlToK8s('yaml');

      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'nanoclaw' }),
      );
    });
  });

  describe('createSidecarToolPodJob', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockBatchApi.createNamespacedJob.mockResolvedValue({});
    });

    const baseSpec = {
      agentJobId: 'direct-abc123-deadbeef',
      groupFolder: 'my-group',
      toolName: 'home_control',
      toolSpec: {
        name: 'home_control',
        description: 'Control smart home',
        parameters: {},
        image: 'my-ha:latest',
        pattern: 'http' as const,
        port: 8080,
      },
      timeout: 60000,
    };

    it('creates a two-container job for http pattern', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const containers = callArgs.body.spec?.template?.spec?.containers;
      expect(containers).toHaveLength(2);
      expect(containers[0].name).toBe('kubeclaw-tool-bridge');
      expect(containers[1].name).toBe('user-tool');
      expect(containers[1].image).toBe('my-ha:latest');
    });

    it('sets KUBECLAW_TOOL_MODE=http-bridge env on bridge container', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);

      const containers =
        mockBatchApi.createNamespacedJob.mock.calls[0][0].body.spec?.template
          ?.spec?.containers;
      const bridgeEnv: { name: string; value: string }[] = containers[0].env;
      expect(
        bridgeEnv.find((e) => e.name === 'KUBECLAW_TOOL_MODE')?.value,
      ).toBe('http-bridge');
      expect(
        bridgeEnv.find((e) => e.name === 'KUBECLAW_TOOL_PORT')?.value,
      ).toBe('8080');
      expect(bridgeEnv.find((e) => e.name === 'KUBECLAW_CATEGORY')?.value).toBe(
        'home_control',
      );
    });

    it('uses file-bridge mode and adds shared emptyDir for file pattern', async () => {
      const fileSpec = {
        ...baseSpec,
        toolSpec: { ...baseSpec.toolSpec, pattern: 'file' as const },
      };
      await jobRunner.createSidecarToolPodJob(fileSpec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const containers = callArgs.body.spec?.template?.spec?.containers;
      const bridgeEnv: { name: string; value: string }[] = containers[0].env;
      expect(
        bridgeEnv.find((e) => e.name === 'KUBECLAW_TOOL_MODE')?.value,
      ).toBe('file-bridge');

      const volumes = callArgs.body.spec?.template?.spec?.volumes;
      expect(volumes?.some((v: any) => v.name === 'shared' && v.emptyDir)).toBe(
        true,
      );

      // Both containers share the volume
      expect(
        containers[0].volumeMounts?.some((m: any) => m.mountPath === '/shared'),
      ).toBe(true);
      expect(
        containers[1].volumeMounts?.some((m: any) => m.mountPath === '/shared'),
      ).toBe(true);
    });

    it('no shared volume for http pattern', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      const volumes = callArgs.body.spec?.template?.spec?.volumes ?? [];
      expect(volumes.some((v: any) => v.name === 'shared')).toBe(false);
    });

    it('job name is within 63 chars', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);

      const jobName = mockBatchApi.createNamespacedJob.mock.calls[0][0].body
        .metadata?.name as string;
      expect(jobName.length).toBeLessThanOrEqual(63);
      expect(jobName).toContain('stool');
    });
  });
});
