import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { RegisteredGroup } from '../types.js';
import type {
  JobInput,
  AgentOutputMessage,
  ToolJobSpec,
} from './types.js';

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
  KUBECLAW_NAMESPACE: 'kubeclaw',
  TOOL_JOB_MEMORY_REQUEST: '512Mi',
  TOOL_JOB_MEMORY_LIMIT: '4Gi',
  TOOL_JOB_CPU_REQUEST: '250m',
  TOOL_JOB_CPU_LIMIT: '2000m',
  REDIS_AGENT_PASSWORD: '',
  REDIS_TOOL_SERVER_PASSWORD: '',
  CREDENTIAL_SIDECAR_IMAGE: 'envoyproxy/envoy:v1.31-latest',
  CREDENTIAL_SIDECAR_PORT: 8443,
  assertToolImageAllowed: vi.fn(),
  assertGroupMountAllowed: vi.fn(),
  getContainerImage: vi.fn(() => 'kubeclaw-agent:latest'),
  getInjectionMode: vi.fn(() => {
    const raw = process.env.CREDENTIAL_INJECTION_MODE;
    if (raw === 'sidecar' || raw === 'istio') return raw;
    return 'off';
  }),
  getAuditOnly: vi.fn(
    () => process.env.CREDENTIAL_INJECTION_AUDIT_ONLY === 'true',
  ),
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

// Mock ACL manager
const { mockCreateToolPodACL } = vi.hoisted(() => ({
  mockCreateToolPodACL: vi.fn(),
}));

vi.mock('./acl-manager.js', () => ({
  getACLManager: vi.fn(() => ({
    createToolPodACL: mockCreateToolPodACL,
  })),
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
import { JobRunner, buildJobName, parseContainerOutputFromLogs } from './job-runner.js';
import * as configModule from '../config.js';
import { assertGroupMountAllowed } from '../config.js';

function makeSpec(overrides: Partial<ToolJobSpec> = {}): ToolJobSpec {
  return {
    name: 'test-job',
    groupFolder: 'test-group',
    chatJid: 'test@chat',
    isMain: false,
    prompt: 'hello',
    sessionId: 'sess1',
    assistantName: 'Andy',
    timeout: 60000,
    provider: 'claude',
    ...overrides,
  };
}

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
      expect(manifest.metadata?.namespace).toBe('kubeclaw');
      expect(manifest.spec?.template?.spec?.containers?.[0]?.image).toBe(
        'kubeclaw-agent:latest',
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

    it('should use kubeclaw-agent:latest image when provider is openrouter', () => {
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
        'kubeclaw-agent:latest',
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

    it('channel-pod spec mounts kubeclaw-specialists ConfigMap optionally', () => {
      const spec = makeSpec();
      const manifest = jobRunner.generateJobManifest(spec);

      const volumes = manifest.spec?.template?.spec?.volumes || [];
      const vol = volumes.find((v) => v.name === 'specialists-catalog');
      expect(vol).toBeDefined();
      expect(vol!.configMap).toEqual({
        name: 'kubeclaw-specialists',
        optional: true,
      });

      const volumeMounts =
        manifest.spec?.template?.spec?.containers?.[0]?.volumeMounts || [];
      const mount = volumeMounts.find((m) => m.name === 'specialists-catalog');
      expect(mount).toEqual({
        name: 'specialists-catalog',
        mountPath: '/etc/kubeclaw/specialists',
        readOnly: true,
      });
    });

    it('agent job manifest mounts the kubeclaw-tools ConfigMap at /etc/kubeclaw/tools', () => {
      const manifest = jobRunner.generateJobManifest(makeSpec());
      const container = manifest.spec.template.spec.containers[0];
      const mount = container.volumeMounts.find(
        (m: any) => m.mountPath === '/etc/kubeclaw/tools',
      );
      expect(mount).toBeDefined();
      expect(mount.readOnly).toBe(true);
      const vol = manifest.spec.template.spec.volumes.find(
        (v: any) => v.name === mount.name,
      );
      expect(vol.configMap.name).toBe('kubeclaw-tools');
      expect(vol.configMap.optional).toBe(true);
    });

    it('claude provider: injects ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL', () => {
      const spec = makeSpec({ provider: 'claude' });
      const manifest = jobRunner.generateJobManifest(spec);
      const envNames = (
        manifest.spec?.template?.spec?.containers?.[0]?.env ?? []
      ).map((e) => e.name);
      expect(envNames).toContain('ANTHROPIC_API_KEY');
      expect(envNames).toContain('ANTHROPIC_BASE_URL');
      expect(envNames).toContain('ANTHROPIC_MODEL');
    });

    it('claude provider: does NOT inject CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN', () => {
      const spec = makeSpec({ provider: 'claude' });
      const manifest = jobRunner.generateJobManifest(spec);
      const envNames = (
        manifest.spec?.template?.spec?.containers?.[0]?.env ?? []
      ).map((e) => e.name);
      expect(envNames).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(envNames).not.toContain('ANTHROPIC_AUTH_TOKEN');
    });

    it('claude provider: does NOT mount /home/node/.claude', () => {
      const spec = makeSpec({ provider: 'claude' });
      const manifest = jobRunner.generateJobManifest(spec);
      const volumeMounts =
        manifest.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? [];
      expect(
        volumeMounts.some((m) => m.mountPath === '/home/node/.claude'),
      ).toBe(false);
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
        namespace: 'kubeclaw',
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

  describe('runToolJob', () => {
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
      const result = await jobRunner.runToolJob(
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

      const result = await jobRunner.runToolJob(testGroup, testInput);

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

      const result = await jobRunner.runToolJob(testGroup, inputWithJobId);

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

      await jobRunner.runToolJob(testGroup, testInput);

      const callArgs = mockBatchApi.createNamespacedJob.mock.calls[0][0];
      expect(callArgs.body.metadata.name).toContain('test-group');
    });
  });

  describe('generateJobManifest — service account', () => {
    it('sets automountServiceAccountToken: false on all tool jobs', () => {
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

    it('does not mount plugins PVC on tool jobs', () => {
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
        expect.objectContaining({ namespace: 'kubeclaw' }),
      );
    });
  });

  describe('createSidecarToolPodJob', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockBatchApi.createNamespacedJob.mockResolvedValue({});
      mockCreateToolPodACL.mockResolvedValue({
        username: 'stool-default',
        password: 'default-pass',
      });
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

    it("falls back to the 'tool-server' ACL user (regression: previously used the 'adapter' user, which cannot read toolcalls)", async () => {
      // Regression: createSidecarToolPodJob previously authenticated as the
      // 'adapter' ACL user, which only has read-only access to kubeclaw:input:*.
      // The bridge needs XREAD on kubeclaw:toolcalls:* and XADD on
      // kubeclaw:toolresults:* — both granted only to 'tool-server'.
      // When per-job ACL minting fails, the fallback must use 'tool-server'.
      mockCreateToolPodACL.mockRejectedValueOnce(new Error('redis 6, no ACLs'));
      process.env.REDIS_ADMIN_PASSWORD = 'testpass';
      process.env.REDIS_URL = 'redis://kubeclaw-redis:6379';

      await jobRunner.createSidecarToolPodJob(baseSpec);

      const containers =
        mockBatchApi.createNamespacedJob.mock.calls[0][0].body.spec?.template
          ?.spec?.containers;
      const bridgeEnv: { name: string; value: string }[] = containers[0].env;
      const redisUrl = bridgeEnv.find((e) => e.name === 'REDIS_URL')?.value;

      expect(redisUrl).toBe('redis://tool-server:testpass@kubeclaw-redis:6379');
      expect(redisUrl).not.toContain('adapter');
    });

    it('passes KUBECLAW_TOOL_HEALTH_PATH to the bridge when ToolSpec.healthPath is set', async () => {
      await jobRunner.createSidecarToolPodJob({
        ...baseSpec,
        toolSpec: { ...baseSpec.toolSpec, healthPath: '/healthz' },
      });

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      expect(bridge.env).toContainEqual({
        name: 'KUBECLAW_TOOL_HEALTH_PATH',
        value: '/healthz',
      });
    });

    it('omits KUBECLAW_TOOL_HEALTH_PATH when ToolSpec.healthPath is absent', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      expect(bridge.env.map((e: any) => e.name)).not.toContain(
        'KUBECLAW_TOOL_HEALTH_PATH',
      );
    });

    it('stamps KUBECLAW_TOOL_REQUEST_MAPPING when toolSpec.requestMapping is set', async () => {
      const mapping = { method: 'GET', path: '/weather/{city}' };
      await jobRunner.createSidecarToolPodJob({
        ...baseSpec,
        toolSpec: {
          ...baseSpec.toolSpec,
          pattern: 'http' as const,
          requestMapping: mapping,
        },
      });
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const env = bridge.env.find(
        (e: any) => e.name === 'KUBECLAW_TOOL_REQUEST_MAPPING',
      );
      expect(env).toBeTruthy();
      expect(JSON.parse(env.value)).toEqual(mapping);
    });

    it('omits KUBECLAW_TOOL_REQUEST_MAPPING when requestMapping is absent', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      expect(bridge.env.map((e: any) => e.name)).not.toContain(
        'KUBECLAW_TOOL_REQUEST_MAPPING',
      );
    });

    it('embeds per-job ACL credentials in the bridge REDIS_URL', async () => {
      mockCreateToolPodACL.mockResolvedValueOnce({
        username: 'stool-test-user',
        password: 'p4ss',
      });

      await jobRunner.createSidecarToolPodJob(baseSpec);

      expect(mockCreateToolPodACL).toHaveBeenCalledWith(
        expect.stringMatching(/^kubeclaw-stool-/),
        baseSpec.agentJobId,
        baseSpec.toolName,
        baseSpec.groupFolder,
        expect.any(Number),
      );

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const redisEnv = bridge.env.find((e: any) => e.name === 'REDIS_URL');
      expect(redisEnv.value).toContain('stool-test-user:p4ss@');
    });

    it('falls back to the shared tool-server user when ACL minting fails', async () => {
      mockCreateToolPodACL.mockRejectedValueOnce(new Error('redis 6, no ACLs'));

      await jobRunner.createSidecarToolPodJob(baseSpec);

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      expect(call).toBeTruthy(); // job still created
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const redisEnv = bridge.env.find((e: any) => e.name === 'REDIS_URL');
      expect(redisEnv.value).not.toContain('stool-');
    });

    it('bridge container REDIS_URL uses tool-server when REDIS_TOOL_SERVER_PASSWORD is set (fallback: no password → plain URL)', async () => {
      // Force fallback path so we test the shared-user credential assembly.
      mockCreateToolPodACL.mockRejectedValueOnce(new Error('minting disabled'));
      delete process.env.REDIS_ADMIN_PASSWORD;
      process.env.REDIS_URL = 'redis://kubeclaw-redis:6379';

      // The config mock returns REDIS_TOOL_SERVER_PASSWORD as empty string by
      // default. Override via env so buildRedisUrl falls through to REDIS_ADMIN_PASSWORD.
      // When both are absent the URL stays plain — verify user is still tool-server.
      delete process.env.REDIS_ADMIN_PASSWORD;
      process.env.REDIS_URL = 'redis://kubeclaw-redis:6379';

      await jobRunner.createSidecarToolPodJob(baseSpec);

      const containers =
        mockBatchApi.createNamespacedJob.mock.calls[0][0].body.spec?.template
          ?.spec?.containers;
      const bridgeEnv: { name: string; value: string }[] = containers[0].env;
      const redisUrl = bridgeEnv.find((e) => e.name === 'REDIS_URL')?.value;

      // No password → URL passes through unchanged (no embedded credentials)
      expect(redisUrl).toBe('redis://kubeclaw-redis:6379');
      // And critically: the URL must not embed 'adapter'
      expect(redisUrl).not.toContain('adapter');
    });

    it('mounts the tool-wrapper ConfigMap into the user container for file-bridge pods', async () => {
      const fileSpec = {
        ...baseSpec,
        toolSpec: { ...baseSpec.toolSpec, pattern: 'file' as const },
      };
      await jobRunner.createSidecarToolPodJob(fileSpec);

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const podSpec = call.body.spec.template.spec;
      const userTool = podSpec.containers.find(
        (c: any) => c.name === 'user-tool',
      );
      const bridge = podSpec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );

      expect(userTool.volumeMounts).toContainEqual({
        name: 'tool-wrapper',
        mountPath: '/kubeclaw',
        readOnly: true,
      });
      // Bridge does NOT get the wrapper, but both share /shared
      expect(bridge.volumeMounts.map((m: any) => m.name)).not.toContain(
        'tool-wrapper',
      );
      expect(bridge.volumeMounts.map((m: any) => m.name)).toContain('shared');
      expect(userTool.volumeMounts.map((m: any) => m.name)).toContain('shared');

      expect(podSpec.volumes).toContainEqual({
        name: 'tool-wrapper',
        configMap: {
          name: 'kubeclaw-tool-wrapper',
          defaultMode: 0o755,
          optional: true,
        },
      });
    });

    it('does not mount the wrapper for http-bridge pods', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const volumes = call.body.spec.template.spec.volumes ?? [];
      expect(volumes.map((v: any) => v.name)).not.toContain('tool-wrapper');
    });

    it('does not mount the wrapper for acp-bridge pods', async () => {
      await jobRunner.createSidecarToolPodJob({
        ...baseSpec,
        toolSpec: {
          ...baseSpec.toolSpec,
          pattern: 'acp' as const,
          acpAgentName: 'my-agent',
        },
      });
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const volumes = call.body.spec.template.spec.volumes ?? [];
      expect(volumes.map((v: any) => v.name)).not.toContain('tool-wrapper');
    });

    const fileSpec = (mount?: string, extra: Record<string, unknown> = {}) => ({
      ...baseSpec,
      toolSpec: {
        ...baseSpec.toolSpec,
        pattern: 'file' as const,
        image: 'alpine:latest',
        run: 'sh -c "$(cat "$INPUT_DIR/command")"',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
        },
        ...(mount ? { mount } : {}),
        ...extra,
      },
    });

    it('sets the user-tool command to the wrapper and passes run + fields env', async () => {
      await jobRunner.createSidecarToolPodJob(fileSpec('scratch'));
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const user = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'user-tool',
      );
      expect(user.command).toEqual(['/bin/sh', '/kubeclaw/tool-wrapper.sh']);
      const userEnvMap = Object.fromEntries(
        user.env.map((e: any) => [e.name, e.value]),
      );
      expect(userEnvMap.KUBECLAW_TOOL_RUN).toBe(
        'sh -c "$(cat "$INPUT_DIR/command")"',
      );
      expect(userEnvMap.WORKDIR).toBe('/work');
      // KUBECLAW_TOOL_FIELDS must NOT be on user-tool (the bridge reads it, not the wrapper)
      expect(userEnvMap.KUBECLAW_TOOL_FIELDS).toBeUndefined();

      // bridge must have KUBECLAW_TOOL_FIELDS (tool-server.ts reads it to write input files)
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const bridgeEnvMap = Object.fromEntries(
        bridge.env.map((e: any) => [e.name, e.value]),
      );
      expect(bridgeEnvMap.KUBECLAW_TOOL_FIELDS).toBe('command');
    });

    it('mount: scratch adds a work emptyDir at /work on the user container', async () => {
      await jobRunner.createSidecarToolPodJob(fileSpec('scratch'));
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const podSpec = call.body.spec.template.spec;
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.volumeMounts).toContainEqual({
        name: 'work',
        mountPath: '/work',
      });
      expect(podSpec.volumes).toContainEqual({ name: 'work', emptyDir: {} });
      const bridge = podSpec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      expect(bridge.volumeMounts.map((m: any) => m.name)).not.toContain('work');
    });

    it('mount: group mounts the group PVC subPath at /work (RW) and checks the allowlist', async () => {
      await jobRunner.createSidecarToolPodJob(fileSpec('group'));
      expect(assertGroupMountAllowed).toHaveBeenCalledWith('alpine:latest');
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const podSpec = call.body.spec.template.spec;
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.volumeMounts).toContainEqual({
        name: 'work',
        mountPath: '/work',
        subPath: baseSpec.groupFolder,
        readOnly: false,
      });
      expect(podSpec.volumes).toContainEqual({
        name: 'work',
        persistentVolumeClaim: { claimName: 'kubeclaw-groups' },
      });
      const bridge = podSpec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      expect(bridge.volumeMounts.map((m: any) => m.name)).not.toContain('work');
    });

    it('mount: group throws when groupFolder is empty', async () => {
      const spec = fileSpec('group');
      (spec as any).groupFolder = '';
      await expect(jobRunner.createSidecarToolPodJob(spec)).rejects.toThrow(
        /groupFolder must be set/,
      );
    });

    it('mount: group honors mountReadOnly', async () => {
      await jobRunner.createSidecarToolPodJob(
        fileSpec('group', { mountReadOnly: true }),
      );
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const user = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'user-tool',
      );
      expect(
        user.volumeMounts.find((m: any) => m.name === 'work').readOnly,
      ).toBe(true);
    });

    it('mount: group throws when the image is not allowlisted', async () => {
      (assertGroupMountAllowed as any).mockImplementationOnce(() => {
        throw new Error('not permitted');
      });
      await expect(
        jobRunner.createSidecarToolPodJob(fileSpec('group')),
      ).rejects.toThrow('not permitted');
    });

    // --- Credential injection tests for createSidecarToolPodJob ---

    const BRAVE_ENTRY = {
      id: 'brave-search',
      host: 'api.search.brave.com',
      upstreamPort: 443,
      credentialFields: [{ name: 'api_key', envVar: 'BRAVE_API_KEY' }],
      baseUrlEnvs: {},
      allowOperatorFallback: true,
      allowedPositions: ['header', 'body'] as Array<'header' | 'body'>,
    };
    const fakeCatalog = { getCatalog: () => [BRAVE_ENTRY] };
    const fakeSecrets = { getGroupPlaceholders: async () => ({}) };

    const credToolSpec = (extra: Record<string, unknown> = {}) => ({
      ...baseSpec,
      toolSpec: {
        ...baseSpec.toolSpec,
        pattern: 'file' as const,
        image: 'curlimages/curl:latest',
        run: 'curl -sS "$(cat "$INPUT_DIR/query")"',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
        credentials: ['brave-search'],
        ...extra,
      },
    });

    it('mode=sidecar + credentials: attaches credential sidecar + placeholder/proxy env on user-tool only', async () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      (jobRunner as any).catalog = fakeCatalog;
      (jobRunner as any).secretManager = fakeSecrets;
      await jobRunner.createSidecarToolPodJob(credToolSpec());
      const body = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body;
      const podSpec = body.spec.template.spec;
      expect(podSpec.containers.map((c: any) => c.name)).toContain(
        'credential-sidecar',
      );
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      const userEnvMap = Object.fromEntries(
        user.env.map((e: any) => [e.name, e.value]),
      );
      expect(userEnvMap.BRAVE_API_KEY).toMatch(/^(KC_PH_|injected-by-broker)/);
      expect(userEnvMap.HTTPS_PROXY).toBeDefined();
      expect(userEnvMap.SSL_CERT_FILE).toBe(
        '/etc/ssl/certs/kubeclaw-egress-ca.crt',
      );
      const bridge = podSpec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const bridgeEnvMap = Object.fromEntries(
        bridge.env.map((e: any) => [e.name, e.value]),
      );
      expect(bridgeEnvMap.BRAVE_API_KEY).toBeUndefined();
      expect(bridgeEnvMap.HTTPS_PROXY).toBeUndefined();
      expect(podSpec.serviceAccountName).toBe('kubeclaw-tool-job');
      expect(
        body.spec.template.metadata.annotations['kubeclaw.io/owner-group'],
      ).toBe(baseSpec.groupFolder);
      expect(podSpec.volumes.map((v: any) => v.name)).toEqual(
        expect.arrayContaining(['envoy-config', 'broker-token', 'egress-ca']),
      );
      delete process.env.CREDENTIAL_INJECTION_MODE;
    });

    it('mode=off: a credentials-declaring tool gets NO injection', async () => {
      delete process.env.CREDENTIAL_INJECTION_MODE; // → 'off'
      (jobRunner as any).catalog = fakeCatalog;
      (jobRunner as any).secretManager = fakeSecrets;
      await jobRunner.createSidecarToolPodJob(credToolSpec());
      const podSpec =
        mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec
          .template.spec;
      expect(podSpec.containers.map((c: any) => c.name)).not.toContain(
        'credential-sidecar',
      );
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.env.map((e: any) => e.name)).not.toContain('BRAVE_API_KEY');
      expect(podSpec.serviceAccountName).toBeFalsy();
    });

    it('mode=sidecar + NO credentials: no injection (gating)', async () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      (jobRunner as any).catalog = fakeCatalog;
      (jobRunner as any).secretManager = fakeSecrets;
      await jobRunner.createSidecarToolPodJob(
        credToolSpec({ credentials: undefined }),
      );
      const podSpec =
        mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec
          .template.spec;
      expect(podSpec.containers.map((c: any) => c.name)).not.toContain(
        'credential-sidecar',
      );
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.env.map((e: any) => e.name)).not.toContain('BRAVE_API_KEY');
      delete process.env.CREDENTIAL_INJECTION_MODE;
    });

    it('mode=sidecar + auditOnly: attaches sidecar + SA but NO placeholder env or owner-group annotation', async () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'true';
      (jobRunner as any).catalog = fakeCatalog;
      (jobRunner as any).secretManager = fakeSecrets;
      await jobRunner.createSidecarToolPodJob(credToolSpec());
      const body = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body;
      const podSpec = body.spec.template.spec;
      expect(podSpec.containers.map((c: any) => c.name)).toContain(
        'credential-sidecar',
      );
      expect(podSpec.serviceAccountName).toBe('kubeclaw-tool-job');
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.env.map((e: any) => e.name)).not.toContain('BRAVE_API_KEY');
      expect(
        body.spec.template.metadata.annotations?.['kubeclaw.io/owner-group'],
      ).toBeUndefined();
      delete process.env.CREDENTIAL_INJECTION_AUDIT_ONLY;
      delete process.env.CREDENTIAL_INJECTION_MODE;
    });

    const cdpSpec = () => ({
      ...baseSpec,
      toolSpec: {
        ...baseSpec.toolSpec,
        name: 'browser',
        image: 'chromedp/headless-shell:latest',
        pattern: 'cdp' as const,
        port: 9222,
        parameters: {
          type: 'object',
          properties: { action: { type: 'string' } },
          required: ['action'],
        },
      },
    });

    it('cdp: chromium native sidecar, no user-tool, /dev/shm, cdp-bridge env', async () => {
      await jobRunner.createSidecarToolPodJob(cdpSpec());
      const podSpec =
        mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec
          .template.spec;
      // only the bridge in containers[] (no user-tool)
      expect(podSpec.containers.map((c: any) => c.name)).toEqual([
        'kubeclaw-tool-bridge',
      ]);
      // chromium as a native sidecar init-container
      const init = (podSpec.initContainers ?? []).find(
        (c: any) => c.name === 'chromium',
      );
      expect(init).toBeDefined();
      expect(init.image).toBe('chromedp/headless-shell:latest');
      expect(init.restartPolicy).toBe('Always');
      expect(init.readinessProbe.httpGet).toEqual({
        path: '/json/version',
        port: 9222,
      });
      expect(init.volumeMounts).toContainEqual({
        name: 'dshm',
        mountPath: '/dev/shm',
      });
      // /dev/shm emptyDir
      expect(podSpec.volumes).toContainEqual({
        name: 'dshm',
        emptyDir: { medium: 'Memory', sizeLimit: '256Mi' },
      });
      // bridge env
      const bridge = podSpec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const env = Object.fromEntries(
        bridge.env.map((e: any) => [e.name, e.value]),
      );
      expect(env.KUBECLAW_TOOL_MODE).toBe('cdp-bridge');
      expect(env.KUBECLAW_CDP_URL).toBe('http://localhost:9222');
      expect(env.KUBECLAW_TOOL_PORT).toBe('9222');
    });

    it('cdp: chromium command defaults to the image entrypoint when toolSpec.command absent', async () => {
      await jobRunner.createSidecarToolPodJob(cdpSpec());
      const podSpec =
        mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec
          .template.spec;
      const init = podSpec.initContainers.find(
        (c: any) => c.name === 'chromium',
      );
      expect(init.command).toBeUndefined();
    });

    it('honors toolSpec.timeout over the caller timeout for activeDeadlineSeconds', async () => {
      await jobRunner.createSidecarToolPodJob({
        agentJobId: 'job-1',
        groupFolder: 'g1',
        toolName: 'browser',
        toolSpec: {
          name: 'browser',
          description: 'x',
          parameters: { type: 'object', properties: {} },
          image: 'chromedp/headless-shell:latest',
          pattern: 'cdp' as const,
          port: 9222,
          timeout: 600000,
        },
        timeout: 60000,
      });
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      expect(call.body.spec.activeDeadlineSeconds).toBe(600);
    });

    it('falls back to caller timeout for activeDeadlineSeconds when toolSpec has no timeout', async () => {
      await jobRunner.createSidecarToolPodJob({
        agentJobId: 'job-1',
        groupFolder: 'g1',
        toolName: 'browser',
        toolSpec: {
          name: 'browser',
          description: 'x',
          parameters: { type: 'object', properties: {} },
          image: 'chromedp/headless-shell:latest',
          pattern: 'cdp' as const,
          port: 9222,
        },
        timeout: 90000,
      });
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      expect(call.body.spec.activeDeadlineSeconds).toBe(90);
    });

    it('file-bridge: pod-level securityContext has fsGroup=2000 AND fsGroupChangePolicy=OnRootMismatch', async () => {
      // Regression: without fsGroup the two containers ran under different UIDs;
      // whichever created /shared/req first owned it exclusively, causing the other
      // to get EACCES on rename().  fsGroup=2000 makes the emptyDir group-owned and
      // grants both containers GID 2000 as a supplementary group.
      // fsGroupChangePolicy=OnRootMismatch prevents a recursive chown of the group
      // PVC (bash_persist) on every pod start — only applies when the root already
      // has the correct ownership.
      const fileSpec = {
        ...baseSpec,
        toolSpec: { ...baseSpec.toolSpec, pattern: 'file' as const },
      };
      await jobRunner.createSidecarToolPodJob(fileSpec);

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const podSecCtx = call.body.spec.template.spec.securityContext;
      expect(podSecCtx).toBeDefined();
      expect(podSecCtx.fsGroup).toBe(2000);
      expect(podSecCtx.fsGroupChangePolicy).toBe('OnRootMismatch');
    });

    it('http-bridge: pod-level securityContext has fsGroup=2000 AND fsGroupChangePolicy=OnRootMismatch', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const podSecCtx = call.body.spec.template.spec.securityContext;
      expect(podSecCtx).toBeDefined();
      expect(podSecCtx.fsGroup).toBe(2000);
      expect(podSecCtx.fsGroupChangePolicy).toBe('OnRootMismatch');
    });
  });

  // Shared fixture for credential injection tests
  const credInjectionSpec = {
    name: 'nc-cred-test',
    groupFolder: 'cred-group',
    chatJid: 'cred@g.us',
    isMain: false,
    prompt: 'hello cred test',
    provider: 'claude' as const,
    timeout: 1800000,
    sessionId: 'sess-abc',
    assistantName: 'Andy',
  };

  describe('generateJobManifest — credential injection mode=off (regression)', () => {
    beforeEach(() => {
      vi.mocked(configModule.getInjectionMode).mockReturnValue('off');
    });

    it('ANTHROPIC_API_KEY is present in the pod spec when mode=off', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const envNames = (
        manifest.spec?.template?.spec?.containers?.[0]?.env ?? []
      ).map((e) => e.name);
      expect(envNames).toContain('ANTHROPIC_API_KEY');
    });

    it('exactly one container in the pod spec when mode=off', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      expect(manifest.spec?.template?.spec?.containers).toHaveLength(1);
    });

    it('serviceAccountName is empty string when mode=off', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      expect(manifest.spec?.template?.spec?.serviceAccountName).toBe('');
    });

    it('no sidecar volumes when mode=off', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const volumeNames = (manifest.spec?.template?.spec?.volumes ?? []).map(
        (v) => v.name,
      );
      expect(volumeNames).not.toContain('envoy-config');
      expect(volumeNames).not.toContain('broker-token');
      expect(volumeNames).not.toContain('egress-ca');
    });
  });

  describe('generateJobManifest — credential injection mode=sidecar', () => {
    beforeEach(() => {
      vi.mocked(configModule.getInjectionMode).mockReturnValue('sidecar');
    });

    it('appends credential-sidecar container and adds HTTPS_PROXY (raw keys pass through without catalog)', () => {
      // Without catalog entries the LLM key stripping is entirely catalog-driven.
      // The sidecar machinery only adds the Envoy container and proxy env vars.
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const containers = manifest.spec?.template?.spec?.containers ?? [];
      expect(containers).toHaveLength(2);
      expect(containers.some((c) => c.name === 'credential-sidecar')).toBe(
        true,
      );
      const main = containers.find((c) => c.name !== 'credential-sidecar')!;
      const envNames = (main.env ?? []).map((e) => e.name);
      // Keys pass through as secretKeyRefs when no catalog covers them
      expect(envNames).toContain('ANTHROPIC_API_KEY');
      // Non-LLM token envs are never injected by job-runner
      expect(envNames).not.toContain('ANTHROPIC_AUTH_TOKEN');
      expect(envNames).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(envNames).toContain('HTTPS_PROXY');
      expect(envNames).toContain('NODE_EXTRA_CA_CERTS');
    });

    it('sets serviceAccountName to kubeclaw-tool-job when mode=sidecar', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      expect(manifest.spec?.template?.spec?.serviceAccountName).toBe(
        'kubeclaw-tool-job',
      );
    });

    it('adds sidecar volumes (envoy-config, broker-token, egress-ca)', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const volumeNames = (manifest.spec?.template?.spec?.volumes ?? []).map(
        (v) => v.name,
      );
      expect(volumeNames).toContain('envoy-config');
      expect(volumeNames).toContain('broker-token');
      expect(volumeNames).toContain('egress-ca');
    });

    it('credential-sidecar container uses correct image and port', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const sidecar = manifest.spec?.template?.spec?.containers?.find(
        (c) => c.name === 'credential-sidecar',
      );
      expect(sidecar).toBeDefined();
      expect(sidecar?.image).toBe('envoyproxy/envoy:v1.31-latest');
      expect(sidecar?.ports?.[0]?.containerPort).toBe(8443);
    });
  });

  describe('generateJobManifest — credential injection mode=istio', () => {
    beforeEach(() => {
      vi.mocked(configModule.getInjectionMode).mockReturnValue('istio');
    });

    afterEach(() => {
      vi.mocked(configModule.getAuditOnly).mockReturnValue(false);
    });

    it('keeps raw secretKeyRef envs and does NOT add HTTPS_PROXY when mode=istio and no catalog', () => {
      // Without catalog entries, no substitution occurs. Keys pass through as secretKeyRefs.
      // Istio iptables handles routing so HTTPS_PROXY is not needed.
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const env = manifest.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const envNames = env.map((e) => e.name);
      // Keys are present as raw secretKeyRefs (catalog not present to replace them)
      expect(envNames).toContain('ANTHROPIC_API_KEY');
      expect(envNames).toContain('OPENAI_API_KEY');
      const anthropicKey = env.find((e) => e.name === 'ANTHROPIC_API_KEY');
      expect(anthropicKey?.valueFrom?.secretKeyRef).toBeDefined();
      // istio mode does not add HTTPS_PROXY (Istio iptables handles routing)
      expect(envNames).not.toContain('HTTPS_PROXY');
    });

    it('does NOT add a credential-sidecar container when mode=istio', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const containers = manifest.spec?.template?.spec?.containers ?? [];
      expect(containers).toHaveLength(1);
      expect(containers.some((c) => c.name === 'credential-sidecar')).toBe(
        false,
      );
    });

    it('does NOT add sidecar volumes when mode=istio', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const volumeNames = (manifest.spec?.template?.spec?.volumes ?? []).map(
        (v) => v.name,
      );
      expect(volumeNames).not.toContain('envoy-config');
      expect(volumeNames).not.toContain('broker-token');
      expect(volumeNames).not.toContain('egress-ca');
    });

    it('sets serviceAccountName to kubeclaw-tool-job when mode=istio', () => {
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      expect(manifest.spec?.template?.spec?.serviceAccountName).toBe(
        'kubeclaw-tool-job',
      );
    });

    it('keeps raw secretKeyRef envs without catalog (catalog drives "injected-by-broker" for no-fallback entries)', () => {
      // Without catalog entries, raw secretKeyRef envs pass through unchanged in istio mode.
      // The "injected-by-broker" literal is only emitted by buildCatalogEnvs when an entry
      // has allowOperatorFallback=false and no group credential is registered.
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const env = manifest.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const named = (n: string) => env.find((e: any) => e.name === n);
      for (const key of [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'OPENROUTER_API_KEY',
      ]) {
        const entry = named(key);
        expect(entry, `${key} entry exists`).toBeDefined();
        // Raw secretKeyRef passes through; value is undefined when valueFrom is set
        expect(entry!.valueFrom?.secretKeyRef).toBeDefined();
      }
    });

    it('keeps raw BASE_URL secretKeyRef envs without catalog (http:// base URLs come from catalog baseUrlEnvs)', () => {
      // Without catalog entries, BASE_URL envs pass through as configured by the built-in
      // provider env injection. The http:// base URL rewriting is now catalog-driven.
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const env = manifest.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const named = (n: string) => env.find((e: any) => e.name === n);
      // Built-in envs inject ANTHROPIC_BASE_URL via secretKeyRef; without catalog they stay
      const anthropicBase = named('ANTHROPIC_BASE_URL');
      expect(anthropicBase).toBeDefined();
      // value may be a literal or secretKeyRef depending on built-in injection; never http:// without catalog
      if (anthropicBase?.value) {
        expect(anthropicBase.value).not.toBe('http://api.anthropic.com');
      }
    });

    it('does NOT substitute when auditOnly=true (preserves valueFrom secretKeyRefs)', () => {
      vi.mocked(configModule.getAuditOnly).mockReturnValue(true);
      const manifest = jobRunner.generateJobManifest(credInjectionSpec);
      const env = manifest.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const openai = env.find((e: any) => e.name === 'OPENAI_API_KEY');
      expect(openai?.valueFrom?.secretKeyRef).toBeDefined();
      expect(openai?.value).toBeUndefined();
    });

    // --- Task 11: catalog-driven env + annotation tests ---

    const replicateCatalogEntry = {
      id: 'replicate',
      host: 'api.replicate.com',
      upstreamPort: 443,
      credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
      baseUrlEnvs: { REPLICATE_API_URL: 'http://api.replicate.com' },
      allowOperatorFallback: false,
      allowedPositions: ['header' as const, 'body' as const],
    };

    const jenkinsCatalogEntry = {
      id: 'jenkins',
      host: 'jenkins.example.com',
      upstreamPort: 8080,
      credentialFields: [
        { name: 'user', envVar: 'JENKINS_USER' },
        { name: 'password', envVar: 'JENKINS_PASSWORD' },
      ],
      baseUrlEnvs: { JENKINS_URL: 'http://jenkins.example.com' },
      allowOperatorFallback: false,
      allowedPositions: ['header' as const, 'body' as const],
    };

    it('stamps kubeclaw.io/owner-group annotation on pod template', () => {
      const spec = {
        ...credInjectionSpec,
        ownerGroup: 'family',
      };
      const manifest = jobRunner.generateJobManifest(spec);
      const annotations = manifest.spec?.template?.metadata?.annotations;
      expect(annotations?.['kubeclaw.io/owner-group']).toBe('family');
    });

    it('stamps per-field placeholder envs when group has registered creds', () => {
      const placeholder = 'KC_PH_token_' + 'a'.repeat(64);
      const spec = {
        ...credInjectionSpec,
        ownerGroup: 'family',
        catalogEntries: [replicateCatalogEntry],
        groupPlaceholders: {
          replicate: { token: placeholder },
        },
      };
      const manifest = jobRunner.generateJobManifest(spec);
      const env = manifest.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const tokenEnv = env.find((e: any) => e.name === 'REPLICATE_API_TOKEN');
      expect(tokenEnv?.value).toBe(placeholder);
      expect(tokenEnv?.value).toMatch(/^KC_PH_token_[0-9a-f]{64}$/);
    });

    it('stamps KC_PH_FALLBACK_<id> when entry allows fallback and group has no registered cred', () => {
      const fallbackEntry = {
        ...replicateCatalogEntry,
        allowOperatorFallback: true,
      };
      const spec = {
        ...credInjectionSpec,
        ownerGroup: 'family',
        catalogEntries: [fallbackEntry],
        groupPlaceholders: {}, // no registered cred for replicate
      };
      const manifest = jobRunner.generateJobManifest(spec);
      const env = manifest.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const tokenEnv = env.find((e: any) => e.name === 'REPLICATE_API_TOKEN');
      expect(tokenEnv?.value).toBe('KC_PH_FALLBACK_replicate');
    });

    it('stamps "injected-by-broker" when entry disallows fallback and no registered cred', () => {
      const spec = {
        ...credInjectionSpec,
        ownerGroup: 'family',
        catalogEntries: [replicateCatalogEntry], // allowOperatorFallback: false
        groupPlaceholders: {}, // no registered cred
      };
      const manifest = jobRunner.generateJobManifest(spec);
      const env = manifest.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const tokenEnv = env.find((e: any) => e.name === 'REPLICATE_API_TOKEN');
      expect(tokenEnv?.value).toBe('injected-by-broker');
    });

    it('stamps baseUrlEnvs unconditionally per catalog entry', () => {
      const spec = {
        ...credInjectionSpec,
        ownerGroup: 'family',
        catalogEntries: [jenkinsCatalogEntry],
        groupPlaceholders: {
          jenkins: {
            user: 'KC_PH_user_' + 'b'.repeat(64),
            password: 'KC_PH_password_' + 'c'.repeat(64),
          },
        },
      };
      const manifest = jobRunner.generateJobManifest(spec);
      const env = manifest.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const urlEnv = env.find((e: any) => e.name === 'JENKINS_URL');
      expect(urlEnv?.value).toBe('http://jenkins.example.com');
    });
  });

  describe('generateJobManifest — catalog drives LLM keys (Task 3)', () => {
    // Fake openai catalog entry matching the values.yaml definition from Task 1
    const openaiCatalogEntry = {
      id: 'openai',
      host: 'api.openai.com',
      upstreamPort: 443,
      credentialFields: [{ name: 'api_key', envVar: 'OPENAI_API_KEY' }],
      baseUrlEnvs: { OPENAI_BASE_URL: 'http://api.openai.com/v1' },
      allowOperatorFallback: true,
      allowedPositions: ['header' as const],
    };

    const specWithOpenaiCatalog = {
      ...makeSpec(),
      catalogEntries: [openaiCatalogEntry],
      groupPlaceholders: {}, // no group-registered credential
    };

    beforeEach(() => {
      vi.mocked(configModule.getInjectionMode).mockImplementation(() => {
        const raw = process.env.CREDENTIAL_INJECTION_MODE;
        if (raw === 'sidecar' || raw === 'istio') return raw;
        return 'off';
      });
      vi.mocked(configModule.getAuditOnly).mockReturnValue(false);
    });

    afterEach(() => {
      delete process.env.CREDENTIAL_INJECTION_MODE;
    });

    it('sidecar mode: catalog entry produces KC_PH_FALLBACK_openai and base URL; no raw secretKeyRef', () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      const manifest = jobRunner.generateJobManifest(specWithOpenaiCatalog);
      const env = manifest.spec!.template.spec!.containers[0].env as Array<{
        name: string;
        value?: string;
        valueFrom?: object;
      }>;

      const apiKeyEnv = env.find((e) => e.name === 'OPENAI_API_KEY');
      expect(apiKeyEnv, 'OPENAI_API_KEY env must be present').toBeDefined();
      expect(apiKeyEnv?.value).toBe('KC_PH_FALLBACK_openai');
      expect(apiKeyEnv?.valueFrom).toBeUndefined();

      const baseUrlEnv = env.find((e) => e.name === 'OPENAI_BASE_URL');
      expect(baseUrlEnv, 'OPENAI_BASE_URL env must be present').toBeDefined();
      expect(baseUrlEnv?.value).toBe('http://api.openai.com/v1');
      expect(baseUrlEnv?.valueFrom).toBeUndefined();
    });

    it('istio mode: catalog entry produces KC_PH_FALLBACK_openai (NOT injected-by-broker) and base URL', () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'istio';
      const manifest = jobRunner.generateJobManifest(specWithOpenaiCatalog);
      const env = manifest.spec!.template.spec!.containers[0].env as Array<{
        name: string;
        value?: string;
        valueFrom?: object;
      }>;

      const apiKeyEnv = env.find((e) => e.name === 'OPENAI_API_KEY');
      expect(apiKeyEnv, 'OPENAI_API_KEY env must be present').toBeDefined();
      expect(apiKeyEnv?.value).toBe('KC_PH_FALLBACK_openai');
      expect(apiKeyEnv?.value).not.toBe('injected-by-broker');
      expect(apiKeyEnv?.valueFrom).toBeUndefined();

      const baseUrlEnv = env.find((e) => e.name === 'OPENAI_BASE_URL');
      expect(baseUrlEnv, 'OPENAI_BASE_URL env must be present').toBeDefined();
      expect(baseUrlEnv?.value).toBe('http://api.openai.com/v1');
      expect(baseUrlEnv?.valueFrom).toBeUndefined();
    });
  });

  describe('generateJobManifest: credential injection env stripping', () => {
    const runner = new JobRunner();

    beforeEach(() => {
      // Reset mocks to their original env-reading implementations so that
      // process.env assignments in each test control the behaviour.
      vi.mocked(configModule.getInjectionMode).mockImplementation(() => {
        const raw = process.env.CREDENTIAL_INJECTION_MODE;
        if (raw === 'sidecar' || raw === 'istio') return raw;
        return 'off';
      });
      vi.mocked(configModule.getAuditOnly).mockImplementation(
        () => process.env.CREDENTIAL_INJECTION_AUDIT_ONLY === 'true',
      );
    });

    afterEach(() => {
      delete process.env.CREDENTIAL_INJECTION_MODE;
      delete process.env.CREDENTIAL_INJECTION_AUDIT_ONLY;
    });

    it('raw API key envs pass through in mode=sidecar without catalog (stripping is catalog-driven)', () => {
      // The old STRIPPED_WHEN_INJECTED set has been removed. Without catalog entries covering
      // the LLM keys, the raw secretKeyRef envs pass through in sidecar mode.
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'false';
      const manifest = runner.generateJobManifest(makeSpec());
      const agentEnv = manifest.spec!.template.spec!.containers[0]
        .env as Array<{ name: string }>;
      const names = agentEnv.map((e) => e.name);
      // Keys pass through as secretKeyRefs; catalog would replace them with placeholders
      expect(names).toContain('ANTHROPIC_API_KEY');
      expect(names).toContain('OPENROUTER_API_KEY');
      // Sidecar proxy env still gets injected
      expect(names).toContain('HTTPS_PROXY');
    });

    it('does NOT strip API key envs when mode=sidecar and auditOnly=true', () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'true';
      const manifest = runner.generateJobManifest(makeSpec());
      const agentEnv = manifest.spec!.template.spec!.containers[0]
        .env as Array<{ name: string }>;
      const names = agentEnv.map((e) => e.name);
      expect(names).toContain('ANTHROPIC_API_KEY');
      expect(names).toContain('OPENROUTER_API_KEY');
    });

    it('still injects the Envoy sidecar container when mode=sidecar and auditOnly=true', () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'true';
      const manifest = runner.generateJobManifest(makeSpec());
      const containerNames = manifest.spec!.template.spec!.containers.map(
        (c: any) => c.name,
      );
      expect(containerNames).toContain('credential-sidecar');
    });

    it('does NOT inject sidecar or strip envs when mode=off', () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'off';
      process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'false';
      const manifest = runner.generateJobManifest(makeSpec());
      const containerNames = manifest.spec!.template.spec!.containers.map(
        (c: any) => c.name,
      );
      expect(containerNames).not.toContain('credential-sidecar');
      const agentEnv = manifest.spec!.template.spec!.containers[0]
        .env as Array<{ name: string }>;
      const names = agentEnv.map((e) => e.name);
      expect(names).toContain('ANTHROPIC_API_KEY');
    });

    it('mode=istio: raw API key envs pass through without catalog; no HTTPS_PROXY, no credential-sidecar', () => {
      // The old applyIstioModeEnvSubstitution function has been removed. Without catalog entries,
      // raw secretKeyRef envs pass through unchanged. Catalog drives the placeholder substitution.
      process.env.CREDENTIAL_INJECTION_MODE = 'istio';
      process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'false';
      const manifest = runner.generateJobManifest(makeSpec());
      const agentEnv = manifest.spec!.template.spec!.containers[0]
        .env as Array<{ name: string; value?: string; valueFrom?: object }>;
      const names = agentEnv.map((e) => e.name);
      // Keys are present as raw secretKeyRefs (no catalog to replace them)
      expect(names).toContain('ANTHROPIC_API_KEY');
      const anthropicKey = agentEnv.find((e) => e.name === 'ANTHROPIC_API_KEY');
      expect(anthropicKey?.valueFrom?.secretKeyRef).toBeDefined();
      // istio mode does not add HTTPS_PROXY
      expect(names).not.toContain('HTTPS_PROXY');
      const containerNames = manifest.spec!.template.spec!.containers.map(
        (c: any) => c.name,
      );
      expect(containerNames).not.toContain('credential-sidecar');
    });

    it('mode=istio + auditOnly=true: keeps API keys, no HTTPS_PROXY, no credential-sidecar', () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'istio';
      process.env.CREDENTIAL_INJECTION_AUDIT_ONLY = 'true';
      const manifest = runner.generateJobManifest(makeSpec());
      const agentEnv = manifest.spec!.template.spec!.containers[0]
        .env as Array<{ name: string }>;
      const names = agentEnv.map((e) => e.name);
      expect(names).toContain('ANTHROPIC_API_KEY');
      expect(names).not.toContain('HTTPS_PROXY');
      const containerNames = manifest.spec!.template.spec!.containers.map(
        (c: any) => c.name,
      );
      expect(containerNames).not.toContain('credential-sidecar');
    });
  });
});

// ---------------------------------------------------------------------------
// ConfigMap content: tool-wrapper.sh must set umask 0000 before mkdir
// ---------------------------------------------------------------------------
// The file-bridge EACCES fix requires that whichever container (bridge or
// user-tool) creates /shared/req and /shared/resp, it creates them with
// 0777 permissions so the non-owning container can rename() into them.
// The bridge does this via chmodSync (in tool-server.ts); the wrapper does
// it by setting umask 0000 before mkdir.  These tests assert the wrapper
// template in BOTH the Helm chart and the static k8s manifest contain the
// umask line immediately before the mkdir.
describe('tool-wrapper.sh ConfigMap: umask 0000 before mkdir', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

  it('helm/kubeclaw/templates/configmaps.yaml: umask 0000 precedes mkdir -p "$S/req"', () => {
    const helmCm = path.join(repoRoot, 'helm/kubeclaw/templates/configmaps.yaml');
    const content = fs.readFileSync(helmCm, 'utf-8');
    // Verify umask 0000 appears before the mkdir line
    const umaskIdx = content.indexOf('umask 0000');
    const mkdirIdx = content.indexOf('mkdir -p "$S/req" "$S/resp"');
    expect(umaskIdx, 'umask 0000 not found in Helm configmaps.yaml').toBeGreaterThan(-1);
    expect(mkdirIdx, 'mkdir line not found in Helm configmaps.yaml').toBeGreaterThan(-1);
    expect(umaskIdx, 'umask 0000 must appear before the mkdir line').toBeLessThan(mkdirIdx);
  });

  it('k8s/35-configmaps.yaml: umask 0000 precedes mkdir -p "$S/req"', () => {
    const staticCm = path.join(repoRoot, 'k8s/35-configmaps.yaml');
    const content = fs.readFileSync(staticCm, 'utf-8');
    const umaskIdx = content.indexOf('umask 0000');
    const mkdirIdx = content.indexOf('mkdir -p "$S/req" "$S/resp"');
    expect(umaskIdx, 'umask 0000 not found in k8s/35-configmaps.yaml').toBeGreaterThan(-1);
    expect(mkdirIdx, 'mkdir line not found in k8s/35-configmaps.yaml').toBeGreaterThan(-1);
    expect(umaskIdx, 'umask 0000 must appear before the mkdir line').toBeLessThan(mkdirIdx);
  });
});

// ---------------------------------------------------------------------------
// ConfigMap content: tool-wrapper.sh must chmod 0777 the mktemp resp dir
// ---------------------------------------------------------------------------
// mktemp -d always creates dirs with mode 0700 regardless of umask.  The
// bridge container (a different UID) then cannot scandir/rm the resp dir.
// The fix is to chmod 0777 immediately after mktemp -d, before writing into
// the dir.  These tests assert that fix is present in BOTH the Helm chart
// and the static k8s manifest.
describe('tool-wrapper.sh ConfigMap: chmod 0777 resp dir after mktemp -d', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

  it('helm/kubeclaw/templates/configmaps.yaml: chmod 0777 "$t" immediately after mktemp -d', () => {
    const helmCm = path.join(repoRoot, 'helm/kubeclaw/templates/configmaps.yaml');
    const content = fs.readFileSync(helmCm, 'utf-8');
    const mktempIdx = content.indexOf('mktemp -d "$S/.resp.$id.XXXXXX"');
    expect(mktempIdx, 'mktemp -d line not found in Helm configmaps.yaml').toBeGreaterThan(-1);
    // The chmod must appear after mktemp and before any write into $t
    const chmodIdx = content.indexOf('chmod 0777 "$t"');
    expect(chmodIdx, 'chmod 0777 "$t" not found in Helm configmaps.yaml').toBeGreaterThan(-1);
    expect(chmodIdx, 'chmod 0777 must appear after mktemp -d').toBeGreaterThan(mktempIdx);
    // And it must appear before the tool-run line that writes into $t
    const toolRunIdx = content.indexOf('sh -c "$KUBECLAW_TOOL_RUN"');
    expect(chmodIdx, 'chmod 0777 must appear before the tool-run write into $t').toBeLessThan(toolRunIdx);
  });

  it('k8s/35-configmaps.yaml: chmod 0777 "$t" immediately after mktemp -d', () => {
    const staticCm = path.join(repoRoot, 'k8s/35-configmaps.yaml');
    const content = fs.readFileSync(staticCm, 'utf-8');
    const mktempIdx = content.indexOf('mktemp -d "$S/.resp.$id.XXXXXX"');
    expect(mktempIdx, 'mktemp -d line not found in k8s/35-configmaps.yaml').toBeGreaterThan(-1);
    const chmodIdx = content.indexOf('chmod 0777 "$t"');
    expect(chmodIdx, 'chmod 0777 "$t" not found in k8s/35-configmaps.yaml').toBeGreaterThan(-1);
    expect(chmodIdx, 'chmod 0777 must appear after mktemp -d').toBeGreaterThan(mktempIdx);
    const toolRunIdx = content.indexOf('sh -c "$KUBECLAW_TOOL_RUN"');
    expect(chmodIdx, 'chmod 0777 must appear before the tool-run write into $t').toBeLessThan(toolRunIdx);
  });
});

// ── parseContainerOutputFromLogs unit tests ─────────────────────────────────

describe('parseContainerOutputFromLogs', () => {
  const START = '---KUBECLAW_OUTPUT_START---';
  const END = '---KUBECLAW_OUTPUT_END---';

  function block(json: string): string {
    return `${START}\n${json}\n${END}`;
  }

  it('(a) parses a single valid block with result/status/newSessionId', () => {
    const payload = JSON.stringify({
      status: 'success',
      result: 'HELLO-123',
      newSessionId: 'sess-abc',
    });
    const logs = `[agent-runner] starting\n${block(payload)}\n[agent-runner] done`;
    const out = parseContainerOutputFromLogs(logs);
    expect(out).not.toBeNull();
    expect(out!.status).toBe('success');
    expect(out!.result).toBe('HELLO-123');
    expect(out!.newSessionId).toBe('sess-abc');
  });

  it('(b) returns the LAST block when multiple blocks are present', () => {
    const first = block(JSON.stringify({ status: 'success', result: 'FIRST' }));
    const last = block(JSON.stringify({ status: 'success', result: 'LAST' }));
    const logs = `${first}\nsome noise\n${last}`;
    const out = parseContainerOutputFromLogs(logs);
    expect(out).not.toBeNull();
    expect(out!.result).toBe('LAST');
  });

  it('(c) extracts correctly when interleaved with other log lines', () => {
    const payload = JSON.stringify({ status: 'success', result: 'marker-xyz' });
    const logs = [
      '[agent-runner] some stderr',
      'INFO: catalog loaded',
      START,
      payload,
      END,
      '[agent-runner] exiting',
    ].join('\n');
    const out = parseContainerOutputFromLogs(logs);
    expect(out).not.toBeNull();
    expect(out!.result).toBe('marker-xyz');
  });

  it('(d) returns null when no block is present', () => {
    const out = parseContainerOutputFromLogs('just some log output\nno markers here');
    expect(out).toBeNull();
  });

  it('(e) returns null when start marker is present but no end marker', () => {
    const logs = `${START}\n{"status":"success","result":"foo"}`;
    const out = parseContainerOutputFromLogs(logs);
    expect(out).toBeNull();
  });

  it('(f) returns null (no throw) when JSON between markers is malformed', () => {
    const logs = `${START}\nnot-valid-json{{{${END}`;
    expect(() => parseContainerOutputFromLogs(logs)).not.toThrow();
    const out = parseContainerOutputFromLogs(logs);
    expect(out).toBeNull();
  });

  it('(g) returns null when JSON shape is missing status field', () => {
    const payload = JSON.stringify({ result: 'something' }); // no status
    const logs = block(payload);
    const out = parseContainerOutputFromLogs(logs);
    expect(out).toBeNull();
  });

  it('(g2) returns null when JSON shape is missing result field', () => {
    const payload = JSON.stringify({ status: 'success' }); // no result
    const logs = block(payload);
    const out = parseContainerOutputFromLogs(logs);
    expect(out).toBeNull();
  });

  it('(g3) returns null when result is not string or null', () => {
    const payload = JSON.stringify({ status: 'success', result: 42 });
    const logs = block(payload);
    const out = parseContainerOutputFromLogs(logs);
    expect(out).toBeNull();
  });

  it('accepts result: null as valid', () => {
    const payload = JSON.stringify({ status: 'success', result: null });
    const logs = block(payload);
    const out = parseContainerOutputFromLogs(logs);
    expect(out).not.toBeNull();
    expect(out!.result).toBeNull();
  });

  it('preserves optional error field when present', () => {
    const payload = JSON.stringify({
      status: 'error',
      result: null,
      error: 'something went wrong',
    });
    const logs = block(payload);
    const out = parseContainerOutputFromLogs(logs);
    expect(out).not.toBeNull();
    expect(out!.status).toBe('error');
    expect(out!.error).toBe('something went wrong');
  });
});

// ── runToolJob result-capture integration tests ─────────────────────────────

describe('runToolJob — result capture from pod logs', () => {
  let runner: JobRunner;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    runner = new JobRunner();

    // Default happy-path: job creates, completes, has a pod with logs
    mockBatchApi.createNamespacedJob.mockResolvedValue({
      metadata: { name: 'nc-test-group-abc123' },
    });
    mockBatchApi.readNamespacedJob.mockResolvedValue({
      status: { succeeded: 1 },
    });
    mockCoreApi.listNamespacedPod.mockResolvedValue({
      items: [{ metadata: { name: 'nc-test-group-abc123-pod' } }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the parsed result from pod logs when a KUBECLAW_OUTPUT block is present', async () => {
    const START = '---KUBECLAW_OUTPUT_START---';
    const END = '---KUBECLAW_OUTPUT_END---';
    const logContent = [
      '[agent-runner] running',
      START,
      JSON.stringify({ status: 'success', result: 'HELLO-123', newSessionId: 'sess-42' }),
      END,
    ].join('\n');

    mockCoreApi.readNamespacedPodLog.mockResolvedValue(logContent);

    const result = await runner.runToolJob(testGroup, testInput);

    expect(result.status).toBe('success');
    expect(result.result).toBe('HELLO-123');
    expect(result.newSessionId).toBe('sess-42');
  });

  it('falls back to result: null when getJobLogs throws, without propagating the error', async () => {
    mockCoreApi.listNamespacedPod.mockRejectedValue(new Error('pod list failed'));

    let caughtErr: unknown = undefined;
    let result: Awaited<ReturnType<typeof runner.runToolJob>> | undefined;
    try {
      result = await runner.runToolJob(testGroup, testInput);
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeUndefined();
    expect(result).toBeDefined();
    expect(result!.status).toBe('success');
    expect(result!.result).toBeNull();
  });

  it('falls back to result: null when pod logs contain no KUBECLAW_OUTPUT block', async () => {
    mockCoreApi.readNamespacedPodLog.mockResolvedValue(
      '[agent-runner] exited without writing output block',
    );

    const result = await runner.runToolJob(testGroup, testInput);

    expect(result.status).toBe('success');
    expect(result.result).toBeNull();
  });
});
