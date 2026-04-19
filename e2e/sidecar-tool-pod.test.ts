/**
 * Sidecar Tool Pod E2E Tests
 *
 * Tests the full round-trip of the sidecar tool pod bridge protocol:
 *   1. A tool call is written to kubeclaw:toolcalls:{agentJobId}:{toolName}
 *   2. tool-server.js (running in http-bridge or file-bridge mode) reads it
 *   3. It forwards the call to the user container (local HTTP server / shared dir)
 *   4. The user container responds
 *   5. The result appears in kubeclaw:toolresults:{agentJobId}:{toolName}
 *
 * No Kubernetes required — the bridge is run as a local subprocess, and the
 * "user container" is a tiny in-process server / file watcher.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSharedRedis, getRedisUrlForTests } from './setup.js';

const TOOL_SERVER_BIN = path.resolve(
  process.cwd(),
  'container/agent-runner/dist/tool-server.js',
);

// Helper: wait for a Redis stream entry matching requestId
async function waitForToolResult(
  agentJobId: string,
  toolName: string,
  requestId: string,
  timeoutMs = 15000,
): Promise<{ result: string | null; error: string | null }> {
  const redis = getSharedRedis();
  if (!redis) throw new Error('Redis not available');

  const stream = `kubeclaw:toolresults:${agentJobId}:${toolName}`;
  const deadline = Date.now() + timeoutMs;
  let lastId = '0-0';

  while (Date.now() < deadline) {
    const blockMs = Math.min(deadline - Date.now(), 2000);
    const resp = await redis.xread('COUNT', 20, 'BLOCK', blockMs, 'STREAMS', stream, lastId);
    if (!resp) continue;

    for (const [, messages] of resp as [string, [string, string[]][]][]) {
      for (const [id, fields] of messages) {
        lastId = id;
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        if (obj.requestId === requestId) {
          return {
            result: obj.result ?? null,
            error: obj.error ?? null,
          };
        }
      }
    }
  }

  throw new Error(`Timed out waiting for tool result (requestId=${requestId})`);
}

// Helper: spawn tool-server.js with given env vars
function spawnToolServer(env: Record<string, string>): ChildProcess {
  const proc = spawn('node', [TOOL_SERVER_BIN], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return proc;
}

// Helper: push a tool call onto the toolcalls stream
async function pushToolCall(
  agentJobId: string,
  toolName: string,
  requestId: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<void> {
  const redis = getSharedRedis();
  if (!redis) throw new Error('Redis not available');
  const stream = `kubeclaw:toolcalls:${agentJobId}:${toolName}`;
  await redis.xadd(stream, '*', 'requestId', requestId, 'tool', tool, 'input', JSON.stringify(input));
}

// Helper: wait for a child process to exit (with timeout)
function waitForExit(proc: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// Cleanup Redis streams after tests
async function cleanupStreams(agentJobId: string): Promise<void> {
  const redis = getSharedRedis();
  if (!redis) return;
  try {
    await redis.del(
      `kubeclaw:toolcalls:${agentJobId}:*`,
      `kubeclaw:toolresults:${agentJobId}:*`,
    );
  } catch {
    // best-effort
  }
}

// ---- HTTP bridge tests -------------------------------------------------------

describe('Sidecar Tool Pod — http-bridge mode', () => {
  let httpServer: Server;
  let httpPort: number;
  const servedRequests: Array<{ tool: string; input: unknown }> = [];
  let toolServerProc: ChildProcess | null = null;

  beforeAll(async () => {
    // Start a local "user tool" HTTP server that echoes tool invocations
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/invoke') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const { tool, input } = JSON.parse(body);
            servedRequests.push({ tool, input });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: `echo:${tool}:${JSON.stringify(input)}` }));
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'bad request' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpPort = (httpServer.address() as any).port as number;
  });

  afterAll(async () => {
    toolServerProc?.kill();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('forwards a tool call to the HTTP user container and returns the result', async () => {
    const redis = getSharedRedis();
    if (!redis) {
      console.warn('Redis not available — skipping http-bridge test');
      return;
    }

    const agentJobId = `e2e-stool-http-${Date.now()}`;
    const toolName = 'my_tool';
    const requestId = `req-${Date.now()}`;

    try {
      // Write the tool call to Redis BEFORE spawning the bridge, so it's picked
      // up with lastId='0-0' (matching tool-server.ts startup behaviour)
      await pushToolCall(agentJobId, toolName, requestId, 'my_tool', { arg: 'hello' });

      toolServerProc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'http-bridge',
        KUBECLAW_TOOL_PORT: String(httpPort),
        IDLE_TIMEOUT: '10000',
        REDIS_URL: getRedisUrlForTests(),
      });

      const { result, error } = await waitForToolResult(agentJobId, toolName, requestId);

      expect(error).toBeNull();
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed).toContain('echo:my_tool:');
      expect(servedRequests.length).toBeGreaterThan(0);
      expect(servedRequests[0].tool).toBe('my_tool');
    } finally {
      toolServerProc?.kill();
      toolServerProc = null;
      await cleanupStreams(agentJobId);
    }
  }, 20000);

  it('propagates an error response from the HTTP user container', async () => {
    const redis = getSharedRedis();
    if (!redis) return;

    // Override server to return an error for this test
    const errorServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'something went wrong' }));
    });
    const errorPort: number = await new Promise((resolve) => {
      errorServer.listen(0, '127.0.0.1', () =>
        resolve((errorServer.address() as any).port));
    });

    const agentJobId = `e2e-stool-err-${Date.now()}`;
    const toolName = 'error_tool';
    const requestId = `req-err-${Date.now()}`;

    try {
      await pushToolCall(agentJobId, toolName, requestId, 'error_tool', {});

      const proc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'http-bridge',
        KUBECLAW_TOOL_PORT: String(errorPort),
        IDLE_TIMEOUT: '10000',
        REDIS_URL: getRedisUrlForTests(),
      });

      try {
        const { error } = await waitForToolResult(agentJobId, toolName, requestId);
        expect(error).toBe('something went wrong');
      } finally {
        proc.kill();
      }
    } finally {
      await cleanupStreams(agentJobId);
      await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    }
  }, 20000);
});

// ---- File bridge tests -------------------------------------------------------

describe('Sidecar Tool Pod — file-bridge mode', () => {
  let sharedDir: string;
  let watcherInterval: ReturnType<typeof setInterval> | null = null;
  let toolServerProc: ChildProcess | null = null;

  beforeAll(() => {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-stool-e2e-'));
  });

  afterAll(() => {
    if (watcherInterval) clearInterval(watcherInterval);
    toolServerProc?.kill();
    fs.rmSync(sharedDir, { recursive: true, force: true });
  });

  // Simulate the "user tool" container: polls for request files and writes responses
  function startFileUserTool(
    dir: string,
    handler: (tool: string, input: unknown) => unknown,
  ): ReturnType<typeof setInterval> {
    return setInterval(() => {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.request.json'));
        for (const file of files) {
          const reqPath = path.join(dir, file);
          const resPath = path.join(dir, file.replace('.request.json', '.response.json'));
          if (fs.existsSync(resPath)) continue; // already answered
          try {
            const req = JSON.parse(fs.readFileSync(reqPath, 'utf-8'));
            const result = handler(req.tool, req.input);
            fs.writeFileSync(resPath, JSON.stringify({ result }));
          } catch (err) {
            const req = JSON.parse(fs.readFileSync(reqPath, 'utf-8'));
            fs.writeFileSync(
              path.join(dir, file.replace('.request.json', '.response.json')),
              JSON.stringify({ error: String(err) }),
            );
          }
        }
      } catch {
        // dir may not exist yet during shutdown
      }
    }, 100);
  }

  it('forwards a tool call via shared files and returns the result', async () => {
    const redis = getSharedRedis();
    if (!redis) {
      console.warn('Redis not available — skipping file-bridge test');
      return;
    }

    const agentJobId = `e2e-stool-file-${Date.now()}`;
    const toolName = 'file_tool';
    const requestId = `req-file-${Date.now()}`;

    // Start the file-based "user tool"
    watcherInterval = startFileUserTool(sharedDir, (tool, input) => {
      return `file_echo:${tool}:${JSON.stringify(input)}`;
    });

    try {
      await pushToolCall(agentJobId, toolName, requestId, 'file_tool', { data: 'world' });

      toolServerProc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'file-bridge',
        KUBECLAW_SHARED_DIR: sharedDir,
        IDLE_TIMEOUT: '10000',
        REDIS_URL: getRedisUrlForTests(),
      });

      const { result, error } = await waitForToolResult(agentJobId, toolName, requestId);

      expect(error).toBeNull();
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed).toContain('file_echo:file_tool:');
    } finally {
      if (watcherInterval) {
        clearInterval(watcherInterval);
        watcherInterval = null;
      }
      toolServerProc?.kill();
      toolServerProc = null;
      await cleanupStreams(agentJobId);
    }
  }, 20000);
});
