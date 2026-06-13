# HTTP Request-Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an unmodified third-party REST container serve as a KubeClaw tool by adding an optional `requestMapping` to `ToolSpec` that the sidecar bridge uses to build the real HTTP call (method/path/query/headers/body from the tool-call input) and shape the response — instead of requiring the container to implement the fixed `POST /invoke` contract.

**Architecture:** A new optional `requestMapping` field on `ToolSpec` (valid only for `pattern: 'http'`), validated at registration. The orchestrator stamps it as `KUBECLAW_TOOL_REQUEST_MAPPING` (JSON) onto the `kubeclaw-tool-bridge` container's env at spawn. The bridge (`tool-server.ts`) — KubeClaw's trusted sidecar container, co-located with the user-tool container on localhost — branches: env unset → today's `POST /invoke`; env set → build the mapped request via a pure `buildMappedRequest` helper, send it over `http://localhost:{port}` reusing the existing readiness gate + `fetchWithRetry`, then return the body (or a `responsePath` extraction), truncated to the existing cap.

**Tech Stack:** TypeScript (Node), vitest, the existing sidecar tool-pod bridge (`container/agent-runner/src/tool-server.ts`), the tool catalog (`src/tools/types.ts`), `src/k8s/job-runner.ts`. Spec: `docs/superpowers/specs/2026-06-13-http-request-mapping-design.md`.

---

## Pre-flight notes for the implementer

- **Node/PATH:** run `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH` before every `npm`/`node`/`npx` command. The repo's root `node_modules` is built against Node 24. (The `container/agent-runner` subdir builds with its own toolchain — see Task 2 — but tests for it run from the repo root under Node 24.)
- **Husky:** the pre-commit hook runs `prettier --write "src/**/*.ts"` and may reformat your `src/` files (harmless; re-stage is automatic). A "pre-commit hook ignored — not executable" warning is harmless.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Single test file:** `npx vitest run src/path/file.test.ts`. Full suite: `npm test`.
- **Build-green invariant:** each task's commit must compile (`npm run build`) and pass `npm test`. The new field is purely additive and optional, so the build stays green throughout; backward compatibility (no mapping → `/invoke`) is preserved at every step.

**Verified current code shapes (do not re-derive):**
- `src/tools/types.ts`: `ToolSpec` has `pattern: 'http' | 'file' | 'acp'`, `healthPath?` (validated to start with `/`), an `ALLOWED_KEYS` set, and `validateTool` / `parseToolCatalog`. `healthPath` validation lives at ~line 132.
- `container/agent-runner/src/tool-server.ts`: `toolPort` (line 21), `MAX_TOOL_OUTPUT_BYTES` (line 23), `fetchWithRetry` (line 73), `ensureToolReady` (line 139). `executeToolBridgeHttp(tool, input)` is at line 333:
  ```typescript
  async function executeToolBridgeHttp(tool: string, input: Record<string, unknown>): Promise<unknown> {
    await ensureToolReady();
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
- `src/k8s/job-runner.ts` `createSidecarToolPodJob`: builds `bridgeEnv` (array literal starting ~line 1766), pushes ACP env conditionally (~1778), pushes `KUBECLAW_TOOL_HEALTH_PATH` when `toolSpec.healthPath` is set (~1788). The bridge container `name: 'kubeclaw-tool-bridge'` uses `env: bridgeEnv` (~line 1856).

**Three-level test mapping:** Unit — `src/tools/types.test.ts` (validation) and `src/tool-server-mapping.test.ts` (new, for the pure helpers). Integration — extend `e2e/sidecar-tool-pod.test.ts` (real compiled bridge subprocess + a local stand-in HTTP server). E2E — minikube-live manifest assertion that the bridge env carries the mapping (the behavior is covered at the integration level).

---

### Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 0.1: Verify clean state and HEAD**

```bash
cd /home/peter/projects/kubeclaw
git status --porcelain      # Expected: empty
git rev-parse HEAD          # Note it; the branch must cut from live HEAD (has the committed spec)
```

- [ ] **Step 0.2: Branch** — the executor's worktree skill handles this; if working in-place: `git checkout -b feat/http-request-mapping`. Expected: on `feat/http-request-mapping`.

---

### Task 1: `RequestMapping` type + validation

Add the optional `requestMapping` field to `ToolSpec`, the `RequestMapping` interface, and validate it in `validateTool` (only allowed for `pattern: 'http'`).

**Files:**
- Modify: `src/tools/types.ts`
- Test: `src/tools/types.test.ts`

- [ ] **Step 1.1: Write the failing tests** — add to `src/tools/types.test.ts`. (The file already has a `base` valid-tool fixture and a `describe('validateTool', ...)` block — reuse `base`, which is an `http` tool.)

```typescript
describe('validateTool — requestMapping', () => {
  const mapped = {
    ...base,
    requestMapping: {
      method: 'GET' as const,
      path: '/weather/{city}',
      query: { units: '{units}' },
      headers: { Accept: 'application/json' },
      responsePath: 'current.temp_c',
    },
  };

  it('accepts a valid http requestMapping', () => {
    expect(validateTool(mapped)).toEqual({ ok: true });
  });

  it('accepts a POST mapping with a body', () => {
    expect(
      validateTool({
        ...base,
        requestMapping: { method: 'POST', path: '/q', body: { q: '{query}' } },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects requestMapping on a file-pattern tool', () => {
    expect(
      validateTool({ ...base, pattern: 'file', requestMapping: { method: 'GET', path: '/x' } }).ok,
    ).toBe(false);
  });

  it('rejects requestMapping on an acp-pattern tool', () => {
    expect(
      validateTool({ ...base, pattern: 'acp', requestMapping: { method: 'GET', path: '/x' } }).ok,
    ).toBe(false);
  });

  it('rejects an invalid method', () => {
    expect(validateTool({ ...base, requestMapping: { method: 'FETCH', path: '/x' } }).ok).toBe(false);
  });

  it('rejects a path without a leading slash', () => {
    expect(validateTool({ ...base, requestMapping: { method: 'GET', path: 'weather' } }).ok).toBe(false);
  });

  it('rejects a missing method', () => {
    expect(validateTool({ ...base, requestMapping: { path: '/x' } }).ok).toBe(false);
  });

  it('rejects non-string query values', () => {
    expect(
      validateTool({ ...base, requestMapping: { method: 'GET', path: '/x', query: { n: 5 } } }).ok,
    ).toBe(false);
  });

  it('rejects non-string header values', () => {
    expect(
      validateTool({ ...base, requestMapping: { method: 'GET', path: '/x', headers: { A: 1 } } }).ok,
    ).toBe(false);
  });

  it('rejects a non-string responsePath', () => {
    expect(
      validateTool({ ...base, requestMapping: { method: 'GET', path: '/x', responsePath: 5 } }).ok,
    ).toBe(false);
  });

  it('rejects an unknown requestMapping key', () => {
    expect(
      validateTool({ ...base, requestMapping: { method: 'GET', path: '/x', bogus: 1 } }).ok,
    ).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/tools/types.test.ts
```

Expected: the new tests FAIL (TypeScript may also reject `requestMapping` on the literal — same failure; proceed).

- [ ] **Step 1.3: Add the `RequestMapping` interface and the field**

In `src/tools/types.ts`, add the interface above `ToolSpec` (or just below it):

```typescript
export interface RequestMapping {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** URL path on the user-tool container; {field} tokens are URL-encoded. Must begin with "/". */
  path: string;
  /** Query params; values are literals or "{field}" (URL-encoded). */
  query?: Record<string, string>;
  /** Headers; values are literals or "{field}" (raw string, newlines stripped). */
  headers?: Record<string, string>;
  /** JSON body template; string leaves equal to "{field}" preserve the field's JSON type. Omit for GET/DELETE. */
  body?: unknown;
  /** Optional dot-path to extract from a JSON response, e.g. "current.temp_c". */
  responsePath?: string;
}
```

Add to the `ToolSpec` interface (after `healthPath?`):

```typescript
  /** Optional per-tool HTTP request mapping (pattern 'http' only). When set, the
   *  bridge builds the real request from this instead of POSTing /invoke. */
  requestMapping?: RequestMapping;
```

Add `'requestMapping'` to the `ALLOWED_KEYS` set.

- [ ] **Step 1.4: Validate it in `validateTool`**

In `src/tools/types.ts`, add a `validateRequestMapping` helper and call it from `validateTool`. Place the call AFTER the `pattern` is known to be valid. Insert near the `healthPath` validation block:

```typescript
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_MAPPING_KEYS = new Set([
  'method',
  'path',
  'query',
  'headers',
  'body',
  'responsePath',
]);

function validateRequestMapping(m: unknown): ValidationResult {
  if (typeof m !== 'object' || m === null)
    return { ok: false, error: 'requestMapping must be an object' };
  const obj = m as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_MAPPING_KEYS.has(k))
      return { ok: false, error: `unknown requestMapping field: ${k}` };
  }
  if (typeof obj.method !== 'string' || !HTTP_METHODS.has(obj.method))
    return { ok: false, error: 'requestMapping.method must be one of GET|POST|PUT|PATCH|DELETE' };
  if (typeof obj.path !== 'string' || !obj.path.startsWith('/'))
    return { ok: false, error: 'requestMapping.path must be a string beginning with "/"' };
  for (const f of ['query', 'headers'] as const) {
    if (obj[f] !== undefined) {
      if (typeof obj[f] !== 'object' || obj[f] === null || Array.isArray(obj[f]))
        return { ok: false, error: `requestMapping.${f} must be an object` };
      for (const v of Object.values(obj[f] as Record<string, unknown>)) {
        if (typeof v !== 'string')
          return { ok: false, error: `requestMapping.${f} values must be strings` };
      }
    }
  }
  if (obj.responsePath !== undefined && typeof obj.responsePath !== 'string')
    return { ok: false, error: 'requestMapping.responsePath must be a string' };
  return { ok: true };
}
```

In `validateTool`, after the `pattern` check passes, add:

```typescript
  if (obj.requestMapping !== undefined) {
    if (obj.pattern !== 'http')
      return { ok: false, error: 'requestMapping is only allowed when pattern is "http"' };
    const r = validateRequestMapping(obj.requestMapping);
    if (!r.ok) return r;
  }
```

(Place this after the existing `pattern` validation so `obj.pattern` is known good. If `validateTool` returns early on a bad pattern, this code is only reached for valid patterns — correct.)

- [ ] **Step 1.5: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/tools/types.test.ts
```

Expected: build clean; all tests pass (existing + 11 new).

- [ ] **Step 1.6: Commit**

```bash
git add src/tools/types.ts src/tools/types.test.ts
git commit -m "feat(tools): RequestMapping type + validation (http pattern only)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Bridge helpers — `buildMappedRequest` + `extractResponsePath`

Two pure, unit-testable functions in the bridge, plus the test file. No wiring into `executeToolBridgeHttp` yet (Task 3) — this task is just the testable logic.

**Files:**
- Modify: `container/agent-runner/src/tool-server.ts`
- Test (create): `src/tool-server-mapping.test.ts`

Note: existing bridge unit tests live at repo root as `src/tool-server-bridge.test.ts` and import from `'../container/agent-runner/src/tool-server.js'`. Mirror that import path and the `vi.hoisted` env + `vi.mock('redis', ...)` preamble (the module reads env at load and starts `main()` on import). Read `src/tool-server-bridge.test.ts` first and copy its preamble verbatim.

- [ ] **Step 2.1: Write the failing tests** — create `src/tool-server-mapping.test.ts`:

```typescript
/**
 * Unit tests for the request-mapping helpers in tool-server.ts.
 * Mirrors src/tool-server-bridge.test.ts: env set via vi.hoisted, redis mocked,
 * before importing the module (it reads env at load and starts main()).
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.KUBECLAW_TOOL_JOB_ID = 'test-job-id';
  process.env.KUBECLAW_CATEGORY = 'weather';
  process.env.REDIS_URL = 'redis://localhost:6379';
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
  buildMappedRequest,
  extractResponsePath,
} from '../container/agent-runner/src/tool-server.js';

describe('buildMappedRequest', () => {
  it('substitutes path tokens (URL-encoded) and builds the localhost URL', () => {
    const r = buildMappedRequest(
      { method: 'GET', path: '/weather/{city}' },
      { city: 'São Paulo' },
      8080,
    );
    expect(r.method).toBe('GET');
    expect(r.url).toBe('http://localhost:8080/weather/S%C3%A3o%20Paulo');
    expect(r.body).toBeUndefined();
  });

  it('encodes query params from fields and literals', () => {
    const r = buildMappedRequest(
      { method: 'GET', path: '/w', query: { q: '{city}', units: 'metric' } },
      { city: 'a b' },
      8080,
    );
    // order-independent assertion
    const u = new URL(r.url);
    expect(u.pathname).toBe('/w');
    expect(u.searchParams.get('q')).toBe('a b');
    expect(u.searchParams.get('units')).toBe('metric');
  });

  it('substitutes header tokens and strips newlines', () => {
    const r = buildMappedRequest(
      { method: 'GET', path: '/x', headers: { 'X-City': '{city}', Accept: 'application/json' } },
      { city: 'NYC\r\nX-Injected: evil' },
      8080,
    );
    expect(r.headers['Accept']).toBe('application/json');
    expect(r.headers['X-City']).toBe('NYCX-Injected: evil'); // CR/LF stripped
  });

  it('preserves JSON type for a body leaf that is exactly "{field}"', () => {
    const r = buildMappedRequest(
      { method: 'POST', path: '/q', body: { n: '{count}', label: 'x', nested: { v: '{flag}' } } },
      { count: 42, flag: true },
      8080,
    );
    const parsed = JSON.parse(r.body!);
    expect(parsed).toEqual({ n: 42, label: 'x', nested: { v: true } });
    expect(r.headers['Content-Type']).toBe('application/json');
  });

  it('string-interpolates a body leaf that embeds a token in a larger string', () => {
    const r = buildMappedRequest(
      { method: 'POST', path: '/q', body: { greeting: 'hello {name}' } },
      { name: 'Sam' },
      8080,
    );
    expect(JSON.parse(r.body!)).toEqual({ greeting: 'hello Sam' });
  });

  it('throws when a referenced field is missing from input', () => {
    expect(() =>
      buildMappedRequest({ method: 'GET', path: '/weather/{city}' }, {}, 8080),
    ).toThrow(/missing field "city"/);
  });

  it('defaults Accept: application/json', () => {
    const r = buildMappedRequest({ method: 'GET', path: '/x' }, {}, 8080);
    expect(r.headers['Accept']).toBe('application/json');
  });
});

describe('extractResponsePath', () => {
  it('extracts a top-level field', () => {
    expect(extractResponsePath('{"temp":21}', 'temp')).toBe('21');
  });

  it('extracts a nested field', () => {
    expect(extractResponsePath('{"current":{"temp_c":21.5}}', 'current.temp_c')).toBe('21.5');
  });

  it('returns a JSON string for an extracted object/array subtree', () => {
    expect(extractResponsePath('{"a":{"b":[1,2]}}', 'a.b')).toBe('[1,2]');
  });

  it('throws when the path is not found', () => {
    expect(() => extractResponsePath('{"a":1}', 'b.c')).toThrow(/responsePath "b.c"/);
  });

  it('throws when the body is not JSON', () => {
    expect(() => extractResponsePath('not json', 'a')).toThrow(/not JSON/);
  });
});
```

- [ ] **Step 2.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/tool-server-mapping.test.ts
```

Expected: FAIL — `buildMappedRequest` / `extractResponsePath` not exported.

- [ ] **Step 2.3: Implement the helpers**

In `container/agent-runner/src/tool-server.ts`, add near the top-level helpers (after `fetchWithRetry` / the readiness helpers, before `executeToolBridgeHttp`). First, define the mapping type locally (the bridge does not import from `src/` — keep an independent local interface mirroring the spec):

```typescript
interface RequestMapping {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  responsePath?: string;
}

interface MappedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Resolve "{field}" tokens in a string against input; throws on a missing field.
 *  `raw=true` returns the substituted string; used for path/query/header positions. */
function substituteString(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(TOKEN_RE, (_m, field: string) => {
    if (!(field in input)) {
      throw new Error(`request mapping references missing field "${field}"`);
    }
    const v = input[field];
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Substitute tokens inside a JSON body template. A string leaf exactly equal to
 *  "{field}" is replaced with the field's value preserving its JSON type; a leaf
 *  embedding a token in a larger string is string-interpolated. */
function substituteBody(node: unknown, input: Record<string, unknown>): unknown {
  if (typeof node === 'string') {
    const exact = node.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (exact) {
      const field = exact[1];
      if (!(field in input)) {
        throw new Error(`request mapping references missing field "${field}"`);
      }
      return input[field]; // preserve JSON type
    }
    return substituteString(node, input);
  }
  if (Array.isArray(node)) return node.map((n) => substituteBody(n, input));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = substituteBody(v, input);
    return out;
  }
  return node;
}

export function buildMappedRequest(
  mapping: RequestMapping,
  input: Record<string, unknown>,
  port: number,
): MappedRequest {
  const path = substituteString(mapping.path, input);
  const url = new URL(`http://localhost:${port}${path}`);
  if (mapping.query) {
    for (const [k, tmpl] of Object.entries(mapping.query)) {
      url.searchParams.set(k, substituteString(tmpl, input));
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (mapping.headers) {
    for (const [k, tmpl] of Object.entries(mapping.headers)) {
      // strip CR/LF to prevent header injection
      headers[k] = substituteString(tmpl, input).replace(/[\r\n]/g, '');
    }
  }
  let body: string | undefined;
  if (mapping.body !== undefined) {
    body = JSON.stringify(substituteBody(mapping.body, input));
    headers['Content-Type'] = 'application/json';
  }
  return { url: url.toString(), method: mapping.method, headers, body };
}

export function extractResponsePath(bodyText: string, responsePath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `responsePath "${responsePath}" requested but response body is not JSON: ${bodyText.slice(0, 120)}`,
    );
  }
  let cur: unknown = parsed;
  for (const seg of responsePath.split('.')) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      throw new Error(
        `responsePath "${responsePath}" not found in response: ${bodyText.slice(0, 120)}`,
      );
    }
  }
  return typeof cur === 'string' ? cur : JSON.stringify(cur);
}
```

- [ ] **Step 2.4: Build the agent-runner + run the tests**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
cd container/agent-runner && npm run build && cd ../..
npx vitest run src/tool-server-mapping.test.ts src/tool-server-bridge.test.ts
```

Expected: all pass (the existing bridge tests must remain green).

- [ ] **Step 2.5: Commit**

```bash
git add container/agent-runner/src/tool-server.ts src/tool-server-mapping.test.ts
git commit -m "feat(tool-bridge): buildMappedRequest + extractResponsePath helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the mapping into `executeToolBridgeHttp`

Branch the http-bridge on `KUBECLAW_TOOL_REQUEST_MAPPING`: unset → `/invoke` (unchanged); set → build the mapped request, send via the existing readiness gate + `fetchWithRetry`, shape the response.

**Files:**
- Modify: `container/agent-runner/src/tool-server.ts`
- Test: `src/tool-server-mapping.test.ts` (extend)

- [ ] **Step 3.1: Write the failing test** — append to `src/tool-server-mapping.test.ts`. This test exercises the mapped branch of `executeToolBridgeHttp` by stubbing `fetch` and setting the mapping env. Because `executeToolBridgeHttp` is not exported, test it through the exported dispatch if available, OR export it. Simplest: export `executeToolBridgeHttp` for testing (add `export` to its declaration in Task 3.2). Then:

```typescript
import { executeToolBridgeHttp } from '../container/agent-runner/src/tool-server.js';

describe('executeToolBridgeHttp — mapped mode', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KUBECLAW_TOOL_REQUEST_MAPPING;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KUBECLAW_TOOL_REQUEST_MAPPING;
  });

  it('builds a GET from the mapping and returns the raw body when no responsePath', async () => {
    process.env.KUBECLAW_TOOL_REQUEST_MAPPING = JSON.stringify({
      method: 'GET',
      path: '/weather/{city}',
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://localhost:8080/weather/NYC');
      return new Response('{"temp":21}', { status: 200 });
    });
    // ready probe also calls fetch; make the probe (path '/') succeed too:
    vi.stubGlobal('fetch', fetchMock);
    const out = await executeToolBridgeHttp('weather', { city: 'NYC' });
    expect(out).toBe('{"temp":21}');
  });

  it('extracts responsePath when set', async () => {
    process.env.KUBECLAW_TOOL_REQUEST_MAPPING = JSON.stringify({
      method: 'GET',
      path: '/w',
      responsePath: 'current.temp_c',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"current":{"temp_c":21.5}}', { status: 200 })),
    );
    const out = await executeToolBridgeHttp('weather', {});
    expect(out).toBe('21.5');
  });

  it('still uses /invoke when no mapping env is set', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://localhost:8080/invoke');
      return new Response('{"result":"ok"}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await executeToolBridgeHttp('weather', { city: 'NYC' });
    expect(out).toBe('ok');
  });
});
```

Note on the readiness gate: `ensureToolReady` is memoized per-process and only probes for http/acp modes. In these unit tests `KUBECLAW_TOOL_MODE` is unset (the hoisted env only sets JOB_ID/CATEGORY), so `ensureToolReady` resolves immediately without a probe — the `fetch` mock therefore only sees the actual request. If a test observes an unexpected extra `fetch` call, confirm `KUBECLAW_TOOL_MODE` is unset in this file's hoisted env (it should be).

- [ ] **Step 3.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/tool-server-mapping.test.ts
```

Expected: FAIL — `executeToolBridgeHttp` not exported and/or no mapped branch.

- [ ] **Step 3.3: Implement the branch**

Replace `executeToolBridgeHttp` (line 333) with the following. IMPORTANT: read the mapping env **inside** the function, not as a module-level const — a module const captures the value at import time and the per-test `process.env` changes in Step 3.1 would never be observed. Reading it per call is correct (the env is stable in production) and testable. Note the added `export` for testability:

```typescript
export async function executeToolBridgeHttp(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  await ensureToolReady();

  const rawRequestMapping = process.env.KUBECLAW_TOOL_REQUEST_MAPPING;
  if (rawRequestMapping) {
    let mapping: RequestMapping;
    try {
      mapping = JSON.parse(rawRequestMapping) as RequestMapping;
    } catch (err) {
      throw new Error(
        `invalid KUBECLAW_TOOL_REQUEST_MAPPING: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const req = buildMappedRequest(mapping, input, toolPort);
    const res = await fetchWithRetry(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    const text = await res.text();
    const shaped = mapping.responsePath
      ? extractResponsePath(text, mapping.responsePath)
      : text;
    return shaped.slice(0, MAX_TOOL_OUTPUT_BYTES);
  }

  // Default contract: POST /invoke with {tool, input}
  const res = await fetchWithRetry(`http://localhost:${toolPort}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, input }),
  });
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result ?? null;
}
```

(`fetchWithRetry` already throws `Tool HTTP {status}: {body}` on non-2xx and retries 5xx — the mapped path inherits this for free. The unresolved-token error from `buildMappedRequest` propagates out of `executeTool` and is written to the toolresults stream by the existing main-loop catch.)

- [ ] **Step 3.4: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
cd container/agent-runner && npm run build && cd ../..
npx vitest run src/tool-server-mapping.test.ts src/tool-server-bridge.test.ts
```

Expected: all pass.

- [ ] **Step 3.5: Commit**

```bash
git add container/agent-runner/src/tool-server.ts src/tool-server-mapping.test.ts
git commit -m "feat(tool-bridge): honor KUBECLAW_TOOL_REQUEST_MAPPING in http-bridge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Stamp the mapping env at spawn

When a sidecar tool pod is created for a tool with a `requestMapping`, pass it to the bridge container via `KUBECLAW_TOOL_REQUEST_MAPPING`.

**Files:**
- Modify: `src/k8s/job-runner.ts`
- Test: `src/k8s/job-runner.test.ts`

- [ ] **Step 4.1: Write the failing tests** — in `src/k8s/job-runner.test.ts`, inside `describe('createSidecarToolPodJob', ...)` (reuse the existing `baseSpec` fixture there):

```typescript
    it('stamps KUBECLAW_TOOL_REQUEST_MAPPING when toolSpec.requestMapping is set', async () => {
      const mapping = { method: 'GET', path: '/weather/{city}' };
      await jobRunner.createSidecarToolPodJob({
        ...baseSpec,
        toolSpec: { ...baseSpec.toolSpec, requestMapping: mapping },
      });
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      const env = bridge.env.find(
        (e: any) => e.name === 'KUBECLAW_TOOL_REQUEST_MAPPING',
      );
      expect(env).toBeTruthy();
      expect(JSON.parse(env.value)).toEqual(mapping);
    });

    it('omits KUBECLAW_TOOL_REQUEST_MAPPING when requestMapping is absent', async () => {
      await jobRunner.createSidecarToolPodJob(baseSpec);
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const bridge = call.body.spec.template.spec.containers.find(
        (c: any) => c.name === 'kubeclaw-tool-bridge',
      );
      expect(bridge.env.map((e: any) => e.name)).not.toContain(
        'KUBECLAW_TOOL_REQUEST_MAPPING',
      );
    });
```

(If `baseSpec.toolSpec.pattern` is not `'http'` in the existing fixture, set it to `'http'` in the first test's spread so the mapping is valid in spirit — the job-runner does not re-validate, but keep it coherent.)

- [ ] **Step 4.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/k8s/job-runner.test.ts
```

Expected: the first new test FAILS (env not present); TS may reject `requestMapping` on the literal until Task 1 is merged — it is (Task 1 precedes this), so it should type-check.

- [ ] **Step 4.3: Implement the stamp**

In `src/k8s/job-runner.ts` `createSidecarToolPodJob`, after the `if (toolSpec.healthPath) { bridgeEnv.push(...) }` block (~line 1788), add:

```typescript
    if (toolSpec.requestMapping) {
      bridgeEnv.push({
        name: 'KUBECLAW_TOOL_REQUEST_MAPPING',
        value: JSON.stringify(toolSpec.requestMapping),
      });
    }
```

- [ ] **Step 4.4: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/k8s/job-runner.test.ts
```

Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "feat(tools): stamp requestMapping into the bridge container env at spawn

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Integration test — real bridge honors the mapping over localhost

Extend `e2e/sidecar-tool-pod.test.ts` (real compiled `tool-server.js` subprocess + a local HTTP server standing in for the `user-tool` container). Prove the mapped request reaches the right URL/method/body and the response is shaped correctly.

**Files:**
- Modify: `e2e/sidecar-tool-pod.test.ts`

- [ ] **Step 5.1: Read the existing harness**

Read `e2e/sidecar-tool-pod.test.ts` fully: how it (a) ensures the agent-runner is built (`ensureToolServerBuilt`), (b) spawns `node dist/tool-server.js` with env (`KUBECLAW_TOOL_JOB_ID`, `KUBECLAW_CATEGORY`, `KUBECLAW_TOOL_MODE=http-bridge`, `KUBECLAW_TOOL_PORT`, `REDIS_URL`), (c) seeds `kubeclaw:toolcalls:{jobId}:{category}` and reads `kubeclaw:toolresults:{jobId}:{category}` via `waitForToolResult`, (d) stands up a local HTTP server for the user-tool container, (e) uses dynamic ports (`reserveEphemeralPort` / `listen(0)`) and cleans up streams in `finally`. Mirror these exactly.

- [ ] **Step 5.2: Add the mapped-mode describe block**

Add a `describe('Sidecar Tool Pod — request mapping')` that, for each case, starts a local HTTP server, spawns the bridge with `KUBECLAW_TOOL_MODE=http-bridge` plus `KUBECLAW_TOOL_REQUEST_MAPPING` set to the case's mapping JSON, seeds a tool call with an `input`, and asserts the result. Follow the existing file's spawn/seed/assert helpers; the new env var is the only addition to the spawn env. Cover:

1. **GET with path + query + raw-body response:** mapping `{method:'GET', path:'/weather/{city}', query:{units:'{units}'}}`; input `{city:'NYC', units:'metric'}`; server asserts `req.url === '/weather/NYC?units=metric'` and returns `{"temp":21}`; assert the tool result is `{"temp":21}` (raw body, no error).
2. **POST with JSON body type preservation:** mapping `{method:'POST', path:'/q', body:{count:'{count}', q:'{query}'}}`; input `{count: 3, query:'rain'}`; server reads the body and asserts `body.count === 3` (number, not "3") and `body.q === 'rain'`; returns `{"ok":true}`; assert result.
3. **responsePath extraction:** mapping `{method:'GET', path:'/w', responsePath:'current.temp_c'}`; server returns `{"current":{"temp_c":21.5}}`; assert the tool result is `21.5`.
4. **404 → tool error:** mapping `{method:'GET', path:'/missing'}`; server responds 404; assert the toolresults entry has an `error` containing `Tool HTTP 404`.

For each, the server handler must tolerate the readiness probe: the bridge probes `GET {healthPath || '/'}` before the first call. Either return 200 for the probe path, or (simpler) have the handler return 200 for any GET that isn't the asserted path and only assert URL on the mapped call — match how the existing retry/readiness tests in this file handle the probe. Use dynamic ports and clean up streams in `finally` exactly as the existing tests do.

- [ ] **Step 5.3: Run**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run e2e/sidecar-tool-pod.test.ts --config vitest.e2e.config.ts
```

Expected: PASS (existing + 4 new). Requires the local test Redis from `e2e/setup.ts` (available in this environment).

- [ ] **Step 5.4: Commit**

```bash
git add e2e/sidecar-tool-pod.test.ts
git commit -m "test(tool-bridge): integration coverage for request-mapping over localhost

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Admin-shell `register_tool` accepts `requestMapping`

The admin-shell `register_tool`/`edit_tool` tool defs and handlers must accept and pass through `requestMapping` so operators can register a mapped tool. (The registry/validation already accept it via Task 1; this exposes it through the admin command.)

**Files:**
- Modify: `src/admin-shell.ts`
- Test: `src/admin-shell.test.ts`

- [ ] **Step 6.1: Write the failing test** — in `src/admin-shell.test.ts`, inside the `register_tool` describe (added in the catalog work), add:

```typescript
  it('passes requestMapping through to registerTool', async () => {
    const mapping = { method: 'GET', path: '/weather/{city}', responsePath: 'temp' };
    await executeTool('register_tool', {
      name: 'weather',
      description: 'Weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      image: 'ghcr.io/example/weather:1',
      pattern: 'http',
      requestMapping: mapping,
    });
    expect(mockRegisterTool).toHaveBeenCalledWith(
      expect.objectContaining({ requestMapping: mapping }),
      expect.any(Function),
    );
  });
```

(Match the file's actual invocation convention — `executeTool('register_tool', input)` vs a direct handler call — by reading the neighbouring `register_tool` tests.)

- [ ] **Step 6.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/admin-shell.test.ts
```

Expected: FAIL — `requestMapping` not in the spec built by `handleRegisterTool`.

- [ ] **Step 6.3: Implement**

In `src/admin-shell.ts`:

1. In the `register_tool` tool definition's `parameters.properties`, add a `requestMapping` property so the admin LLM can supply it:

```typescript
          requestMapping: {
            type: 'object',
            description:
              'Optional HTTP request mapping (pattern "http" only): how to build the real request to the tool container. Fields: method, path ("/x/{field}"), query, headers, body, responsePath.',
            properties: {
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
              path: { type: 'string' },
              query: { type: 'object' },
              headers: { type: 'object' },
              body: {},
              responsePath: { type: 'string' },
            },
          },
```

Add the same `requestMapping` property block to the `edit_tool` definition's properties.

2. In `handleRegisterTool`, add a conditional spread for `requestMapping` alongside the other optionals:

```typescript
    ...(input.requestMapping !== undefined && {
      requestMapping: input.requestMapping as Record<string, unknown>,
    }),
```

3. In `handleEditTool`, add `'requestMapping'` to the list of patchable field names so an edit can set/replace it.

- [ ] **Step 6.4: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/admin-shell.test.ts
```

Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add src/admin-shell.ts src/admin-shell.test.ts
git commit -m "feat(tools): admin-shell register/edit_tool accept requestMapping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation

Document `requestMapping` in the tool-bridge docs and the catalog/tool-author guidance.

**Files:**
- Modify: `docs/TOOL_BRIDGE.md`

- [ ] **Step 7.1: Add a request-mapping section**

In `docs/TOOL_BRIDGE.md`, add a section under the http-pattern documentation explaining: the default `/invoke` contract still applies when no mapping is set; with `requestMapping`, the bridge builds the real request to the container; the schema fields (method, path with `{field}` tokens, query, headers, body, responsePath); the encoding rules (URL-encode in path/query, newline-stripping in headers, JSON-type preservation for exact-token body leaves); response handling (raw body or `responsePath` extraction, truncated to the output cap); and a worked example:

```yaml
# A stock weather REST image, driven via request mapping (no /invoke needed):
tools:
  - name: weather
    description: Current weather for a city
    parameters:
      type: object
      properties:
        city: { type: string }
        units: { type: string }
      required: [city]
    image: ghcr.io/example/weather-api:1      # must also be in TOOL_IMAGE_ALLOWLIST
    pattern: http
    port: 8080
    requestMapping:
      method: GET
      path: /v1/weather/{city}
      query:
        units: "{units}"
      responsePath: current.summary
```

Note that the mapping targets the container on localhost (not an external URL), and that the container owns its own upstream credentials/egress.

- [ ] **Step 7.2: Commit**

```bash
git add docs/TOOL_BRIDGE.md
git commit -m "docs: document per-tool HTTP request-mapping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification

- [ ] **Step 8.1: Clean build (both) + full unit suite**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build && cd container/agent-runner && npm run build && cd ../..
npm test 2>&1 | grep -E "Test Files|Tests "
```

Expected: all pass.

- [ ] **Step 8.2: Integration suite**

```bash
npm run test:e2e -- e2e/sidecar-tool-pod.test.ts e2e/tool-catalog-spawn.test.ts 2>&1 | tail -4
```

Expected: pass.

- [ ] **Step 8.3: Minikube-live (if a cluster is available)**

```bash
kubectl get nodes >/dev/null 2>&1 && npm run test:e2e -- e2e/alpine-tool-execution.test.ts e2e/tool-pod-spawn.test.ts 2>&1 | tail -4 || echo "No cluster — live e2e skipped (note in report)"
```

Expected if cluster present: pass (confirms the spawn path with the new env stamp didn't regress). If skipped, say so explicitly.

- [ ] **Step 8.4: Two-stage review**

Run the repo's spec-compliance then code-quality review per the project's review policy before reporting complete.

---

## Out of scope (do not do these here)

- The `file` and `acp` bridge patterns — `requestMapping` is `http`-only and rejected on the others by validation.
- Targeting external URLs directly (no container) — a mapped request always targets `http://localhost:{port}`.
- Form-encoded / multipart bodies — JSON bodies only.
- A template/expression language beyond `{field}` token substitution.
- Array indexing in `responsePath` — dot-separated object keys only (a non-object segment is a miss error).
- Credential injection for the container's own upstream calls — handled by the existing Envoy/broker egress path, not this feature.
