/**
 * Browser CDP Bridge Integration Tests
 *
 * Proves that the compiled cdp-bridge mode of tool-server.js connects to a
 * REAL chromium (chromedp/headless-shell) over CDP, drives page actions
 * (navigate / snapshot / click / type), and maintains a SINGLE persistent
 * Browser/Page across multiple sequential tool calls.
 *
 * Infrastructure: chromedp/headless-shell is started as a local docker
 * container on a dynamic host port, and the compiled bridge is spawned as a
 * subprocess.  No Kubernetes required.
 *
 * Skip gate: if docker is unavailable the entire suite is skipped cleanly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, ChildProcess } from 'child_process';
import { createServer, AddressInfo } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getSharedRedis, getRedisUrlForTests } from './setup.js';

const AGENT_RUNNER_DIR = path.resolve(process.cwd(), 'container/agent-runner');
const TOOL_SERVER_BIN = path.resolve(AGENT_RUNNER_DIR, 'dist/tool-server.js');

// ---------------------------------------------------------------------------
// Docker availability check (synchronous, runs at module load)
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
  try {
    execSync('docker version', { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = isDockerAvailable();

// ---------------------------------------------------------------------------
// Ensure container/agent-runner is built before any test in this file runs.
// Mirrors the identical bootstrap in sidecar-tool-pod.test.ts so this suite
// is self-sufficient regardless of run order.
// ---------------------------------------------------------------------------

function ensureToolServerBuilt(): void {
  const installComplete = path.join(AGENT_RUNNER_DIR, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(installComplete)) {
    console.log('[browser-cdp] node_modules/.package-lock.json missing — running npm install in container/agent-runner ...');
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
// Runs once before any test in this file — independent of docker availability.
beforeAll(() => {
  ensureToolServerBuilt();
}, 180_000);

// ---------------------------------------------------------------------------
// Helpers shared with sidecar-tool-pod.test.ts (duplicated for file isolation)
// ---------------------------------------------------------------------------

async function waitForToolResult(
  agentJobId: string,
  toolName: string,
  requestId: string,
  timeoutMs = 30_000,
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

/** Reserve a free ephemeral port by briefly binding and releasing. */
async function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Poll an HTTP URL until it returns HTTP 200 (or until deadline).
 * Returns true on success, false on timeout.
 */
async function waitForHttp200(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Browser CDP Bridge — cdp-bridge mode against real chromedp/headless-shell', () => {
  // Unique per-run identifiers
  const agentJobId = `e2e-cdp-${Date.now()}`;
  const toolName = 'browser';

  let chromiumContainerId: string | null = null;
  let chromiumHostPort: number;
  let bridgeProc: ChildProcess | null = null;

  // -------------------------------------------------------------------------
  // beforeAll: docker pull + run + bridge spawn
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    if (!DOCKER_AVAILABLE) return; // will be skipped in tests

    // Reserve a dynamic host port for chromium CDP
    chromiumHostPort = await reserveEphemeralPort();

    // Start chromedp/headless-shell (pull is implicit; docker will use cached
    // image if already present and fall back to the registry on first run).
    let containerId: string;
    try {
      containerId = execSync(
        `docker run -d --rm -p ${chromiumHostPort}:9222 chromedp/headless-shell:latest`,
        { stdio: 'pipe', timeout: 120_000 },
      )
        .toString()
        .trim();
    } catch (err) {
      console.warn('[browser-cdp] docker run failed:', err instanceof Error ? err.message : String(err));
      // Signal to tests that docker setup failed (skip gate checks DOCKER_AVAILABLE only)
      return;
    }
    chromiumContainerId = containerId;
    console.log(`[browser-cdp] chromedp container started: ${chromiumContainerId} → port ${chromiumHostPort}`);

    // Wait for chromium to be ready (up to 30s)
    const cdpVersionUrl = `http://localhost:${chromiumHostPort}/json/version`;
    const ready = await waitForHttp200(cdpVersionUrl, 30_000);
    if (!ready) {
      console.warn('[browser-cdp] chromium CDP endpoint did not become ready within 30s');
      // Clean up and bail; tests will fail gracefully (result assertions skipped)
      execSync(`docker rm -f ${chromiumContainerId}`, { stdio: 'pipe' });
      chromiumContainerId = null;
      return;
    }
    console.log('[browser-cdp] chromium ready');

    // Spawn the compiled bridge in cdp-bridge mode
    bridgeProc = spawn('node', [TOOL_SERVER_BIN], {
      env: {
        ...process.env,
        KUBECLAW_TOOL_JOB_ID: agentJobId,
        KUBECLAW_CATEGORY: toolName,
        KUBECLAW_TOOL_MODE: 'cdp-bridge',
        KUBECLAW_CDP_URL: `http://localhost:${chromiumHostPort}`,
        IDLE_TIMEOUT: '120000',
        REDIS_URL: getRedisUrlForTests(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    bridgeProc.stdout?.on('data', (d: Buffer) => process.stderr.write(`[bridge stdout] ${d}`));
    bridgeProc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[bridge] ${d}`));

    // Give the bridge a moment to connect to Redis and chromium
    await new Promise((r) => setTimeout(r, 1500));
  }, 180_000);

  // -------------------------------------------------------------------------
  // afterAll: kill bridge + remove container + clean Redis
  // -------------------------------------------------------------------------

  afterAll(async () => {
    bridgeProc?.kill();
    bridgeProc = null;

    if (chromiumContainerId) {
      try {
        execSync(`docker rm -f ${chromiumContainerId}`, { stdio: 'pipe', timeout: 15_000 });
        console.log(`[browser-cdp] container ${chromiumContainerId} removed`);
      } catch (err) {
        console.warn('[browser-cdp] docker rm failed:', err instanceof Error ? err.message : String(err));
      }
      chromiumContainerId = null;
    }

    await cleanupStreams(agentJobId, toolName);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 1: navigate to a self-contained data URL
  // -------------------------------------------------------------------------

  it('navigate: goes to a data URL and returns the URL in the result', async (ctx) => {
    if (!DOCKER_AVAILABLE || !chromiumContainerId) { ctx.skip(); return; }

    const redis = getSharedRedis();
    if (!redis) {
      console.warn('[browser-cdp] Redis not available — skipping');
      return;
    }

    const requestId = `req-nav-${Date.now()}`;
    // A self-contained page with a clickable button; clicking it sets the title
    const dataUrl = "data:text/html,<button data-x onclick=\"document.title='clicked'\">Login</button>";

    await pushToolCall(agentJobId, toolName, requestId, toolName, {
      action: 'navigate',
      url: dataUrl,
    });

    const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 30_000);

    expect(error).toBeNull();
    expect(result).not.toBeNull();
    // The result is JSON.stringify'd by the bridge main loop; parse once to get the string
    const text = JSON.parse(result!) as string;
    // navigate returns `Navigated to <url> — "<title>"`
    expect(text).toMatch(/Navigated to/);
  }, 45_000);

  // -------------------------------------------------------------------------
  // Test 2: snapshot → ref injection + button text visible
  // -------------------------------------------------------------------------

  it('snapshot: returns [e1] ref and "Login" text after navigate', async (ctx) => {
    if (!DOCKER_AVAILABLE || !chromiumContainerId) { ctx.skip(); return; }

    const redis = getSharedRedis();
    if (!redis) {
      console.warn('[browser-cdp] Redis not available — skipping');
      return;
    }

    const requestId = `req-snap-${Date.now()}`;

    await pushToolCall(agentJobId, toolName, requestId, toolName, {
      action: 'snapshot',
    });

    const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 30_000);

    expect(error).toBeNull();
    expect(result).not.toBeNull();
    const text = JSON.parse(result!) as string;
    // SNAPSHOT_FN assigns data-kc-ref="e1" to the first visible interactive element
    expect(text).toContain('[e1]');
    // The button's text content "Login" must appear
    expect(text).toContain('Login');
  }, 45_000);

  // -------------------------------------------------------------------------
  // Test 3: click the button using the [e1] ref
  // -------------------------------------------------------------------------

  it('click: clicking [e1] returns no error', async (ctx) => {
    if (!DOCKER_AVAILABLE || !chromiumContainerId) { ctx.skip(); return; }

    const redis = getSharedRedis();
    if (!redis) {
      console.warn('[browser-cdp] Redis not available — skipping');
      return;
    }

    const requestId = `req-click-${Date.now()}`;

    await pushToolCall(agentJobId, toolName, requestId, toolName, {
      action: 'click',
      ref: 'e1',
    });

    const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 30_000);

    expect(error).toBeNull();
    expect(result).not.toBeNull();
    const text = JSON.parse(result!) as string;
    expect(text).toContain('Clicked e1');
  }, 45_000);

  // -------------------------------------------------------------------------
  // Test 4: statefulness — snapshot after click sees the updated page title
  //
  // When the Login button was clicked, the page set document.title='clicked'.
  // A subsequent snapshot on the SAME persistent page must show "Title: clicked".
  // This proves state persists across separate tool calls via the single
  // cdpBrowser/cdpPage held in tool-server module scope.
  // -------------------------------------------------------------------------

  it('statefulness: snapshot after click shows updated title "clicked"', async (ctx) => {
    if (!DOCKER_AVAILABLE || !chromiumContainerId) { ctx.skip(); return; }

    const redis = getSharedRedis();
    if (!redis) {
      console.warn('[browser-cdp] Redis not available — skipping');
      return;
    }

    // Brief wait to let the onclick handler settle (title change is synchronous
    // but CDP evaluation is async; 200ms is generous)
    await new Promise((r) => setTimeout(r, 200));

    const requestId = `req-snap2-${Date.now()}`;

    await pushToolCall(agentJobId, toolName, requestId, toolName, {
      action: 'snapshot',
    });

    const { result, error } = await waitForToolResult(agentJobId, toolName, requestId, 30_000);

    expect(error).toBeNull();
    expect(result).not.toBeNull();
    const text = JSON.parse(result!) as string;
    // executeToolBridgeCdp's snapshot includes "Title: <page title>"
    // The onclick handler set document.title = 'clicked'
    expect(text).toContain('Title: clicked');
  }, 45_000);

  // -------------------------------------------------------------------------
  // Test 5: type into an input on a new page (cross-call state via type)
  //
  // Navigate to a new data URL with an <input>, take a snapshot (get ref),
  // type into the input, then snapshot again and confirm the value persists.
  // -------------------------------------------------------------------------

  it('type + statefulness: typed text persists in visible text across calls', async (ctx) => {
    if (!DOCKER_AVAILABLE || !chromiumContainerId) { ctx.skip(); return; }

    const redis = getSharedRedis();
    if (!redis) {
      console.warn('[browser-cdp] Redis not available — skipping');
      return;
    }

    // Navigate to a page with a text input and a div that mirrors the value
    const inputUrl =
      "data:text/html,<input id='q' oninput=\"document.getElementById('out').textContent=this.value\"><div id='out'></div>";

    const navReq = `req-nav2-${Date.now()}`;
    await pushToolCall(agentJobId, toolName, navReq, toolName, {
      action: 'navigate',
      url: inputUrl,
    });
    const navOut = await waitForToolResult(agentJobId, toolName, navReq, 30_000);
    expect(navOut.error).toBeNull();

    // Snapshot to get the input's ref
    const snap1Req = `req-snap3-${Date.now()}`;
    await pushToolCall(agentJobId, toolName, snap1Req, toolName, {
      action: 'snapshot',
    });
    const snap1Out = await waitForToolResult(agentJobId, toolName, snap1Req, 30_000);
    expect(snap1Out.error).toBeNull();
    const snap1Text = JSON.parse(snap1Out.result!) as string;
    // The <input> must have a ref assigned
    expect(snap1Text).toContain('[e1]');

    // Type "hello" into the input ref
    const typeReq = `req-type-${Date.now()}`;
    await pushToolCall(agentJobId, toolName, typeReq, toolName, {
      action: 'type',
      ref: 'e1',
      text: 'hello',
    });
    const typeOut = await waitForToolResult(agentJobId, toolName, typeReq, 30_000);
    expect(typeOut.error).toBeNull();

    // Snapshot again — the mirror div's text "hello" must appear, proving the
    // same page is still in scope (statefulness across calls)
    const snap2Req = `req-snap4-${Date.now()}`;
    await pushToolCall(agentJobId, toolName, snap2Req, toolName, {
      action: 'snapshot',
    });
    const snap2Out = await waitForToolResult(agentJobId, toolName, snap2Req, 30_000);
    expect(snap2Out.error).toBeNull();
    const snap2Text = JSON.parse(snap2Out.result!) as string;
    // The mirrored value "hello" must appear in the visible text section
    expect(snap2Text).toContain('hello');
  }, 90_000);
});
