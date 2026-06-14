# Browser Tool → `cdp` Bridge Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `browser` from a static in-process built-in into a catalog tool driven through a new `cdp` bridge pattern: the bridge holds one persistent `playwright-core` connection to a stock chromium-CDP image (default `chromedp/headless-shell`) attached as a native sidecar, exposing a stateful primitive browser contract (`navigate`/`snapshot`/`click`/`type`/`press`/`back`/`wait`) to the channel LLM.

**Architecture:** A `ToolSpec` with `pattern: 'cdp'` makes `createSidecarToolPodJob` attach `toolSpec.image` (operator's stock chromium image) as a K8s native sidecar (mirroring the existing `browserSidecar` init-container), skip the `user-tool` container, add a `/dev/shm` emptyDir, and set `KUBECLAW_CDP_URL`. The bridge (`tool-server.ts`) runs in a new `cdp-bridge` mode: `executeToolBridgeCdp` lazily `connectOverCDP`s, caches one Browser/Page across calls, and dispatches the `action` field. `browser` leaves the static maps; `places_search` is decoupled onto its own `places` category.

**Tech Stack:** TypeScript (Node 24), vitest, `playwright-core`, the sidecar bridge (`container/agent-runner/src/tool-server.ts`), the tool catalog (`src/tools/types.ts`), `src/k8s/job-runner.ts`, `src/k8s/ipc-redis.ts`, Helm. Spec: `docs/superpowers/specs/2026-06-14-browser-cdp-bridge-design.md`.

---

## Pre-flight notes for the implementer

- **Node/PATH:** `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH` before every `npm`/`node`/`npx`/`helm`. The bridge builds in `container/agent-runner/` (`cd container/agent-runner && npm install --no-audit --no-fund && npm run build`).
- **Husky:** the pre-commit hook runs `prettier --write "src/**/*.ts"` and needs `npm` on PATH — always `export PATH=…` in the commit shell. Leftover prettier drift is committed as a `style:` commit (Task 9).
- **Commit trailer:** end every commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Build-green invariant:** each commit compiles (`npm run build`) and passes `npm test`.

**Verified current shapes (do not re-derive):**
- `src/tools/types.ts`: `pattern: 'http' | 'file' | 'acp'` (~:23); `const PATTERNS = new Set(['http', 'file', 'acp'])` (~:97); pattern check `if (typeof obj.pattern !== 'string' || !PATTERNS.has(obj.pattern)) return { ok:false, error:'pattern must be one of http|file|acp' }` (~:181); `RESERVED_NAMES = new Set(['browser','places_search','execution'])` (~:72); `type ValidationResult = {ok:true}|{ok:false;error:string}` (~:61); success `return { ok: true }` (~:303). Pattern-guard idiom: `if (obj.run !== undefined) { if (obj.pattern !== 'file') return {ok:false,error:'run is only allowed when pattern is "file"'}; … }` (~:248).
- `container/agent-runner/src/tool-server.ts`: `const toolMode = process.env.KUBECLAW_TOOL_MODE as 'http-bridge'|'file-bridge'|'acp-bridge'|undefined` (~:20); dispatch `executeTool` (~:632): `if (toolMode==='acp-bridge') return executeToolBridgeAcp(...); if (toolMode==='http-bridge') return executeToolBridgeHttp(...); if (toolMode==='file-bridge') return executeToolBridgeFile(...); return executeToolLocal(...)`. `waitForToolReady`/`ensureToolReady` (~:106-152) poll `http://localhost:${toolPort}${toolHealthPath}` (env `KUBECLAW_TOOL_PORT` default 8080, `KUBECLAW_TOOL_HEALTH_PATH` default `/`), `ensureToolReady` runs only for `http-bridge`/`acp-bridge`. Consts (~:19): `toolPort`, `MAX_TOOL_OUTPUT_BYTES` (default 50000), `idleTimeout`. `main()` loop XREADs toolcalls, calls `executeTool(tool, input, requestId)`.
- `container/agent-runner/package.json` deps (~:11): `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `cron-parser`, `redis`. **No playwright.** `container/Dockerfile` copies `package*.json` (~:42), `npm install` (~:45), `npm run build` (~:51) — adding a dep + rebuild picks it up.
- `src/k8s/job-runner.ts` `createSidecarToolPodJob` (~:1714): `const isFileBridge = toolSpec.pattern==='file'; const isAcpBridge = toolSpec.pattern==='acp'; const toolMode = isFileBridge?'file-bridge':isAcpBridge?'acp-bridge':'http-bridge'` (~:1718); `bridgeEnv` array (~:1767) includes `{name:'KUBECLAW_TOOL_PORT',value:String(port)}` + conditional `KUBECLAW_TOOL_HEALTH_PATH` when `toolSpec.healthPath`; `userEnv` (~:1876); credential block (~:1883) builds `credContainers`/`credVolumes`/`credServiceAccount`/`credAnnotations`; `containers: [ {bridge}, {user-tool}, ...credContainers ]` (~:1967); `volumes` (~:1823) empty then file-bridge-only, final `volumes: [...volumes, ...credVolumes]`; `template.spec` (~:1961): `{ restartPolicy:'Never', serviceAccountName: credServiceAccount ?? '', ...(credServiceAccount?{automountServiceAccountToken:false}:{}), containers:[…], volumes:[…] }`. The `port` variable = `toolSpec.port ?? 8080`.
- `generateJobManifest` browser-sidecar block (~:1079): `const initContainers = spec.browserSidecar ? [{ name:'browser', image:BROWSER_SIDECAR_IMAGE, ports:[{containerPort:BROWSER_SIDECAR_PORT}], readinessProbe:{httpGet:{path:'/json/version',port:BROWSER_SIDECAR_PORT},initialDelaySeconds:2,periodSeconds:2,failureThreshold:10}, resources:{…}, restartPolicy:'Always' }] : undefined`; applied via `...(initContainers && { initContainers })` on `template.spec` (~:1150). **Mirror this for cdp but use `toolSpec` fields, not BROWSER_SIDECAR_* constants.**
- `src/runtime/direct-llm-runner.ts`: `browser` entry in `TOOLS` (~:140-157, the `command` NL-string tool); `TOOL_SERVER_NAME = { browser:'agentBrowser', places_search:'placesSearch' }` (~:406); `TOOL_CATEGORY = { browser:'browser', places_search:'browser' }` (~:412).
- `src/k8s/ipc-redis.ts`: `const BUILTIN_CATEGORIES = new Set(['execution', 'browser'])` (~:279); `startToolPodSpawnWatcher` branch `if (BUILTIN_CATEGORIES.has(category)) createToolPodJob(...) else { resolveTool/createSidecarToolPodJob }` (~:1046); legacy `processTaskIpc` `tool_pod_request` → `createToolPodJob` directly (~:751, does NOT consult BUILTIN_CATEGORIES).
- `src/k8s/job-runner.test.ts`: `vi.mock('../config.js', () => ({ … getInjectionMode, getAuditOnly, assertGroupMountAllowed, getContainerImage, CREDENTIAL_SIDECAR_IMAGE, CREDENTIAL_SIDECAR_PORT, TOOL_JOB_* … }))` (~:16) — **does NOT mock BROWSER_SIDECAR_***; cdp tests use `toolSpec` fields so no new config mock needed. `mockBatchApi.createNamespacedJob` (~:90); `describe('createSidecarToolPodJob')` `baseSpec` (~:1371, http `home_control`). Assert via `mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec.template.spec`.
- `src/tools/types.test.ts`: `base` http fixture (~:4); pattern test `expect(validateTool({...base, pattern:'grpc'}).ok).toBe(false)` (~:59).

**External facts (verified):**
- **`chromedp/headless-shell:latest`**: ENTRYPOINT is `/headless-shell/run.sh` which starts `socat` (exposes CDP on **9222** → internal 9223) and launches the binary with `--no-sandbox --use-gl=angle --use-angle=swiftshader --remote-debugging-address=0.0.0.0 --remote-debugging-port=9223` **baked in**. So the browser ToolSpec needs **NO `command`** — the default entrypoint exposes CDP on 9222. Runs as **root** (no securityContext clash; sidecar tool pods don't force non-root). Readiness: `GET http://localhost:9222/json/version` → 200 with `webSocketDebuggerUrl`. Do **not** pass `--headless`/`--disable-gpu`. `/dev/shm`: use a 256Mi `emptyDir{medium:Memory}` at `/dev/shm` (works for any chromium image; simpler than the flag). Memory ~256Mi req / 1Gi limit.
- **`playwright-core`**: `chromium.connectOverCDP('http://localhost:9222')` → `Browser` (fetches /json/version internally); `browser.contexts()[0].pages()[0]` for the existing page. `playwright-core` triggers **no** browser download. Element refs: PRIMARY (version-proof) = inject `data-kc-ref="eN"` attributes via `page.evaluate` and target `page.locator('[data-kc-ref="e5"]')`. (Optional future enhancement: `page.ariaSnapshot({mode:'ai'})` + `page.locator('aria-ref=e5')` — semi-internal, version-sensitive; not used in v1.)

**Three-level test mapping:** Unit — `src/tools/types.test.ts`, `src/k8s/job-runner.test.ts`, `src/tool-server-mapping.test.ts` (or a new `src/tool-server-cdp.test.ts` for `executeToolBridgeCdp` with a mocked page). Integration — `e2e/browser-cdp.test.ts` (real bridge `cdp-bridge` + a real `chromedp/headless-shell` via docker, gated). E2E — `e2e/web-tools-manifest.test.ts` or a new `e2e/browser-cdp-manifest.test.ts` (manifest assertions, cluster-self-gated).

---

### Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 0.1:** `cd /home/peter/projects/kubeclaw && export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH && git status --porcelain` (expect empty) `&& git rev-parse HEAD` (cut from here — has the spec + this plan).
- [ ] **Step 0.2:** the executor's worktree skill branches; in-place fallback `git checkout -b feat/browser-cdp-bridge`.

---

### Task 1: `ToolSpec.pattern: 'cdp'` + validation

**Files:** Modify `src/tools/types.ts`; Test `src/tools/types.test.ts`

- [ ] **Step 1.1: Failing tests** — add to `src/tools/types.test.ts`:

```typescript
describe('validateTool — cdp pattern', () => {
  const cdpBase = { ...base, image: 'chromedp/headless-shell:latest', pattern: 'cdp' as const, port: 9222 };
  it('accepts pattern cdp with image + port', () => {
    expect(validateTool(cdpBase)).toEqual({ ok: true });
  });
  it('rejects cdp without a port', () => {
    const { port, ...noPort } = cdpBase as any;
    expect(validateTool(noPort).ok).toBe(false);
  });
  it('still rejects an unknown pattern', () => {
    expect(validateTool({ ...base, pattern: 'grpc' }).ok).toBe(false);
  });
});
```

- [ ] **Step 1.2:** `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH && npx vitest run src/tools/types.test.ts` → new tests FAIL.
- [ ] **Step 1.3: Implement** — in `src/tools/types.ts`:
  - Change the `pattern` field type to `'http' | 'file' | 'acp' | 'cdp'`.
  - `const PATTERNS = new Set(['http', 'file', 'acp', 'cdp']);`
  - Update the error message to `'pattern must be one of http|file|acp|cdp'`.
  - Add a cdp guard after the pattern check (mirroring the `run`/`requestMapping` idiom): a `cdp` tool requires `port`:

```typescript
  if (obj.pattern === 'cdp' && (obj.port === undefined || typeof obj.port !== 'number')) {
    return { ok: false, error: 'cdp pattern requires a numeric port (the CDP port)' };
  }
```

  (`image` is already required for all patterns — confirm the existing `image` check covers cdp; if `image` is not currently required, add `if (obj.pattern === 'cdp' && !obj.image) return {ok:false, error:'cdp pattern requires an image'}`.)

- [ ] **Step 1.4:** `npm run build && npx vitest run src/tools/types.test.ts` → PASS.
- [ ] **Step 1.5: Commit**

```bash
git add src/tools/types.ts src/tools/types.test.ts
git commit -m "feat(tools): add ToolSpec pattern 'cdp' + validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `cdp-bridge` mode + `executeToolBridgeCdp` (bridge)

**Files:** Modify `container/agent-runner/package.json`, `container/agent-runner/src/tool-server.ts`; Test `src/tool-server-cdp.test.ts` (new)

- [ ] **Step 2.1: Add the dependency** — `cd container/agent-runner && export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH && npm install playwright-core@latest --save && cd ../..`. Confirm `playwright-core` appears in `container/agent-runner/package.json` dependencies and no browsers were downloaded (playwright-core has no post-install).

- [ ] **Step 2.2: Failing unit test** — create `src/tool-server-cdp.test.ts`. It mocks `playwright-core` so no real browser is needed, and drives `executeToolBridgeCdp` action dispatch + error handling. **IMPORTANT:** importing `tool-server.js` runs its module top-level (env reads + the Redis `main()` loop), so FIRST copy the exact `vi.hoisted(...)` env setup + `vi.mock('redis', ...)` preamble from `src/tool-server-mapping.test.ts` (read it) to the top of this file so the import is inert — otherwise the test hangs trying to reach Redis. The `playwright-core` mock below is in addition to that preamble:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
// (above: the same vi.hoisted env + vi.mock('redis', …) preamble as src/tool-server-mapping.test.ts)

const page = {
  url: vi.fn(() => 'https://example.com/'),
  title: vi.fn(async () => 'Example'),
  goto: vi.fn(async () => {}),
  goBack: vi.fn(async () => {}),
  evaluate: vi.fn(async () => [{ ref: 'e1', role: 'button', text: 'Login' }]),
  innerText: vi.fn(async () => 'hello world'),
  keyboard: { press: vi.fn(async () => {}) },
  waitForSelector: vi.fn(async () => {}),
  waitForTimeout: vi.fn(async () => {}),
  isClosed: vi.fn(() => false),
  locator: vi.fn(() => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}), press: vi.fn(async () => {}) })),
};
const context = { pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
const browser = { isConnected: vi.fn(() => true), contexts: vi.fn(() => [context]), newContext: vi.fn(async () => context) };
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: vi.fn(async () => browser) } }));

import { executeToolBridgeCdp } from '../container/agent-runner/src/tool-server.js';

describe('executeToolBridgeCdp', () => {
  beforeEach(() => { process.env.KUBECLAW_CDP_URL = 'http://localhost:9222'; });
  it('navigate returns the new URL + title', async () => {
    const r = await executeToolBridgeCdp('browser', { action: 'navigate', url: 'https://example.com' });
    expect(String(r)).toContain('example.com');
    expect(page.goto).toHaveBeenCalled();
  });
  it('snapshot returns URL/title + interactive elements with refs', async () => {
    const r = await executeToolBridgeCdp('browser', { action: 'snapshot' });
    expect(String(r)).toContain('e1');
    expect(String(r)).toContain('Login');
  });
  it('click targets the data-kc-ref locator', async () => {
    await executeToolBridgeCdp('browser', { action: 'click', ref: 'e1' });
    expect(page.locator).toHaveBeenCalledWith('[data-kc-ref="e1"]');
  });
  it('type fills then optionally submits', async () => {
    const loc = { click: vi.fn(), fill: vi.fn(async () => {}), press: vi.fn(async () => {}) };
    page.locator.mockReturnValueOnce(loc as any);
    await executeToolBridgeCdp('browser', { action: 'type', ref: 'e1', text: 'hi', submit: true });
    expect(loc.fill).toHaveBeenCalledWith('hi', expect.anything());
    expect(loc.press).toHaveBeenCalledWith('Enter');
  });
  it('unknown action returns a clean error listing valid actions', async () => {
    const r = await executeToolBridgeCdp('browser', { action: 'teleport' });
    expect(String(r)).toMatch(/unknown action/i);
    expect(String(r)).toContain('navigate');
  });
  it('a Playwright failure is returned as a string, not thrown', async () => {
    page.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const r = await executeToolBridgeCdp('browser', { action: 'navigate', url: 'https://nope.invalid' });
    expect(String(r)).toMatch(/error:/i);
  });
});
```

- [ ] **Step 2.3:** `cd container/agent-runner && npm run build && cd .. && npx vitest run src/tool-server-cdp.test.ts` → FAIL (function absent).

- [ ] **Step 2.4: Implement `executeToolBridgeCdp`** — in `container/agent-runner/src/tool-server.ts`, add near the top (after imports): `import { chromium, type Browser, type Page } from 'playwright-core';` and:

```typescript
let cdpBrowser: Browser | null = null;
let cdpPage: Page | null = null;

async function getCdpPage(): Promise<Page> {
  const url = process.env.KUBECLAW_CDP_URL || 'http://localhost:9222';
  if (cdpBrowser?.isConnected() && cdpPage && !cdpPage.isClosed()) return cdpPage;
  cdpBrowser = await chromium.connectOverCDP(url);
  const ctx = cdpBrowser.contexts()[0] ?? (await cdpBrowser.newContext());
  cdpPage = ctx.pages()[0] ?? (await ctx.newPage());
  return cdpPage;
}

// Inject data-kc-ref attributes on interactive elements and return a readable list.
const SNAPSHOT_FN = `(() => {
  const SEL = ['a[href]','button:not([disabled])','input:not([disabled])','select:not([disabled])','textarea:not([disabled])','[role=button]','[role=link]','[role=checkbox]','[role=tab]','[role=menuitem]','[role=combobox]','[tabindex]:not([tabindex="-1"])','[onclick]'].join(',');
  document.querySelectorAll('[data-kc-ref]').forEach(e => e.removeAttribute('data-kc-ref'));
  let n = 0; const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-kc-ref', ref);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const text = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().replace(/\\s+/g,' ').slice(0,80);
    out.push('[' + ref + '] ' + role + ' "' + text + '"');
  }
  return out.join('\\n');
})()`;

export async function executeToolBridgeCdp(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = String(input.action ?? '');
  let page: Page;
  try {
    page = await getCdpPage();
  } catch (err) {
    return `error: cannot connect to browser (${err instanceof Error ? err.message : String(err)})`;
  }
  try {
    switch (action) {
      case 'navigate': {
        await page.goto(String(input.url ?? ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
        return `Navigated to ${page.url()} — "${await page.title()}"`;
      }
      case 'snapshot': {
        const elements = (await page.evaluate(SNAPSHOT_FN)) as string;
        const text = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 4000);
        const out = `URL: ${page.url()}\nTitle: ${await page.title()}\n\nInteractive elements:\n${elements}\n\nVisible text (truncated):\n${text}`;
        return out.slice(0, MAX_TOOL_OUTPUT_BYTES);
      }
      case 'click': {
        await page.locator(`[data-kc-ref="${String(input.ref ?? '')}"]`).click({ timeout: 10000 });
        return `Clicked ${input.ref}`;
      }
      case 'type': {
        const loc = page.locator(`[data-kc-ref="${String(input.ref ?? '')}"]`);
        await loc.fill(String(input.text ?? ''), { timeout: 10000 });
        if (input.submit) await loc.press('Enter');
        return `Typed into ${input.ref}`;
      }
      case 'press': {
        await page.keyboard.press(String(input.key ?? ''));
        return `Pressed ${input.key}`;
      }
      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return `Back to ${page.url()}`;
      }
      case 'wait': {
        const f = String(input.for ?? '');
        if (/^\d+$/.test(f)) await page.waitForTimeout(Math.min(Number(f), 30000));
        else await page.waitForSelector(f, { timeout: 30000 });
        return `Waited for ${f}`;
      }
      default:
        return `error: unknown action "${action}". Valid actions: navigate, snapshot, click, type, press, back, wait`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/data-kc-ref|no element|not found|Timeout.*locator/i.test(msg)) {
      return `error: element ${input.ref ?? ''} not found or not actionable — call snapshot first (${msg.slice(0, 200)})`;
    }
    return `error: ${msg.slice(0, 500)}`;
  }
}
```

- [ ] **Step 2.5: Wire the dispatch + readiness** — in `executeTool` (~:632), add as the FIRST branch: `if (toolMode === 'cdp-bridge') return executeToolBridgeCdp(tool, input);`. Extend the `toolMode` type cast (~:20) to include `'cdp-bridge'`. Extend `ensureToolReady`'s guard so cdp waits for the CDP endpoint: change `if (toolMode !== 'http-bridge' && toolMode !== 'acp-bridge')` to also allow `'cdp-bridge'` (so it polls `KUBECLAW_TOOL_PORT` + `KUBECLAW_TOOL_HEALTH_PATH`). The dispatch path already calls `executeTool`; if `executeTool`'s callers don't `await ensureToolReady()` for cdp, have `executeToolBridgeCdp` call `await ensureToolReady()` before `getCdpPage()` (mirror how http-bridge ensures readiness). Confirm the http-bridge readiness call site and match it.

- [ ] **Step 2.6:** `cd container/agent-runner && npm run build && cd .. && npx vitest run src/tool-server-cdp.test.ts` → PASS.

- [ ] **Step 2.7: Commit**

```bash
git add container/agent-runner/package.json container/agent-runner/package-lock.json container/agent-runner/src/tool-server.ts src/tool-server-cdp.test.ts
git commit -m "feat(tool-bridge): cdp-bridge mode + executeToolBridgeCdp (persistent Playwright-over-CDP, primitive actions)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `createSidecarToolPodJob` cdp wiring

**Files:** Modify `src/k8s/job-runner.ts`; Test `src/k8s/job-runner.test.ts`

- [ ] **Step 3.1: Failing tests** — in `src/k8s/job-runner.test.ts`, inside `describe('createSidecarToolPodJob')`:

```typescript
    const cdpSpec = () => ({
      ...baseSpec,
      toolSpec: {
        ...baseSpec.toolSpec,
        name: 'browser',
        image: 'chromedp/headless-shell:latest',
        pattern: 'cdp' as const,
        port: 9222,
        parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
      },
    });

    it('cdp: chromium native sidecar, no user-tool, /dev/shm, cdp-bridge env', async () => {
      await jobRunner.createSidecarToolPodJob(cdpSpec());
      const podSpec = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec.template.spec;
      // no user-tool; only the bridge in containers[]
      expect(podSpec.containers.map((c: any) => c.name)).toEqual(['kubeclaw-tool-bridge']);
      // chromium as a native sidecar init-container
      const init = (podSpec.initContainers ?? []).find((c: any) => c.name === 'chromium');
      expect(init).toBeDefined();
      expect(init.image).toBe('chromedp/headless-shell:latest');
      expect(init.restartPolicy).toBe('Always');
      expect(init.readinessProbe.httpGet).toEqual({ path: '/json/version', port: 9222 });
      expect(init.volumeMounts).toContainEqual({ name: 'dshm', mountPath: '/dev/shm' });
      // /dev/shm emptyDir
      expect(podSpec.volumes).toContainEqual({ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } });
      // bridge env
      const bridge = podSpec.containers.find((c: any) => c.name === 'kubeclaw-tool-bridge');
      const env = Object.fromEntries(bridge.env.map((e: any) => [e.name, e.value]));
      expect(env.KUBECLAW_TOOL_MODE).toBe('cdp-bridge');
      expect(env.KUBECLAW_CDP_URL).toBe('http://localhost:9222');
      expect(env.KUBECLAW_TOOL_PORT).toBe('9222');
      expect(env.KUBECLAW_TOOL_HEALTH_PATH).toBe('/json/version');
    });

    it('cdp: chromium command defaults to the image entrypoint when toolSpec.command absent', async () => {
      await jobRunner.createSidecarToolPodJob(cdpSpec());
      const podSpec = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec.template.spec;
      const init = podSpec.initContainers.find((c: any) => c.name === 'chromium');
      expect(init.command).toBeUndefined();
    });
```

- [ ] **Step 3.2:** `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH && npx vitest run src/k8s/job-runner.test.ts` → new tests FAIL.

- [ ] **Step 3.3: Implement** — in `createSidecarToolPodJob`:
  - Add `const isCdpBridge = toolSpec.pattern === 'cdp';` next to `isFileBridge`/`isAcpBridge` (~:1718) and extend the `toolMode` ternary: `isCdpBridge ? 'cdp-bridge' :` before `'http-bridge'`.
  - In `bridgeEnv` (~:1767), after the existing pushes add (when `isCdpBridge`):

```typescript
    if (isCdpBridge) {
      bridgeEnv.push(
        { name: 'KUBECLAW_CDP_URL', value: `http://localhost:${port}` },
        { name: 'KUBECLAW_TOOL_HEALTH_PATH', value: toolSpec.healthPath ?? '/json/version' },
      );
    }
```

  (`KUBECLAW_TOOL_PORT` is already set to `String(port)`; for cdp, `port = toolSpec.port` = 9222.)
  - Build the chromium native sidecar + /dev/shm before the container assembly:

```typescript
    const cdpInitContainers = isCdpBridge
      ? [
          {
            name: 'chromium',
            image: toolSpec.image,
            imagePullPolicy: toolSpec.pullPolicy ?? 'IfNotPresent',
            ...(toolSpec.command ? { command: toolSpec.command } : {}),
            ports: [{ containerPort: port }],
            readinessProbe: {
              httpGet: { path: toolSpec.healthPath ?? '/json/version', port },
              initialDelaySeconds: 2,
              periodSeconds: 2,
              failureThreshold: 15,
            },
            resources: {
              requests: { memory: toolSpec.memoryRequest ?? '256Mi', cpu: toolSpec.cpuRequest ?? '100m' },
              limits: { memory: toolSpec.memoryLimit ?? '1Gi', cpu: toolSpec.cpuLimit ?? '500m' },
            },
            volumeMounts: [{ name: 'dshm', mountPath: '/dev/shm' }],
            restartPolicy: 'Always', // K8s 1.29+ native sidecar
          },
        ]
      : undefined;
    if (isCdpBridge) {
      volumes.push({ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } });
    }
```

  - In the `containers` array (~:1967), make the `user-tool` container conditional — for cdp there is no user-tool: `...(isCdpBridge ? [] : [ { name:'user-tool', … } ]), ...credContainers`. (Restructure so the user-tool object is spread from an array gated on `!isCdpBridge`. For v1 the browser tool declares no `credentials`, so `credContainers` is empty for cdp — leave the spread as-is.)
  - On `template.spec` (~:1961), add `...(cdpInitContainers && { initContainers: cdpInitContainers })`.

- [ ] **Step 3.4:** `npm run build && npx vitest run src/k8s/job-runner.test.ts && npx vitest run src/k8s/ 2>&1 | grep -E "Test Files|Tests "` → PASS, no regressions.

- [ ] **Step 3.5: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "feat(tools): createSidecarToolPodJob cdp wiring (chromium native sidecar, no user-tool, /dev/shm, KUBECLAW_CDP_URL)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Remove `browser` from static surface + `places_search` decouple

**Files:** Modify `src/runtime/direct-llm-runner.ts`, `src/tools/types.ts`, `src/k8s/ipc-redis.ts`; Tests as affected.

- [ ] **Step 4.1: Inspect** — `grep -n "browser\|places_search\|places" src/runtime/direct-llm-runner.test.ts src/k8s/ipc-redis.test.ts src/k8s/tool-call-roundtrip.test.ts src/metrics/channel-wiring.test.ts | head -30`. Note tests asserting on `browser` as a static tool or category 'browser'.
- [ ] **Step 4.2: direct-llm-runner.ts** — remove the `browser` object from `TOOLS` (~:140-157); remove `browser: 'agentBrowser'` from `TOOL_SERVER_NAME`; remove `browser: 'browser'` from `TOOL_CATEGORY`; change `places_search: 'browser'` to `places_search: 'places'` in `TOOL_CATEGORY`. Update the `TOOL_CATEGORY` type if it's `Record<string,'browser'|'execution'>` → add `'places'`: `Record<string,'browser'|'execution'|'places'>`.
- [ ] **Step 4.3: types.ts** — remove `'browser'` from `RESERVED_NAMES` (keep `places_search`, `execution`).
- [ ] **Step 4.4: ipc-redis.ts** — `BUILTIN_CATEGORIES` (~:279): `new Set(['execution', 'places'])` (remove `'browser'`, add `'places'`). Confirm `startToolPodSpawnWatcher` then routes name `browser` → catalog (resolveTool) and `places` → createToolPodJob. The legacy `tool_pod_request` path is unaffected (calls createToolPodJob directly).
- [ ] **Step 4.5: Fix affected tests** — update any test asserting `browser` in static `TOOLS`/`TOOL_CATEGORY`, or `places_search` category `'browser'`, or `BUILTIN_CATEGORIES` containing `'browser'`. If a test exercises the `metrics`/channel tool-throws path with `browser` (the one switched to `browser` in the web-tools feature), switch it to a still-static tool — `places_search` is still static (category `'places'`), so use `makeFakeOpenAIWithToolCall('places_search')` there. Be surgical.
- [ ] **Step 4.6:** `npm run build && npx vitest run src/runtime/ src/k8s/ src/metrics/ src/tools/types.test.ts 2>&1 | grep -E "Test Files|Tests "` → PASS. Confirm `places_search` still routes to a built-in (`grep -n "places" src/runtime/direct-llm-runner.ts src/k8s/ipc-redis.ts`).
- [ ] **Step 4.7: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/tools/types.ts src/k8s/ipc-redis.ts src/runtime/direct-llm-runner.test.ts src/k8s/ipc-redis.test.ts src/metrics/channel-wiring.test.ts
git commit -m "refactor(tools): remove browser from static maps (now a cdp catalog tool); decouple places_search onto its own 'places' category

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Add only the test files you actually changed.)

---

### Task 5: Helm — `browser` catalog baseline

**Files:** Modify `helm/kubeclaw/values.yaml`

- [ ] **Step 5.1: Append the baseline tool** — to the existing `tools:` list in `helm/kubeclaw/values.yaml` (which has bash/bash_persist/web_fetch/web_search):

```yaml
  - name: browser
    description: Drive a real web browser (Chromium). Call snapshot to see the page (it returns the interactive elements with refs and the visible text), then click/type using a ref. Actions persist within a session.
    parameters:
      type: object
      properties:
        action: { type: string, enum: [navigate, snapshot, click, type, press, back, wait] }
        url:    { type: string }
        ref:    { type: string }
        text:   { type: string }
        submit: { type: boolean }
        key:    { type: string }
        for:    { type: string }
      required: [action]
    image: chromedp/headless-shell:latest
    pattern: cdp
    port: 9222
    memoryRequest: 256Mi
    memoryLimit: 1Gi
    cpuRequest: 100m
    cpuLimit: "1"
    timeout: 600000
```

(No `command` — `chromedp/headless-shell`'s entrypoint already exposes CDP on 9222. No `mount`. No `credentials`.)

- [ ] **Step 5.2: Verify render** — `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH && helm template kubeclaw helm/kubeclaw | grep -E 'name.*browser|chromedp|pattern.*cdp|9222' | head && helm template kubeclaw helm/kubeclaw >/dev/null && echo helmOK && helm template kubeclaw helm/kubeclaw -f helm/kubeclaw/values-minikube.yaml >/dev/null && echo helmMinikubeOK`. Confirm `browser` renders in the tools ConfigMap with `pattern: cdp` + `port: 9222` (toJson preserves fields). If `values-minikube.yaml` overrides `tools:`, append there too.
- [ ] **Step 5.3: Commit**

```bash
git add helm/kubeclaw/values.yaml helm/kubeclaw/values-minikube.yaml
git commit -m "feat(tools): ship browser cdp catalog baseline (stock chromedp/headless-shell)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Integration test — real bridge cdp-bridge + real chromium

Prove `executeToolBridgeCdp` drives a real chromium over CDP and that state persists across calls, using the compiled bridge in `cdp-bridge` mode against a real `chromedp/headless-shell` container.

**Files:** Create `e2e/browser-cdp.test.ts`

- [ ] **Step 6.1: Read the harness** — read `e2e/sidecar-tool-pod.test.ts` for how it spawns the compiled bridge + seeds toolcalls/reads toolresults over Redis. Confirm `docker` is available (`docker version`); if not, the test must SKIP cleanly (gate on docker).
- [ ] **Step 6.2: Write the test** — in `beforeAll`: `docker run -d --rm -p <dynamicPort>:9222 chromedp/headless-shell:latest` (capture the container id); poll `http://localhost:<port>/json/version` until 200 (or skip if pull/run fails). Spawn the compiled bridge (`node container/agent-runner/dist/tool-server.js`) with `KUBECLAW_TOOL_MODE=cdp-bridge`, `KUBECLAW_CDP_URL=http://localhost:<port>`, plus the redis env the harness uses. Drive these toolcalls (via the harness's Redis seed/read) and assert:
  1. `navigate` to a `data:text/html` page containing `<button onclick="document.title='clicked'">Login</button>` → result contains the data URL.
  2. `snapshot` → result contains `[e1]` and `Login`.
  3. `click` with `ref: 'e1'` → no error.
  4. `navigate`-less `snapshot` again or a `wait`/title check proving the click took effect on the SAME page (state persisted across calls) — e.g. a follow-up snapshot/title reflects `clicked`.
  Tear down: kill the bridge, `docker rm -f <container>` in `afterAll`/`finally` (even on failure).
- [ ] **Step 6.3: Run** — `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH && cd container/agent-runner && npm run build && cd .. && (docker version >/dev/null 2>&1 && npx vitest run e2e/browser-cdp.test.ts --config vitest.e2e.config.ts 2>&1 | tail -12 || echo "NO DOCKER — test skips")`. PASS if docker present; clean skip otherwise. Confirm no leftover container (`docker ps -a | grep headless-shell || echo clean`).
- [ ] **Step 6.4: Commit**

```bash
git add e2e/browser-cdp.test.ts
git commit -m "test(tool-bridge): integration coverage for cdp bridge against real chromedp/headless-shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: E2E manifest test — cdp browser pod spawn

**Files:** Modify `e2e/web-tools-manifest.test.ts` (add a cdp case) OR create `e2e/browser-cdp-manifest.test.ts`

- [ ] **Step 7.1: Read** `e2e/web-tools-manifest.test.ts` (the cluster-self-gated `createSidecarToolPodJob`-direct pattern: stub catalog not needed for cdp since browser declares no credentials; the `isOrchestratorReady` gate; `createdJobs` cleanup; `process.env.KUBECLAW_NAMESPACE` set before the dynamic import).
- [ ] **Step 7.2: Add the cdp manifest test** — construct a cdp `browser` SidecarToolPodJobSpec (`toolSpec` = `{ name:'browser', image:'chromedp/headless-shell:latest', pattern:'cdp', port:9222, parameters:{type:'object',properties:{action:{type:'string'}},required:['action']} }`), `createSidecarToolPodJob` against the live cluster, read the Job back, assert: `containers` = only `kubeclaw-tool-bridge`; an `initContainers` entry `chromium` (image chromedp/headless-shell, `restartPolicy: Always`, readiness `/json/version` on 9222); a `dshm` `/dev/shm` emptyDir; bridge env `KUBECLAW_TOOL_MODE=cdp-bridge` + `KUBECLAW_CDP_URL`. Register the job in `createdJobs` and clean up in `afterAll`. Run via the standard e2e config (the file must NOT be named `minikube-live-*`).
- [ ] **Step 7.3: Run** — `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH && npm run build && kubectl get nodes >/dev/null 2>&1 && npx vitest run e2e/web-tools-manifest.test.ts --config vitest.e2e.config.ts 2>&1 | tail -10 || echo "NO CLUSTER"`. Confirm no leaked jobs (`kubectl get jobs -n kubeclaw | grep -E "e2e-.*browser" || echo clean`).
- [ ] **Step 7.4: Commit**

```bash
git add e2e/web-tools-manifest.test.ts
git commit -m "test(tools): manifest coverage for cdp browser pod (chromium native sidecar, no user-tool)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Docs

**Files:** Modify `docs/TOOL_BRIDGE.md`

- [ ] **Step 8.1: Document** (verify each claim against code): the `cdp` pattern — a catalog tool whose `image` is a stock chromium-CDP image attached as a native sidecar; the bridge holds one persistent Playwright-over-CDP connection (stateful warm session, per-pod = per-group isolation, ephemeral); the `browser` tool's `action` contract (navigate/snapshot/click/type/press/back/wait) and the snapshot→ref model (`data-kc-ref`); the `/dev/shm` emptyDir + `KUBECLAW_CDP_URL`; the worked example (the `browser` baseline on `chromedp/headless-shell`). Note: `browser` keeps its dual existence in the legacy agent-runner; `places_search` moved to its own `places` category.
- [ ] **Step 8.2: Commit**

```bash
git add docs/TOOL_BRIDGE.md
git commit -m "docs: cdp bridge pattern + browser tool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Full verification + final review

- [ ] **Step 9.1:** `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH && npm run build && (cd container/agent-runner && npm run build) && npm test 2>&1 | grep -E "Test Files|Tests "` → all pass.
- [ ] **Step 9.2:** integration + (if docker/cluster) e2e: `npx vitest run e2e/sidecar-tool-pod.test.ts --config vitest.e2e.config.ts 2>&1 | tail -4`; `docker version >/dev/null 2>&1 && npx vitest run e2e/browser-cdp.test.ts --config vitest.e2e.config.ts 2>&1 | tail -4 || echo "no docker"`; `kubectl get nodes >/dev/null 2>&1 && npx vitest run e2e/web-tools-manifest.test.ts --config vitest.e2e.config.ts 2>&1 | tail -4 || echo "no cluster"`.
- [ ] **Step 9.3:** `helm template kubeclaw helm/kubeclaw >/dev/null && echo helmOK && helm template kubeclaw helm/kubeclaw -f helm/kubeclaw/values-minikube.yaml >/dev/null && echo helmMinikubeOK`.
- [ ] **Step 9.4: prettier drift** — `git checkout -- e2e/results/ 2>/dev/null; git status --porcelain`; if only prettier reformats remain: `git add -A && git commit -m "style(tools): apply prettier formatting left by pre-commit hook` (+ trailer).
- [ ] **Step 9.5: Two-stage review** — spec-compliance then code-quality review before reporting complete.

---

## Out of scope (do not do these here)

- Profile/login persistence across pod restarts (`mount: group` → `--user-data-dir` on the chromium container).
- `screenshot` (image return) and `eval(js)` actions.
- Converting `places_search` itself into a credential-injected catalog tool (only the minimal `places` category decouple is in scope).
- Removing the in-process local path / retiring the legacy agent-runner — `browser` keeps its dual existence there, untouched.
- The `ariaSnapshot({mode:'ai'})` + `aria-ref=` enhancement (v1 uses the version-proof `data-kc-ref` injection).
- Touching the first-party `kubeclaw-browser-sidecar` image (it stays for the legacy agent-job `browserSidecar` feature).
