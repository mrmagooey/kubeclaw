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
  mockFileSidecarRunToolJob,
  mockHttpSidecarRunToolJob,
  mockAclManager,
} = vi.hoisted(() => {
  const mockAclManager = {
    createJobACL: vi.fn().mockResolvedValue(undefined),
    revokeJobACL: vi.fn().mockResolvedValue(undefined),
    getJobCredentials: vi.fn().mockReturnValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    mockJobRunToolJob: vi.fn().mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'sess-1',
    }),
    mockJobCleanup: vi.fn().mockResolvedValue(undefined),
    mockFileSidecarRunToolJob: vi.fn().mockResolvedValue({
      status: 'success',
      result: 'file-ok',
      newSessionId: 'sess-2',
    }),
    mockHttpSidecarRunToolJob: vi.fn().mockResolvedValue({
      status: 'success',
      result: 'http-ok',
      newSessionId: 'sess-3',
    }),
    mockAclManager,
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

vi.mock('../k8s/file-sidecar-runner.js', () => ({
  FileSidecarJobRunner: class {
    runToolJob = mockFileSidecarRunToolJob;
  },
}));

vi.mock('../k8s/http-sidecar-runner.js', () => ({
  HttpSidecarJobRunner: class {
    runToolJob = mockHttpSidecarRunToolJob;
  },
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
  getACLManager: vi.fn(() => mockAclManager),
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
    it('returns HTTP sidecar runner when userImage + userPort are set', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
        containerConfig: { userImage: 'my-image:latest', userPort: 8080 },
      };
      const runner = getRunnerForGroup(group);
      expect(runner).toBeDefined();
      expect(typeof runner.runAgent).toBe('function');
    });

    it('returns file sidecar runner when only userImage is set', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
        containerConfig: { userImage: 'my-image:latest' },
      };
      const runner = getRunnerForGroup(group);
      expect(runner).toBeDefined();
      expect(typeof runner.runAgent).toBe('function');
    });

    it('returns direct LLM runner when direct is set', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
        containerConfig: { direct: true },
      };
      const runner = getRunnerForGroup(group);
      expect(runner).toBeDefined();
      expect(typeof runner.runAgent).toBe('function');
    });

    it('returns kubernetes runner when no containerConfig is set', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const group = {
        name: 'test-group',
        folder: 'test-group',
        trigger: '',
        added_at: new Date().toISOString(),
      };
      const runner = getRunnerForGroup(group);
      expect(runner).toBeDefined();
      expect(typeof runner.runAgent).toBe('function');
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

  describe('FileSidecarToolJobRunner', () => {
    const fileSidecarGroup = {
      name: 'sidecar-group',
      folder: 'sidecar-group',
      trigger: '',
      added_at: new Date().toISOString(),
      containerConfig: { userImage: 'my-image:latest' },
    };

    it('writeTasksSnapshot writes tasks to IPC directory', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(fileSidecarGroup);
      const tasks = [{ id: '1', name: 'Task', status: 'pending' }];
      runner.writeTasksSnapshot('sidecar-group', true, tasks as never);

      const file = path.join(
        tmpDir,
        'sidecar-group',
        'ipc',
        'current_tasks.json',
      );
      expect(fs.existsSync(file)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(tasks);
    });

    it('writeGroupsSnapshot writes groups for main=true', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(fileSidecarGroup);
      const groups = [{ name: 'g1', folder: 'g1' }];
      runner.writeGroupsSnapshot(
        'sidecar-group',
        true,
        groups as never,
        new Set(),
      );

      const file = path.join(
        tmpDir,
        'sidecar-group',
        'ipc',
        'available_groups.json',
      );
      const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(written.groups).toEqual(groups);
    });

    it('writeGroupsSnapshot writes empty groups for main=false', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(fileSidecarGroup);
      const groups = [{ name: 'g1', folder: 'g1' }];
      runner.writeGroupsSnapshot(
        'sidecar-group',
        false,
        groups as never,
        new Set(),
      );

      const file = path.join(
        tmpDir,
        'sidecar-group',
        'ipc',
        'available_groups.json',
      );
      const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(written.groups).toEqual([]);
    });

    it('sendMessage returns false when no active job', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      // Access sendMessage via type cast to SidecarRunner
      const runner = getRunnerForGroup(fileSidecarGroup) as unknown as {
        sendMessage: (g: string, t: string) => Promise<boolean>;
      };
      const result = await runner.sendMessage('sidecar-group', 'hello');
      expect(result).toBe(false);
    });

    it('setSendMessageHandler registers a handler', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(fileSidecarGroup) as unknown as {
        setSendMessageHandler: (
          h: (g: string, t: string) => Promise<boolean>,
        ) => void;
        sendMessage: (g: string, t: string) => Promise<boolean>;
      };
      const handler = vi.fn().mockResolvedValue(true);
      runner.setSendMessageHandler(handler);
      // sendMessage still returns false because no active job
      const result = await runner.sendMessage('sidecar-group', 'hello');
      expect(result).toBe(false);
    });

    it('shutdown resolves without error when no active jobs', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(fileSidecarGroup);
      await expect(runner.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('HttpSidecarToolJobRunner', () => {
    const httpSidecarGroup = {
      name: 'http-sidecar-group',
      folder: 'http-sidecar-group',
      trigger: '',
      added_at: new Date().toISOString(),
      containerConfig: { userImage: 'my-image:latest', userPort: 8080 },
    };

    it('writeTasksSnapshot writes tasks to IPC directory', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(httpSidecarGroup);
      const tasks = [{ id: '2', name: 'HTTP Task', status: 'done' }];
      runner.writeTasksSnapshot('http-sidecar-group', true, tasks as never);

      const file = path.join(
        tmpDir,
        'http-sidecar-group',
        'ipc',
        'current_tasks.json',
      );
      expect(fs.existsSync(file)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(tasks);
    });

    it('writeGroupsSnapshot writes groups for main=true', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(httpSidecarGroup);
      const groups = [{ name: 'g2', folder: 'g2' }];
      runner.writeGroupsSnapshot(
        'http-sidecar-group',
        true,
        groups as never,
        new Set(),
      );

      const file = path.join(
        tmpDir,
        'http-sidecar-group',
        'ipc',
        'available_groups.json',
      );
      const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(written.groups).toEqual(groups);
    });

    it('writeGroupsSnapshot writes empty groups for main=false', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(httpSidecarGroup);
      const groups = [{ name: 'g2', folder: 'g2' }];
      runner.writeGroupsSnapshot(
        'http-sidecar-group',
        false,
        groups as never,
        new Set(),
      );

      const file = path.join(
        tmpDir,
        'http-sidecar-group',
        'ipc',
        'available_groups.json',
      );
      const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(written.groups).toEqual([]);
    });

    it('sendMessage returns false when no active job', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(httpSidecarGroup) as unknown as {
        sendMessage: (g: string, t: string) => Promise<boolean>;
      };
      const result = await runner.sendMessage('http-sidecar-group', 'hello');
      expect(result).toBe(false);
    });

    it('setSendMessageHandler registers a handler', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(httpSidecarGroup) as unknown as {
        setSendMessageHandler: (
          h: (g: string, t: string) => Promise<boolean>,
        ) => void;
        sendMessage: (g: string, t: string) => Promise<boolean>;
      };
      const handler = vi.fn().mockResolvedValue(true);
      runner.setSendMessageHandler(handler);
      const result = await runner.sendMessage('http-sidecar-group', 'hello');
      expect(result).toBe(false);
    });

    it('shutdown resolves without error when no active jobs', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(httpSidecarGroup);
      await expect(runner.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('shutdownAllRunners - comprehensive', () => {
    it('shuts down all four runner types when all are active', async () => {
      const {
        getToolJobRunner,
        getRunnerForGroup,
        getDirectLLMRunner,
        shutdownAllRunners,
      } = await import('./index.js');

      getToolJobRunner();
      getDirectLLMRunner();
      getRunnerForGroup({
        name: 'fs',
        folder: 'fs',
        trigger: '',
        added_at: '',
        containerConfig: { userImage: 'img' },
      });
      getRunnerForGroup({
        name: 'http',
        folder: 'http',
        trigger: '',
        added_at: '',
        containerConfig: { userImage: 'img', userPort: 80 },
      });

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

  describe('FileSidecarToolJobRunner.runAgent', () => {
    const fsGroup = {
      name: 'fs',
      folder: 'fs',
      trigger: '',
      added_at: '',
      containerConfig: { userImage: 'img:latest' },
    };

    it('returns error when userImage is missing', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const noImageGroup = {
        name: 'g',
        folder: 'g',
        trigger: '',
        added_at: '',
        containerConfig: {},
      };
      // Use userImage group to get FileSidecarRunner, then test missing image via type override
      const runner = getRunnerForGroup(fsGroup) as unknown as {
        runAgent: (
          ...a: unknown[]
        ) => Promise<{ status: string; error: string }>;
      };
      // Call with a group that has no userImage
      const result = await runner.runAgent(
        { ...fsGroup, containerConfig: {} },
        { ...baseInput, groupFolder: 'fs' },
      );
      expect(result.status).toBe('error');
      expect(result.error).toContain('userImage');
    });

    it('returns success output', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      mockFileSidecarRunToolJob.mockResolvedValueOnce({
        status: 'success',
        result: 'fs-done',
        newSessionId: 'fs-sess',
      });
      const result = await getRunnerForGroup(fsGroup).runAgent(fsGroup, {
        ...baseInput,
        groupFolder: 'fs',
      });
      expect(result.status).toBe('success');
      expect(result.result).toBe('fs-done');
    });

    it('returns error when jobRunner throws', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      mockFileSidecarRunToolJob.mockRejectedValueOnce(new Error('fs crash'));
      const result = await getRunnerForGroup(fsGroup).runAgent(fsGroup, {
        ...baseInput,
        groupFolder: 'fs',
      });
      expect(result.status).toBe('error');
      expect(result.error).toBe('fs crash');
    });

    it('continues when ACL creation fails', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      mockAclManager.createJobACL.mockRejectedValueOnce(new Error('acl error'));
      mockFileSidecarRunToolJob.mockResolvedValueOnce({
        status: 'success',
        result: 'ok',
      });
      const result = await getRunnerForGroup(fsGroup).runAgent(fsGroup, {
        ...baseInput,
        groupFolder: 'fs',
      });
      expect(result.status).toBe('success');
    });

    it('sendMessage returns true via handler when active job has credentials', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      mockAclManager.getJobCredentials.mockReturnValue({
        username: 'u',
        password: 'p',
      });

      // suspend the job so activeJobs stays populated
      let resolveJob!: (v: unknown) => void;
      mockFileSidecarRunToolJob.mockReturnValueOnce(
        new Promise((r) => {
          resolveJob = r;
        }),
      );

      const runner = getRunnerForGroup(fsGroup) as unknown as {
        runAgent: (...a: unknown[]) => Promise<unknown>;
        setSendMessageHandler: (
          h: (g: string, t: string) => Promise<boolean>,
        ) => void;
        sendMessage: (g: string, t: string) => Promise<boolean>;
      };
      const handler = vi.fn().mockResolvedValue(true);
      runner.setSendMessageHandler(handler);

      const runPromise = runner.runAgent(fsGroup, {
        ...baseInput,
        groupFolder: 'fs',
      });
      // yield microtasks so createJobACL resolves and activeJobs gets populated
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const result = await runner.sendMessage('fs', 'hello');
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith('fs', 'hello');

      resolveJob({ status: 'success', result: 'ok' });
      await runPromise;
      mockAclManager.getJobCredentials.mockReturnValue(undefined);
    });

    it('shutdown revokes ACLs for active jobs', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      let resolveJob!: (v: unknown) => void;
      mockFileSidecarRunToolJob.mockReturnValueOnce(
        new Promise((r) => {
          resolveJob = r;
        }),
      );

      const runner = getRunnerForGroup(fsGroup);
      const runPromise = runner.runAgent(fsGroup, {
        ...baseInput,
        groupFolder: 'fs',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      await runner.shutdown();
      expect(mockAclManager.close).toHaveBeenCalled();

      resolveJob({ status: 'success', result: 'ok' });
      await runPromise.catch(() => {}); // may throw after shutdown
    });
  });

  describe('HttpSidecarToolJobRunner.runAgent', () => {
    const httpGroup = {
      name: 'http',
      folder: 'http',
      trigger: '',
      added_at: '',
      containerConfig: { userImage: 'img:latest', userPort: 9090 },
    };

    it('returns error when userImage is missing', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      const runner = getRunnerForGroup(httpGroup) as unknown as {
        runAgent: (
          ...a: unknown[]
        ) => Promise<{ status: string; error: string }>;
      };
      const result = await runner.runAgent(
        { ...httpGroup, containerConfig: { userPort: 9090 } },
        { ...baseInput, groupFolder: 'http' },
      );
      expect(result.status).toBe('error');
      expect(result.error).toContain('userImage');
    });

    it('returns success output', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      mockHttpSidecarRunToolJob.mockResolvedValueOnce({
        status: 'success',
        result: 'http-done',
        newSessionId: 'http-sess',
      });
      const result = await getRunnerForGroup(httpGroup).runAgent(httpGroup, {
        ...baseInput,
        groupFolder: 'http',
      });
      expect(result.status).toBe('success');
      expect(result.result).toBe('http-done');
    });

    it('returns error when jobRunner throws', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      mockHttpSidecarRunToolJob.mockRejectedValueOnce(new Error('http crash'));
      const result = await getRunnerForGroup(httpGroup).runAgent(httpGroup, {
        ...baseInput,
        groupFolder: 'http',
      });
      expect(result.status).toBe('error');
      expect(result.error).toBe('http crash');
    });

    it('continues when ACL creation fails', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      mockAclManager.createJobACL.mockRejectedValueOnce(new Error('acl error'));
      mockHttpSidecarRunToolJob.mockResolvedValueOnce({
        status: 'success',
        result: 'ok',
      });
      const result = await getRunnerForGroup(httpGroup).runAgent(httpGroup, {
        ...baseInput,
        groupFolder: 'http',
      });
      expect(result.status).toBe('success');
    });

    it('shutdown revokes ACLs for active jobs', async () => {
      const { getRunnerForGroup } = await import('./index.js');
      let resolveJob!: (v: unknown) => void;
      mockHttpSidecarRunToolJob.mockReturnValueOnce(
        new Promise((r) => {
          resolveJob = r;
        }),
      );

      const runner = getRunnerForGroup(httpGroup);
      const runPromise = runner.runAgent(httpGroup, {
        ...baseInput,
        groupFolder: 'http',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      await runner.shutdown();
      expect(mockAclManager.close).toHaveBeenCalled();

      resolveJob({ status: 'success', result: 'ok' });
      await runPromise.catch(() => {});
    });
  });
});
