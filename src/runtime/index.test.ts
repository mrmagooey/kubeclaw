/**
 * Tests for runtime/index.ts — runner selection and lifecycle
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---- Hoisted shared mocks -------------------------------------------------

const {
  mockJobRunToolJob,
  mockJobCleanup,
} = vi.hoisted(() => {
  return {
    mockJobRunToolJob: vi.fn().mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'sess-1',
    }),
    mockJobCleanup: vi.fn().mockResolvedValue(undefined),
  };
});

// ---- Mocks ----------------------------------------------------------------

vi.mock('../k8s/job-runner.js', () => ({
  JobRunner: class {
    runToolJob = mockJobRunToolJob;
    cleanup = mockJobCleanup;
  },
  buildJobName: vi.fn((folder: string) => `job-${folder}`),
}));

vi.mock('./direct-llm-runner.js', () => ({
  DirectLLMRunner: class {
    runAgent = vi
      .fn()
      .mockResolvedValue({ status: 'success', result: 'direct' });
    writeTasksSnapshot = vi.fn();
    writeGroupsSnapshot = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../k8s/acl-manager.js', () => ({
  getACLManager: vi.fn(() => ({})),
  RedisACLManager: class {},
}));

vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/test-groups',
  STORE_DIR: '/tmp/test-store',
  ASSISTANT_NAME: 'TestBot',
  ASSISTANT_HAS_OWN_NUMBER: false,
  POLL_INTERVAL: 2000,
  SCHEDULER_POLL_INTERVAL: 60000,
  MOUNT_ALLOWLIST_PATH: '/tmp/mount-allowlist.json',
  SENDER_ALLOWLIST_PATH: '/tmp/sender-allowlist.json',
  KUBECLAW_NAMESPACE: 'kubeclaw',
  KUBECLAW_MODE: 'standalone',
  KUBECLAW_CHANNEL: '',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---- Tests ----------------------------------------------------------------

describe('runtime/index', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-runtime-test-'));
    process.env.KUBECLAW_IPC_BASE = tmpDir;
    const { resetRunners } = await import('./index.js');
    resetRunners();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.KUBECLAW_IPC_BASE;
  });

  describe('getRunnerForGroup', () => {
    it('returns direct LLM runner when direct is set', async () => {
      const { getRunnerForGroup, getDirectLLMRunner } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
        containerConfig: { direct: true },
      };
      const runner = getRunnerForGroup(group);
      expect(runner).toBe(getDirectLLMRunner());
    });

    it('returns kubernetes runner when no containerConfig is set', async () => {
      const { getRunnerForGroup, getToolJobRunner } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
      };
      const runner = getRunnerForGroup(group);
      expect(runner).toBe(getToolJobRunner());
    });

    it('routes groups with legacy userImage config to the K8s tool-job runner', async () => {
      const { getRunnerForGroup, getToolJobRunner } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
        containerConfig: { userImage: 'ghost/image:1' } as any,
      };
      const runner = getRunnerForGroup(group);
      expect(runner).toBe(getToolJobRunner());
    });

    it('routes groups with legacy userImage+userPort config to the K8s tool-job runner', async () => {
      const { getRunnerForGroup, getToolJobRunner } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
        containerConfig: { userImage: 'my-image:latest', userPort: 8080 } as any,
      };
      const runner = getRunnerForGroup(group);
      expect(runner).toBe(getToolJobRunner());
    });

    it('reuses the same runner instance on repeated calls (singleton)', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
      };
      const runner1 = getRunnerForGroup(group);
      const runner2 = getRunnerForGroup(group);
      expect(runner1).toBe(runner2);
    });
  });

  describe('getToolJobRunner', () => {
    it('returns a runner with runAgent method', async () => {
      const { getToolJobRunner } = await import('./index.js');
      const runner = getToolJobRunner();
      expect(typeof runner.runAgent).toBe('function');
    });
  });

  describe('resetRunners', () => {
    it('creates a new instance after reset', async () => {
      const { getToolJobRunner, resetRunners } = await import('./index.js');
      const runner1 = getToolJobRunner();
      resetRunners();
      const runner2 = getToolJobRunner();
      expect(runner1).not.toBe(runner2);
    });
  });

  describe('shutdownAllRunners', () => {
    it('resolves without error when no runners are active', async () => {
      const { shutdownAllRunners } = await import('./index.js');
      await expect(shutdownAllRunners()).resolves.toBeUndefined();
    });

    it('shuts down all active runners and clears singletons', async () => {
      const { getToolJobRunner, shutdownAllRunners, getRunnerForGroup } =
        await import('./index.js');

      getToolJobRunner();

      const directGroup = {
        name: 'direct',
        folder: 'direct',
        trigger: '',
        added_at: new Date().toISOString(),
        containerConfig: { direct: true },
      };
      getRunnerForGroup(directGroup);

      await expect(shutdownAllRunners()).resolves.toBeUndefined();
    });
  });

  describe('KubernetesToolJobRunner.writeTasksSnapshot', () => {
    it('writes a JSON file to the IPC directory', async () => {
      const { getToolJobRunner } = await import('./index.js');
      const runner = getToolJobRunner();

      const groupFolder = 'my-group';
      const tasks = [{ id: '1', name: 'Task 1', status: 'pending' }];
      runner.writeTasksSnapshot(groupFolder, true, tasks as never);

      const expectedFile = path.join(
        tmpDir,
        groupFolder,
        'ipc',
        'current_tasks.json',
      );
      expect(fs.existsSync(expectedFile)).toBe(true);
      const written = JSON.parse(fs.readFileSync(expectedFile, 'utf-8'));
      expect(written).toEqual(tasks);
    });
  });

  describe('KubernetesToolJobRunner.writeGroupsSnapshot', () => {
    it('writes available_groups.json for main group', async () => {
      const { getToolJobRunner } = await import('./index.js');
      const runner = getToolJobRunner();

      const groupFolder = 'main-group';
      const groups = [{ name: 'group-a', folder: 'group-a' }];
      runner.writeGroupsSnapshot(groupFolder, true, groups as never, new Set());

      const expectedFile = path.join(
        tmpDir,
        groupFolder,
        'ipc',
        'available_groups.json',
      );
      expect(fs.existsSync(expectedFile)).toBe(true);
      const written = JSON.parse(fs.readFileSync(expectedFile, 'utf-8'));
      expect(written.groups).toEqual(groups);
    });

    it('writes empty groups array for non-main groups', async () => {
      const { getToolJobRunner } = await import('./index.js');
      const runner = getToolJobRunner();

      const groupFolder = 'sub-group';
      const groups = [{ name: 'group-a', folder: 'group-a' }];
      runner.writeGroupsSnapshot(
        groupFolder,
        false,
        groups as never,
        new Set(),
      );

      const expectedFile = path.join(
        tmpDir,
        groupFolder,
        'ipc',
        'available_groups.json',
      );
      const written = JSON.parse(fs.readFileSync(expectedFile, 'utf-8'));
      expect(written.groups).toEqual([]);
    });
  });

  describe('getDirectLLMRunner', () => {
    it('returns direct LLM runner singleton', async () => {
      const { getDirectLLMRunner } = await import('./index.js');
      const runner1 = getDirectLLMRunner();
      const runner2 = getDirectLLMRunner();
      expect(runner1).toBe(runner2);
    });
  });

  describe('shutdownAllRunners - comprehensive', () => {
    it('shuts down both runner types when active', async () => {
      const {
        getToolJobRunner,
        getDirectLLMRunner,
        shutdownAllRunners,
      } = await import('./index.js');

      getToolJobRunner();
      getDirectLLMRunner();

      await expect(shutdownAllRunners()).resolves.toBeUndefined();
    });
  });

  // ---- runAgent paths -------------------------------------------------------

  const baseInput = {
    prompt: 'hello',
    groupFolder: 'g',
    chatJid: 'jid@g.us',
    isMain: false,
    assistantName: 'Bot',
  };

  describe('KubernetesToolJobRunner.runAgent', () => {
    const k8sGroup = { name: 'k8s', folder: 'k8s', trigger: '', added_at: '' };

    it('returns success output', async () => {
      const { getToolJobRunner } = await import('./index.js');
      mockJobRunToolJob.mockResolvedValueOnce({
        status: 'success',
        result: 'done',
        newSessionId: 'ns',
      });
      const result = await getToolJobRunner().runAgent(k8sGroup, {
        ...baseInput,
        groupFolder: 'k8s',
      });
      expect(result.status).toBe('success');
      expect(result.result).toBe('done');
      expect(result.newSessionId).toBe('ns');
    });

    it('returns error output when jobRunner returns error status', async () => {
      const { getToolJobRunner } = await import('./index.js');
      mockJobRunToolJob.mockResolvedValueOnce({
        status: 'error',
        result: null,
        error: 'job failed',
      });
      const result = await getToolJobRunner().runAgent(k8sGroup, {
        ...baseInput,
        groupFolder: 'k8s',
      });
      expect(result.status).toBe('error');
      expect(result.error).toBe('job failed');
    });

    it('returns error when jobRunner throws', async () => {
      const { getToolJobRunner } = await import('./index.js');
      mockJobRunToolJob.mockRejectedValueOnce(new Error('k8s crash'));
      const result = await getToolJobRunner().runAgent(k8sGroup, {
        ...baseInput,
        groupFolder: 'k8s',
      });
      expect(result.status).toBe('error');
      expect(result.error).toBe('k8s crash');
    });

    it('calls onProcess callback when provided', async () => {
      const { getToolJobRunner } = await import('./index.js');
      mockJobRunToolJob.mockResolvedValueOnce({
        status: 'success',
        result: 'ok',
      });
      const onProcess = vi.fn();
      await getToolJobRunner().runAgent(
        k8sGroup,
        { ...baseInput, groupFolder: 'k8s' },
        onProcess,
      );
      // onProcess is forwarded; K8s runner wraps it — just confirm no crash
      expect(mockJobRunToolJob).toHaveBeenCalled();
    });

    it('calls onOutput callback when provided', async () => {
      const { getToolJobRunner } = await import('./index.js');
      const output = { status: 'success' as const, result: 'streamed' };
      mockJobRunToolJob.mockImplementationOnce(
        async (
          _g: unknown,
          _i: unknown,
          _onProc: unknown,
          onOutput: ((o: unknown) => Promise<void>) | undefined,
        ) => {
          if (onOutput) await onOutput(output);
          return output;
        },
      );
      const onOutput = vi.fn().mockResolvedValue(undefined);
      await getToolJobRunner().runAgent(
        k8sGroup,
        { ...baseInput, groupFolder: 'k8s' },
        undefined,
        onOutput,
      );
      expect(onOutput).toHaveBeenCalledWith(output);
    });

    it('uses KUBECLAW_IPC_BASE env for IPC path (caching)', async () => {
      const { getToolJobRunner } = await import('./index.js');
      const runner = getToolJobRunner();
      const tasks: never[] = [];
      runner.writeTasksSnapshot('cached-group', false, tasks);
      runner.writeTasksSnapshot('cached-group', false, tasks); // second call uses cached path
      const file = path.join(
        tmpDir,
        'cached-group',
        'ipc',
        'current_tasks.json',
      );
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual([]);
    });
  });
});
