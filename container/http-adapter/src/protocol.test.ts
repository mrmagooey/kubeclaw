/**
 * Tests for protocol.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeMarkedOutput,
  readStdin,
  parseContainerInput,
  toAgentTaskRequest,
  toContainerOutput,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  ContainerInput,
  ContainerOutput,
  AgentTaskResponse,
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

describe('toAgentTaskRequest', () => {
  it('should convert ContainerInput to AgentTaskRequest with all fields', () => {
    const input: ContainerInput = {
      prompt: 'test prompt',
      sessionId: 'session-123',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
      isScheduledTask: false,
      assistantName: 'TestBot',
      secrets: { apiKey: 'secret123' },
    };

    const result = toAgentTaskRequest(input);

    expect(result.prompt).toBe('test prompt');
    expect(result.sessionId).toBe('session-123');
    expect(result.context.groupFolder).toBe('/test/group');
    expect(result.context.chatJid).toBe('user@example.com');
    expect(result.context.isMain).toBe(true);
    expect(result.context.assistantName).toBe('TestBot');
    expect(result.secrets).toEqual({ apiKey: 'secret123' });
  });

  it('should default assistantName to Andy when not provided', () => {
    const input: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: false,
    };

    const result = toAgentTaskRequest(input);

    expect(result.context.assistantName).toBe('Andy');
  });

  it('should handle optional fields as undefined', () => {
    const input: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: false,
    };

    const result = toAgentTaskRequest(input);

    expect(result.sessionId).toBeUndefined();
    expect(result.secrets).toBeUndefined();
  });

  it('should use provided assistantName', () => {
    const input: ContainerInput = {
      prompt: 'test prompt',
      groupFolder: '/test/group',
      chatJid: 'user@example.com',
      isMain: true,
      assistantName: 'CustomBot',
    };

    const result = toAgentTaskRequest(input);

    expect(result.context.assistantName).toBe('CustomBot');
  });
});

describe('toContainerOutput', () => {
  it('should convert AgentTaskResponse with success status', () => {
    const response: AgentTaskResponse = {
      status: 'success',
      result: 'test output',
      sessionId: 'session-456',
    };

    const output = toContainerOutput(response);

    expect(output.status).toBe('success');
    expect(output.result).toBe('test output');
    expect(output.newSessionId).toBe('session-456');
    expect(output.error).toBeUndefined();
  });

  it('should convert AgentTaskResponse with error status', () => {
    const response: AgentTaskResponse = {
      status: 'error',
      error: 'Something went wrong',
    };

    const output = toContainerOutput(response);

    expect(output.status).toBe('error');
    expect(output.result).toBeNull();
    expect(output.error).toBe('Something went wrong');
    expect(output.newSessionId).toBeUndefined();
  });

  it('should handle undefined result', () => {
    const response: AgentTaskResponse = {
      status: 'success',
    };

    const output = toContainerOutput(response);

    expect(output.status).toBe('success');
    expect(output.result).toBeNull();
  });

  it('should handle result with sessionId', () => {
    const response: AgentTaskResponse = {
      status: 'success',
      result: 'output',
      sessionId: 'new-session',
    };

    const output = toContainerOutput(response);

    expect(output.newSessionId).toBe('new-session');
  });
});
