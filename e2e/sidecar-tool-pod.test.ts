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
import { spawn, execSync, ChildProcess } from 'child_process';
import { createServer, IncomingMessage, ServerResponse, Server, AddressInfo } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSharedRedis, getRedisUrlForTests } from './setup.js';

const AGENT_RUNNER_DIR = path.resolve(process.cwd(), 'container/agent-runner');

const TOOL_SERVER_BIN = path.resolve(
  AGENT_RUNNER_DIR,
  'dist/tool-server.js',
);

/**
 * Ensure container/agent-runner is built before any test in this file runs.
 * Runs npm install only when node_modules/.package-lock.json is absent (written
 * by npm only on successful install completion, so partial installs are detected).
 * Always runs tsc build — it is fast (~1s when up-to-date) and avoids silently
 * running tests against stale output when src/ has changed.
 * Throws with a clear message if the expected output is still missing after build.
 */
function ensureToolServerBuilt(): void {
  const installComplete = path.join(AGENT_RUNNER_DIR, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(installComplete)) {
    console.log('[sidecar-tool-pod] node_modules/.package-lock.json missing — running npm install in container/agent-runner ...');
    execSync('npm install', { cwd: AGENT_RUNNER_DIR, stdio: 'inherit', timeout: 120_000 });
  }

  // Always build — tsc is fast (~1s when up-to-date) and the alternative
  // is silently running against stale output if src/ changed.
  execSync('npm run build', { cwd: AGENT_RUNNER_DIR, stdio: 'inherit', timeout: 120_000 });

  if (!fs.existsSync(TOOL_SERVER_BIN)) {
    throw new Error(
      `container/agent-runner build did not produce ${TOOL_SERVER_BIN}. Run \`cd container/agent-runner && npm install && npm run build\` manually.`,
    );
  }
}

// Bootstrap: install deps if needed, always build container/agent-runner.
// Runs once before any test in this file.
beforeAll(() => {
  ensureToolServerBuilt();
}, 180_000);

// ---- Regression: tool-server binary must exist on disk ----------------------

describe('Sidecar Tool Pod — build artifact', () => {
  it('dist/tool-server.js exists after beforeAll bootstrap', () => {
    expect(fs.existsSync(TOOL_SERVER_BIN)).toBe(true);
  });
});

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
async function cleanupStreams(agentJobId: string, toolName: string): Promise<void> {
  const redis = getSharedRedis();
  if (!redis) return;
  try {
    await redis.del(
      `kubeclaw:toolcalls:${agentJobId}:${toolName}`,
      `kubeclaw:toolresults:${agentJobId}:${toolName}`,
    );
  } catch {
    /* best-effort */
  }
}

// Reserve an ephemeral port by briefly binding to 0 and capturing the assigned port.
// Accepts the tiny theoretical reuse race — acceptable in single-process CI.
async function reserveEphemeralPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
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
      await cleanupStreams(agentJobId, toolName);
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
      await cleanupStreams(agentJobId, toolName);
      await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    }
  }, 20000);
});

// ---- Readiness gate tests ---------------------------------------------------

describe('Sidecar Tool Pod — readiness gate', () => {
  let bridge: ChildProcess | null = null;
  let server: Server | null = null;

  afterAll(async () => {
    bridge?.kill();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it('waits for a slow-starting user container instead of failing', async () => {
    const agentJobId = `ready-test-${Date.now()}`;
    const toolName = 'slowtool';
    const port = await reserveEphemeralPort();
    const redis = getSharedRedis();
    if (!redis) throw new Error('Redis not available');

    // Write the tool call BEFORE the server exists (mirrors pod startup race)
    const requestId = `req-${Date.now()}`;
    await redis.xadd(
      `kubeclaw:toolcalls:${agentJobId}:${toolName}`,
      '*',
      'requestId', requestId,
      'tool', toolName,
      'input', JSON.stringify({ q: 'hello' }),
    );

    bridge = spawn('node', [TOOL_SERVER_BIN], {
      env: {
        ...process.env,
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'http-bridge',
        KUBECLAW_TOOL_PORT: String(port),
        REDIS_URL: getRedisUrlForTests(),
        IDLE_TIMEOUT: '20000',
        KUBECLAW_TOOL_READY_TIMEOUT: '10000',
        KUBECLAW_TOOL_READY_INTERVAL_MS: '200',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    try {
      // Start the "user container" only after 2s
      await new Promise((r) => setTimeout(r, 2000));
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'late but ready' }));
      });
      await new Promise<void>((r) => server!.listen(port, r));

      const out = await waitForToolResult(agentJobId, toolName, requestId, 15000);
      expect(out.error).toBeNull();
      expect(out.result).toContain('late but ready');
    } finally {
      await cleanupStreams(agentJobId, toolName);
    }
  }, 30_000);
});

// ---- Retry discipline tests --------------------------------------------------

describe('Sidecar Tool Pod — retry discipline', () => {
  let bridge: ChildProcess | null = null;
  let server: Server | null = null;
  let hits = 0;

  afterAll(async () => {
    bridge?.kill();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it('retries 5xx then succeeds; fails fast on 4xx', async () => {
    hits = 0;
    const agentJobId = `retry-test-${Date.now()}`;
    const toolName = 'flakytool';
    const redis = getSharedRedis();
    if (!redis) throw new Error('Redis not available');

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // The bridge probes readiness with GET / — skip hit counting and body
      // parsing for non-POST requests so the hit counter stays clean.
      if (req.method !== 'POST') {
        res.writeHead(200).end('ok');
        return;
      }
      hits++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { input } = JSON.parse(body);
        if (input.mode === 'flaky' && hits <= 2) {
          res.writeHead(500).end('transient');
        } else if (input.mode === 'badrequest') {
          res.writeHead(400).end('nope');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result: `ok after ${hits} hits` }));
        }
      });
    });
    const port: number = await new Promise((resolve) => {
      server!.listen(0, () => resolve((server!.address() as AddressInfo).port));
    });

    bridge = spawn('node', [TOOL_SERVER_BIN], {
      env: {
        ...process.env,
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'http-bridge',
        KUBECLAW_TOOL_PORT: String(port),
        REDIS_URL: getRedisUrlForTests(),
        IDLE_TIMEOUT: '30000',
        KUBECLAW_TOOL_RETRY_BASE_MS: '100',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    try {
      // 5xx twice → third attempt succeeds
      const flakyReq = `req-flaky-${Date.now()}`;
      await redis.xadd(
        `kubeclaw:toolcalls:${agentJobId}:${toolName}`, '*',
        'requestId', flakyReq, 'tool', toolName,
        'input', JSON.stringify({ mode: 'flaky' }),
      );
      const flakyOut = await waitForToolResult(agentJobId, toolName, flakyReq, 15000);
      expect(flakyOut.error).toBeNull();
      expect(flakyOut.result).toContain('ok after 3 hits');

      // 4xx → exactly one additional hit, error result
      const hitsBefore = hits;
      const badReq = `req-bad-${Date.now()}`;
      await redis.xadd(
        `kubeclaw:toolcalls:${agentJobId}:${toolName}`, '*',
        'requestId', badReq, 'tool', toolName,
        'input', JSON.stringify({ mode: 'badrequest' }),
      );
      const badOut = await waitForToolResult(agentJobId, toolName, badReq, 15000);
      expect(badOut.error).toContain('Tool HTTP 400');
      expect(hits).toBe(hitsBefore + 1);
    } finally {
      await cleanupStreams(agentJobId, toolName);
    }
  }, 40_000);
});

// ---- File bridge tests (jq-free per-field protocol) -------------------------
//
// These tests replaced the old request.json/response.json protocol tests.
// The old "file-bridge mode" describe block used startFileUserTool() which
// polled for *.request.json files and wrote *.response.json — that was the
// pre-migration protocol. It is fully removed here.
//
// The new protocol (per-field file bridge):
//   Bridge writes /shared/req/{id}/input/<field> (one file per declared field),
//   atomically renames the temp req dir into /shared/req/{id}, then polls
//   /shared/resp/{id} for response/stderr/exit_code files.
//   The wrapper watches /shared/req/*/, exports INPUT_DIR=$d/input, runs
//   KUBECLAW_TOOL_RUN in WORKDIR, and writes the response atomically.

describe('Sidecar Tool Pod — file-bridge mode (jq-free per-field protocol)', () => {
  let sharedDir: string;
  let wrapperScriptPath: string;
  let toolServerProc: ChildProcess | null = null;
  let wrapperProc: ChildProcess | null = null;

  /**
   * Read the canonical wrapper script from k8s/35-configmaps.yaml and write
   * a copy with the only modification being the shared-dir root rewritten from
   * S=/shared to S=<tempShared>. The protocol logic (INPUT_DIR, KUBECLAW_TOOL_RUN,
   * mktemp, mv "$t") is identical to what runs in production.
   */
  function prepareWrapperScript(tempShared: string): string {
    const configmapsPath = path.resolve(process.cwd(), 'k8s/35-configmaps.yaml');
    const yaml = fs.readFileSync(configmapsPath, 'utf-8');

    // Extract the script body: everything after "tool-wrapper.sh: |" up to
    // the next top-level YAML key or end of file. Each line of the block
    // scalar is indented by 4 spaces.
    const blockStart = yaml.indexOf('  tool-wrapper.sh: |\n');
    if (blockStart === -1) throw new Error('tool-wrapper.sh block not found in k8s/35-configmaps.yaml');
    const afterMarker = yaml.slice(blockStart + '  tool-wrapper.sh: |\n'.length);

    // Collect indented lines (4-space indent for the ConfigMap block scalar)
    const lines: string[] = [];
    for (const line of afterMarker.split('\n')) {
      if (line.startsWith('    ') || line === '') {
        lines.push(line.startsWith('    ') ? line.slice(4) : '');
      } else {
        break; // end of block scalar
      }
    }
    const scriptBody = lines.join('\n');

    // Sanity-check: assert key protocol lines are present so a future refactor
    // of the wrapper doesn't silently make this test meaningless.
    expect(scriptBody).toContain('INPUT_DIR');
    expect(scriptBody).toContain('KUBECLAW_TOOL_RUN');
    expect(scriptBody).toContain('mktemp');
    expect(scriptBody).toContain('mv "$t"');

    // The ONLY modification: rewrite the shared-dir root from the hardcoded
    // /shared to the test's temp dir. This is a path concern (the production
    // script targets the in-pod /shared mount); all protocol logic is unchanged.
    const modified = scriptBody.replace('S=/shared', `S=${tempShared}`);

    const scriptFile = path.join(tempShared, 'tool-wrapper.sh');
    fs.writeFileSync(scriptFile, modified, { mode: 0o755 });
    return scriptFile;
  }

  /** Spawn the wrapper script as a background sh process. */
  function spawnWrapper(
    scriptPath: string,
    workdir: string,
    toolRun: string,
    pollInterval = '1',
  ): ChildProcess {
    return spawn('sh', [scriptPath], {
      env: {
        ...process.env,
        WORKDIR: workdir,
        KUBECLAW_TOOL_RUN: toolRun,
        KUBECLAW_POLL_INTERVAL: pollInterval,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  beforeAll(() => {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-fb-e2e-'));
    wrapperScriptPath = prepareWrapperScript(sharedDir);
  });

  afterAll(() => {
    toolServerProc?.kill();
    wrapperProc?.kill();
    fs.rmSync(sharedDir, { recursive: true, force: true });
  });

  it('scratch bash: echo hello via command field → result is "hello\\n"', async () => {
    const redis = getSharedRedis();
    if (!redis) {
      console.warn('Redis not available — skipping file-bridge test');
      return;
    }

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-fb-scratch-'));
    const agentJobId = `e2e-fb-hello-${Date.now()}`;
    const toolName = 'bash_tool';
    const requestId = `req-fb-hello-${Date.now()}`;

    // KUBECLAW_TOOL_RUN reads the command from the INPUT_DIR/command file and
    // executes it via sh. The wrapper sets INPUT_DIR before running TOOL_RUN.
    const toolRun = 'sh -c "$(cat "$INPUT_DIR/command")"';

    try {
      await pushToolCall(agentJobId, toolName, requestId, toolName, { command: 'echo hello' });

      toolServerProc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'file-bridge',
        KUBECLAW_SHARED_DIR: sharedDir,
        KUBECLAW_TOOL_FIELDS: 'command',
        IDLE_TIMEOUT: '15000',
        REDIS_URL: getRedisUrlForTests(),
      });

      wrapperProc = spawnWrapper(wrapperScriptPath, scratchDir, toolRun);

      const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 15000);

      expect(error).toBeNull();
      expect(result).not.toBeNull();
      // result is JSON.stringified by the main loop; parse once to get the raw stdout string.
      // The wrapper preserves the trailing newline from echo.
      expect(JSON.parse(result!)).toBe('hello\n');
    } finally {
      toolServerProc?.kill();
      toolServerProc = null;
      wrapperProc?.kill();
      wrapperProc = null;
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await cleanupStreams(agentJobId, toolName);
    }
  }, 25000);

  it('non-zero exit: "exit 3" → error contains "exit 3"', async () => {
    const redis = getSharedRedis();
    if (!redis) {
      console.warn('Redis not available — skipping file-bridge test');
      return;
    }

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-fb-exit-'));
    const agentJobId = `e2e-fb-exit-${Date.now()}`;
    const toolName = 'exit_tool';
    const requestId = `req-fb-exit-${Date.now()}`;
    const toolRun = 'sh -c "$(cat "$INPUT_DIR/command")"';

    try {
      await pushToolCall(agentJobId, toolName, requestId, toolName, { command: 'exit 3' });

      toolServerProc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'file-bridge',
        KUBECLAW_SHARED_DIR: sharedDir,
        KUBECLAW_TOOL_FIELDS: 'command',
        IDLE_TIMEOUT: '15000',
        REDIS_URL: getRedisUrlForTests(),
      });

      wrapperProc = spawnWrapper(wrapperScriptPath, scratchDir, toolRun);

      const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 15000);

      // Bridge converts non-zero exit to an error: "exit {code}: {stderr}"
      expect(error).not.toBeNull();
      expect(error).toContain('exit 3');
    } finally {
      toolServerProc?.kill();
      toolServerProc = null;
      wrapperProc?.kill();
      wrapperProc = null;
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await cleanupStreams(agentJobId, toolName);
    }
  }, 25000);

  it('persistence semantics: write file then read it back via same WORKDIR', async () => {
    const redis = getSharedRedis();
    if (!redis) {
      console.warn('Redis not available — skipping file-bridge test');
      return;
    }

    // Use a dedicated shared dir for this test to avoid collisions with parallel tests.
    const testSharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-fb-persist-'));
    const persistScriptPath = prepareWrapperScript(testSharedDir);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-fb-workdir-'));
    const agentJobId = `e2e-fb-persist-${Date.now()}`;
    const toolName = 'persist_tool';
    const toolRun = 'sh -c "$(cat "$INPUT_DIR/command")"';

    const req1 = `req-fb-write-${Date.now()}`;
    const req2 = `req-fb-read-${Date.now()}`;

    let localToolServer: ChildProcess | null = null;
    let localWrapper: ChildProcess | null = null;

    try {
      // Call 1: write a file into WORKDIR
      await pushToolCall(agentJobId, toolName, req1, toolName, { command: 'echo data > f.txt' });

      localToolServer = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'file-bridge',
        KUBECLAW_SHARED_DIR: testSharedDir,
        KUBECLAW_TOOL_FIELDS: 'command',
        IDLE_TIMEOUT: '30000',
        REDIS_URL: getRedisUrlForTests(),
      });

      localWrapper = spawnWrapper(persistScriptPath, workDir, toolRun);

      const write = await waitForToolResult(agentJobId, toolName, req1, 15000);
      expect(write.error).toBeNull();

      // Call 2: read back the file — must see the data written by call 1.
      // Same bridge and wrapper are still running (same WORKDIR = same "group PVC").
      await pushToolCall(agentJobId, toolName, req2, toolName, { command: 'cat f.txt' });

      const read = await waitForToolResult(agentJobId, toolName, req2, 15000);
      expect(read.error).toBeNull();
      expect(read.result).not.toBeNull();
      // echo data > f.txt writes "data\n"; cat f.txt reproduces it.
      expect(JSON.parse(read.result!)).toBe('data\n');
    } finally {
      localToolServer?.kill();
      localWrapper?.kill();
      fs.rmSync(testSharedDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
      await cleanupStreams(agentJobId, toolName);
    }
  }, 40000);

  it('declared-fields guard: undeclared field is not written to input dir', async () => {
    const redis = getSharedRedis();
    if (!redis) {
      console.warn('Redis not available — skipping file-bridge test');
      return;
    }

    // Strategy: drive the bridge only (no wrapper running) to atomically publish the req
    // dir, then inspect its input/ directory before the wrapper could consume it.
    // We achieve determinism by NOT starting the wrapper during the inspection window,
    // then manually writing a synthetic response so the bridge can complete.
    const testSharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-fb-fields-'));
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-fb-fields-work-'));
    const agentJobId = `e2e-fb-fields-${Date.now()}`;
    const toolName = 'fields_tool';
    const requestId = `req-fb-fields-${Date.now()}`;

    let localToolServer: ChildProcess | null = null;

    try {
      // Push a call that includes an undeclared field ("evil") alongside the
      // declared "command" field. KUBECLAW_TOOL_FIELDS=command means the bridge
      // must write only the "command" file into input/.
      await pushToolCall(agentJobId, toolName, requestId, toolName, {
        command: 'echo x',
        evil: 'y',  // undeclared — must NOT appear as a file
      });

      localToolServer = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'file-bridge',
        KUBECLAW_SHARED_DIR: testSharedDir,
        KUBECLAW_TOOL_FIELDS: 'command',  // only "command" is declared
        IDLE_TIMEOUT: '15000',
        REDIS_URL: getRedisUrlForTests(),
      });

      // Poll until the bridge has published /shared/req/{requestId}/input/
      const reqInputDir = path.join(testSharedDir, 'req', requestId, 'input');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(reqInputDir) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!fs.existsSync(reqInputDir)) {
        throw new Error(`Bridge did not publish req dir at ${reqInputDir} within 10s`);
      }

      // Assert: only "command" file present, "evil" absent.
      const inputFiles = fs.readdirSync(reqInputDir);
      expect(inputFiles).toContain('command');
      expect(inputFiles).not.toContain('evil');

      // Manually synthesise a response so the bridge can complete cleanly
      // (prevents the bridge from hanging in the idle timer and logging errors).
      const respDir = path.join(testSharedDir, 'resp', requestId);
      const tmpResp = path.join(testSharedDir, `.resp.${requestId}.tmp`);
      fs.mkdirSync(tmpResp, { recursive: true });
      fs.writeFileSync(path.join(tmpResp, 'response'), 'x\n');
      fs.writeFileSync(path.join(tmpResp, 'stderr'), '');
      fs.writeFileSync(path.join(tmpResp, 'exit_code'), '0');
      fs.mkdirSync(path.join(testSharedDir, 'resp'), { recursive: true });
      fs.renameSync(tmpResp, respDir);
      // Also remove the req dir so the (absent) wrapper wouldn't try to process it
      fs.rmSync(path.join(testSharedDir, 'req', requestId), { recursive: true, force: true });

      // Wait for the bridge to pick up the synthetic response and publish the result
      const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 10000);
      expect(error).toBeNull();
      expect(JSON.parse(result!)).toBe('x\n');
    } finally {
      localToolServer?.kill();
      fs.rmSync(testSharedDir, { recursive: true, force: true });
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await cleanupStreams(agentJobId, toolName);
    }
  }, 25000);
});

// ---- Request-mapping integration tests --------------------------------------

describe('Sidecar Tool Pod — request mapping', () => {
  it('GET path+query: bridge sends correct URL and returns raw body', async () => {
    const redis = getSharedRedis();
    if (!redis) throw new Error('Redis not available');

    const agentJobId = `e2e-rm-get-${Date.now()}`;
    const toolName = 'weather_tool';
    const requestId = `req-rm-get-${Date.now()}`;
    let server: Server | null = null;
    let proc: ChildProcess | null = null;

    try {
      let receivedUrl: string | null = null;

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Readiness probe: any GET that isn't our mapped path — answer 200 silently
        if (req.method === 'GET' && req.url && req.url.startsWith('/weather/')) {
          receivedUrl = req.url;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"temp":21}');
        } else {
          res.writeHead(200).end('ok');
        }
      });

      const port: number = await new Promise((resolve) =>
        server!.listen(0, '127.0.0.1', () =>
          resolve((server!.address() as AddressInfo).port),
        ),
      );

      const mapping = { method: 'GET', path: '/weather/{city}', query: { units: '{units}' } };

      await pushToolCall(agentJobId, toolName, requestId, toolName, { city: 'NYC', units: 'metric' });

      proc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'http-bridge',
        KUBECLAW_TOOL_PORT: String(port),
        KUBECLAW_TOOL_REQUEST_MAPPING: JSON.stringify(mapping),
        IDLE_TIMEOUT: '10000',
        REDIS_URL: getRedisUrlForTests(),
      });

      const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 15000);

      expect(error).toBeNull();
      expect(result).not.toBeNull();

      // Assert the received URL had the correct path + query (order-independent)
      expect(receivedUrl).not.toBeNull();
      const u = new URL(`http://localhost${receivedUrl}`);
      expect(u.pathname).toBe('/weather/NYC');
      expect(u.searchParams.get('units')).toBe('metric');

      // The main loop JSON.stringifies the returned value, so result holds
      // the double-encoded string. Parse once to get the raw body string.
      expect(JSON.parse(result!)).toBe('{"temp":21}');
    } finally {
      proc?.kill();
      await cleanupStreams(agentJobId, toolName);
      await new Promise<void>((r) => (server ? server!.close(() => r()) : r()));
    }
  }, 25000);

  it('POST JSON body: numeric type preserved in body, result returned', async () => {
    const redis = getSharedRedis();
    if (!redis) throw new Error('Redis not available');

    const agentJobId = `e2e-rm-post-${Date.now()}`;
    const toolName = 'search_tool';
    const requestId = `req-rm-post-${Date.now()}`;
    let server: Server | null = null;
    let proc: ChildProcess | null = null;

    try {
      let bodyAssertionError: string | null = null;

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'POST' && req.url === '/q') {
          let raw = '';
          req.on('data', (chunk) => (raw += chunk));
          req.on('end', () => {
            try {
              const body = JSON.parse(raw) as { count: unknown; q: unknown };
              if (typeof body.count !== 'number' || body.count !== 3) {
                bodyAssertionError = `expected count to be number 3, got ${typeof body.count} ${body.count}`;
              }
              if (body.q !== 'rain') {
                bodyAssertionError = `expected q to be "rain", got ${body.q}`;
              }
            } catch (err) {
              bodyAssertionError = `JSON parse error: ${err}`;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          });
        } else {
          // Readiness probe or any other request
          res.writeHead(200).end('ok');
        }
      });

      const port: number = await new Promise((resolve) =>
        server!.listen(0, '127.0.0.1', () =>
          resolve((server!.address() as AddressInfo).port),
        ),
      );

      const mapping = { method: 'POST', path: '/q', body: { count: '{count}', q: '{query}' } };

      await pushToolCall(agentJobId, toolName, requestId, toolName, { count: 3, query: 'rain' });

      proc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'http-bridge',
        KUBECLAW_TOOL_PORT: String(port),
        KUBECLAW_TOOL_REQUEST_MAPPING: JSON.stringify(mapping),
        IDLE_TIMEOUT: '10000',
        REDIS_URL: getRedisUrlForTests(),
      });

      const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 15000);

      expect(error).toBeNull();
      expect(bodyAssertionError).toBeNull();
      expect(result).not.toBeNull();
      // The main loop JSON.stringifies the returned value; parse twice to get
      // the actual object (first parse → raw body string; second → object).
      const rawBody = JSON.parse(result!) as string;
      const parsed = JSON.parse(rawBody) as { ok: boolean };
      expect(parsed.ok).toBe(true);
    } finally {
      proc?.kill();
      await cleanupStreams(agentJobId, toolName);
      await new Promise<void>((r) => (server ? server!.close(() => r()) : r()));
    }
  }, 25000);

  it('responsePath: extracts nested field from JSON response', async () => {
    const redis = getSharedRedis();
    if (!redis) throw new Error('Redis not available');

    const agentJobId = `e2e-rm-rp-${Date.now()}`;
    const toolName = 'weather_rp_tool';
    const requestId = `req-rm-rp-${Date.now()}`;
    let server: Server | null = null;
    let proc: ChildProcess | null = null;

    try {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET' && req.url === '/w') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"current":{"temp_c":21.5}}');
        } else {
          // Readiness probe or other requests
          res.writeHead(200).end('ok');
        }
      });

      const port: number = await new Promise((resolve) =>
        server!.listen(0, '127.0.0.1', () =>
          resolve((server!.address() as AddressInfo).port),
        ),
      );

      const mapping = { method: 'GET', path: '/w', responsePath: 'current.temp_c' };

      await pushToolCall(agentJobId, toolName, requestId, toolName, {});

      proc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'http-bridge',
        KUBECLAW_TOOL_PORT: String(port),
        KUBECLAW_TOOL_REQUEST_MAPPING: JSON.stringify(mapping),
        IDLE_TIMEOUT: '10000',
        REDIS_URL: getRedisUrlForTests(),
      });

      const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 15000);

      expect(error).toBeNull();
      expect(result).not.toBeNull();
      // extractResponsePath returns a string; result is JSON.stringified by the main loop
      // The extracted value is 21.5 (number) → JSON.stringify(21.5) → "21.5"
      expect(JSON.parse(result!)).toBe('21.5');
    } finally {
      proc?.kill();
      await cleanupStreams(agentJobId, toolName);
      await new Promise<void>((r) => (server ? server!.close(() => r()) : r()));
    }
  }, 25000);

  it('404 response: tool result carries error containing "Tool HTTP 404"', async () => {
    const redis = getSharedRedis();
    if (!redis) throw new Error('Redis not available');

    const agentJobId = `e2e-rm-404-${Date.now()}`;
    const toolName = 'missing_tool';
    const requestId = `req-rm-404-${Date.now()}`;
    let server: Server | null = null;
    let proc: ChildProcess | null = null;

    try {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET' && req.url === '/missing') {
          res.writeHead(404).end('not found');
        } else {
          // Readiness probe (GET /) — answer 200 so the bridge passes the gate
          res.writeHead(200).end('ok');
        }
      });

      const port: number = await new Promise((resolve) =>
        server!.listen(0, '127.0.0.1', () =>
          resolve((server!.address() as AddressInfo).port),
        ),
      );

      const mapping = { method: 'GET', path: '/missing' };

      await pushToolCall(agentJobId, toolName, requestId, toolName, {});

      proc = spawnToolServer({
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'http-bridge',
        KUBECLAW_TOOL_PORT: String(port),
        KUBECLAW_TOOL_REQUEST_MAPPING: JSON.stringify(mapping),
        IDLE_TIMEOUT: '10000',
        REDIS_URL: getRedisUrlForTests(),
      });

      const { error } = await waitForToolResult(agentJobId, toolName, requestId, 15000);

      expect(error).not.toBeNull();
      expect(error).toContain('Tool HTTP 404');
    } finally {
      proc?.kill();
      await cleanupStreams(agentJobId, toolName);
      await new Promise<void>((r) => (server ? server!.close(() => r()) : r()));
    }
  }, 25000);
});
