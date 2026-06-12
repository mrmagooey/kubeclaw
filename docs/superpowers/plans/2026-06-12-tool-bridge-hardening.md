# Tool Bridge Hardening & Legacy Sidecar Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the four proven patterns from the legacy whole-group sidecar runners (per-job Redis ACLs, readiness checks, HTTP retry with 4xx/5xx distinction, Redis reconnect backoff) plus the zero-Dockerfile wrapper-script concept into the newer per-tool-call sidecar bridge (`tool-server.js` / `createSidecarToolPodJob`), then delete the legacy runners, adapter images, and wrapper ConfigMaps.

**Architecture:** The newer bridge is `container/agent-runner/src/tool-server.ts` running as the `kubeclaw-tool-bridge` container next to an arbitrary `user-tool` container (K8s Job built by `JobRunner.createSidecarToolPodJob` in `src/k8s/job-runner.ts:1713`). It reads tool calls from Redis stream `kubeclaw:toolcalls:{agentJobId}:{toolName}` and forwards via one of three contracts (http-bridge `POST /invoke`, file-bridge `/shared/{requestId}.request.json`, acp-bridge). Today it authenticates as the shared static `tool-server` Redis user, fires the first request with no readiness check, has no retries, and no reconnect backoff. The legacy system (`src/k8s/{http,file}-sidecar-runner.ts` + `container/{http,file}-adapter/` images + `FileSidecarToolJobRunner`/`HttpSidecarToolJobRunner` in `src/runtime/index.ts`) is turn-level conversation delegation — unreachable from interactive chat (channel pods hardcode `DirectLLMRunner` at `src/channel-runner.ts:2113`; only the task scheduler can reach it, and nothing configures `userImage`). Its per-job ACL machinery (`src/k8s/acl-manager.ts` + SQLite `job_acls` table) stays and gains a new tool-pod method.

**Tech Stack:** TypeScript (Node 20+), vitest (root `vitest.config.ts` for `src/**/*.test.ts`, `vitest.e2e.config.ts` for `e2e/`), `redis` (node-redis v4) in tool-server, `ioredis` in the orchestrator, `@kubernetes/client-node`, Helm.

**Branch:** All work happens on a feature branch — never on `main` (Task 0).

**Three-level test mapping for this plan** (per repo test policy):
- **Unit** — mocked-dependency tests in `src/**/*.test.ts`: retry/readiness/reconnect helpers, ACL rule construction, Job manifest generation.
- **Integration** — `e2e/sidecar-tool-pod.test.ts` and `e2e/sidecar-acl.test.ts`: the real compiled bridge runs as a local subprocess against real Redis (no Kubernetes). These run with `npm run test:e2e` against the local Redis from `e2e/setup.ts`.
- **End-to-end** — the existing minikube-live suite (`e2e/alpine-tool-execution.test.ts`, `e2e/tool-pod-spawn.test.ts`) exercises the full K8s path including the new manifest fields; it must pass unchanged on a cluster. No *new* minikube test is added: the new behaviors (ACL, readiness, retry, wrapper) are all observable at the integration level, and the existing live tests verify nothing regressed at the K8s level.

---

## Pre-flight notes for the implementer

- `tool-server.ts` reads env vars **at module scope**. Tests must set env via `vi.hoisted()` **before** importing the module (see existing `src/tool-server.test.ts:13-18` for the pattern).
- `tool-server.ts` calls `main()` at module bottom. Existing tests tolerate this by mocking `redis` so the main loop spins harmlessly. Follow the same pattern.
- `src/k8s/job-runner.test.ts` mocks `../config.js`, `../logger.js`, `./redis-client.js`, and `@kubernetes/client-node` (see its lines 1–120). New job-runner tests go in that file and reuse those mocks; you must ALSO add a `vi.mock('./acl-manager.js', ...)` (Task 5 below shows it).
- Root build: `npm run build`. Tool-server build: `cd container/agent-runner && npm run build` (the integration tests auto-build it in `beforeAll`).
- Run a single test file: `npx vitest run src/path/to/file.test.ts`.

---

### Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 0.1: Verify clean state and current HEAD**

```bash
cd /home/peter/projects/kubeclaw
git status --porcelain   # Expected: empty output
git rev-parse HEAD       # Note the commit — branch must be cut from live HEAD, not memory
```

- [ ] **Step 0.2: Create the branch**

```bash
git checkout -b feat/tool-bridge-hardening
```

Expected: `Switched to a new branch 'feat/tool-bridge-hardening'`

---

### Task 1: Redis reconnect backoff in the bridge

The legacy adapters reconnect with `min(2^retries × 100ms, 10s)`; tool-server currently has no reconnect strategy at all (`tool-server.ts:359-360`).

**Files:**
- Modify: `container/agent-runner/src/tool-server.ts`
- Test (create): `src/tool-server-bridge.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `src/tool-server-bridge.test.ts`:

```typescript
/**
 * Unit tests for the tool-server bridge hardening helpers:
 * reconnectStrategy, fetchWithRetry, waitForToolReady.
 *
 * tool-server.ts reads env at module scope and starts main() on import, so
 * env must be set in vi.hoisted() and redis must be mocked before import
 * (same pattern as src/tool-server.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.KUBECLAW_TOOL_JOB_ID = 'test-job-id';
  process.env.KUBECLAW_CATEGORY = 'execution';
  process.env.REDIS_URL = 'redis://localhost:6379';
  // Tiny timings so retry/readiness tests run fast
  process.env.KUBECLAW_TOOL_REQUEST_TIMEOUT = '500';
  process.env.KUBECLAW_TOOL_RETRY_BASE_MS = '10';
  process.env.KUBECLAW_TOOL_READY_TIMEOUT = '300';
  process.env.KUBECLAW_TOOL_READY_INTERVAL_MS = '20';
});

vi.mock('redis', () => {
  const mockRedis = {
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    xRead: vi.fn().mockResolvedValue(null),
    xAdd: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  };
  return { createClient: vi.fn(() => mockRedis) };
});

import {
  reconnectStrategy,
  fetchWithRetry,
  ToolClientError,
  waitForToolReady,
} from '../container/agent-runner/src/tool-server.js';

describe('reconnectStrategy', () => {
  it('backs off exponentially from 100ms', () => {
    expect(reconnectStrategy(0)).toBe(100);
    expect(reconnectStrategy(1)).toBe(200);
    expect(reconnectStrategy(2)).toBe(400);
  });

  it('caps the delay at 10 seconds', () => {
    expect(reconnectStrategy(10)).toBe(10_000);
  });

  it('gives up with an Error after 10 retries', () => {
    expect(reconnectStrategy(11)).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

```bash
npx vitest run src/tool-server-bridge.test.ts
```

Expected: FAIL — `reconnectStrategy` is not exported (`SyntaxError: ... does not provide an export named 'reconnectStrategy'` or similar).

- [ ] **Step 1.3: Implement reconnectStrategy and wire it into both Redis clients**

In `container/agent-runner/src/tool-server.ts`, add below the `SECRET_ENV_VARS` constant (line 31):

```typescript
/**
 * Exponential reconnect backoff (ported from the legacy adapters):
 * min(2^retries * 100ms, 10s), giving up after 10 retries.
 */
export function reconnectStrategy(retries: number): number | Error {
  if (retries > 10) return new Error('Redis reconnect retries exhausted');
  return Math.min(Math.pow(2, retries) * 100, 10_000);
}
```

Change the main client creation (currently `tool-server.ts:359`):

```typescript
  const redis = createClient({
    url: redisUrl,
    socket: { reconnectStrategy },
  }) as RedisClientType;
```

Change `getRedisForTask()` (currently `tool-server.ts:204-211`):

```typescript
let taskRedis: RedisClientType | null = null;
async function getRedisForTask(): Promise<RedisClientType> {
  if (!taskRedis) {
    taskRedis = createClient({
      url: redisUrl,
      socket: { reconnectStrategy },
    }) as RedisClientType;
    await taskRedis.connect();
  }
  return taskRedis;
}
```

- [ ] **Step 1.4: Build tool-server and run the test**

```bash
cd container/agent-runner && npm run build && cd ../..
npx vitest run src/tool-server-bridge.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 1.5: Run the existing tool-server tests to confirm no regression**

```bash
npx vitest run src/tool-server.test.ts
```

Expected: PASS.

- [ ] **Step 1.6: Commit**

```bash
git add container/agent-runner/src/tool-server.ts src/tool-server-bridge.test.ts
git commit -m "feat(tool-bridge): add Redis reconnect backoff (ported from legacy adapters)"
```

---

### Task 2: HTTP retry with 4xx/5xx distinction and per-attempt timeout

The legacy http-adapter fails fast on 4xx and retries 5xx/network errors with exponential backoff (`container/http-adapter/src/http-client.ts`). The bridge currently uses one bare `fetch` with no timeout (`tool-server.ts:215-225`).

**Files:**
- Modify: `container/agent-runner/src/tool-server.ts`
- Test: `src/tool-server-bridge.test.ts` (extend)

- [ ] **Step 2.1: Write the failing tests**

Append to `src/tool-server-bridge.test.ts`:

```typescript
describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the response on first success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"result":"ok"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('http://localhost:9999/invoke', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on 4xx without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('bad request', { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('http://localhost:9999/invoke', { method: 'POST' }),
    ).rejects.toBeInstanceOf(ToolClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx and succeeds on a later attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('{"result":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('http://localhost:9999/invoke', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries network errors and throws after 3 attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('http://localhost:9999/invoke', { method: 'POST' }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2.2: Run to verify failure**

```bash
npx vitest run src/tool-server-bridge.test.ts
```

Expected: FAIL — `fetchWithRetry` / `ToolClientError` not exported.

- [ ] **Step 2.3: Implement fetchWithRetry**

In `container/agent-runner/src/tool-server.ts`, add below `reconnectStrategy`:

```typescript
/** Unrecoverable client error (HTTP 4xx) — do not retry. */
export class ToolClientError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Tool HTTP ${status}: ${body}`);
    this.name = 'ToolClientError';
  }
}

const REQUEST_TIMEOUT_MS = parseInt(
  process.env.KUBECLAW_TOOL_REQUEST_TIMEOUT || '30000',
  10,
);
const RETRY_BASE_MS = parseInt(
  process.env.KUBECLAW_TOOL_RETRY_BASE_MS || '1000',
  10,
);
const RETRY_MAX_ATTEMPTS = 3;

/**
 * fetch with the legacy http-adapter's retry discipline:
 * - per-attempt timeout (AbortSignal)
 * - 4xx → ToolClientError, no retry (the request itself is wrong)
 * - 5xx / network error / timeout → exponential backoff (base, 2x, 4x), 3 attempts
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      log(`Retrying ${url} in ${delay}ms (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      const body = await res.text();
      if (res.status >= 400 && res.status < 500) {
        throw new ToolClientError(res.status, body);
      }
      lastError = new Error(`Tool HTTP ${res.status}: ${body}`);
    } catch (err) {
      if (err instanceof ToolClientError) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
```

Note: `log()` uses `category` which is fine at module scope. `Response.ok` is true for 2xx only; 3xx from localhost is not expected — treated as retryable, which is acceptable.

- [ ] **Step 2.4: Use fetchWithRetry in the http-bridge and acp-bridge**

Replace `executeToolBridgeHttp` (currently `tool-server.ts:215-225`):

```typescript
async function executeToolBridgeHttp(tool: string, input: Record<string, unknown>): Promise<unknown> {
  const res = await fetchWithRetry(`http://localhost:${toolPort}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, input }),
  });
  const data = await res.json() as { result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result ?? null;
}
```

In `executeToolBridgeAcp`, replace the **sync-mode** POST (currently `tool-server.ts:264-271`) with (note the explicit `idleTimeout` — ACP sync runs may legitimately take minutes, so the default 30s per-attempt timeout must not apply):

```typescript
  if (acpMode === 'sync') {
    const res = await fetchWithRetry(
      `${acpBaseUrl}/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name: agentName, input: acpInput, mode: 'synchronous' }),
      },
      idleTimeout,
    );
    return extractACPResult(await res.json());
  }
```

And the **async-mode** create POST (currently `tool-server.ts:275-280`):

```typescript
  const createRes = await fetchWithRetry(`${acpBaseUrl}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_name: agentName, input: acpInput }),
  });
  const run = await createRes.json() as { run_id: string; status: string };
```

(The `if (!res.ok) throw ...` / `if (!createRes.ok) throw ...` lines are removed — `fetchWithRetry` already throws on non-2xx. Leave the poll loop's plain `fetch` calls unchanged; the loop is its own retry mechanism.)

- [ ] **Step 2.5: Build and run tests**

```bash
cd container/agent-runner && npm run build && cd ../..
npx vitest run src/tool-server-bridge.test.ts src/tool-server.test.ts
```

Expected: PASS.

- [ ] **Step 2.6: Commit**

```bash
git add container/agent-runner/src/tool-server.ts src/tool-server-bridge.test.ts
git commit -m "feat(tool-bridge): retry with 4xx/5xx distinction and per-attempt timeout"
```

---

### Task 3: Readiness gate before first forward (http/acp)

The legacy http-adapter polls `GET /agent/health` before sending the first task (`container/http-adapter/src/health-check.ts`). The bridge fires immediately, so a slow-starting user container yields connection-refused errors. Readiness semantics for arbitrary images: **any HTTP response (even 404) means the port is accepting connections**; connection errors mean not ready.

**Files:**
- Modify: `container/agent-runner/src/tool-server.ts`
- Test: `src/tool-server-bridge.test.ts` (extend)

- [ ] **Step 3.1: Write the failing tests**

Append to `src/tool-server-bridge.test.ts`:

```typescript
describe('waitForToolReady', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves as soon as the user container answers (any status)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nf', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForToolReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls through connection errors until the container is up', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForToolReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws when the deadline passes with no response', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForToolReady()).rejects.toThrow(/not ready after/);
  });
});
```

(The hoisted env in Task 1 already sets `KUBECLAW_TOOL_READY_TIMEOUT=300` and `KUBECLAW_TOOL_READY_INTERVAL_MS=20`, so the deadline test completes in ~300ms.)

- [ ] **Step 3.2: Run to verify failure**

```bash
npx vitest run src/tool-server-bridge.test.ts
```

Expected: FAIL — `waitForToolReady` not exported.

- [ ] **Step 3.3: Implement the readiness gate**

In `container/agent-runner/src/tool-server.ts`, add below `fetchWithRetry`:

```typescript
const READY_TIMEOUT_MS = parseInt(
  process.env.KUBECLAW_TOOL_READY_TIMEOUT || '30000',
  10,
);
const READY_INTERVAL_MS = parseInt(
  process.env.KUBECLAW_TOOL_READY_INTERVAL_MS || '1000',
  10,
);
const toolHealthPath = process.env.KUBECLAW_TOOL_HEALTH_PATH || '/';

/**
 * Poll the user container until it accepts an HTTP connection (ported from
 * the legacy adapter's waitForHealthy). ANY HTTP response — including 404 —
 * counts as ready: the contract is "the port is listening", because arbitrary
 * images may not expose a real health endpoint. Connection errors mean
 * not-ready; keep polling until the deadline.
 */
export async function waitForToolReady(): Promise<void> {
  const url = `http://localhost:${toolPort}${toolHealthPath}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      log(`User container ready (${url})`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
    }
  }
  throw new Error(`User container not ready after ${READY_TIMEOUT_MS}ms (${url})`);
}

let readyPromise: Promise<void> | null = null;

/** Memoized readiness gate — applies to http-bridge and acp-bridge only. */
function ensureToolReady(): Promise<void> {
  if (toolMode !== 'http-bridge' && toolMode !== 'acp-bridge') {
    return Promise.resolve();
  }
  if (!readyPromise) {
    readyPromise = waitForToolReady().catch((err) => {
      readyPromise = null; // a later call may try again
      throw err;
    });
  }
  return readyPromise;
}
```

Add `await ensureToolReady();` as the **first line** of `executeToolBridgeHttp` and of `executeToolBridgeAcp`:

```typescript
async function executeToolBridgeHttp(tool: string, input: Record<string, unknown>): Promise<unknown> {
  await ensureToolReady();
  const res = await fetchWithRetry(`http://localhost:${toolPort}/invoke`, {
```

```typescript
async function executeToolBridgeAcp(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  await ensureToolReady();
  const acpBaseUrl = `http://localhost:${toolPort}`;
```

- [ ] **Step 3.4: Build and run all bridge tests**

```bash
cd container/agent-runner && npm run build && cd ../..
npx vitest run src/tool-server-bridge.test.ts src/tool-server.test.ts
```

Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add container/agent-runner/src/tool-server.ts src/tool-server-bridge.test.ts
git commit -m "feat(tool-bridge): readiness gate before first forward to user container"
```

---

### Task 4: Plumb optional `healthPath` from ToolSpec to the bridge

Operators should be able to point the readiness probe at a real health endpoint. Plumbing: `ToolSpec.healthPath` → spawn-stream field `toolHealthPath` → `KUBECLAW_TOOL_HEALTH_PATH` env on the bridge container.

**Files:**
- Modify: `src/types.ts` (ToolSpec, line 63–79)
- Modify: `src/k8s/job-runner.ts` (`createSidecarToolPodJob`, bridgeEnv at line ~1748)
- Modify: `src/runtime/direct-llm-runner.ts` (spawnFields at line ~529)
- Modify: `src/k8s/ipc-redis.ts` (spawn watcher destructure at line ~1008 and toolSpec build at line ~1045)
- Test: `src/k8s/job-runner.test.ts` (extend `describe('createSidecarToolPodJob')`, line ~1349)

- [ ] **Step 4.1: Write the failing manifest test**

In `src/k8s/job-runner.test.ts`, inside `describe('createSidecarToolPodJob', ...)` (line ~1349), add (reuse the existing `baseSpec` defined in that block; pass `healthPath` via a spread):

```typescript
    it('passes KUBECLAW_TOOL_HEALTH_PATH to the bridge when ToolSpec.healthPath is set', async () => {
      await jobRunner.createSidecarToolPodJob({
        ...baseSpec,
        toolSpec: { ...baseSpec.toolSpec, healthPath: '/healthz' },
      });

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      expect(bridge.env).toContainEqual({
        name: 'KUBECLAW_TOOL_HEALTH_PATH',
        value: '/healthz',
      });
    });

    it('omits KUBECLAW_TOOL_HEALTH_PATH when ToolSpec.healthPath is absent', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      expect(bridge.env.map((e: any) => e.name)).not.toContain(
        'KUBECLAW_TOOL_HEALTH_PATH',
      );
    });
```

- [ ] **Step 4.2: Run to verify failure**

```bash
npx vitest run src/k8s/job-runner.test.ts
```

Expected: the new first test FAILS (TypeScript may also reject `healthPath` on the ToolSpec literal — that is the same failure, proceed).

- [ ] **Step 4.3: Add the field to ToolSpec**

In `src/types.ts`, inside `interface ToolSpec` (after the `port?` member at line ~70):

```typescript
  /** Optional readiness-probe path on the user container (default "/"; any HTTP response counts as ready). */
  healthPath?: string;
```

- [ ] **Step 4.4: Stamp the env in createSidecarToolPodJob**

In `src/k8s/job-runner.ts`, after the `bridgeEnv` array literal (ends at line ~1757, before the `if (isAcpBridge)` block), add:

```typescript
    if (toolSpec.healthPath) {
      bridgeEnv.push({
        name: 'KUBECLAW_TOOL_HEALTH_PATH',
        value: toolSpec.healthPath,
      });
    }
```

- [ ] **Step 4.5: Forward the field over the spawn stream (channel mode)**

In `src/runtime/direct-llm-runner.ts`, inside the `if (customSpec) { spawnFields.push(...) }` block (line ~529–542), after the `toolPort` push:

```typescript
        if (customSpec.healthPath)
          spawnFields.push('toolHealthPath', customSpec.healthPath);
```

- [ ] **Step 4.6: Parse the field in the orchestrator spawn watcher**

In `src/k8s/ipc-redis.ts` `startToolPodSpawnWatcher`, the destructuring at line ~1008 already collects named fields; `toolHealthPath` arrives via `obj`. In the `toolSpec` object literal passed to `createSidecarToolPodJob` (line ~1045-1059), add alongside the `toolAcpAgentName` spread:

```typescript
                  ...(obj.toolHealthPath
                    ? { healthPath: obj.toolHealthPath }
                    : {}),
```

- [ ] **Step 4.7: Build and test**

```bash
npm run build
npx vitest run src/k8s/job-runner.test.ts src/k8s/ipc-redis.test.ts
```

Expected: PASS.

- [ ] **Step 4.8: Commit**

```bash
git add src/types.ts src/k8s/job-runner.ts src/runtime/direct-llm-runner.ts src/k8s/ipc-redis.ts src/k8s/job-runner.test.ts
git commit -m "feat(tool-bridge): plumb optional ToolSpec.healthPath to the readiness probe"
```

---

### Task 5: Per-job Redis ACL minting for sidecar tool pods (ACL manager side)

Port the legacy per-job ACL pattern to tool-pod scope. The new user can read **only** its own toolcalls stream and write **only** its own toolresults stream. The SQLite `job_acls` table and AES-256-GCM encryption already exist (`src/db.ts:2157`, `src/k8s/acl-manager.ts:291-343`) — only a new minting method and a cleanup sweep are needed.

**Files:**
- Modify: `src/k8s/acl-manager.ts`
- Test: `src/k8s/acl-manager.test.ts` (extend)

- [ ] **Step 5.1: Write the failing tests**

In `src/k8s/acl-manager.test.ts`, add inside the top-level `describe('RedisACLManager', ...)` (the file already mocks `ioredis` with `mockAcl`/`mockInfo` and initializes a test DB in `beforeEach` — reuse them):

```typescript
  describe('createToolPodACL', () => {
    beforeEach(() => {
      mockInfo.mockResolvedValue('redis_version:7.2.0');
      mockAcl.mockResolvedValue('OK');
    });

    it('creates a user scoped to exactly the job toolcalls/toolresults streams', async () => {
      const creds = await manager.createToolPodACL(
        'kubeclaw-stool-abc123-mytool',
        'direct-1717-agent',
        'mytool',
        'my-group',
        3600,
      );

      expect(creds.username).toMatch(/^stool-kubeclaw-stool-abc123-mytool/);
      expect(creds.password).toBeTruthy();

      const aclArgs = mockAcl.mock.calls.find((c) => c[0] === 'SETUSER')!;
      const argStrings = aclArgs.map(String);
      expect(argStrings).toContain(
        '%R~kubeclaw:toolcalls:direct-1717-agent:mytool',
      );
      expect(argStrings).toContain(
        '%W~kubeclaw:toolresults:direct-1717-agent:mytool',
      );
      expect(argStrings).toContain('+xread');
      expect(argStrings).toContain('+xadd');
      // No pub/sub, no cross-key access
      expect(argStrings).toContain('resetchannels');
      expect(argStrings.join(' ')).not.toContain('~kubeclaw:input');
    });

    it('persists the ACL so credentials can be retrieved and revoked', async () => {
      const creds = await manager.createToolPodACL(
        'kubeclaw-stool-def456-othertool',
        'agent-2',
        'othertool',
        'my-group',
        60,
      );
      const stored = getJobACLByGroup('my-group');
      expect(stored).toBeTruthy();
      expect(stored!.username).toBe(creds.username);
      expect(stored!.status).toBe('active');
    });
  });
```

- [ ] **Step 5.2: Run to verify failure**

```bash
npx vitest run src/k8s/acl-manager.test.ts
```

Expected: FAIL — `createToolPodACL` does not exist.

- [ ] **Step 5.3: Implement createToolPodACL and the cleanup sweep**

In `src/k8s/acl-manager.ts`, add inside `class RedisACLManager` (after `createJobACL`, line ~157):

```typescript
  /**
   * Create an ACL user for a sidecar tool pod's bridge container.
   *
   * Scope (per-tool-call bridge, NOT the legacy adapter scope):
   *   - read-only on  kubeclaw:toolcalls:{agentJobId}:{toolName}
   *   - write-only on kubeclaw:toolresults:{agentJobId}:{toolName}
   *   - no pub/sub channels, no other keys
   *
   * Returns the plaintext credentials for embedding in the pod's REDIS_URL.
   * The encrypted copy is persisted in job_acls keyed by `jobKey` so the
   * periodic sweep can revoke it after expiry.
   */
  async createToolPodACL(
    podJobName: string,
    agentJobId: string,
    toolName: string,
    groupFolder: string,
    ttlSeconds: number = 3600,
  ): Promise<{ username: string; password: string }> {
    await this.verifyRedisVersion();

    // Suffix avoids job_acls PK collisions if the same job name recurs.
    const jobKey = `${podJobName}-${Date.now().toString(36)}`;
    const username = `stool-${podJobName}`;
    const password = this.generatePassword();
    const encryptedPassword = this.encryptPassword(password);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const acl: JobACL = {
      jobId: jobKey,
      groupFolder,
      username,
      password: encryptedPassword,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
    };

    const redis = await this.ensureConnection();

    const aclRules = [
      `%R~kubeclaw:toolcalls:${agentJobId}:${toolName}`,
      `%W~kubeclaw:toolresults:${agentJobId}:${toolName}`,
      'resetchannels',
      '+xread',
      '+xadd',
      '+ping',
      '+reset',
      '+quit',
      // node-redis v4 may send CLIENT SETINFO/SETNAME on connect
      '+client|setinfo',
      '+client|setname',
    ];

    try {
      await redis.acl('SETUSER', username, 'on', `>${password}`, ...aclRules);
      storeJobACL(acl);
      logger.info(
        { podJobName, username, agentJobId, toolName },
        'Created per-job ACL user for sidecar tool pod',
      );
      return { username, password };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { podJobName, error: errorMessage },
        'Failed to create tool pod ACL user',
      );
      throw new Error(`Failed to create tool pod ACL user: ${errorMessage}`);
    }
  }
```

At the bottom of the file (after `resetACLManager`), add the sweep — sidecar tool pods have no completion hook in the orchestrator (`cleanupToolPods` in `src/k8s/ipc-redis.ts:908` has no callers), so expiry-based revocation is the mechanism:

```typescript
let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Periodically revoke expired ACL users. Sidecar tool pods are cleaned up by
 * idle timeout / activeDeadlineSeconds with no orchestrator-side completion
 * hook, so their per-job ACLs are revoked by TTL expiry via this sweep.
 */
export function startAclCleanupSweep(intervalMs: number = 600_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    getACLManager()
      .cleanupExpired()
      .catch((err) => logger.warn({ err }, 'ACL cleanup sweep failed'));
  }, intervalMs);
  sweepTimer.unref();
  logger.info({ intervalMs }, 'ACL cleanup sweep started');
}

export function stopAclCleanupSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
```

- [ ] **Step 5.4: Run the tests**

```bash
npx vitest run src/k8s/acl-manager.test.ts
```

Expected: PASS (existing + 2 new). If the import list at the top of the test file lacks `getJobACLByGroup`, it is already imported (line ~17) — verify.

- [ ] **Step 5.5: Commit**

```bash
git add src/k8s/acl-manager.ts src/k8s/acl-manager.test.ts
git commit -m "feat(acl): per-job ACL minting for sidecar tool pods + expiry sweep"
```

---

### Task 6: Wire per-job ACLs into createSidecarToolPodJob, start the sweep, ship ACL_ENCRYPTION_KEY

**Files:**
- Modify: `src/k8s/job-runner.ts` (`createSidecarToolPodJob`, line ~1713)
- Modify: `src/index.ts` (startup block, line ~930)
- Modify: `helm/kubeclaw/templates/secrets.yaml` (add `acl-encryption-key` to the `kubeclaw-redis` secret, preserve-on-upgrade pattern used at lines 44–76)
- Modify: `helm/kubeclaw/templates/orchestrator.yaml` (env block, line ~140-160)
- Test: `src/k8s/job-runner.test.ts` (extend)

- [ ] **Step 6.1: Write the failing tests**

In `src/k8s/job-runner.test.ts`, add a mock for the ACL manager near the other `vi.mock` calls at the top of the file (after the `./redis-client.js` mock, line ~74). Use `vi.hoisted` so the test body can steer it:

```typescript
const { mockCreateToolPodACL } = vi.hoisted(() => ({
  mockCreateToolPodACL: vi.fn(),
}));

vi.mock('./acl-manager.js', () => ({
  getACLManager: vi.fn(() => ({
    createToolPodACL: mockCreateToolPodACL,
  })),
}));
```

Then inside `describe('createSidecarToolPodJob', ...)` add:

```typescript
    it('embeds per-job ACL credentials in the bridge REDIS_URL', async () => {
      mockCreateToolPodACL.mockResolvedValueOnce({
        username: 'stool-test-user',
        password: 'p4ss',
      });

      await jobRunner.createSidecarToolPodJob(baseSpec);

      expect(mockCreateToolPodACL).toHaveBeenCalledWith(
        expect.stringMatching(/^kubeclaw-stool-/),
        baseSpec.agentJobId,
        baseSpec.toolName,
        baseSpec.groupFolder,
        expect.any(Number),
      );

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const redisEnv = bridge.env.find((e: any) => e.name === 'REDIS_URL');
      expect(redisEnv.value).toContain('stool-test-user:p4ss@');
    });

    it('falls back to the shared tool-server user when ACL minting fails', async () => {
      mockCreateToolPodACL.mockRejectedValueOnce(new Error('redis 6, no ACLs'));

      await jobRunner.createSidecarToolPodJob(baseSpec);

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      expect(call).toBeTruthy(); // job still created
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const redisEnv = bridge.env.find((e: any) => e.name === 'REDIS_URL');
      expect(redisEnv.value).not.toContain('stool-');
    });
```

Also add `mockCreateToolPodACL.mockResolvedValue({ username: 'stool-x', password: 'p' });` to the `beforeEach` of the `createSidecarToolPodJob` describe block (or `mockClear` + default in each test) so the **pre-existing** tests in that block keep passing — they will now trigger ACL minting too. Check the existing regression test at line ~1445 (asserts `tool-server` auth): update it to assert the **fallback** path by making `mockCreateToolPodACL` reject in that test.

- [ ] **Step 6.2: Run to verify failure**

```bash
npx vitest run src/k8s/job-runner.test.ts
```

Expected: new tests FAIL (`mockCreateToolPodACL` never called).

- [ ] **Step 6.3: Implement minting in createSidecarToolPodJob**

In `src/k8s/job-runner.ts`:

Add the import at the top (near the `acl` related imports — there are none yet; place after the `redis-client.js` import):

```typescript
import { getACLManager } from './acl-manager.js';
```

In `createSidecarToolPodJob`, replace the `redisUrl` construction (currently lines ~1737-1746, including the stale comment about the 'adapter' user) with:

```typescript
    const timeoutSeconds = Math.floor(spec.timeout / 1000);

    // Prefer a per-job ACL user scoped to exactly this job's two streams
    // (ported from the legacy adapter security model). Fall back to the
    // shared 'tool-server' user if minting fails (e.g. Redis < 7), matching
    // the legacy runners' degrade-gracefully behavior.
    let redisUsername = 'tool-server';
    let redisPassword =
      REDIS_TOOL_SERVER_PASSWORD || process.env.REDIS_ADMIN_PASSWORD;
    try {
      const creds = await getACLManager().createToolPodACL(
        jobName,
        spec.agentJobId,
        spec.toolName,
        spec.groupFolder,
        timeoutSeconds + 900, // outlive the pod by 15 min; sweep revokes after
      );
      redisUsername = creds.username;
      redisPassword = creds.password;
    } catch (err) {
      logger.warn(
        { jobName, err },
        'Per-job ACL minting failed; falling back to shared tool-server Redis user',
      );
    }
    const redisUrl = buildRedisUrl(
      process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
      redisUsername,
      redisPassword,
    );
```

(Note: `timeoutSeconds` was already declared at line ~1736 — keep exactly one declaration.)

- [ ] **Step 6.4: Start the sweep at orchestrator startup**

In `src/index.ts`, add to the import from the k8s/ipc area (a new import line is fine):

```typescript
import { startAclCleanupSweep } from './k8s/acl-manager.js';
```

Then immediately before the `startToolPodSpawnWatcher().catch(...)` call at line ~930:

```typescript
  startAclCleanupSweep();
```

- [ ] **Step 6.5: Ship ACL_ENCRYPTION_KEY via Helm**

`ACL_ENCRYPTION_KEY` is currently not set anywhere in the chart (the manager falls back to an insecure derived key with a warning — `src/k8s/acl-manager.ts:332-339`).

In `helm/kubeclaw/templates/secrets.yaml`, follow the existing preserve-on-upgrade pattern (lines 44–76): add a `$aclEncryptionKey` variable generated with `randAlphaNum 32`, preserved from the existing secret if present:

```yaml
{{- $aclEncryptionKey := randAlphaNum 32 }}
{{- if and $redisSecret (hasKey ($redisSecret.data | default dict) "acl-encryption-key") }}{{- $aclEncryptionKey = index $redisSecret.data "acl-encryption-key" | b64dec }}{{- end }}
```

and in the secret's `stringData`/`data` block (next to `tool-server-password` at line ~75):

```yaml
  acl-encryption-key: {{ $aclEncryptionKey | quote }}
```

In `helm/kubeclaw/templates/orchestrator.yaml`, add to the orchestrator env (next to `REDIS_ADMIN_PASSWORD`, line ~141):

```yaml
            - name: ACL_ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: kubeclaw-redis
                  key: acl-encryption-key
```

- [ ] **Step 6.6: Build, test, helm-lint**

```bash
npm run build
npx vitest run src/k8s/job-runner.test.ts
helm template kubeclaw helm/kubeclaw >/dev/null && echo "helm OK"
```

Expected: PASS / `helm OK`.

- [ ] **Step 6.7: Commit**

```bash
git add src/k8s/job-runner.ts src/index.ts src/k8s/job-runner.test.ts helm/kubeclaw/templates/secrets.yaml helm/kubeclaw/templates/orchestrator.yaml
git commit -m "feat(acl): sidecar tool pods authenticate with per-job Redis ACL users"
```

---### Task 7: File-bridge wrapper script ConfigMap (zero-Dockerfile onboarding)

Ports the legacy `runner-wrapper.sh` concept to the bridge's `{requestId}.request.json` convention, so a stock image (with `sh` + `jq`) can serve file-bridge tools without custom code. Mounted read-only at `/kubeclaw` in the **user-tool container only**, and only for file-bridge pods. `optional: true` keeps non-Helm installs working.

**Files:**
- Modify: `helm/kubeclaw/templates/configmaps.yaml` (add new ConfigMap; legacy ones are deleted in Task 10)
- Modify: `k8s/35-configmaps.yaml` (same)
- Modify: `src/k8s/job-runner.ts` (`createSidecarToolPodJob` volumes/mounts, lines ~1771-1777 and container specs)
- Test: `src/k8s/job-runner.test.ts` (extend)

- [ ] **Step 7.1: Write the failing manifest tests**

Inside `describe('createSidecarToolPodJob', ...)` in `src/k8s/job-runner.test.ts` (a `fileSpec` variant already exists at line ~1404 — reuse its shape):

```typescript
    it('mounts the tool-wrapper ConfigMap into the user container for file-bridge pods', async () => {
      await jobRunner.createSidecarToolPodJob(fileSpec);

      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const podSpec = call.body.spec.template.spec;
      const userTool = podSpec.containers.find((c: any) => c.name === 'user-tool');
      const bridge = podSpec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );

      expect(userTool.volumeMounts).toContainEqual({
        name: 'tool-wrapper',
        mountPath: '/kubeclaw',
        readOnly: true,
      });
      // Bridge does NOT get the wrapper, but both share /shared
      expect(bridge.volumeMounts.map((m: any) => m.name)).not.toContain('tool-wrapper');
      expect(bridge.volumeMounts.map((m: any) => m.name)).toContain('shared');
      expect(userTool.volumeMounts.map((m: any) => m.name)).toContain('shared');

      expect(podSpec.volumes).toContainEqual({
        name: 'tool-wrapper',
        configMap: {
          name: 'kubeclaw-tool-wrapper',
          defaultMode: 0o755,
          optional: true,
        },
      });
    });

    it('does not mount the wrapper for http-bridge pods', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const volumes = call.body.spec.template.spec.volumes ?? [];
      expect(volumes.map((v: any) => v.name)).not.toContain('tool-wrapper');
    });
```

- [ ] **Step 7.2: Run to verify failure**

```bash
npx vitest run src/k8s/job-runner.test.ts
```

Expected: first new test FAILS.

- [ ] **Step 7.3: Split the shared mounts array and add the wrapper volume**

In `src/k8s/job-runner.ts` `createSidecarToolPodJob`, replace the volume block (currently lines ~1771-1777):

```typescript
    const bridgeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> = [];
    const userMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> = [];
    const volumes: Array<any> = [];

    if (isFileBridge) {
      bridgeMounts.push({ name: 'shared', mountPath: '/shared' });
      userMounts.push({ name: 'shared', mountPath: '/shared' });
      // Optional wrapper script: lets stock images (sh + jq) serve file-bridge
      // tools via command: ["/bin/sh", "/kubeclaw/tool-wrapper.sh", "<cmd>"]
      userMounts.push({ name: 'tool-wrapper', mountPath: '/kubeclaw', readOnly: true });
      volumes.push({ name: 'shared', emptyDir: {} });
      volumes.push({
        name: 'tool-wrapper',
        configMap: {
          name: 'kubeclaw-tool-wrapper',
          defaultMode: 0o755,
          optional: true,
        },
      });
    }
```

Then in the two container specs, replace `volumeMounts: volumeMounts` with `volumeMounts: bridgeMounts` (bridge container, line ~1807) and `volumeMounts: userMounts` (user-tool container, line ~1819).

- [ ] **Step 7.4: Add the ConfigMap to Helm and raw manifests**

Append to `helm/kubeclaw/templates/configmaps.yaml` (the legacy ConfigMaps above it are removed in Task 10):

```yaml
---
# File-bridge tool wrapper. Lets a stock image (sh + jq required) serve
# file-bridge ToolSpecs with zero custom code:
#   command: ["/bin/sh", "/kubeclaw/tool-wrapper.sh", "your-command", "arg1"]
# The wrapper watches /shared for {requestId}.request.json written by the
# kubeclaw-tool-bridge container, pipes the request's .input JSON to the
# wrapped command's stdin, and writes stdout to {requestId}.response.json.
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-tool-wrapper
  namespace: {{ include "kubeclaw.namespace" . }}
data:
  tool-wrapper.sh: |
    #!/bin/sh
    SHARED_DIR="${KUBECLAW_SHARED_DIR:-/shared}"
    POLL_INTERVAL="${KUBECLAW_POLL_INTERVAL:-1}"

    log() { echo "[tool-wrapper] $*" >&2; }

    if [ "$#" -eq 0 ]; then
      log "Usage: tool-wrapper.sh <command> [args...]"
      exit 1
    fi

    log "Watching $SHARED_DIR (command: $*)"
    while true; do
      for req in "$SHARED_DIR"/*.request.json; do
        [ -f "$req" ] || continue
        id=$(basename "$req" .request.json)
        log "Processing request $id"
        if out=$(jq -c '.input' < "$req" | "$@" 2>&1); then
          printf '{"result": %s}' "$(printf '%s' "$out" | jq -Rs '.')" \
            > "$SHARED_DIR/$id.response.json"
        else
          printf '{"error": %s}' "$(printf '%s' "$out" | jq -Rs '.')" \
            > "$SHARED_DIR/$id.response.json"
        fi
        rm -f "$req"
      done
      sleep "$POLL_INTERVAL"
    done
```

Append the same ConfigMap (without the `{{ include ... }}` templating — use `namespace: kubeclaw`) to `k8s/35-configmaps.yaml`.

- [ ] **Step 7.5: Build, test, helm-lint**

```bash
npm run build
npx vitest run src/k8s/job-runner.test.ts
helm template kubeclaw helm/kubeclaw | grep -A3 "kubeclaw-tool-wrapper" | head -5
```

Expected: tests PASS; helm output shows the new ConfigMap.

- [ ] **Step 7.6: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts helm/kubeclaw/templates/configmaps.yaml k8s/35-configmaps.yaml
git commit -m "feat(tool-bridge): file-bridge wrapper ConfigMap for zero-Dockerfile tool images"
```

---

### Task 8: Integration tests — real bridge subprocess against real Redis

`e2e/sidecar-tool-pod.test.ts` already runs the compiled bridge as a subprocess against the test Redis (see its lines 1–90: `ensureToolServerBuilt`, `waitForToolResult`, `getSharedRedis`). Extend it with readiness, retry, and fail-fast scenarios; extend `e2e/sidecar-acl.test.ts` with tool-pod ACL isolation. Follow the existing helper functions in each file for spawning the bridge process and writing tool calls (the file contains a helper that spawns `dist/tool-server.js` with env — reuse it; the snippets below show the env contract the new tests need).

**Files:**
- Modify: `e2e/sidecar-tool-pod.test.ts`
- Modify: `e2e/sidecar-acl.test.ts`

- [ ] **Step 8.1: Add the readiness test (slow-starting user server)**

In `e2e/sidecar-tool-pod.test.ts`, add a describe block. Model the bridge-spawn on the existing http-bridge tests in the same file (same env vars; add the two retry/readiness tunables):

```typescript
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
    const port = 19181;
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
  }, 30_000);
});
```

(Adjust `waitForToolResult`'s return handling to the file's actual helper signature — it returns `{ result, error }` per its lines 70–90.)

- [ ] **Step 8.2: Add the retry and fail-fast tests**

```typescript
describe('Sidecar Tool Pod — retry discipline', () => {
  let bridge: ChildProcess | null = null;
  let server: Server | null = null;
  let hits = 0;

  afterAll(async () => {
    bridge?.kill();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it('retries 5xx then succeeds; fails fast on 4xx', async () => {
    const agentJobId = `retry-test-${Date.now()}`;
    const toolName = 'flakytool';
    const port = 19182;
    const redis = getSharedRedis();
    if (!redis) throw new Error('Redis not available');

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
    await new Promise<void>((r) => server!.listen(port, r));

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
  }, 40_000);
});
```

- [ ] **Step 8.3: Add the tool-pod ACL isolation test**

In `e2e/sidecar-acl.test.ts`, add inside the top-level describe (the file already connects to test Redis and uses the real `RedisACLManager` against it — follow its existing setup for the manager instance and Redis URL):

```typescript
  describe('Tool pod ACLs (createToolPodACL)', () => {
    it('scopes the user to exactly its own toolcalls/toolresults streams', async () => {
      const manager = getACLManager();
      const creds = await manager.createToolPodACL(
        'kubeclaw-stool-e2e-mytool',
        'agent-e2e-1',
        'mytool',
        'e2e-group',
        120,
      );

      const { Redis } = await import('ioredis');
      const url = new URL(getRedisUrlForTests());
      const client = new Redis({
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        username: creds.username,
        password: creds.password,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      await client.connect();

      // Allowed: write own toolresults stream
      await expect(
        client.xadd('kubeclaw:toolresults:agent-e2e-1:mytool', '*', 'k', 'v'),
      ).resolves.toBeTruthy();

      // Denied: another agent job's stream
      await expect(
        client.xadd('kubeclaw:toolresults:other-agent:mytool', '*', 'k', 'v'),
      ).rejects.toThrow(/NOPERM/i);

      // Denied: writing the toolcalls stream (read-only)
      await expect(
        client.xadd('kubeclaw:toolcalls:agent-e2e-1:mytool', '*', 'k', 'v'),
      ).rejects.toThrow(/NOPERM/i);

      // Denied: pub/sub
      await expect(
        client.publish('kubeclaw:messages:e2e-group', 'hi'),
      ).rejects.toThrow(/NOPERM/i);

      client.disconnect();
    });
  });
```

(Import `getACLManager` at the top of the file if not already imported; check its existing imports at lines 11–20.)

- [ ] **Step 8.4: Run the integration suites**

```bash
npx vitest run e2e/sidecar-tool-pod.test.ts e2e/sidecar-acl.test.ts --config vitest.e2e.config.ts
```

Expected: PASS. (These need the local test Redis from `e2e/setup.ts`; if Redis is unavailable the suite's existing guards apply.)

- [ ] **Step 8.5: Commit**

```bash
git add e2e/sidecar-tool-pod.test.ts e2e/sidecar-acl.test.ts
git commit -m "test(tool-bridge): integration coverage for readiness, retry, and per-job ACLs"
```

---

### Task 9: Remove the legacy runners from the runtime layer

**Files:**
- Modify: `src/runtime/index.ts` (delete `FileSidecarToolJobRunner` lines ~194-486, `HttpSidecarToolJobRunner` lines ~494-784, `SidecarRunner` interface ~787-789, their singletons/getters ~793-810, the two `getRunnerForGroup` branches ~831-838, `shutdownAllRunners`/`resetRunners` references, imports of `FileSidecarJobRunner`/`HttpSidecarJobRunner`, header comment lines 4-12)
- Modify: `src/runtime/index.test.ts` (delete the `FileSidecarToolJobRunner.runAgent` and `HttpSidecarToolJobRunner.runAgent` describe blocks at lines ~311 and ~410, plus their module mocks)
- Modify: `src/runtime/types.ts` (comments at lines 97 and 144 reference the deleted classes)
- Modify: `src/types.ts` (remove `userImage`, `userCommand`, `userArgs`, `filePollInterval`, `userPort`, `healthEndpoint` from `ContainerConfig` and rewrite its doc comment)
- Modify: `src/profile-command.integration.test.ts` (delete mock entries lines ~41-46), `src/schedule-command.integration.test.ts` (delete mock entries lines ~45-53)

- [ ] **Step 9.1: Simplify getRunnerForGroup and delete the classes**

In `src/runtime/index.ts`:

1. Delete the imports of `FileSidecarJobRunner` (line 20) and `HttpSidecarJobRunner` (line 21), and the `getACLManager, RedisACLManager` import **stays** (line 34) only if still referenced — after deleting the classes it is referenced only by the re-export at line 890; keep both the import and re-export (the orchestrator imports `getACLManager` from this module path in some call sites — verify with `grep -rn "from './runtime/index.js'" src/ | grep -i acl` and keep/drop accordingly; if nothing imports it from here, delete the import and re-export and import directly where needed).
2. Delete class `FileSidecarToolJobRunner` (lines ~194-486) and class `HttpSidecarToolJobRunner` (lines ~494-784).
3. Delete `export interface SidecarRunner` (lines ~787-789).
4. Delete the `fileSidecarRunner`/`httpSidecarRunner` singletons and their getters (lines ~793-810), and remove them from `shutdownAllRunners()` and `resetRunners()`.
5. Replace `getRunnerForGroup` with:

```typescript
/**
 * Select the correct runner for a group based on its containerConfig.
 *
 * Routing rules (checked in order):
 *   direct  → DirectLLMRunner          (in-process LLM — primary path for channels)
 *   neither → KubernetesToolJobRunner  (short-lived tool jobs / scheduled tasks)
 */
export function getRunnerForGroup(group: RegisteredGroup): MessageRunner {
  const { direct } = group.containerConfig ?? {};
  if (direct) {
    logger.debug({ group: group.name }, 'Using direct LLM runner');
    return getDirectLLMRunner();
  }
  logger.debug({ group: group.name }, 'Using Kubernetes tool-job runner');
  return getK8sRunner();
}
```

6. Update the file-header comment (lines 1-13) to list only the two remaining runners.

- [ ] **Step 9.2: Clean ContainerConfig**

In `src/types.ts`, delete the members `userImage`, `userCommand`, `userArgs`, `filePollInterval`, `userPort`, `healthEndpoint` from `ContainerConfig` (lines ~95-103) and replace the interface doc comment (lines ~82-89) with:

```typescript
/**
 * Orchestrator configuration for runners in this group.
 *
 * **Runner selection rule:**
 * - `direct: true` → `DirectLLMRunner` (in-process LLM — primary path for channel pods)
 * - otherwise      → `KubernetesToolJobRunner` (short-lived tool jobs / scheduled tasks)
 */
```

- [ ] **Step 9.3: Fix the tests that referenced the deleted code**

1. `src/runtime/index.test.ts`: delete the `describe('FileSidecarToolJobRunner...')` and `describe('HttpSidecarToolJobRunner...')` blocks (starting lines ~311 and ~410) and any `vi.mock('../k8s/file-sidecar-runner.js', ...)` / `vi.mock('../k8s/http-sidecar-runner.js', ...)` blocks. Also update any `getRunnerForGroup` routing tests in that file that assert the sidecar branches (they should now assert: `userImage`-style configs are ignored and route to `KubernetesToolJobRunner`).
2. `src/profile-command.integration.test.ts`: delete lines ~41-46 (`FileSidecarJobRunner: vi.fn(), fileSidecarRunner: {...}, HttpSidecarJobRunner: vi.fn(), httpSidecarRunner: {...}`) from whichever `vi.mock` factory contains them.
3. `src/schedule-command.integration.test.ts`: same for lines ~45-53.
4. `src/runtime/types.ts`: rewrite the comments at lines 97 and 144 that name the deleted classes (e.g. line 144's "Implemented by FileSidecarToolJobRunner and HttpSidecarToolJobRunner." → "Optional: implemented by runners that can route follow-up messages to a live job.").

- [ ] **Step 9.4: Build and run the affected suites**

```bash
npm run build
npx vitest run src/runtime/index.test.ts src/profile-command.integration.test.ts src/schedule-command.integration.test.ts
```

Expected: PASS, no TypeScript errors.

- [ ] **Step 9.5: Commit**

```bash
git add -A src/runtime/ src/types.ts src/profile-command.integration.test.ts src/schedule-command.integration.test.ts
git commit -m "refactor(runtime): remove legacy whole-group sidecar runners"
```

---

### Task 10: Delete the legacy k8s runners, adapter images, manifests, and config

**Files:**
- Delete: `src/k8s/file-sidecar-runner.ts`, `src/k8s/file-sidecar-runner.test.ts`, `src/k8s/http-sidecar-runner.ts`, `src/k8s/http-sidecar-runner.test.ts`, `src/k8s/sidecar-log-parser.ts`, `src/k8s/sidecar-log-parser.test.ts`
- Delete: `container/file-adapter/` and `container/http-adapter/` (entire directories)
- Delete: `e2e/file-sidecar.test.ts`, `e2e/http-sidecar.test.ts`
- Modify: `src/k8s/types.ts` (remove `SidecarJobSpec`, `SidecarHttpJobSpec`, `SidecarFileJobSpec`, `SidecarCredentials`, and the `credentials?: SidecarCredentials` member on `ToolJobSpec` at line ~77)
- Modify: `src/config.ts` (remove `REDIS_ADAPTER_PASSWORD`, line 229)
- Modify: `src/k8s/job-runner.ts` (remove `REDIS_ADAPTER_PASSWORD` from the config import at line 38)
- Modify: `src/k8s/job-runner.test.ts` (remove `REDIS_ADAPTER_PASSWORD: ''` from the config mock, line 29)
- Modify: `container/build.sh` (remove `--file-adapter` / `--http-adapter` flag handling at lines ~20-25, the two build sections at lines ~66-87, the usage string at line ~46, and the summary lines ~125-129)
- Modify: `helm/kubeclaw/templates/configmaps.yaml` (delete the `kubeclaw-runner-wrapper` and `kubeclaw-wrapper-script` ConfigMaps — everything except the `kubeclaw-tool-wrapper` added in Task 7)
- Modify: `k8s/35-configmaps.yaml` (same)
- Modify: `helm/kubeclaw/templates/redis.yaml` (delete the `user adapter ...` ACL line 36 and the `REDIS_ADAPTER_PASSWORD` env block at lines ~62-66)
- Modify: `helm/kubeclaw/templates/orchestrator.yaml` (delete the `REDIS_ADAPTER_PASSWORD` env block at lines ~156-160)
- Modify: `helm/kubeclaw/templates/secrets.yaml` (delete the `$adapterPassword` variable at line ~61 and the `adapter-password:` data line at line ~76)

- [ ] **Step 10.1: Delete the files**

```bash
git rm src/k8s/file-sidecar-runner.ts src/k8s/file-sidecar-runner.test.ts \
       src/k8s/http-sidecar-runner.ts src/k8s/http-sidecar-runner.test.ts \
       src/k8s/sidecar-log-parser.ts src/k8s/sidecar-log-parser.test.ts \
       e2e/file-sidecar.test.ts e2e/http-sidecar.test.ts
git rm -r container/file-adapter container/http-adapter
```

- [ ] **Step 10.2: Clean the type/config/Helm references listed above**

Apply each "Modify" item in the Files list. For `src/k8s/types.ts`: after removing the four interfaces and the `credentials?` member, run the build — if `SidecarCredentials` is still referenced anywhere, the compiler will say where; resolve by removing the referencing dead code, not by re-adding the type.

- [ ] **Step 10.3: Sweep for stragglers**

```bash
grep -rn "file-adapter\|http-adapter\|FileSidecar\|HttpSidecar\|sidecar-log-parser\|REDIS_ADAPTER_PASSWORD\|adapter-password\|kubeclaw-runner-wrapper\|kubeclaw-wrapper-script" \
  --include="*.ts" --include="*.yaml" --include="*.sh" \
  src/ container/ helm/ k8s/ e2e/ | grep -v node_modules
```

Expected: **no output**. Any hit is a missed reference — fix it (delete the referencing line or block) before proceeding.

- [ ] **Step 10.4: Build, full unit suite, helm-lint**

```bash
npm run build
npm test
helm template kubeclaw helm/kubeclaw >/dev/null && echo "helm OK"
```

Expected: build clean, all unit tests pass, `helm OK`.

- [ ] **Step 10.5: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy sidecar runners, adapter images, and wrapper ConfigMaps"
```

---

### Task 11: Documentation update

**Files:**
- Modify: `docs/SIDECAR_ACL.md`
- Modify: `docs/REDIS_IPC_PROTOCOL.md` (if it references adapters — verify)
- Modify: `docs/SPEC.md` (only if the sweep below finds references)

- [ ] **Step 11.1: Find every doc that mentions the removed system**

```bash
grep -rln "file-adapter\|http-adapter\|FileSidecar\|HttpSidecar\|runner-wrapper\|wrapper-script\|userImage" docs/ README.md INSTALL.md 2>/dev/null
```

- [ ] **Step 11.2: Rewrite docs/SIDECAR_ACL.md for the new scope**

Replace the document's framing: per-job ACLs now protect **sidecar tool pods** (the per-tool-call bridge), not the removed whole-group adapters. The document must state:

- ACL user naming: `stool-{podJobName}`, minted by `RedisACLManager.createToolPodACL()` in `src/k8s/acl-manager.ts`, called from `JobRunner.createSidecarToolPodJob()`.
- Scope: read-only `kubeclaw:toolcalls:{agentJobId}:{toolName}`, write-only `kubeclaw:toolresults:{agentJobId}:{toolName}`, no channels, commands `+xread +xadd +ping +reset +quit +client|setinfo +client|setname`.
- Fallback: shared `tool-server` user when minting fails (Redis < 7, missing admin password), with a logged warning.
- Lifecycle: TTL = pod timeout + 15 min; revocation by the periodic sweep (`startAclCleanupSweep`, started in `src/index.ts`) — there is no completion hook.
- Storage: unchanged (`job_acls` SQLite table, AES-256-GCM via `ACL_ENCRYPTION_KEY`, now shipped in the `kubeclaw-redis` Helm secret as `acl-encryption-key`).
- Required env (orchestrator): `REDIS_URL`, `REDIS_ADMIN_PASSWORD`, `ACL_ENCRYPTION_KEY`.

Keep the encryption and schema sections (still accurate); delete the adapter follow-up-messaging sections.

- [ ] **Step 11.3: Update remaining hits from Step 11.1**

For each file found: remove or rewrite the legacy-adapter references. In `docs/REDIS_IPC_PROTOCOL.md`, the `kubeclaw:input:{jobId}` / follow-up sections that describe adapter behavior should be trimmed to what the remaining consumers (agent jobs) actually use. Do not rewrite unrelated stale content (that is the separate docs-cleanup effort).

- [ ] **Step 11.4: Document the new bridge features**

Add a short section to `docs/SIDECAR_ACL.md` or a new `docs/TOOL_BRIDGE.md` (preferred: new file) covering, with exact env names: `KUBECLAW_TOOL_HEALTH_PATH` / `ToolSpec.healthPath` readiness semantics ("any HTTP response = ready"), retry behavior (3 attempts, 4xx fail-fast, `KUBECLAW_TOOL_REQUEST_TIMEOUT`, `KUBECLAW_TOOL_RETRY_BASE_MS`), reconnect backoff, and the `kubeclaw-tool-wrapper` usage example:

```yaml
# ToolSpec example: stock image, file bridge, zero custom code (image needs sh + jq)
tools:
  - name: word_count
    description: Count words in the input text
    parameters: { type: object, properties: { text: { type: string } } }
    image: alpine:latest        # must also be in TOOL_IMAGE_ALLOWLIST in production
    pattern: file
    command: ["/bin/sh", "/kubeclaw/tool-wrapper.sh", "wc", "-w"]
```

- [ ] **Step 11.5: Commit**

```bash
git add docs/
git commit -m "docs: update sidecar ACL and tool bridge docs for the hardened per-tool-call path"
```

---

### Task 12: Full verification

- [ ] **Step 12.1: Clean build + full unit suite**

```bash
npm run build && cd container/agent-runner && npm run build && cd ../..
npm test
```

Expected: all pass. Pay attention to any test still importing deleted modules.

- [ ] **Step 12.2: Integration suite (local Redis, no K8s)**

```bash
npm run test:e2e -- e2e/sidecar-tool-pod.test.ts e2e/sidecar-acl.test.ts e2e/sidecar-security.test.ts e2e/tool-server-idle-timeout.test.ts
```

Expected: pass (K8s-gated tests inside these files self-skip without a cluster).

- [ ] **Step 12.3: Minikube live e2e (if a cluster is available)**

```bash
kubectl get nodes >/dev/null 2>&1 && npm run test:e2e -- e2e/alpine-tool-execution.test.ts e2e/tool-pod-spawn.test.ts || echo "No cluster — live e2e skipped (note this in the final report)"
```

Expected if cluster present: pass — this exercises the real K8s path with the new manifest (per-job ACL minting, wrapper volume, healthPath env). If skipped, say so explicitly in the completion report; do not claim e2e verification.

- [ ] **Step 12.4: Final review sweep**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Confirm the diff contains no unrelated changes. Then run the two-stage review per the repository's review policy (spec-compliance first, then code-quality) before reporting complete.

---

## Explicitly OUT of scope (do not do these)

- **`automountServiceAccountToken: false` / securityContext on the user-tool container, `imagePullSecrets`, output-size caps** — real gaps, but they are new hardening work (gap 3), not legacy ports. Separate change series.
- **The cluster-wide tool catalog / admin-shell registration workflow and per-tool HTTP request-mapping** — separate, larger design (agreed direction; not this plan).
- **Converting built-in tools (bash/web_search/...) to ToolSpecs** — depends on the catalog work.
- **BYO-agent (turn-level delegation) redesign** — undecided; this plan deletes the unreachable legacy implementation only. If the user wants a wishlist note, that is a one-line README/REQUIREMENTS edit they can request separately.
- **General docs-cleanup of stale SPEC.md content** — separate effort already acknowledged.
