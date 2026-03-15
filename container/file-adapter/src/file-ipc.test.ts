/**
 * Tests for file-ipc.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileIPC, FileIPCOptions } from './file-ipc.js';
import { TaskFile, ResultFile } from './protocol.js';
import { mockFs } from './test-utils/fs-mock.js';

// Mock the fs module
vi.mock('fs', () => {
  return {
    default: {
      mkdirSync: vi.fn((path: string, opts?: { recursive?: boolean }) =>
        mockFs.mkdirSync(path, opts),
      ),
      writeFileSync: vi.fn((path: string, data: string) =>
        mockFs.writeFileSync(path, data),
      ),
      readFileSync: vi.fn((path: string, encoding?: string) =>
        mockFs.readFileSync(path, encoding),
      ),
      existsSync: vi.fn((path: string) => mockFs.existsSync(path)),
      readdirSync: vi.fn((path: string) => mockFs.readdirSync(path)),
      unlinkSync: vi.fn((path: string) => mockFs.unlinkSync(path)),
    },
    mkdirSync: vi.fn((path: string, opts?: { recursive?: boolean }) =>
      mockFs.mkdirSync(path, opts),
    ),
    writeFileSync: vi.fn((path: string, data: string) =>
      mockFs.writeFileSync(path, data),
    ),
    readFileSync: vi.fn((path: string, encoding?: string) =>
      mockFs.readFileSync(path, encoding),
    ),
    existsSync: vi.fn((path: string) => mockFs.existsSync(path)),
    readdirSync: vi.fn((path: string) => mockFs.readdirSync(path)),
    unlinkSync: vi.fn((path: string) => mockFs.unlinkSync(path)),
  };
});

// Mock the path module
vi.mock('path', () => {
  return {
    default: {
      join: vi.fn((...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
    },
    join: vi.fn((...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
  };
});

describe('FileIPC', () => {
  const inputDir = '/workspace/input';
  const outputDir = '/workspace/output';
  const defaultOptions: FileIPCOptions = {
    inputDir,
    outputDir,
    pollInterval: 100,
    timeout: 5000,
  };

  beforeEach(() => {
    mockFs.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create directories on construction', () => {
      new FileIPC(defaultOptions);

      expect(mockFs.existsSync(inputDir)).toBe(true);
      expect(mockFs.existsSync(outputDir)).toBe(true);
    });

    it('should initialize task counter to 0', () => {
      const fileIPC = new FileIPC(defaultOptions);

      expect(fileIPC.getTaskCounter()).toBe(0);
    });
  });

  describe('writeTask', () => {
    it('should create task.json for first task', () => {
      const fileIPC = new FileIPC(defaultOptions);
      const task: TaskFile = {
        prompt: 'test prompt',
        groupFolder: '/test/group',
        chatJid: 'user@example.com',
        isMain: true,
      };

      const taskPath = fileIPC.writeTask(task);

      expect(taskPath).toBe(`${inputDir}/task.json`);
      expect(mockFs.existsSync(`${inputDir}/task.json`)).toBe(true);

      const content = JSON.parse(
        mockFs.readFileSync(`${inputDir}/task.json`, 'utf-8') as string,
      );
      expect(content.prompt).toBe('test prompt');
    });

    it('should create sequential files for subsequent tasks', () => {
      const fileIPC = new FileIPC(defaultOptions);
      const task1: TaskFile = {
        prompt: 'first task',
        groupFolder: '/test/group',
        chatJid: 'user@example.com',
        isMain: true,
      };
      const task2: TaskFile = {
        prompt: 'second task',
        groupFolder: '/test/group',
        chatJid: 'user@example.com',
        isMain: true,
      };
      const task3: TaskFile = {
        prompt: 'third task',
        groupFolder: '/test/group',
        chatJid: 'user@example.com',
        isMain: true,
      };

      fileIPC.writeTask(task1);
      const path2 = fileIPC.writeTask(task2);
      const path3 = fileIPC.writeTask(task3);

      expect(path2).toBe(`${inputDir}/task_1.json`);
      expect(path3).toBe(`${inputDir}/task_2.json`);
      expect(fileIPC.getTaskCounter()).toBe(3);
    });

    it('should write task data as formatted JSON', () => {
      const fileIPC = new FileIPC(defaultOptions);
      const task: TaskFile = {
        prompt: 'test prompt',
        sessionId: 'session-123',
        groupFolder: '/test/group',
        chatJid: 'user@example.com',
        isMain: true,
        isScheduledTask: false,
        assistantName: 'TestBot',
        secrets: { apiKey: 'secret' },
      };

      fileIPC.writeTask(task);

      const content = mockFs.readFileSync(
        `${inputDir}/task.json`,
        'utf-8',
      ) as string;
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(task);
    });
  });

  describe('waitForResult', () => {
    it('should return result when file exists immediately', async () => {
      const fileIPC = new FileIPC(defaultOptions);
      const expectedResult: ResultFile = {
        status: 'success',
        result: 'test output',
      };

      // Pre-create the result file
      mockFs.writeFileSync(
        `${outputDir}/result.json`,
        JSON.stringify(expectedResult),
      );

      const result = await fileIPC.waitForResult();

      expect(result).toEqual(expectedResult);
    });

    it('should wait for result file and return it', async () => {
      const fileIPC = new FileIPC({
        ...defaultOptions,
        pollInterval: 50,
      });
      const expectedResult: ResultFile = {
        status: 'success',
        result: 'delayed output',
      };

      // Create result file after a short delay
      setTimeout(() => {
        mockFs.writeFileSync(
          `${outputDir}/result.json`,
          JSON.stringify(expectedResult),
        );
      }, 150);

      const result = await fileIPC.waitForResult();

      expect(result).toEqual(expectedResult);
    });

    it('should return null on timeout', async () => {
      const fileIPC = new FileIPC({
        ...defaultOptions,
        pollInterval: 50,
        timeout: 100,
      });

      const result = await fileIPC.waitForResult();

      expect(result).toBeNull();
    });

    it('should handle partial file writes and continue polling', async () => {
      const fileIPC = new FileIPC({
        ...defaultOptions,
        pollInterval: 50,
      });
      const expectedResult: ResultFile = {
        status: 'success',
        result: 'final output',
      };

      // Create invalid file first, then fix it
      let callCount = 0;
      const originalWriteFileSync = mockFs.writeFileSync.bind(mockFs);

      setTimeout(() => {
        // First write - invalid JSON
        originalWriteFileSync(`${outputDir}/result.json`, 'invalid');
      }, 100);

      setTimeout(() => {
        // Second write - valid JSON
        originalWriteFileSync(
          `${outputDir}/result.json`,
          JSON.stringify(expectedResult),
        );
      }, 200);

      const result = await fileIPC.waitForResult();

      expect(result).toEqual(expectedResult);
    });

    it('should handle result with session ID', async () => {
      const fileIPC = new FileIPC(defaultOptions);
      const expectedResult: ResultFile = {
        status: 'success',
        result: 'output with session',
        newSessionId: 'new-session-123',
      };

      mockFs.writeFileSync(
        `${outputDir}/result.json`,
        JSON.stringify(expectedResult),
      );

      const result = await fileIPC.waitForResult();

      expect(result?.newSessionId).toBe('new-session-123');
    });

    it('should handle error result', async () => {
      const fileIPC = new FileIPC(defaultOptions);
      const expectedResult: ResultFile = {
        status: 'error',
        result: null,
        error: 'Something went wrong',
      };

      mockFs.writeFileSync(
        `${outputDir}/result.json`,
        JSON.stringify(expectedResult),
      );

      const result = await fileIPC.waitForResult();

      expect(result?.status).toBe('error');
      expect(result?.error).toBe('Something went wrong');
    });
  });

  describe('cleanupFiles', () => {
    it('should remove all task files and result file', () => {
      const fileIPC = new FileIPC(defaultOptions);
      const task: TaskFile = {
        prompt: 'test',
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
      };

      // Create multiple task files
      fileIPC.writeTask(task);
      fileIPC.writeTask(task);
      mockFs.writeFileSync(`${outputDir}/result.json`, '{"status":"success"}');

      expect(mockFs.existsSync(`${inputDir}/task.json`)).toBe(true);
      expect(mockFs.existsSync(`${inputDir}/task_1.json`)).toBe(true);
      expect(mockFs.existsSync(`${outputDir}/result.json`)).toBe(true);

      fileIPC.cleanupFiles();

      expect(mockFs.existsSync(`${inputDir}/task.json`)).toBe(false);
      expect(mockFs.existsSync(`${inputDir}/task_1.json`)).toBe(false);
      expect(mockFs.existsSync(`${outputDir}/result.json`)).toBe(false);
    });

    it('should handle cleanup when no files exist', () => {
      const fileIPC = new FileIPC(defaultOptions);

      // Should not throw
      expect(() => fileIPC.cleanupFiles()).not.toThrow();
    });

    it('should ignore non-task files in input directory', () => {
      const fileIPC = new FileIPC(defaultOptions);

      // Create a non-task file (doesn't start with 'task')
      mockFs.writeFileSync(`${inputDir}/other.json`, '{}');
      mockFs.writeFileSync(`${inputDir}/backup.json`, '{}');

      fileIPC.cleanupFiles();

      // Non-task files should still exist
      expect(mockFs.existsSync(`${inputDir}/other.json`)).toBe(true);
      expect(mockFs.existsSync(`${inputDir}/backup.json`)).toBe(true);
    });
  });

  describe('resetTaskCounter', () => {
    it('should reset task counter to 0', () => {
      const fileIPC = new FileIPC(defaultOptions);
      const task: TaskFile = {
        prompt: 'test',
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
      };

      fileIPC.writeTask(task);
      fileIPC.writeTask(task);
      expect(fileIPC.getTaskCounter()).toBe(2);

      fileIPC.resetTaskCounter();

      expect(fileIPC.getTaskCounter()).toBe(0);
    });

    it('should allow creating task.json again after reset', () => {
      const fileIPC = new FileIPC(defaultOptions);
      const task: TaskFile = {
        prompt: 'test',
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
      };

      fileIPC.writeTask(task);
      fileIPC.resetTaskCounter();
      const path = fileIPC.writeTask(task);

      expect(path).toBe(`${inputDir}/task.json`);
    });
  });

  describe('getTaskCounter', () => {
    it('should return current task counter value', () => {
      const fileIPC = new FileIPC(defaultOptions);
      const task: TaskFile = {
        prompt: 'test',
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
      };

      expect(fileIPC.getTaskCounter()).toBe(0);
      fileIPC.writeTask(task);
      expect(fileIPC.getTaskCounter()).toBe(1);
      fileIPC.writeTask(task);
      expect(fileIPC.getTaskCounter()).toBe(2);
    });
  });
});
