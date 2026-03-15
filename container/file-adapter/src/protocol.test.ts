/**
 * Tests for protocol.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeMarkedOutput,
  readStdin,
  parseContainerInput,
  toTaskFile,
  toContainerOutput,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  ContainerInput,
  ContainerOutput,
  ResultFile,
} from './protocol.js';

describe('writeMarkedOutput', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should write output with markers to console.log', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'test result',
    };

    writeMarkedOutput(output);

    expect(consoleSpy).toHaveBeenCalledTimes(3);
    expect(consoleSpy).toHaveBeenNthCalledWith(1, OUTPUT_START_MARKER);
    expect(consoleSpy).toHaveBeenNthCalledWith(2, JSON.stringify(output));
    expect(consoleSpy).toHaveBeenNthCalledWith(3, OUTPUT_END_MARKER);
  });

  it('should handle error output', () => {
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: 'test error',
    };

    writeMarkedOutput(output);

    expect(consoleSpy).toHaveBeenCalledTimes(3);
    expect(consoleSpy).toHaveBeenNthCalledWith(2, JSON.stringify(output));
  });
});

describe('readStdin', () => {
  let stdinMock: any;

  beforeEach(() => {
    stdinMock = {
      setEncoding: vi.fn(),
      on: vi.fn(),
    };
    vi.stubGlobal('process', { ...process, stdin: stdinMock });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should read all data from stdin', async () => {
    const testData = '{"prompt": "test"}';

    stdinMock.on.mockImplementation((event: string, callback: Function) => {
      if (event === 'data') {
        callback(testData);
      } else if (event === 'end') {
        callback();
      }
    });

    const result = await readStdin();

    expect(result).toBe(testData);
    expect(stdinMock.setEncoding).toHaveBeenCalledWith('utf8');
  });

  it('should handle multiple data chunks', async () => {
    const chunk1 = '{"prompt": "';
    const chunk2 = 'test"}';

    stdinMock.on.mockImplementation((event: string, callback: Function) => {
      if (event === 'data') {
        callback(chunk1);
        callback(chunk2);
      } else if (event === 'end') {
        callback();
      }
    });

    const result = await readStdin();

    expect(result).toBe(chunk1 + chunk2);
  });

  it('should reject on error', async () => {
    const error = new Error('stdin error');

    stdinMock.on.mockImplementation((event: string, callback: Function) => {
      if (event === 'error') {
        callback(error);
      }
    });

    await expect(readStdin()).rejects.toThrow('stdin error');
  });
});

describe('parseContainerInput', () => {
  it('should parse valid input with all fields', () => {
    const input = JSON.stringify({
      prompt: 'test prompt',
      sessionId: 'session-123',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
      isScheduledTask: false,
      assistantName: 'TestBot',
      secrets: { apiKey: 'secret123' },
    });

    const result = parseContainerInput(input);

    expect(result.prompt).toBe('test prompt');
    expect(result.sessionId).toBe('session-123');
    expect(result.groupFolder).toBe('/test/group');
    expect(result.chatJid).toBe('user@example.com');
    expect(result.isMain).toBe(true);
    expect(result.isScheduledTask).toBe(false);
    expect(result.assistantName).toBe('TestBot');
    expect(result.secrets).toEqual({ apiKey: 'secret123' });
  });

  it('should parse input with minimal fields', () => {
    const input = JSON.stringify({
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: false,
    });

    const result = parseContainerInput(input);

    expect(result.prompt).toBe('test prompt');
    expect(result.groupFolder).toBe('/test/group');
    expect(result.chatJid).toBe('user@example.com');
    expect(result.isMain).toBe(false);
    expect(result.sessionId).toBeUndefined();
  });

  it('should throw error when prompt is missing', () => {
    const input = JSON.stringify({
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
    });

    expect(() => parseContainerInput(input)).toThrow(
      'Missing required field: prompt',
    );
  });

  it('should throw error when groupFolder is missing', () => {
    const input = JSON.stringify({
      prompt: 'test prompt',
      chatJid: 'user@example.com',
      isMain: true,
    });

    expect(() => parseContainerInput(input)).toThrow(
      'Missing required field: groupFolder',
    );
  });

  it('should throw error when chatJid is missing', () => {
    const input = JSON.stringify({
      prompt: 'test prompt',
      groupFolder: '/test/group',
      isMain: true,
    });

    expect(() => parseContainerInput(input)).toThrow(
      'Missing required field: chatJid',
    );
  });

  it('should throw error when isMain is missing', () => {
    const input = JSON.stringify({
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
    });

    expect(() => parseContainerInput(input)).toThrow(
      'Missing or invalid field: isMain',
    );
  });

  it('should throw error when isMain is not a boolean', () => {
    const input = JSON.stringify({
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: 'true',
    });

    expect(() => parseContainerInput(input)).toThrow(
      'Missing or invalid field: isMain',
    );
  });

  it('should throw error for invalid JSON', () => {
    const input = 'invalid json {';

    expect(() => parseContainerInput(input)).toThrow();
  });
});

describe('toTaskFile', () => {
  it('should convert ContainerInput to TaskFile correctly', () => {
    const input: ContainerInput = {
      prompt: 'test prompt',
      sessionId: 'session-123',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
      isScheduledTask: true,
      assistantName: 'TestBot',
      secrets: { key: 'value' },
    };

    const result = toTaskFile(input);

    expect(result.prompt).toBe(input.prompt);
    expect(result.sessionId).toBe(input.sessionId);
    expect(result.groupFolder).toBe(input.groupFolder);
    expect(result.chatJid).toBe(input.chatJid);
    expect(result.isMain).toBe(input.isMain);
    expect(result.isScheduledTask).toBe(input.isScheduledTask);
    expect(result.assistantName).toBe(input.assistantName);
    expect(result.secrets).toEqual(input.secrets);
  });

  it('should handle optional fields as undefined', () => {
    const input: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: false,
    };

    const result = toTaskFile(input);

    expect(result.sessionId).toBeUndefined();
    expect(result.isScheduledTask).toBeUndefined();
    expect(result.assistantName).toBeUndefined();
    expect(result.secrets).toBeUndefined();
  });
});

describe('toContainerOutput', () => {
  it('should convert ResultFile with success status', () => {
    const result: ResultFile = {
      status: 'success',
      result: 'test output',
      newSessionId: 'session-456',
    };

    const output = toContainerOutput(result);

    expect(output.status).toBe('success');
    expect(output.result).toBe('test output');
    expect(output.newSessionId).toBe('session-456');
    expect(output.error).toBeUndefined();
  });

  it('should convert ResultFile with error status', () => {
    const result: ResultFile = {
      status: 'error',
      result: null,
      error: 'Something went wrong',
    };

    const output = toContainerOutput(result);

    expect(output.status).toBe('error');
    expect(output.result).toBeNull();
    expect(output.error).toBe('Something went wrong');
    expect(output.newSessionId).toBeUndefined();
  });

  it('should handle null result with success status', () => {
    const result: ResultFile = {
      status: 'success',
      result: null,
    };

    const output = toContainerOutput(result);

    expect(output.status).toBe('success');
    expect(output.result).toBeNull();
  });
});
