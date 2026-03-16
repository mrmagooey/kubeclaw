/**
 * HTTP Sidecar Runner Tests
 *
 * Tests for the HttpSidecarJobRunner class, specifically
 * generateHttpSidecarJobManifest. Key differences from the file sidecar:
 * - No shared volumes (communication is over localhost)
 * - NANOCLAW_AGENT_URL env var instead of workspace paths
 * - Health endpoint config env vars
 * - PORT env var in the user container
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpSidecarJobRunner } from './http-sidecar-runner.js';
import { JobInput, SidecarHttpJobSpec } from './types.js';
import { RegisteredGroup } from '../types.js';

// Create mock functions using vi.hoisted to ensure proper initialization order
const mocks = vi.hoisted(() => ({
  mockCreateNamespacedJob: vi.fn(),
  mockReadNamespacedJob: vi.fn(),
  mockDeleteNamespacedJob: vi.fn(),
  mockListNamespacedPod: vi.fn(),
  mockReadNamespacedPodLog: vi.fn(),
}));

// Mock the Kubernetes client-node module
vi.mock('@kubernetes/client-node', () => {
  return {
    KubeConfig: class MockKubeConfig {
      loadFromDefault = vi.fn();
      makeApiClient = vi.fn((api: new () => unknown) => {
        const apiName = api.name;
        if (apiName === 'CoreV1Api' || apiName.includes('Core')) {
          return {
            listNamespacedPod: mocks.mockListNamespacedPod,
            readNamespacedPodLog: mocks.mockReadNamespacedPodLog,
          };
        }
        if (apiName === 'BatchV1Api' || apiName.includes('Batch')) {
          return {
            createNamespacedJob: mocks.mockCreateNamespacedJob,
            readNamespacedJob: mocks.mockReadNamespacedJob,
            deleteNamespacedJob: mocks.mockDeleteNamespacedJob,
          };
        }
        return {};
      });
    },
    CoreV1Api: class CoreV1Api {},
    BatchV1Api: class BatchV1Api {},
  };
});

// Mock config
vi.mock('../config.js', () => ({
  CONTAINER_TIMEOUT: 300000,
  NANOCLAW_NAMESPACE: 'nanoclaw',
  SIDECAR_HTTP_ADAPTER_IMAGE: 'nanoclaw-http-adapter:latest',
  SIDECAR_HTTP_REQUEST_TIMEOUT: 300000,
  SIDECAR_HTTP_MAX_RETRIES: 3,
  SIDECAR_HTTP_RETRY_DELAY: 1000,
  SIDECAR_HTTP_HEALTH_POLL_INTERVAL: 1000,
  SIDECAR_HTTP_HEALTH_POLL_TIMEOUT: 30000,
  AGENT_JOB_MEMORY_REQUEST: '512Mi',
  AGENT_JOB_MEMORY_LIMIT: '4Gi',
  AGENT_JOB_CPU_REQUEST: '250m',
  AGENT_JOB_CPU_LIMIT: '2000m',
  TIMEZONE: 'UTC',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_ADMIN_PASSWORD: 'admin-secret',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('HttpSidecarJobRunner', () => {
  let runner: HttpSidecarJobRunner;

  const testGroup: RegisteredGroup = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@test',
    added_at: new Date().toISOString(),
  };

  beforeEach(() => {
    runner = new HttpSidecarJobRunner();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('generateHttpSidecarJobManifest', () => {
    it('should create job manifest with correct structure', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test prompt',
        sessionId: 'test-session',
        assistantName: 'TestBot',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test prompt',
        userImage: 'test-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      expect(manifest.apiVersion).toBe('batch/v1');
      expect(manifest.kind).toBe('Job');
      expect(manifest.metadata?.name).toBe('test-job-id');
      expect(manifest.metadata?.namespace).toBe('nanoclaw');
    });

    it('should set TTL and backoff limit', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'test-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      expect(manifest.spec?.ttlSecondsAfterFinished).toBe(3600);
      expect(manifest.spec?.backoffLimit).toBe(0);
    });

    it('should use spec timeout as activeDeadlineSeconds without capping', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'test-image:latest',
        // timeout of 1 hour — should be used as-is (no 30-min cap)
        timeout: 3600000,
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      // activeDeadlineSeconds should reflect the full 1-hour timeout
      expect(manifest.spec?.activeDeadlineSeconds).toBe(3600);
    });

    it('should use spec timeout when smaller than the cap', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'test-image:latest',
        timeout: 60000, // 60 seconds
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      expect(manifest.spec?.activeDeadlineSeconds).toBe(60);
    });

    it('should include exactly two containers', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const containers = manifest.spec?.template?.spec?.containers;
      expect(containers).toHaveLength(2);
    });

    it('should name containers correctly', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const containers = manifest.spec?.template?.spec?.containers;
      expect(containers?.[0].name).toBe('nanoclaw-http-adapter');
      expect(containers?.[1].name).toBe('user-agent');
    });

    it('should NOT include any shared volumes (HTTP uses localhost networking)', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      // No volumes at all — HTTP sidecar uses localhost networking, not shared filesystem
      const podSpec = manifest.spec?.template?.spec;
      expect(podSpec?.volumes).toBeUndefined();
    });

    it('should NOT mount volumes into adapter container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const adapterContainer = manifest.spec?.template?.spec?.containers?.[0];
      expect(adapterContainer?.volumeMounts).toBeUndefined();
    });

    it('should NOT mount volumes into user container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const userContainer = manifest.spec?.template?.spec?.containers?.[1];
      expect(userContainer?.volumeMounts).toBeUndefined();
    });

    it('should construct NANOCLAW_AGENT_URL using default port 8080', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        // userPort not specified — should default to 8080
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_AGENT_URL',
        value: 'http://localhost:8080',
      });
    });

    it('should construct NANOCLAW_AGENT_URL using custom userPort', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        userPort: 3000,
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_AGENT_URL',
        value: 'http://localhost:3000',
      });
    });

    it('should set health endpoint env var to default /agent/health', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_HEALTH_ENDPOINT',
        value: '/agent/health',
      });
    });

    it('should use custom health endpoint when provided', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        healthEndpoint: '/health',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_HEALTH_ENDPOINT',
        value: '/health',
      });
    });

    it('should set all health polling config env vars on adapter container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;

      expect(adapterEnv).toContainEqual({ name: 'TZ', value: 'UTC' });
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_REQUEST_TIMEOUT',
        value: '300000',
      });
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_HEALTH_POLL_INTERVAL',
        value: '1000',
      });
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_HEALTH_POLL_TIMEOUT',
        value: '30000',
      });
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_MAX_RETRIES',
        value: '3',
      });
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_RETRY_DELAY',
        value: '1000',
      });
    });

    it('should set NANOCLAW_JOB_ID on adapter container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'my-unique-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;
      expect(adapterEnv).toContainEqual({
        name: 'NANOCLAW_JOB_ID',
        value: 'my-unique-job-id',
      });
    });

    it('should set REDIS_URL env var on adapter container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;
      expect(adapterEnv).toContainEqual({
        name: 'REDIS_URL',
        value: 'redis://localhost:6379',
      });
    });

    it('should use per-job credentials when provided', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        credentials: {
          username: 'job-user-123',
          password: 'job-pass-456',
        },
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;
      expect(adapterEnv).toContainEqual({
        name: 'REDIS_USERNAME',
        value: 'job-user-123',
      });
      expect(adapterEnv).toContainEqual({
        name: 'REDIS_PASSWORD',
        value: 'job-pass-456',
      });
    });

    it('should fall back to admin password when no per-job credentials provided', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        // no credentials field
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterEnv = manifest.spec?.template?.spec?.containers?.[0].env;
      // REDIS_ADMIN_PASSWORD is 'admin-secret' in the mock, so fallback kicks in
      expect(adapterEnv).toContainEqual({
        name: 'REDIS_USERNAME',
        value: 'default',
      });
      expect(adapterEnv).toContainEqual({
        name: 'REDIS_PASSWORD',
        value: 'admin-secret',
      });
    });

    it('should set PORT env var on user container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const userEnv = manifest.spec?.template?.spec?.containers?.[1].env;
      expect(userEnv).toContainEqual({ name: 'PORT', value: '8080' });
    });

    it('should set PORT env var to custom userPort on user container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        userPort: 9090,
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const userEnv = manifest.spec?.template?.spec?.containers?.[1].env;
      expect(userEnv).toContainEqual({ name: 'PORT', value: '9090' });
    });

    it('should expose the userPort as a container port on the user container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        userPort: 4000,
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const userContainer = manifest.spec?.template?.spec?.containers?.[1];
      expect(userContainer?.ports).toContainEqual({ containerPort: 4000 });
    });

    it('should set fixed resource limits on adapter container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const adapterContainer = manifest.spec?.template?.spec?.containers?.[0];
      expect(adapterContainer?.resources?.requests?.memory).toBe('128Mi');
      expect(adapterContainer?.resources?.requests?.cpu).toBe('50m');
      expect(adapterContainer?.resources?.limits?.memory).toBe('256Mi');
      expect(adapterContainer?.resources?.limits?.cpu).toBe('250m');
    });

    it('should use default resource limits for user container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const userContainer = manifest.spec?.template?.spec?.containers?.[1];
      // Falls back to config defaults from mock
      expect(userContainer?.resources?.requests?.memory).toBe('512Mi');
      expect(userContainer?.resources?.requests?.cpu).toBe('250m');
      expect(userContainer?.resources?.limits?.memory).toBe('4Gi');
      expect(userContainer?.resources?.limits?.cpu).toBe('2000m');
    });

    it('should use custom resource limits for user container when provided', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        memoryRequest: '2Gi',
        memoryLimit: '16Gi',
        cpuRequest: '1000m',
        cpuLimit: '8000m',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const userContainer = manifest.spec?.template?.spec?.containers?.[1];
      expect(userContainer?.resources?.requests?.memory).toBe('2Gi');
      expect(userContainer?.resources?.requests?.cpu).toBe('1000m');
      expect(userContainer?.resources?.limits?.memory).toBe('16Gi');
      expect(userContainer?.resources?.limits?.cpu).toBe('8000m');
    });

    it('should set proper labels on job metadata', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'my-test-job',
      );

      const labels = manifest.metadata?.labels;
      expect(labels?.['nanoclaw/group']).toBe('test-group');
      expect(labels?.['nanoclaw/type']).toBe('http-sidecar');
      // Special characters in chatJid get replaced with '-'
      expect(labels?.['nanoclaw/chat-jid']).toBe('test-g-us');
    });

    it('should sanitize chatJid in labels by replacing non-alphanumeric chars with -', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: '1234567890-group@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: '1234567890-group@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const labels = manifest.metadata?.labels;
      // '@' and '.' are replaced with '-'
      expect(labels?.['nanoclaw/chat-jid']).toBe('1234567890-group-g-us');
    });

    it('should include app label on both job metadata and pod template', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      expect(manifest.metadata?.labels?.['app']).toBe(
        'nanoclaw-http-sidecar-agent',
      );
      expect(manifest.spec?.template?.metadata?.labels?.['app']).toBe(
        'nanoclaw-http-sidecar-agent',
      );
    });

    it('should set restartPolicy to Never', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      expect(manifest.spec?.template?.spec?.restartPolicy).toBe('Never');
    });

    it('should set imagePullPolicy to IfNotPresent by default on both containers', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const containers = manifest.spec?.template?.spec?.containers;
      expect(containers?.[0].imagePullPolicy).toBe('IfNotPresent');
      expect(containers?.[1].imagePullPolicy).toBe('IfNotPresent');
    });

    it('should use the userImage specified in spec for the user container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'my-custom-agent:v2.0',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const userContainer = manifest.spec?.template?.spec?.containers?.[1];
      expect(userContainer?.image).toBe('my-custom-agent:v2.0');
    });

    it('should use the configured HTTP adapter image for adapter container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarHttpJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateHttpSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const adapterContainer = manifest.spec?.template?.spec?.containers?.[0];
      expect(adapterContainer?.image).toBe('nanoclaw-http-adapter:latest');
    });
  });
});
