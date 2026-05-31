# Structured-results web-search backend (Brave Search) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile DuckDuckGo HTML scrape in `toolWebSearch` with the Brave Search API, routing the API key through the credential broker so that `sidecar`/`istio` mode tool-job pods never see the real key.

**Architecture:** The Brave Search API (`api.search.brave.com`) is added to `credentialInjection.catalog` in `values.yaml` so the broker stamps `X-Subscription-Token` at egress in sidecar/istio modes. The `toolWebSearch` function in `container/agent-runner/src/tool-server.ts` is rewritten to call `https://api.search.brave.com/res/v1/web/search?q=<query>&count=10`, map `web.results[]` to structured `{title, url, snippet, published, source}` records, and return a JSON string. In `credentialInjection.mode: off`, the function reads `process.env.BRAVE_API_KEY` directly and sets the header itself. The `web_search` tool description in `src/runtime/direct-llm-runner.ts` is updated to document the richer structured return fields.

**Tech Stack:** TypeScript, vitest, Brave Search API, Envoy ext_authz

---

## Pre-flight

Read before starting:
- `container/agent-runner/src/tool-server.ts` lines 125–136 (current `toolWebSearch`) and lines 280–300 (dispatch table)
- `src/runtime/direct-llm-runner.ts` lines 105–119 (`web_search` tool definition)
- `helm/kubeclaw/values.yaml` lines 411–425 (`credentialInjection.catalog` schema and example)
- `src/credential-injection/workload-env.ts` (full — `KC_PH_*` placeholder env var conventions)
- `e2e/minikube-live-browser.test.ts` lines 349–423 (existing `web_search` test to update)

**Branch:** create a worktree via `superpowers:using-git-worktrees`. Don't work on `main`.

**Test command (agent-runner package has no vitest):** unit and integration tests run from the repo root with `npx vitest run` (or `npm test`). The agent-runner package itself has no `devDependencies` on vitest — tests for `tool-server.ts` live under `src/` in the root package which is already configured in `vitest.config.ts`.

---

## Task 1: Brave Search catalog entry in `helm/kubeclaw/values.yaml`

**Files:**
- Modify: `helm/kubeclaw/values.yaml:415`
- Test: `e2e/credential-injection-integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add a new `describe` block at the bottom of `e2e/credential-injection-integration.test.ts`:

```typescript
// ─── 3. Brave Search catalog entry ───────────────────────────────────────────

describe('brave-search catalog entry renders correctly', () => {
  const BRAVE_CATALOG_ARGS =
    `--set 'credentialInjection.catalog[0].id=brave-search'` +
    ` --set 'credentialInjection.catalog[0].host=api.search.brave.com'` +
    ` --set 'credentialInjection.catalog[0].upstreamPort=443'` +
    ` --set 'credentialInjection.catalog[0].credentialFields[0].name=api_key'` +
    ` --set 'credentialInjection.catalog[0].credentialFields[0].envVar=BRAVE_API_KEY'` +
    ` --set 'credentialInjection.catalog[0].allowOperatorFallback=true'` +
    ` --set 'credentialInjection.catalog[0].allowedPositions[0]=header'`;

  it('renders the broker ConfigMap with brave-search host', () => {
    const out = helmTemplate(`--set credentialInjection.mode=sidecar ${BRAVE_CATALOG_ARGS}`);
    expect(out).toContain('api.search.brave.com');
    expect(out).toContain('BRAVE_API_KEY');
  });

  it('brave-search entry parses with allowedPositions: header', () => {
    const out = helmTemplate(`--set credentialInjection.mode=sidecar ${BRAVE_CATALOG_ARGS}`);
    expect(out).toContain('allowedPositions');
    // The rendered ConfigMap must not embed any real key
    expect(out).not.toMatch(/BSA[A-Za-z0-9]{25,}/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run e2e/credential-injection-integration.test.ts
```

Expected: FAIL — `api.search.brave.com` not found in rendered output because the `catalog` entry does not exist yet.

- [ ] **Step 3: Add the `brave-search` entry to `helm/kubeclaw/values.yaml`**

In `helm/kubeclaw/values.yaml`, replace the `catalog: []` line at line 415 with:

```yaml
  catalog:
    - id: brave-search
      host: api.search.brave.com
      upstreamPort: 443
      credentialFields:
        - { name: api_key, envVar: BRAVE_API_KEY }
      allowOperatorFallback: true
      allowedPositions: [header]
      apiKeyShape: { prefix: "BSA", minLength: 30 }
```

- [ ] **Step 4: Run test, verify passes**

```bash
npx vitest run e2e/credential-injection-integration.test.ts
```

Expected: all 4 tests in the file pass (2 pre-existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/values.yaml e2e/credential-injection-integration.test.ts
git commit -m "feat: add brave-search to credentialInjection.catalog"
```

---

## Task 2: Replace `toolWebSearch` in `container/agent-runner/src/tool-server.ts`

**Files:**
- Create: `src/tool-server.test.ts`
- Modify: `container/agent-runner/src/tool-server.ts:125-136`
- Test: `src/tool-server.test.ts`

> **Note on test location:** The agent-runner package (`container/agent-runner/`) has no vitest dev dependency. Tests for `tool-server.ts` are placed under the root `src/` directory, which `vitest.config.ts` already includes. The test file imports `toolWebSearch` after it is refactored into an exportable form (see Step 3).

- [ ] **Step 1: Write the failing unit tests**

Create `/home/peter/projects/kubeclaw/src/tool-server.test.ts`:

```typescript
/**
 * Unit tests for toolWebSearch (Brave Search backend).
 *
 * Stubs globalThis.fetch so no real HTTP requests are made.
 * Tests run under vitest with the root vitest.config.ts (src/**\/\*.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Re-export shim ---
// toolWebSearch is not exported by tool-server.ts today.  After Step 3 adds
// `export` to the function declaration, this import will resolve.
import { toolWebSearch } from '../container/agent-runner/src/tool-server.js';

// Brave Search API shape: web.results[]
function makeBraveResponse(overrides: Partial<{
  results: Array<{ title: string; url: string; description: string; age?: string; meta_url?: { hostname: string } }>;
  statusCode: number;
}> = {}): { statusCode: number; body: object } {
  const results = overrides.results ?? [
    {
      title: 'Kubernetes Networking',
      url: 'https://kubernetes.io/docs/concepts/cluster-administration/networking/',
      description: 'Kubernetes assumes that pods can communicate with other pods.',
      age: '2024-01-01T00:00:00Z',
      meta_url: { hostname: 'kubernetes.io' },
    },
  ];
  return {
    statusCode: overrides.statusCode ?? 200,
    body: { web: { results } },
  };
}

describe('toolWebSearch — Brave Search backend', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Clear env so tests start clean
    delete process.env.BRAVE_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRAVE_API_KEY;
  });

  // ── (a) Happy path: returns JSON with `snippet` ───────────────────────────
  it('happy path: returns JSON array containing snippet field', async () => {
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: statusCode === 200,
      status: statusCode,
      json: async () => body,
    } as Response);

    const raw = await toolWebSearch({ query: 'kubernetes networking' });
    const results = JSON.parse(raw) as Array<{ title: string; url: string; snippet: string; published?: string; source?: string }>;

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toHaveProperty('snippet');
    expect(results[0]).toHaveProperty('title');
    expect(results[0]).toHaveProperty('url');
    expect(results[0].snippet).toBe('Kubernetes assumes that pods can communicate with other pods.');
  });

  // ── (b) Non-200 response throws a descriptive error ──────────────────────
  it('non-200 response throws a descriptive error containing the status code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    } as unknown as Response);

    await expect(toolWebSearch({ query: 'test' })).rejects.toThrow('429');
  });

  // ── (c) Placeholder key (sidecar/istio): header NOT set ──────────────────
  it('placeholder key starting with KC_PH_ does NOT set X-Subscription-Token header', async () => {
    process.env.BRAVE_API_KEY = 'KC_PH_brave-search_api_key';
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: statusCode,
      json: async () => body,
    } as Response);

    await toolWebSearch({ query: 'test' });

    const [, initArg] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = initArg?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Subscription-Token']).toBeUndefined();
  });

  it('literal injected-by-broker value does NOT set X-Subscription-Token header', async () => {
    process.env.BRAVE_API_KEY = 'injected-by-broker';
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: statusCode,
      json: async () => body,
    } as Response);

    await toolWebSearch({ query: 'test' });

    const [, initArg] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = initArg?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Subscription-Token']).toBeUndefined();
  });

  // ── (d) Real key (mode: off): header IS set ───────────────────────────────
  it('real BRAVE_API_KEY sets X-Subscription-Token header', async () => {
    process.env.BRAVE_API_KEY = 'BSArealkey1234567890abcdefghijklmno';
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: statusCode,
      json: async () => body,
    } as Response);

    await toolWebSearch({ query: 'test' });

    const [, initArg] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = initArg?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Subscription-Token']).toBe('BSArealkey1234567890abcdefghijklmno');
  });

  // ── (e) Empty results: returns empty JSON array ───────────────────────────
  it('empty web.results array returns empty JSON array', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    } as Response);

    const raw = await toolWebSearch({ query: 'xyzzy' });
    expect(JSON.parse(raw)).toEqual([]);
  });

  // ── (f) Correct API URL and query encoding ────────────────────────────────
  it('constructs the correct Brave Search API URL with encoded query', async () => {
    const { statusCode, body } = makeBraveResponse();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: statusCode,
      json: async () => body,
    } as Response);

    await toolWebSearch({ query: 'kubernetes networking' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=kubernetes%20networking&count=10',
    );
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/tool-server.test.ts
```

Expected: FAIL — the import `{ toolWebSearch }` will fail because `toolWebSearch` is not currently exported, and the implementation still calls DuckDuckGo.

- [ ] **Step 3: Rewrite `toolWebSearch` and export it**

In `container/agent-runner/src/tool-server.ts`, replace lines 125–136:

**Before:**
```typescript
async function toolWebSearch(input: { query: string }): Promise<string> {
  // Use DuckDuckGo HTML endpoint
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 KubeClaw/1.0' } });
  const html = await res.text();
  // Extract result titles and snippets
  const results = [...html.matchAll(/<a class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)]
    .slice(0, 10)
    .map(([, url, title]) => `${title}: ${url}`)
    .join('\n');
  return results || html.slice(0, 5000);
}
```

**After:**
```typescript
export interface BraveSearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  source?: string;
}

export async function toolWebSearch(input: { query: string }): Promise<string> {
  const apiUrl =
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=10`;

  // In sidecar/istio mode the workload's HTTPS_PROXY routes through Envoy and
  // the broker stamps X-Subscription-Token via ext_authz — do NOT set the
  // header manually.  In mode=off read BRAVE_API_KEY directly.
  const key = process.env.BRAVE_API_KEY;
  const shouldSetHeader =
    !!key &&
    !key.startsWith('KC_PH_') &&
    key !== 'injected-by-broker';

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
  };
  if (shouldSetHeader) {
    headers['X-Subscription-Token'] = key!;
  }

  const res = await fetch(apiUrl, { headers });
  if (!res.ok) {
    throw new Error(
      `Brave Search API returned ${res.status}: ${await res.text()}`,
    );
  }

  const data = await res.json() as { web?: { results?: Array<{
    title?: string;
    url?: string;
    description?: string;
    age?: string;
    meta_url?: { hostname?: string };
  }> } };

  const results: BraveSearchResult[] = (data.web?.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
    published: r.age,
    source: r.meta_url?.hostname,
  }));

  return JSON.stringify(results);
}
```

- [ ] **Step 4: Run test, verify passes**

```bash
npx vitest run src/tool-server.test.ts
```

Expected: all 6 unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/tool-server.ts src/tool-server.test.ts
git commit -m "feat: replace DuckDuckGo scrape with Brave Search API in toolWebSearch"
```

---

## Task 3: Update `web_search` tool description in `src/runtime/direct-llm-runner.ts`

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts:108-118`
- Test: `src/direct-llm-runner.description.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `/home/peter/projects/kubeclaw/src/direct-llm-runner.description.test.ts`:

```typescript
/**
 * Lightweight snapshot test for the web_search tool definition in TOOLS.
 *
 * Ensures the description documents structured result fields (snippet, url,
 * title) so the LLM knows what to expect from the new Brave Search backend.
 * No mocking needed — just imports the constant.
 */
import { describe, it, expect } from 'vitest';

// TOOLS is not currently exported.  After Step 3 adds `export`, this resolves.
import { TOOLS } from './runtime/direct-llm-runner.js';
import type OpenAI from 'openai';

describe('web_search tool definition', () => {
  const webSearchTool = (TOOLS as OpenAI.ChatCompletionFunctionTool[]).find(
    (t) => t.function.name === 'web_search',
  );

  it('tool definition exists', () => {
    expect(webSearchTool).toBeDefined();
  });

  it('description mentions structured JSON result fields', () => {
    const desc = webSearchTool!.function.description;
    expect(desc).toMatch(/snippet/i);
    expect(desc).toMatch(/title/i);
    expect(desc).toMatch(/url/i);
    expect(desc).toMatch(/json/i);
  });

  it('query parameter is still required', () => {
    const params = webSearchTool!.function.parameters as {
      required?: string[];
    };
    expect(params.required).toContain('query');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/direct-llm-runner.description.test.ts
```

Expected: FAIL — the import `{ TOOLS }` fails because `TOOLS` is not exported, and the description does not contain "snippet" or "JSON".

- [ ] **Step 3: Export `TOOLS` and update the `web_search` description**

In `src/runtime/direct-llm-runner.ts`, change the `TOOLS` declaration at line 89 from:

```typescript
const TOOLS: OpenAI.ChatCompletionFunctionTool[] = [
```

to:

```typescript
export const TOOLS: OpenAI.ChatCompletionFunctionTool[] = [
```

Then replace the `web_search` entry at lines 105–119:

**Before:**
```typescript
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for a query. Use when the user asks to look something up or find current information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
```

**After:**
```typescript
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for a query. Returns a JSON array of up to 10 results, each with ' +
        'fields: title (string), url (string), snippet (string — the most relevant excerpt), ' +
        'published (ISO date string, optional), source (hostname, optional). ' +
        'Use when the user asks to look something up or find current information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
```

- [ ] **Step 4: Run test, verify passes**

```bash
npx vitest run src/direct-llm-runner.description.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Run the full test suite to catch regressions**

```bash
npm test
```

Expected: all existing tests continue to pass. If `direct-llm-runner.ts` is imported by other test files that rely on `TOOLS` being a `const` (not exported), they will still pass — `export const` is backward-compatible.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/direct-llm-runner.description.test.ts
git commit -m "feat: document structured Brave Search return fields in web_search tool description"
```

---

## Task 4: Update the E2E test in `e2e/minikube-live-browser.test.ts`

**Files:**
- Modify: `e2e/minikube-live-browser.test.ts:349-423`
- Test: `e2e/minikube-live-browser.test.ts` (self — verified via minikube)

This task has **no unit-test step** — the E2E test is itself the test. The failing-before / passing-after cycle is enforced by the structural assertions added below (they would have failed on the old DuckDuckGo plain-text output).

> **N/A note (unit level):** The change is purely to the E2E test assertions. There is no isolatable unit to stub here — the assertions exercise the live SSE stream against a real cluster.

- [ ] **Step 1: Update the `web_search` E2E test to assert structured JSON results**

In `e2e/minikube-live-browser.test.ts`, replace the entire `web_search` test (lines 349–423) with the version below. Key change: after pod execution, the SSE stream check now attempts to JSON-parse the tool-result payload and asserts that at least one result object has a `snippet` field. The pod-spawn and log assertions are preserved unchanged.

```typescript
  // ── 2. web_search: LLM → tool pod → Brave Search API ─────────────────────
  it(
    'web_search via channel → tool pod → Brave Search API returns structured results',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Open SSE before posting so we don't miss fast replies.
      const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);

      // Fire the POST and the tool-pod polling in parallel.
      const postPromise = postMessage(
        'You MUST call the web_search tool with query="kubernetes networking". ' +
        'Do not call any other tool. Do not respond with any text — only ' +
        'call web_search with query="kubernetes networking" right now.',
      );

      const testStartMs = Date.now();
      let podName: string | null = null;
      try {
        // Wait for the POST to return 200.
        const res = await postPromise;
        expect(res.status, 'POST /message returned unexpected status').toBe(200);

        // Poll for a tool pod — try primary label first, fall back to category label.
        // Only consider pods created after this test started.
        podName = await waitForToolPod('app=kubeclaw-tool-pod', 90_000, testStartMs);
        if (podName === null) {
          podName = await waitForToolPod('kubeclaw/category=browser', 30_000, testStartMs);
        }
        expect(
          podName,
          'No kubeclaw-tool-pod appeared within 90 s after web_search directive',
        ).not.toBeNull();

        // Poll the pod's logs for the expected execution marker.
        // tool-server.ts:357: `log(\`Executing tool=${tool} requestId=${requestId}\`)`
        const logFound = await waitForPodLog(
          podName!,
          'Executing tool=webSearch',
          90_000,
        );
        expect(
          logFound,
          `Pod ${podName} logs did not contain "Executing tool=webSearch" within 90 s`,
        ).toBe(true);
      } finally {
        // Informational + structural: did the SSE stream deliver structured data?
        let sseDelivered = false;
        let sseHasRelatedContent = false;
        let structuredSnippetFound = false;
        try {
          await sse.waitFor((l) => l.length > 0, 60_000);
          sseDelivered = sse.lines.length > 0;
          sseHasRelatedContent = sse.lines.some((l) =>
            /kubernetes|networking|container|pod|cluster/i.test(l),
          );

          // Structural assertion: try to find a tool-result SSE line that carries
          // the JSON array from the new Brave Search backend.  Look for any data
          // line that JSON-parses to an array with at least one object containing
          // a non-empty `snippet` field.
          for (const line of sse.lines) {
            try {
              const payload = JSON.parse(line) as unknown;
              // The tool result may be nested inside a wrapper object or be the
              // array directly — handle both shapes.
              const candidates: unknown[] = Array.isArray(payload)
                ? [payload]
                : (typeof payload === 'object' && payload !== null)
                  ? Object.values(payload as Record<string, unknown>)
                  : [];
              for (const candidate of candidates) {
                if (Array.isArray(candidate) && candidate.length > 0) {
                  const first = candidate[0] as Record<string, unknown>;
                  if (typeof first['snippet'] === 'string' && first['snippet'].length > 0) {
                    structuredSnippetFound = true;
                    break;
                  }
                }
              }
            } catch {
              // Not JSON — skip
            }
            if (structuredSnippetFound) break;
          }
        } catch {
          // LLM did not produce SSE output within the budget — expected for small models
        }

        console.log(
          `web_search observability: SSE delivered=${sseDelivered}, ` +
          `SSE contains related terms=${sseHasRelatedContent}, ` +
          `structured snippet in SSE=${structuredSnippetFound}, ` +
          `tool pod name=${podName ?? 'none'}`,
        );
        if (!sseDelivered) {
          console.warn(
            'web_search: SSE stream delivered no data within 60 s. ' +
            'Small model may not have responded yet — this is informational only.',
          );
        }
        // Structural assertion: if the SSE stream did deliver data, at least one
        // line must contain a `snippet` field from the Brave Search response.
        // This assertion is skipped (soft-fail with warn) when the LLM produces
        // no SSE output within the budget, because the tool result may not have
        // been relayed yet.
        if (sseDelivered) {
          expect(
            structuredSnippetFound,
            'SSE stream delivered data but no line contained a Brave Search structured result ' +
            'with a non-empty `snippet` field. The old DuckDuckGo plain-text path would also ' +
            'fail here — verify the Brave API key is injected and the broker mapping is active.',
          ).toBe(true);
        }
        sse.dispose();
      }
    },
    180_000,
  );
```

- [ ] **Step 2: Verify the test change compiles**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no TypeScript errors. The `JSON.parse` + `Array.isArray` chain is fully typed.

- [ ] **Step 3: Run the E2E test against minikube (optional, requires live cluster)**

If a minikube cluster with kubeclaw installed (`credentialInjection.mode: sidecar`, `BRAVE_API_KEY` secret provisioned) is available:

```bash
npx vitest run e2e/minikube-live-browser.test.ts
```

Expected:
- Test 1 (`web_fetch`) — passes unchanged.
- Test 2 (`web_search`) — pod spawns, logs show `Executing tool=webSearch`, and if the LLM responds via SSE, the structured `snippet` assertion passes.
- Tests 3a/3b (`browser`) — pass unchanged.

If no live cluster is available, the TypeScript compilation check in Step 2 is sufficient to gate the commit.

- [ ] **Step 4: Commit**

```bash
git add e2e/minikube-live-browser.test.ts
git commit -m "test(e2e): assert structured Brave Search snippet field in web_search SSE output"
```

---

## Test level summary

| Level | File | Coverage |
|---|---|---|
| **Unit** | `src/tool-server.test.ts` | `toolWebSearch`: happy path, non-200 error, placeholder-key header omission (sidecar/istio), real-key header set (mode:off), empty results, URL encoding |
| **Unit** | `src/direct-llm-runner.description.test.ts` | `web_search` tool definition: description mentions structured fields, `query` param still required |
| **Integration** | `e2e/credential-injection-integration.test.ts` | `brave-search` catalog entry renders with correct host + env var; no real key leaks into rendered YAML |
| **E2E** | `e2e/minikube-live-browser.test.ts` | Full path from HTTP POST → LLM tool call → tool-job pod → Brave Search API → SSE reply with `snippet`; runs against `credentialInjection.mode: sidecar` (default install) |

---

## Rollout notes

1. **Helm upgrade required** before tool pods pick up the new catalog entry (the broker ConfigMap is updated by `helm upgrade`).
2. **Secret provisioning:** add the Brave API key via the admin shell:
   ```
   /secrets set BRAVE_API_KEY BSA<your_key>
   ```
   The broker will resolve it at egress; tool-job pods never see the real value in `sidecar`/`istio` mode.
3. **mode: off fallback:** set `BRAVE_API_KEY` directly in the orchestrator environment; `toolWebSearch` reads it and sets the header itself. No broker involvement.
4. **DuckDuckGo is removed entirely** — there is no fallback. If the Brave API key is missing in `mode: off`, calls will return an HTTP 401 error thrown as an exception.
