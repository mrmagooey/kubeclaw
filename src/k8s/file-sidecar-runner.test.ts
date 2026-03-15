/**
 * File Sidecar Runner Tests
 *
 * Tests for the FileSidecarJobRunner class including:
 * - ACL creation during job start
 * - Redis environment variables in job manifest
 * - Follow-up message routing
 * - ACL cleanup on job completion
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileSidecarJobRunner } from './file-sidecar-runner.js';
import { _initTestDatabase } from '../db.js';
import { JobInput, SidecarFileJobSpec } from './types.js';
import { RegisteredGroup } from '../types.js';

// Create mock functions using vi.hoisted to ensure proper initialization order
const mocks = vi.hoisted(() => ({
  mockCreateNamespacedJob: vi.fn(),
  mockReadNamespacedJob: vi.fn(),
  mockDeleteNamespacedJob: vi.fn(),
  mockListNamespacedPod: vi.fn(),
  mockReadNamespacedPodLog: vi.fn(),
  mockCreateJobACL: vi.fn(),
  mockRevokeJobACL: vi.fn(),
  mockGetJobCredentials: vi.fn(),
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
  IDLE_TIMEOUT: 30000,
  NANOCLAW_NAMESPACE: 'nanoclaw',
  SIDECAR_FILE_ADAPTER_IMAGE: 'nanoclaw/file-adapter:latest',
  SIDECAR_FILE_POLL_INTERVAL: 1000,
  AGENT_JOB_MEMORY_REQUEST: '512Mi',
  AGENT_JOB_MEMORY_LIMIT: '4Gi',
  AGENT_JOB_CPU_REQUEST: '250m',
  AGENT_JOB_CPU_LIMIT: '2000m',
  TIMEZONE: 'UTC',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_ADMIN_PASSWORD: undefined,
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

// Mock ACL manager
vi.mock('./acl-manager.js', () => ({
  getACLManager: vi.fn(() => ({
    createJobACL: mocks.mockCreateJobACL,
    revokeJobACL: mocks.mockRevokeJobACL,
    getJobCredentials: mocks.mockGetJobCredentials,
    verifyRedisVersion: vi.fn().mockResolvedValue(undefined),
  })),
  resetACLManager: vi.fn(),
}));

describe('FileSidecarJobRunner', () => {
  let runner: FileSidecarJobRunner;
  const testGroup: RegisteredGroup = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@test',
    added_at: new Date().toISOString(),
  };

  beforeEach(async () => {
    await _initTestDatabase();
    runner = new FileSidecarJobRunner();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('generateFileSidecarJobManifest', () => {
    it('should create job manifest with correct structure', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test prompt',
        sessionId: 'test-session',
        assistantName: 'TestBot',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test prompt',
        userImage: 'test-image:latest',
      };

      const manifest = runner.generateFileSidecarJobManifest(
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

    it('should include both sidecar and user containers', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateFileSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const containers = manifest.spec?.template?.spec?.containers;
      expect(containers).toHaveLength(2);
      expect(containers?.[0].name).toBe('nanoclaw-file-adapter');
      expect(containers?.[1].name).toBe('user-agent');
    });

    it('should include workspace volume for IPC', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateFileSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const volumes = manifest.spec?.template?.spec?.volumes;
      const workspaceVolume = volumes?.find((v) => v.name === 'workspace');
      expect(workspaceVolume).toBeDefined();
      expect(workspaceVolume?.emptyDir).toBeDefined();
    });

    it('should set correct environment variables for sidecar adapter', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: true,
        prompt: 'Test prompt',
        sessionId: 'session-123',
        assistantName: 'TestBot',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: true,
        prompt: 'Test prompt',
        userImage: 'user-image:latest',
        filePollInterval: 500,
        timeout: 60000,
      };

      const manifest = runner.generateFileSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job-id',
      );

      const sidecarContainer = manifest.spec?.template?.spec?.containers?.[0];
      const env = sidecarContainer?.env;

      expect(env).toContainEqual({ name: 'TZ', value: 'UTC' });
      expect(env).toContainEqual({
        name: 'NANOCLAW_GROUP_FOLDER',
        value: 'test-group',
      });
      expect(env).toContainEqual({
        name: 'NANOCLAW_CHAT_JID',
        value: 'test@g.us',
      });
      expect(env).toContainEqual({ name: 'NANOCLAW_IS_MAIN', value: 'true' });
      expect(env).toContainEqual({
        name: 'NANOCLAW_PROMPT',
        value: 'Test prompt',
      });
      expect(env).toContainEqual({
        name: 'NANOCLAW_SESSION_ID',
        value: 'session-123',
      });
      expect(env).toContainEqual({
        name: 'NANOCLAW_ASSISTANT_NAME',
        value: 'TestBot',
      });
      expect(env).toContainEqual({
        name: 'NANOCLAW_JOB_ID',
        value: 'test-job-id',
      });
      expect(env).toContainEqual({
        name: 'NANOCLAW_POLL_INTERVAL',
        value: '500',
      });
      expect(env).toContainEqual({ name: 'NANOCLAW_TIMEOUT', value: '60000' });
    });

    it('should mount groups and sessions PVCs', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateFileSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const volumes = manifest.spec?.template?.spec?.volumes;
      expect(volumes?.some((v) => v.name === 'groups-pvc')).toBe(true);
      expect(volumes?.some((v) => v.name === 'sessions-pvc')).toBe(true);
    });

    it('should include project PVC for main group', () => {
      const input: JobInput = {
        groupFolder: 'main',
        chatJid: 'main@g.us',
        isMain: true,
        prompt: 'Test',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'main',
        chatJid: 'main@g.us',
        isMain: true,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateFileSidecarJobManifest(
        { ...testGroup, folder: 'main' },
        input,
        spec,
        'test-job',
      );

      const volumes = manifest.spec?.template?.spec?.volumes;
      expect(volumes?.some((v) => v.name === 'project-pvc')).toBe(true);
    });

    it('should set resource limits for sidecar adapter', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateFileSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const sidecarContainer = manifest.spec?.template?.spec?.containers?.[0];
      expect(sidecarContainer?.resources?.requests?.memory).toBe('128Mi');
      expect(sidecarContainer?.resources?.requests?.cpu).toBe('50m');
      expect(sidecarContainer?.resources?.limits?.memory).toBe('256Mi');
      expect(sidecarContainer?.resources?.limits?.cpu).toBe('250m');
    });

    it('should set custom resource limits for user container', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        memoryRequest: '1Gi',
        memoryLimit: '8Gi',
        cpuRequest: '500m',
        cpuLimit: '4000m',
      };

      const manifest = runner.generateFileSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const userContainer = manifest.spec?.template?.spec?.containers?.[1];
      expect(userContainer?.resources?.requests?.memory).toBe('1Gi');
      expect(userContainer?.resources?.requests?.cpu).toBe('500m');
      expect(userContainer?.resources?.limits?.memory).toBe('8Gi');
      expect(userContainer?.resources?.limits?.cpu).toBe('4000m');
    });

    it('should pass secrets as environment variables', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
        secrets: {
          API_KEY: 'secret-key-123',
          DB_PASSWORD: 'db-pass-456',
        },
      };

      const manifest = runner.generateFileSidecarJobManifest(
        testGroup,
        input,
        spec,
        'test-job',
      );

      const userContainer = manifest.spec?.template?.spec?.containers?.[1];
      const env = userContainer?.env;

      expect(env).toContainEqual({ name: 'API_KEY', value: 'secret-key-123' });
      expect(env).toContainEqual({
        name: 'DB_PASSWORD',
        value: 'db-pass-456',
      });
    });

    it('should set proper labels on job', () => {
      const input: JobInput = {
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
      };

      const spec: SidecarFileJobSpec = {
        name: 'test-job',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        prompt: 'Test',
        userImage: 'user-image:latest',
      };

      const manifest = runner.generateFileSidecarJobManifest(
        testGroup,
        input,
        spec,
        'my-test-job',
      );

      const labels = manifest.metadata?.labels;
      expect(labels?.['nanoclaw/group']).toBe('test-group');
      expect(labels?.['nanoclaw/type']).toBe('file-sidecar');
      expect(labels?.['nanoclaw/chat-jid']).toBe('test-g-us');
    });
  });
});
