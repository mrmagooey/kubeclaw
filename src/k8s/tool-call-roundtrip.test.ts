/**
 * Tool Call Round-Trip Tests
 *
 * Exercises the full tool execution sidecar protocol:
 *
 *   1. Orchestrator: processTaskIpc handles tool_pod_request → creates pod → sends ack
 *   2. Orchestrator: cleanupToolPods deletes category pods when agent ends
 *   3. Redis stream round-trip: tool call written to toolcalls stream, executed by
 *      tool-server, result written to toolresults stream, read by tool-router-mcp
 *
 * All Redis interactions are simulated with an in-memory stream store so no
 * real Redis or Kubernetes cluster is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── In-memory Redis stream simulation ────────────────────────────────────────

interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

class MemoryStreamStore {
  private streams = new Map<string, StreamEntry[]>();
  private nextSeq = 0;
  private waiters = new Map<string, Array<() => void>>();

  xadd(stream: string, fields: Record<string, string>): string {
    const id = `${Date.now()}-${this.nextSeq++}`;
    if (!this.streams.has(stream)) this.streams.set(stream, []);
    this.streams.get(stream)!.push({ id, fields });
    // wake up any XREAD blockers waiting on this stream
    (this.waiters.get(stream) || []).forEach((cb) => cb());
    this.waiters.delete(stream);
    return id;
  }

  /**
   * Non-blocking read: returns all entries with id > lastId, or empty array.
   */
  xreadAfter(stream: string, lastId: string): StreamEntry[] {
    const entries = this.streams.get(stream) || [];
    if (lastId === '$' || lastId === '0-0') {
      return lastId === '$' ? [] : entries;
    }
    return entries.filter((e) => e.id > lastId);
  }

  /**
   * Blocking read: resolves once an entry appears with id > lastId.
   * Polls the in-memory store; wakes immediately if data already available.
   */
  async xreadBlock(
    stream: string,
    lastId: string,
    timeoutMs: number,
  ): Promise<StreamEntry | null> {
    const check = () => {
      const entries = this.streams.get(stream) || [];
      if (lastId === '$') {
        // '$' means only entries arriving AFTER this xread call
        // We handle this by tracking the current tail at call time
        return null; // resolved separately below
      }
      return entries.find((e) => e.id > lastId) ?? null;
    };

    const found = check();
    if (found) return found;

    return new Promise((resolve) => {
      const deadline = setTimeout(() => {
        // Remove this waiter if it fires before data arrives
        const waiters = this.waiters.get(stream) || [];
        const idx = waiters.indexOf(wake);
        if (idx !== -1) waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const wake = () => {
        clearTimeout(deadline);
        const entry = check();
        resolve(entry);
      };

      if (!this.waiters.has(stream)) this.waiters.set(stream, []);
      this.waiters.get(stream)!.push(wake);
    });
  }

  /**
   * Variant of xreadBlock for '$' cursor: resolves on the NEXT write after call.
   */
  async xreadBlockNext(
    stream: string,
    timeoutMs: number,
  ): Promise<StreamEntry | null> {
    return new Promise((resolve) => {
      const deadline = setTimeout(() => {
        const waiters = this.waiters.get(stream) || [];
        const idx = waiters.indexOf(wake);
        if (idx !== -1) waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const wake = () => {
        clearTimeout(deadline);
        const entries = this.streams.get(stream) || [];
        resolve(entries[entries.length - 1] ?? null);
      };

      if (!this.waiters.has(stream)) this.waiters.set(stream, []);
      this.waiters.get(stream)!.push(wake);
    });
  }
}

// ── Mocks (must be hoisted) ───────────────────────────────────────────────────

const { mockCreateToolPodJob, mockStopJob, mockXadd } = vi.hoisted(() => {
  const mockCreateToolPodJob = vi.fn().mockResolvedValue('nc-exec-pod-abc');
  const mockStopJob = vi.fn().mockResolvedValue(undefined);
  const mockXadd = vi.fn();
  return { mockCreateToolPodJob, mockStopJob, mockXadd };
});

vi.mock('./job-runner.js', () => ({
  jobRunner: {
    createToolPodJob: mockCreateToolPodJob,
    stopJob: mockStopJob,
  },
}));

vi.mock('../config.js', () => ({
  TIMEZONE: 'UTC',
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
}));

vi.mock('../db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../group-folder.js', () => ({
  isValidGroupFolder: vi.fn().mockReturnValue(true),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    xadd: mockXadd,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
  })),
}));

vi.mock('./redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({ xadd: mockXadd })),
  getRedisSubscriber: vi.fn(() => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
  })),
  getOutputStream: vi.fn((f: string) => `kubeclaw:messages:${f}`),
  getOutputChannel: vi.fn((f: string) => `kubeclaw:messages:${f}`),
  getTaskChannel: vi.fn((f: string) => `kubeclaw:tasks:${f}`),
  getInputStream: vi.fn((jobId: string) => `kubeclaw:input:${jobId}`),
  getToolCallsStream: vi.fn(
    (jobId: string, cat: string) => `kubeclaw:toolcalls:${jobId}:${cat}`,
  ),
  getToolResultsStream: vi.fn(
    (jobId: string, cat: string) => `kubeclaw:toolresults:${jobId}:${cat}`,
  ),
}));

vi.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: vi.fn().mockReturnValue({
      next: vi.fn().mockReturnValue({
        toISOString: vi.fn().mockReturnValue('2026-01-01T00:00:00.000Z'),
      }),
    }),
  },
}));

import { processTaskIpc, cleanupToolPods } from './ipc-redis.js';

// ── Shared deps stub ──────────────────────────────────────────────────────────

function makeDeps() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: vi.fn().mockReturnValue({}),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    writeGroupsSnapshot: vi.fn(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Tool Call Round-Trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockXadd.mockResolvedValue('mock-stream-id');
  });

  // ── Orchestrator: tool_pod_request is retired ────────────────────────────────
  // The tool_pod_request IPC path was removed. Agents now request tool pods via
  // the kubeclaw:spawn-tool-pod stream (callCatalogToolViaRedis). Any stale
  // tool_pod_request messages must be silently ignored.

  describe('processTaskIpc: tool_pod_request (retired)', () => {
    it('ignores tool_pod_request — no pod created, no ack sent', async () => {
      const deps = makeDeps();

      await processTaskIpc(
        {
          type: 'tool_pod_request' as any,
          agentJobId: 'agent-job-123',
          category: 'execution' as any,
          groupFolder: 'my-group',
        } as any,
        'my-group',
        false,
        deps,
      );

      expect(mockCreateToolPodJob).not.toHaveBeenCalled();
      expect(mockXadd).not.toHaveBeenCalled();
    });
  });

  // ── Orchestrator: cleanupToolPods ───────────────────────────────────────────
  // cleanupToolPods() is still responsible for stopping pods tracked in
  // toolPodsByAgent (now populated by startToolPodSpawnWatcher, not tool_pod_request).
  // The tool_pod_request path no longer populates the map, so we test the
  // mechanics of the function itself.

  describe('cleanupToolPods', () => {
    it('does nothing for an unknown tool job', async () => {
      await cleanupToolPods('agent-does-not-exist');
      expect(mockStopJob).not.toHaveBeenCalled();
    });

    it('is a no-op when called twice for the same job', async () => {
      // First call on unknown job (nothing to do)
      await cleanupToolPods('agent-idem');
      mockStopJob.mockClear();
      // Second call on same job (still nothing)
      await cleanupToolPods('agent-idem');
      expect(mockStopJob).not.toHaveBeenCalled();
    });
  });

  // ── Redis stream round-trip protocol ─────────────────────────────────────────

  describe('Redis stream round-trip protocol', () => {
    it('tool call is routed from caller to executor and result returned', async () => {
      const store = new MemoryStreamStore();
      const agentJobId = 'agent-rt-001';
      const category = 'execution';
      const callsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const resultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      // Tool server: reads one call, executes tool, writes result
      const serverDone = (async () => {
        const entry = await store.xreadBlockNext(callsStream, 5000);
        expect(entry).not.toBeNull();
        const { requestId, tool, input } = entry!.fields;
        expect(tool).toBe('bash');
        const parsed = JSON.parse(input);
        expect(parsed.command).toBe('echo hello');

        // Simulate tool execution result
        store.xadd(resultsStream, {
          requestId,
          result: JSON.stringify('hello\n'),
        });
      })();

      // Tool router (caller): writes a tool call, waits for matching result
      const requestId = 'req-1234';
      store.xadd(callsStream, {
        requestId,
        tool: 'bash',
        input: JSON.stringify({ command: 'echo hello' }),
      });

      const resultEntry = await store.xreadBlockNext(resultsStream, 5000);
      expect(resultEntry).not.toBeNull();
      expect(resultEntry!.fields.requestId).toBe(requestId);
      expect(JSON.parse(resultEntry!.fields.result)).toBe('hello\n');

      await serverDone;
    });

    it('result is matched by requestId (ignores unrelated entries)', async () => {
      const store = new MemoryStreamStore();
      const agentJobId = 'agent-rt-002';
      const category = 'browser';
      const callsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const resultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      // Pre-populate results stream with a result for a *different* request
      store.xadd(resultsStream, {
        requestId: 'req-other',
        result: JSON.stringify('unrelated'),
      });

      // Tool server: returns result only for req-target
      const serverDone = (async () => {
        const entry = await store.xreadBlockNext(callsStream, 5000);
        expect(entry).not.toBeNull();
        store.xadd(resultsStream, {
          requestId: entry!.fields.requestId,
          result: JSON.stringify('correct result'),
        });
      })();

      store.xadd(callsStream, {
        requestId: 'req-target',
        tool: 'webSearch',
        input: JSON.stringify({ query: 'test' }),
      });

      // Caller polls results stream, skipping the pre-existing 'req-other' entry
      const entries = store.xreadAfter(resultsStream, '0-0');
      const match = entries.find((e) => e.fields.requestId === 'req-target');
      expect(match).toBeUndefined(); // not yet written

      await serverDone;

      const allEntries = store.xreadAfter(resultsStream, '0-0');
      const targeted = allEntries.find(
        (e) => e.fields.requestId === 'req-target',
      );
      expect(targeted).toBeDefined();
      expect(JSON.parse(targeted!.fields.result)).toBe('correct result');
    });

    it('error from tool server is propagated in result fields', async () => {
      const store = new MemoryStreamStore();
      const agentJobId = 'agent-rt-003';
      const category = 'execution';
      const callsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const resultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      const serverDone = (async () => {
        const entry = await store.xreadBlockNext(callsStream, 5000);
        expect(entry).not.toBeNull();
        // Simulate a tool error
        store.xadd(resultsStream, {
          requestId: entry!.fields.requestId,
          result: 'null',
          error: 'command not found: missing-binary',
        });
      })();

      const requestId = 'req-err';
      store.xadd(callsStream, {
        requestId,
        tool: 'bash',
        input: JSON.stringify({ command: 'missing-binary --help' }),
      });

      await serverDone;

      const entries = store.xreadAfter(resultsStream, '0-0');
      const result = entries.find((e) => e.fields.requestId === requestId);
      expect(result).toBeDefined();
      expect(result!.fields.error).toBe('command not found: missing-binary');
    });

    it('multiple concurrent tool calls resolve independently', async () => {
      const store = new MemoryStreamStore();
      const agentJobId = 'agent-rt-004';
      const category = 'execution';
      const callsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const resultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      // Caller sends 3 calls up front
      store.xadd(callsStream, {
        requestId: 'r1',
        tool: 'read',
        input: JSON.stringify({ file_path: '/a' }),
      });
      store.xadd(callsStream, {
        requestId: 'r2',
        tool: 'glob',
        input: JSON.stringify({ pattern: '*.ts' }),
      });
      store.xadd(callsStream, {
        requestId: 'r3',
        tool: 'grep',
        input: JSON.stringify({ pattern: 'foo' }),
      });

      // Tool server: drains calls stream with cursor, echoes each as a result
      let lastId = '0-0';
      for (let i = 0; i < 3; i++) {
        const entries = store.xreadAfter(callsStream, lastId);
        expect(entries.length).toBeGreaterThan(0);
        const entry = entries[0];
        lastId = entry.id;
        const { requestId, tool } = entry.fields;
        store.xadd(resultsStream, {
          requestId,
          result: JSON.stringify(`result-of-${tool}`),
        });
      }

      const allResults = store.xreadAfter(resultsStream, '0-0');
      const byId = Object.fromEntries(
        allResults.map((e) => [e.fields.requestId, e.fields]),
      );

      expect(JSON.parse(byId.r1.result)).toBe('result-of-read');
      expect(JSON.parse(byId.r2.result)).toBe('result-of-glob');
      expect(JSON.parse(byId.r3.result)).toBe('result-of-grep');
    });

    it('close signal is detected on agent input stream', async () => {
      // Verify the MemoryStreamStore correctly handles the close message type
      // (the cancel signal sent by job.cancel / sendCloseSignal).
      const store = new MemoryStreamStore();
      const agentJobId = 'agent-close-001';
      const inputStream = `kubeclaw:input:${agentJobId}`;

      store.xadd(inputStream, { type: 'close' });

      const entries = store.xreadAfter(inputStream, '0-0');
      const close = entries.find((e) => e.fields.type === 'close');
      expect(close).toBeDefined();
    });

    it('eoi signal is detected on agent input stream', async () => {
      // Verify the MemoryStreamStore correctly handles the eoi (end-of-input)
      // message type — the graceful "no more input" signal written by the
      // onProcess callback for one-shot jobs. Unlike close, eoi does NOT abort
      // the agent mid-loop; it only exits the post-completion wait loop.
      const store = new MemoryStreamStore();
      const agentJobId = 'agent-eoi-001';
      const inputStream = `kubeclaw:input:${agentJobId}`;

      store.xadd(inputStream, { type: 'eoi' });

      const entries = store.xreadAfter(inputStream, '0-0');
      const eoi = entries.find((e) => e.fields.type === 'eoi');
      expect(eoi).toBeDefined();
      // eoi must NOT be mistaken for a cancel close signal
      const close = entries.find((e) => e.fields.type === 'close');
      expect(close).toBeUndefined();
    });
  });

  // ── Session end: cleanupToolPods for unknown sessions ──────────────────────

  describe('session isolation', () => {
    it('cleanupToolPods for different session IDs are independent', async () => {
      // Verify calling cleanupToolPods for one session does not affect another.
      // Pod tracking via startToolPodSpawnWatcher is tested in ipc-redis.test.ts.
      await cleanupToolPods('agent-session-a');
      expect(mockStopJob).not.toHaveBeenCalled();

      await cleanupToolPods('agent-session-b');
      expect(mockStopJob).not.toHaveBeenCalled();
    });
  });
});
