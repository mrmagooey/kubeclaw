/**
 * Tests for http-client.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendTask, ClientError, RetryExhaustedError } from './http-client.js';
import { AgentTaskRequest } from './protocol.js';

describe('ClientError', () => {
  it('should create error with correct properties', () => {
    const error = new ClientError(400, 'Bad Request');

    expect(error.statusCode).toBe(400);
    expect(error.body).toBe('Bad Request');
    expect(error.message).toContain('400');
    expect(error.message).toContain('Bad Request');
    expect(error.name).toBe('ClientError');
  });
});

describe('RetryExhaustedError', () => {
  it('should create error with correct properties', () => {
    const error = new RetryExhaustedError(3, 'Connection refused');

    expect(error.attempts).toBe(3);
    expect(error.lastError).toBe('Connection refused');
    expect(error.message).toContain('3');
    expect(error.message).toContain('Connection refused');
    expect(error.name).toBe('RetryExhaustedError');
  });
});

describe('sendTask', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const baseOptions = {
    baseUrl: 'http://localhost:8080',
    requestTimeout: 5000,
    maxRetries: 2,
    retryDelay: 100,
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('should return parsed JSON on HTTP 200', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValueOnce(
        JSON.stringify({
          status: 'success',
          result: 'output',
        }),
      ),
    });

    const result = await sendTask(request, baseOptions);

    expect(result.status).toBe('success');
    expect(result.result).toBe('output');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/agent/task',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
  });

  it('should return non-JSON as string result', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValueOnce('plain text response'),
    });

    const result = await sendTask(request, baseOptions);

    expect(result.status).toBe('success');
    expect(result.result).toBe('plain text response');
  });

  it('should throw ClientError on HTTP 4xx', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    await expect(sendTask(request, baseOptions)).rejects.toThrow(ClientError);
  });

  it('should throw ClientError with status code 400', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    try {
      await sendTask(request, baseOptions);
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError);
      expect((error as ClientError).statusCode).toBe(400);
    }
  });

  it('should retry on HTTP 5xx', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValueOnce('Internal Server Error'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi
          .fn()
          .mockResolvedValueOnce(JSON.stringify({ status: 'success' })),
      });

    const result = await sendTask(request, { ...baseOptions, retryDelay: 10 });

    expect(result.status).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should retry on network errors', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi
          .fn()
          .mockResolvedValueOnce(JSON.stringify({ status: 'success' })),
      });

    const result = await sendTask(request, { ...baseOptions, retryDelay: 10 });

    expect(result.status).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should throw RetryExhaustedError after max retries', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockRejectedValue(new Error('Persistent network error'));

    await expect(
      sendTask(request, { ...baseOptions, maxRetries: 2, retryDelay: 10 }),
    ).rejects.toThrow(RetryExhaustedError);
  });

  it('should use exponential backoff delays', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockRejectedValue(new Error('Network error'));

    const startTime = Date.now();
    try {
      await sendTask(request, {
        ...baseOptions,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch (e) {
      // Expected
    }
    const elapsed = Date.now() - startTime;

    // Expected delays: 50ms (attempt 1), 100ms (attempt 2), 200ms (attempt 3)
    // Total: at least 350ms
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  it('should handle HTTP 404 error without retry', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('Not Found'),
    });

    await expect(sendTask(request, baseOptions)).rejects.toThrow(ClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should handle HTTP 429 rate limit without retry', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue('Too Many Requests'),
    });

    await expect(sendTask(request, baseOptions)).rejects.toThrow(ClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should handle response with sessionId', async () => {
    const request: AgentTaskRequest = {
      prompt: 'test',
      context: {
        groupFolder: '/test',
        chatJid: 'user@example.com',
        isMain: true,
        assistantName: 'Andy',
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValueOnce(
        JSON.stringify({
          status: 'success',
          result: 'output',
          sessionId: 'new-session-123',
        }),
      ),
    });

    const result = await sendTask(request, baseOptions);

    expect(result.sessionId).toBe('new-session-123');
  });
});
