# Agent-Runner Catalog Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal agent jobs consume the tool catalog exactly like the channel — drop the hardcoded routed tools, load the catalog, and route tool execution by name through the `kubeclaw:spawn-tool-pod` stream — after first fixing a catalog-parse regression that currently breaks every catalog tool.

**Architecture:** The channel's `DirectLLMRunner` is already catalog-driven (static IPC tools + catalog tools by name via `spawn-tool-pod` → `createSidecarToolPodJob`). The legacy agent-runner still hardcodes `bash`/`read`/`write`/`edit`/`glob`/`grep`/`web_*`/`agent_browser` and routes them by category through a `tool_pod_request` pub/sub + ACK → `createToolPodJob` → `executeToolLocal`. We rewire the agent-runner onto the channel's by-name path and retire the now-dead `tool_pod_request`/`execution`-category machinery. Bootstrap (Mode 1) is untouched.

**Tech Stack:** TypeScript (ES2022, NodeNext), `@mariozechner/pi-agent-core` + `pi-ai` (agent loop; AJV-validated JSON-Schema tool params), Redis streams, Kubernetes Jobs, Helm, vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-agent-runner-catalog-unification-design.md`

---

## Key facts the implementer must know

- **Two packages.** The main app is `src/**` (root `package.json`, root `node_modules`). The agent-runner is `container/agent-runner/**` (its own `package.json`/`node_modules`, `rootDir: ./src`). The agent-runner **cannot** import from `src/**`. Tests for agent-runner code live under `container/agent-runner/src/*.test.ts` OR in root `src/*.test.ts` importing via relative path `../container/agent-runner/src/<file>.js`; both globs are in `vitest.config.ts`. Run all tests from the repo root with `npx vitest run`.
- **Tool params are plain JSON Schema.** pi-ai validates tool-call args with **AJV** (`ajv.compile(tool.parameters)`) and serializes `parameters` to providers as JSON Schema. A catalog `ToolSpec.parameters` (already JSON Schema) is passed straight into a pi-agent-core `AgentTool` with a `as unknown as TSchema` cast.
- **The channel's by-name path (the target):** write the call to `kubeclaw:toolcalls:{agentJobId}:{toolName}` (fields `requestId`, `tool`, `input`), then `XADD kubeclaw:spawn-tool-pod` with fields `{agentJobId, groupFolder, category=<toolName>, timeout, channel}`, then block-read `kubeclaw:toolresults:{agentJobId}:{toolName}` from `lastId='0-0'`, correlating by `requestId`. The orchestrator's `startToolPodSpawnWatcher` (`src/k8s/ipc-redis.ts`) resolves the tool by name, re-checks `spec.channels` against `channel`, and calls `createSidecarToolPodJob`.
- **ACL = uniform option A.** `KUBECLAW_CHANNEL` is NOT set on agent job manifests, so the agent always sends `channel=''` and filters its tool list with `getForChannel('')` → only non-channel-restricted tools.
- **Node 24 toolchain.** Before any `git commit`, ensure Node 24 is on PATH so husky/prettier run:
  ```bash
  export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
  ```
- **Run a single test file:** `npx vitest run <path/to/file.test.ts>`. **Run all unit/integration:** `npx vitest run`. The husky pre-commit runs `prettier --write "src/**/*.ts"` (it does NOT touch `container/agent-runner/**`, so format those files yourself if prettier complains — run `npx prettier --write container/agent-runner/src/<file>.ts`).

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/tools/types.ts` | Add `timeout?: number` to `ToolSpec` + `ALLOWED_KEYS` + validation | 0 |
| `src/k8s/job-runner.ts` (`createSidecarToolPodJob`) | Honor `toolSpec.timeout` over caller timeout | 0 |
| `src/tools/types.test.ts` | Unit: `timeout` accepted/validated | 0 |
| `src/tools/baseline-parse.test.ts` (new) | Regression: rendered Helm baseline parses | 0 |
| `src/k8s/job-runner.test.ts` | Unit: sidecar job honors `toolSpec.timeout` | 0 |
| `container/agent-runner/src/tool-catalog.ts` (new) | Lenient agent-runner-local catalog reader + `getForChannel` | 1 |
| `container/agent-runner/src/tool-catalog.test.ts` (new) | Unit: parse + channel filter | 1 |
| `src/k8s/job-runner.ts` (`generateJobManifest`) | Mount `kubeclaw-tools` ConfigMap on agent jobs | 2 |
| `src/k8s/job-runner.test.ts` | Unit: agent manifest mounts tools ConfigMap | 2 |
| `container/agent-runner/src/index.ts` (`callCatalogToolViaRedis`) | New by-name dispatch via `spawn-tool-pod` | 3 |
| `container/agent-runner/src/catalog-dispatch.test.ts` (new) | Unit: XADD fields + result correlation | 3 |
| `container/agent-runner/src/index.ts` (`buildToolDefinitions`, `runAgentLoop`) | Drop routed tools; add catalog tools; load reader | 4 |
| `container/agent-runner/src/build-tools.test.ts` (new) | Unit: catalog tools present, routed tools gone, ACL filter | 4 |
| `container/agent-runner/src/index.ts` + `src/k8s/ipc-redis.ts` + `container/agent-runner/src/tool-server.ts` | Remove dead `tool_pod_request`/ack/`execution` machinery + comments | 5 |
| `src/k8s/ipc-redis.test.ts` | Unit: `tool_pod_request` no longer handled; `execution` not builtin | 5 |
| `e2e/agent-runner-catalog.test.ts` (new) | E2E: agent job runs `bash`/`bash_persist` via sidecar bridge | 6 |

---

## Task 0: Fix the catalog `timeout` regression

**Why:** `values.yaml`'s `browser` tool sets `timeout: 600000`, but `timeout` is not an allowed `ToolSpec` key, so `parseToolCatalog` rejects the **entire** baseline → `resolveToolByName` returns `undefined` for every catalog tool. This blocks the whole feature and is a live bug. Make `timeout` a first-class field and honor it.

**Files:**
- Modify: `src/tools/types.ts` (interface ~18-53, `ALLOWED_KEYS` ~74-96, `validateTool` ~155-319)
- Modify: `src/k8s/job-runner.ts` (`createSidecarToolPodJob`, the `timeoutSeconds` computation ~line 1740)
- Test: `src/tools/types.test.ts`, `src/tools/baseline-parse.test.ts` (new), `src/k8s/job-runner.test.ts`

- [ ] **Step 1: Write the failing regression test for the rendered baseline**

Create `src/tools/baseline-parse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { parseToolCatalog } from './types.js';

/**
 * Regression guard (2026-06-14): a tool key not in ALLOWED_KEYS (e.g. `timeout`
 * on the browser tool) made parseToolCatalog reject the ENTIRE baseline, so the
 * orchestrator resolved zero catalog tools. This feeds the real values.yaml
 * `tools:` list through parseToolCatalog exactly as the Helm baseline ConfigMap
 * would, and asserts every shipped tool is accepted.
 */
describe('rendered Helm tools baseline', () => {
  it('parses cleanly via parseToolCatalog', () => {
    const values = parseYaml(
      readFileSync('helm/kubeclaw/values.yaml', 'utf-8'),
    ) as { tools?: unknown[] };
    const envelope = JSON.stringify({
      version: 1,
      generation: 0,
      tools: values.tools ?? [],
    });
    const r = parseToolCatalog(envelope);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = r.tools.map((t) => t.name).sort();
      expect(names).toContain('browser');
      expect(names).toContain('bash');
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/tools/baseline-parse.test.ts`
Expected: FAIL — `r.ok` is `false` (parse error `unknown field: timeout`). (If the repo lacks the `yaml` package, the import will fail instead — in that case use `js-yaml` which is already a dependency: `import yaml from 'js-yaml'; const values = yaml.load(readFileSync(...)) as ...`. Check `package.json` first and use whichever YAML lib is present.)

- [ ] **Step 3: Add `timeout` to the ToolSpec type**

In `src/tools/types.ts`, add the field to the `ToolSpec` interface (after the `credentials?` field, before the closing brace ~line 52):

```typescript
  /** Optional per-tool execution timeout in milliseconds. When set, overrides the
   *  caller-supplied default for the tool's sidecar Job (activeDeadlineSeconds) and
   *  the agent/channel result-wait deadline. */
  timeout?: number;
```

- [ ] **Step 4: Add `timeout` to ALLOWED_KEYS and validate it**

In `src/tools/types.ts`, add `'timeout'` to the `ALLOWED_KEYS` set (insert after `'credentials',` ~line 95):

```typescript
  'credentials',
  'timeout',
```

Then add validation inside `validateTool`, immediately before the final `return { ok: true };` (~line 319):

```typescript
  if (obj.timeout !== undefined) {
    if (
      typeof obj.timeout !== 'number' ||
      !Number.isInteger(obj.timeout) ||
      obj.timeout <= 0
    ) {
      return { ok: false, error: 'timeout must be a positive integer (ms)' };
    }
  }
```

- [ ] **Step 5: Run the baseline + types tests to confirm they pass**

Run: `npx vitest run src/tools/baseline-parse.test.ts src/tools/types.test.ts`
Expected: PASS (baseline parses; existing type tests still green).

- [ ] **Step 6: Add a unit test asserting validation of `timeout`**

Append to `src/tools/types.test.ts` (inside the existing top-level `describe` for `validateTool`; match the file's existing test style — it builds a minimal valid tool and tweaks one field):

```typescript
  it('accepts a positive integer timeout', () => {
    const r = validateTool({
      name: 'slowtool',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      image: 'alpine:latest',
      pattern: 'file',
      run: 'echo hi',
      timeout: 600000,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a non-positive or non-integer timeout', () => {
    for (const bad of [0, -1, 1.5, 'x']) {
      const r = validateTool({
        name: 'slowtool',
        description: 'x',
        parameters: { type: 'object', properties: {} },
        image: 'alpine:latest',
        pattern: 'file',
        run: 'echo hi',
        timeout: bad as unknown as number,
      });
      expect(r.ok).toBe(false);
    }
  });
```

(Ensure `validateTool` is imported at the top of the test file — it almost certainly already is; if not, add it to the existing import from `./types.js`.)

- [ ] **Step 7: Run the types test to confirm it passes**

Run: `npx vitest run src/tools/types.test.ts`
Expected: PASS.

- [ ] **Step 8: Write a failing test that the sidecar job honors `toolSpec.timeout`**

First read `src/k8s/job-runner.test.ts` to find the existing `createSidecarToolPodJob` test block and its harness (how it builds the `JobRunner`, fakes the K8s client, and inspects the created Job manifest). Add a test mirroring that harness. The assertion: when `toolSpec.timeout` is set, the Job's `spec.activeDeadlineSeconds` equals `toolSpec.timeout / 1000`, overriding the caller's `timeout`. Example shape (adapt names to the existing harness in that file):

```typescript
it('createSidecarToolPodJob honors toolSpec.timeout over the caller timeout', async () => {
  const captured = captureCreatedJob(); // use the file's existing capture mechanism
  await runner.createSidecarToolPodJob({
    agentJobId: 'job-1',
    groupFolder: 'g1',
    toolName: 'browser',
    toolSpec: {
      name: 'browser',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      image: 'chromedp/headless-shell:latest',
      pattern: 'cdp',
      port: 9222,
      timeout: 600000,
    },
    timeout: 60000, // caller default — should be overridden
  });
  expect(captured.spec.activeDeadlineSeconds).toBe(600);
});
```

- [ ] **Step 9: Run it to confirm it fails**

Run: `npx vitest run src/k8s/job-runner.test.ts`
Expected: FAIL — `activeDeadlineSeconds` is `60`, not `600`.

- [ ] **Step 10: Honor `toolSpec.timeout` in `createSidecarToolPodJob`**

In `src/k8s/job-runner.ts`, find the line in `createSidecarToolPodJob` (~1740):

```typescript
const timeoutSeconds = Math.floor(spec.timeout / 1000);
```

Replace with:

```typescript
// A per-tool catalog timeout (toolSpec.timeout, ms) overrides the caller default.
const effectiveTimeoutMs = spec.toolSpec.timeout ?? spec.timeout;
const timeoutSeconds = Math.floor(effectiveTimeoutMs / 1000);
```

- [ ] **Step 11: Run the job-runner test to confirm it passes**

Run: `npx vitest run src/k8s/job-runner.test.ts`
Expected: PASS.

- [ ] **Step 12: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS (all green).

- [ ] **Step 13: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add src/tools/types.ts src/tools/types.test.ts src/tools/baseline-parse.test.ts src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "fix(tools): make timeout a real ToolSpec field; unbreak catalog baseline parse"
```

---

## Task 1: Agent-runner-local catalog reader

**Why:** The agent-runner can't import the main `ToolCatalogLoader`. Add a small local reader over the mounted `tools.json` with the same `getForChannel` semantics.

**Files:**
- Create: `container/agent-runner/src/tool-catalog.ts`
- Test: `container/agent-runner/src/tool-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/tool-catalog.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCatalog } from './tool-catalog.js';

function writeCatalog(tools: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'kc-cat-'));
  const path = join(dir, 'tools.json');
  writeFileSync(path, JSON.stringify({ version: 1, generation: 3, tools }));
  return path;
}

describe('loadCatalog', () => {
  it('returns [] when the file is absent', () => {
    const cat = loadCatalog('/no/such/path/tools.json');
    expect(cat.getForChannel('')).toEqual([]);
  });

  it('reads tools and exposes name/description/parameters/timeout', () => {
    const path = writeCatalog([
      {
        name: 'bash',
        description: 'run a command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        image: 'alpine:latest',
        pattern: 'file',
        run: 'sh -c "$(cat "$INPUT_DIR/command")"',
      },
    ]);
    const cat = loadCatalog(path);
    const tools = cat.getForChannel('');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('bash');
    expect(tools[0].description).toBe('run a command');
    expect(tools[0].parameters).toMatchObject({ type: 'object' });
  });

  it('getForChannel filters by the channels ACL', () => {
    const path = writeCatalog([
      { name: 'open', description: 'd', parameters: { type: 'object' }, image: 'i', pattern: 'file' },
      { name: 'restricted', description: 'd', parameters: { type: 'object' }, image: 'i', pattern: 'file', channels: ['telegram'] },
    ]);
    const cat = loadCatalog(path);
    expect(cat.getForChannel('').map((t) => t.name)).toEqual(['open']);
    expect(cat.getForChannel('telegram').map((t) => t.name).sort()).toEqual(['open', 'restricted']);
  });

  it('tolerates an unparseable file by returning []', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kc-cat-'));
    const path = join(dir, 'tools.json');
    writeFileSync(path, 'not json');
    const cat = loadCatalog(path);
    expect(cat.getForChannel('')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run container/agent-runner/src/tool-catalog.test.ts`
Expected: FAIL with "Cannot find module './tool-catalog.js'".

- [ ] **Step 3: Implement the reader**

Create `container/agent-runner/src/tool-catalog.ts`:

```typescript
/**
 * Agent-runner-local tool catalog reader.
 *
 * The agent-runner is a separate package and cannot import the main app's
 * ToolCatalogLoader. This is a deliberately lenient reader over the same
 * tools.json the channel pod mounts (the `kubeclaw-tools` ConfigMap): it reads
 * only the fields the agent needs and never throws. Validation, credential
 * resolution, and the authoritative channel ACL all happen orchestrator-side at
 * spawn time, so this reader does no schema validation.
 */
import { existsSync, readFileSync } from 'fs';

export interface CatalogTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  channels?: string[];
  timeout?: number;
}

export interface Catalog {
  /** Tools visible to `channelName`: those with empty/absent `channels` or that list it. */
  getForChannel(channelName: string): CatalogTool[];
}

export function loadCatalog(path: string): Catalog {
  let tools: CatalogTool[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
        tools?: unknown[];
      };
      if (Array.isArray(parsed.tools)) {
        tools = parsed.tools
          .filter(
            (t): t is Record<string, unknown> =>
              typeof t === 'object' && t !== null,
          )
          .filter(
            (t) =>
              typeof t.name === 'string' &&
              typeof t.description === 'string' &&
              typeof t.parameters === 'object' &&
              t.parameters !== null,
          )
          .map((t) => ({
            name: t.name as string,
            description: t.description as string,
            parameters: t.parameters as Record<string, unknown>,
            channels: Array.isArray(t.channels)
              ? (t.channels as string[])
              : undefined,
            timeout:
              typeof t.timeout === 'number' ? (t.timeout as number) : undefined,
          }));
      }
    } catch {
      tools = [];
    }
  }
  return {
    getForChannel(channelName: string): CatalogTool[] {
      return tools.filter(
        (t) => !t.channels?.length || t.channels.includes(channelName),
      );
    },
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run container/agent-runner/src/tool-catalog.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
npx prettier --write container/agent-runner/src/tool-catalog.ts container/agent-runner/src/tool-catalog.test.ts
git add container/agent-runner/src/tool-catalog.ts container/agent-runner/src/tool-catalog.test.ts
git commit -m "feat(agent-runner): add lenient local tool-catalog reader"
```

---

## Task 2: Mount the `kubeclaw-tools` ConfigMap on agent jobs

**Why:** The agent job needs `tools.json` at `/etc/kubeclaw/tools` to read the catalog. Mirror the existing `specialists-catalog` mount. Bootstrap uses a separate manifest path (`bootstrap-runner.ts`) and is unaffected.

**Files:**
- Modify: `src/k8s/job-runner.ts` (`generateJobManifest` — the `specialists-catalog` push block, ~lines 973-982)
- Test: `src/k8s/job-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Read the existing `generateJobManifest` tests in `src/k8s/job-runner.test.ts` to match the harness (how it calls `generateJobManifest`/`createAgentPodJob` and inspects volumes). Add:

```typescript
it('agent job manifest mounts the kubeclaw-tools ConfigMap at /etc/kubeclaw/tools', () => {
  const manifest = generateJobManifest(/* use the same args the neighbouring tests use */);
  const container = manifest.spec.template.spec.containers[0];
  const mount = container.volumeMounts.find(
    (m: any) => m.mountPath === '/etc/kubeclaw/tools',
  );
  expect(mount).toBeDefined();
  expect(mount.readOnly).toBe(true);
  const vol = manifest.spec.template.spec.volumes.find(
    (v: any) => v.name === mount.name,
  );
  expect(vol.configMap.name).toBe('kubeclaw-tools');
  expect(vol.configMap.optional).toBe(true);
});
```

(If `generateJobManifest` is not exported, follow whatever the neighbouring tests do — they may call a public method like `createAgentPodJob` with a fake client and capture the manifest. Use the same approach.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/k8s/job-runner.test.ts`
Expected: FAIL — no `/etc/kubeclaw/tools` mount.

- [ ] **Step 3: Add the volume + volumeMount**

In `src/k8s/job-runner.ts`, find the specialists mount block (~973-982):

```typescript
volumes.push({
  name: 'specialists-catalog',
  configMap: { name: 'kubeclaw-specialists', optional: true },
} as any);
volumeMounts.push({
  name: 'specialists-catalog',
  mountPath: '/etc/kubeclaw/specialists',
  readOnly: true,
} as any);
```

Immediately after it, add:

```typescript
// Mount the merged tool catalog ConfigMap so the agent-runner can read tools.json
// and route tool execution by name (same catalog the channel pods mount).
volumes.push({
  name: 'tools-catalog',
  configMap: { name: 'kubeclaw-tools', optional: true },
} as any);
volumeMounts.push({
  name: 'tools-catalog',
  mountPath: '/etc/kubeclaw/tools',
  readOnly: true,
} as any);
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/k8s/job-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "feat(jobs): mount kubeclaw-tools ConfigMap on agent job manifests"
```

---

## Task 3: By-name tool dispatch in the agent-runner

**Why:** Replace the category-based `tool_pod_request` + ACK spawn with the channel's by-name `spawn-tool-pod` path. Add the new function alongside the old one (the old one is removed in Task 5).

**Files:**
- Modify: `container/agent-runner/src/index.ts` (add `callCatalogToolViaRedis` near the existing `callToolViaRedis`, ~line 350)
- Test: `container/agent-runner/src/catalog-dispatch.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/catalog-dispatch.test.ts`. It drives a fake redis exposing `xAdd` and `xRead`, asserts the spawn XADD + call XADD fields, and that the result is correlated by `requestId`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { callCatalogToolViaRedis } from './index.js';

function fakeRedis() {
  const adds: Array<{ stream: string; fields: Record<string, string> }> = [];
  let resultPushed = false;
  return {
    adds,
    xAdd: vi.fn(async (stream: string, _id: string, fields: Record<string, string>) => {
      adds.push({ stream, fields });
      return '1-0';
    }),
    // First poll: no data; second poll: the matching result keyed by the call's requestId.
    xRead: vi.fn(async () => {
      const call = adds.find((a) => a.stream.startsWith('kubeclaw:toolcalls:'));
      if (!call || resultPushed) {
        if (!resultPushed && call) {
          resultPushed = true;
          return [
            {
              name: `kubeclaw:toolresults:job-1:bash`,
              messages: [
                { id: '1-0', message: { requestId: call.fields.requestId, result: JSON.stringify('hello') } },
              ],
            },
          ];
        }
        return null;
      }
      return null;
    }),
  };
}

describe('callCatalogToolViaRedis', () => {
  it('writes the call, spawns by name, and returns the correlated result', async () => {
    const redis = fakeRedis();
    const spawned = new Set<string>();
    const out = await callCatalogToolViaRedis(
      redis as any,
      'job-1',
      'g1',
      '', // channel (uniform option A)
      { name: 'bash', description: 'd', parameters: {} },
      { command: 'echo hello' },
      spawned,
    );
    expect(out).toBe('hello');

    const call = redis.adds.find((a) => a.stream === 'kubeclaw:toolcalls:job-1:bash');
    expect(call?.fields.tool).toBe('bash');
    expect(JSON.parse(call!.fields.input)).toEqual({ command: 'echo hello' });

    const spawn = redis.adds.find((a) => a.stream === 'kubeclaw:spawn-tool-pod');
    expect(spawn?.fields).toMatchObject({
      agentJobId: 'job-1',
      groupFolder: 'g1',
      category: 'bash',
      channel: '',
    });
    expect(spawn?.fields.timeout).toBeDefined();
  });

  it('spawns only once per tool name', async () => {
    const redis = fakeRedis();
    const spawned = new Set<string>();
    await callCatalogToolViaRedis(redis as any, 'job-1', 'g1', '', { name: 'bash', description: 'd', parameters: {} }, { command: 'a' }, spawned);
    // second call reuses the pod: no second spawn XADD
    const before = redis.adds.filter((a) => a.stream === 'kubeclaw:spawn-tool-pod').length;
    expect(before).toBe(1);
    expect(spawned.has('bash')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run container/agent-runner/src/catalog-dispatch.test.ts`
Expected: FAIL — `callCatalogToolViaRedis` is not exported.

- [ ] **Step 3: Implement `callCatalogToolViaRedis`**

In `container/agent-runner/src/index.ts`, add this exported function next to `callToolViaRedis` (after it, ~line 415). It mirrors the channel's `executeToolViaK8s` by-name path. Add a `CatalogTool` import from the reader and a default timeout constant:

```typescript
import type { CatalogTool } from './tool-catalog.js';

const SPAWN_TOOL_POD_STREAM = 'kubeclaw:spawn-tool-pod';
const CATALOG_TOOL_TIMEOUT_MS = 120_000;

/**
 * Execute a catalog tool by NAME via the orchestrator's spawn-tool-pod stream —
 * the same path the channel's DirectLLMRunner uses. Writes the call first, then
 * requests the sidecar pod (once per tool name), then block-reads the result
 * stream from '0-0' and correlates by requestId.
 */
export async function callCatalogToolViaRedis(
  redis: RedisClientType,
  agentJobId: string,
  groupFolder: string,
  channel: string,
  spec: CatalogTool,
  args: Record<string, unknown>,
  spawnedTools: Set<string>,
): Promise<string> {
  const toolName = spec.name;
  const timeoutMs = spec.timeout ?? CATALOG_TOOL_TIMEOUT_MS;
  const requestId = randomUUID();
  const callsStream = `kubeclaw:toolcalls:${agentJobId}:${toolName}`;
  const resultsStream = `kubeclaw:toolresults:${agentJobId}:${toolName}`;

  // Write the call BEFORE spawning so the pod (which reads from lastId='0-0')
  // cannot miss it.
  await (redis as any).xAdd(callsStream, '*', {
    requestId,
    tool: toolName,
    input: JSON.stringify(args),
  });

  if (!spawnedTools.has(toolName)) {
    spawnedTools.add(toolName);
    await (redis as any).xAdd(SPAWN_TOOL_POD_STREAM, '*', {
      agentJobId,
      groupFolder,
      category: toolName,
      timeout: String(timeoutMs),
      channel,
    });
    log(`Requested sidecar tool pod for ${toolName}`);
  }

  const deadline = Date.now() + timeoutMs;
  let lastId = '0-0';
  while (Date.now() < deadline) {
    const blockMs = Math.min(deadline - Date.now(), 5000);
    const response = await (redis as any).xRead(
      [{ key: resultsStream, id: lastId }],
      { BLOCK: blockMs, COUNT: 10 },
    );
    if (!response?.length) continue;
    for (const stream of response) {
      for (const msg of (stream as any).messages ?? []) {
        lastId = msg.id;
        const f = msg.message as Record<string, string>;
        if (f.requestId !== requestId) continue;
        if (f.error) return `Tool error: ${f.error}`;
        try {
          const parsed = JSON.parse(f.result ?? 'null');
          return typeof parsed === 'string'
            ? parsed
            : JSON.stringify(parsed, null, 2);
        } catch {
          return f.result ?? '';
        }
      }
    }
  }
  return `Tool timed out after ${Math.floor(timeoutMs / 1000)}s`;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run container/agent-runner/src/catalog-dispatch.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
npx prettier --write container/agent-runner/src/index.ts container/agent-runner/src/catalog-dispatch.test.ts
git add container/agent-runner/src/index.ts container/agent-runner/src/catalog-dispatch.test.ts
git commit -m "feat(agent-runner): add by-name catalog tool dispatch via spawn-tool-pod"
```

---

## Task 4: Rewire `buildToolDefinitions` to the catalog

**Why:** Drop the 9 hardcoded routed tools; build catalog tools from the reader; keep the IPC tools. Load the reader in `runAgentLoop` and pass the channel + tool list in.

**Files:**
- Modify: `container/agent-runner/src/index.ts` (`buildToolDefinitions` ~618-929; `runAgentLoop` catalog load + call ~941-963)
- Test: `container/agent-runner/src/build-tools.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/build-tools.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildToolDefinitions } from './index.js';
import type { CatalogTool } from './tool-catalog.js';

const catalog: CatalogTool[] = [
  { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'web_search', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
];

function build(opts: { isSuperuser?: boolean; isMain?: boolean } = {}) {
  return buildToolDefinitions({
    isSuperuser: opts.isSuperuser ?? false,
    isMain: opts.isMain ?? false,
    redis: {} as any,
    agentJobId: 'job-1',
    groupFolder: 'g1',
    chatJid: 'c1',
    channel: '',
    catalogTools: catalog,
    spawnedTools: new Set<string>(),
  });
}

describe('buildToolDefinitions', () => {
  it('exposes catalog tools by name', () => {
    const names = build().map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('web_search');
  });

  it('no longer exposes the old hardcoded routed tools', () => {
    const names = build().map((t) => t.name);
    for (const gone of ['read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'agent_browser']) {
      expect(names).not.toContain(gone);
    }
  });

  it('keeps the IPC tools', () => {
    const names = build().map((t) => t.name);
    for (const kept of ['send_message', 'schedule_task', 'list_tasks', 'pause_task', 'resume_task', 'cancel_task', 'update_task']) {
      expect(names).toContain(kept);
    }
  });

  it('adds main-only and superuser tools when flagged', () => {
    const mainNames = build({ isMain: true }).map((t) => t.name);
    expect(mainNames).toContain('register_group');
    expect(mainNames).toContain('deploy_channel');
    const suNames = build({ isSuperuser: true }).map((t) => t.name);
    expect(suNames).toContain('local_bash');
  });

  it('catalog tool parameters pass through as JSON Schema', () => {
    const bash = build().find((t) => t.name === 'bash')!;
    expect(bash.parameters).toMatchObject({ type: 'object' });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run container/agent-runner/src/build-tools.test.ts`
Expected: FAIL — `buildToolDefinitions` has the old positional signature, not the new options object, and `bash` is hardcoded not catalog-driven.

- [ ] **Step 3: Change the `buildToolDefinitions` signature to an options object and drop the routed tools**

In `container/agent-runner/src/index.ts`, replace the function signature (618-627) and the entire routed-tools section (the array literal entries for `bash`,`read`,`write`,`edit`,`glob`,`grep`,`web_fetch`,`web_search`,`agent_browser`, lines 628-745) with a catalog-driven build. The new signature and head:

```typescript
import type { TSchema } from '@sinclair/typebox';

interface BuildToolDefinitionsArgs {
  isSuperuser: boolean;
  isMain: boolean;
  redis: RedisClientType;
  agentJobId: string;
  groupFolder: string;
  chatJid: string;
  channel: string;
  catalogTools: CatalogTool[];
  spawnedTools: Set<string>;
}

export function buildToolDefinitions(
  args: BuildToolDefinitionsArgs,
): AgentTool<any>[] {
  const {
    isSuperuser,
    isMain,
    redis,
    agentJobId,
    groupFolder,
    chatJid,
    channel,
    catalogTools,
    spawnedTools,
  } = args;

  // Catalog tools — routed by name through the spawn-tool-pod stream, identical
  // to the channel's DirectLLMRunner. Parameters are plain JSON Schema (pi-ai
  // validates with AJV), so the catalog spec passes straight through.
  const tools: AgentTool<any>[] = catalogTools.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters as unknown as TSchema,
    execute: async (_id: string, params: unknown) =>
      textResult(
        await callCatalogToolViaRedis(
          redis,
          agentJobId,
          groupFolder,
          channel,
          spec,
          params as Record<string, unknown>,
          spawnedTools,
        ),
      ),
  }));

  // IPC tools (in-process / Redis pub-sub) — unchanged.
  tools.push(
```

Then keep all the existing IPC tool object literals (`send_message` through `update_task`) — but note they were previously elements of the initial array literal; now they must be arguments to `tools.push(...)`. Wrap the seven IPC tool object literals (originally lines 747-827) as comma-separated arguments to this single `tools.push( ... )` call, closing with `);` where the original array closed (line 828, replace `];` with `);`).

Leave the `if (isMain) { tools.push({...}) }` (830-878) and `if (isSuperuser) { tools.push(...) }` (880-926) blocks and the final `return tools;` (928) exactly as they are.

Add the `CatalogTool` import at the top if not already added in Task 3 (`import type { CatalogTool } from './tool-catalog.js';`).

- [ ] **Step 4: Update `runAgentLoop` to load the catalog and call the new signature**

In `container/agent-runner/src/index.ts` `runAgentLoop` (~941-963), the current code is:

```typescript
const isSuperuser = process.env.KUBECLAW_SUPERUSER === 'true';
const podReadyMap = new Map<string, boolean>();
```
...
```typescript
const tools = buildToolDefinitions(
  isSuperuser, input.isMain, redis, inputStream, jobId,
  input.groupFolder, input.chatJid, podReadyMap,
);
```

Replace the `podReadyMap` line with a spawned-tools set, load the catalog, and call with the options object:

```typescript
const isSuperuser = process.env.KUBECLAW_SUPERUSER === 'true';
const channel = process.env.KUBECLAW_CHANNEL ?? '';
const spawnedTools = new Set<string>();
const catalog = loadCatalog('/etc/kubeclaw/tools/tools.json');
const catalogTools = catalog.getForChannel(channel);
```
...
```typescript
const tools = buildToolDefinitions({
  isSuperuser,
  isMain: input.isMain,
  redis,
  agentJobId: jobId,
  groupFolder: input.groupFolder,
  chatJid: input.chatJid,
  channel,
  catalogTools,
  spawnedTools,
});
```

Add the import at the top of the file: `import { loadCatalog } from './tool-catalog.js';`. The `inputStream` argument is no longer passed to `buildToolDefinitions` (the catalog path doesn't need it); `inputStream` is still used elsewhere in `runAgentLoop`, so leave its construction intact.

- [ ] **Step 5: Run the build-tools test to confirm it passes**

Run: `npx vitest run container/agent-runner/src/build-tools.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Typecheck the agent-runner package**

Run: `cd container/agent-runner && npx tsc --noEmit && cd ../..`
Expected: no errors. (If `@sinclair/typebox` is not a direct dependency, `TSchema` may still resolve transitively via `pi-ai`; if `tsc` cannot find it, import `TSchema` from `@mariozechner/pi-ai` instead — verify with `grep -r "TSchema" container/agent-runner/node_modules/@mariozechner/pi-ai/dist/*.d.ts`.)

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
npx prettier --write container/agent-runner/src/index.ts container/agent-runner/src/build-tools.test.ts
git add container/agent-runner/src/index.ts container/agent-runner/src/build-tools.test.ts
git commit -m "feat(agent-runner): build tools from the catalog; drop hardcoded routed tools"
```

---

## Task 5: Remove the dead `tool_pod_request` / `execution`-category machinery

**Why:** After Task 4 nothing publishes `tool_pod_request` and nothing routes the `execution` category. Remove the dead producer/consumer/cases and fix stale comments. Each removal is gated on a grep that proves no remaining caller.

**Files:**
- Modify: `container/agent-runner/src/index.ts` (remove `callToolViaRedis`, `TOOL_CATEGORY`, `TOOL_SERVER_NAME`, `POD_ACK_TIMEOUT`, `waitForToolPodAck`, the `tool_pod_ack` enqueue handling; update the file-header comment + stale superuser comment)
- Modify: `src/k8s/ipc-redis.ts` (remove the `tool_pod_request` case + its `tool_pod_ack` producer; drop `'execution'` from `BUILTIN_CATEGORIES`)
- Modify: `container/agent-runner/src/tool-server.ts` (remove the dead `execution`/`browser` cases in `executeToolLocal`, only if proven unreachable)
- Modify: `src/k8s/types.ts` (narrow `ToolPodJobSpec.category` union) and `src/k8s/job-runner.ts` (`createToolPodJob` category type) — only if proven safe
- Test: `src/k8s/ipc-redis.test.ts`

- [ ] **Step 1: Prove no remaining producer of `tool_pod_request`**

Run: `grep -rn "tool_pod_request\|waitForToolPodAck\|tool_pod_ack" src container/agent-runner/src | grep -v '\.test\.'`
Expected: matches ONLY in `container/agent-runner/src/index.ts` (the soon-removed `callToolViaRedis` + `InputStreamManager`) and `src/k8s/ipc-redis.ts` (the handler). If any OTHER producer exists, stop and reassess.

- [ ] **Step 2: Write the failing test that the orchestrator no longer handles `tool_pod_request` and `execution` is not builtin**

Read `src/k8s/ipc-redis.test.ts` to find how `processTaskIpc` and `BUILTIN_CATEGORIES` are exercised (and whether `BUILTIN_CATEGORIES` is exported — if not, test behavior via the spawn watcher path or export it for the test). Add:

```typescript
it('does not create a tool pod for a legacy tool_pod_request message', async () => {
  // Use the file's existing processTaskIpc harness + a spy on jobRunner.createToolPodJob.
  const createToolPodJob = vi.fn();
  await processTaskIpc(
    JSON.stringify({ type: 'tool_pod_request', agentJobId: 'j', category: 'execution', groupFolder: 'g' }),
    { ...deps, jobRunner: { ...deps.jobRunner, createToolPodJob } } as any,
  );
  expect(createToolPodJob).not.toHaveBeenCalled();
});
```

(Adapt to the actual `processTaskIpc` signature/harness in the file. If the harness is awkward, instead assert on `BUILTIN_CATEGORIES` directly once it's exported: `expect(BUILTIN_CATEGORIES.has('execution')).toBe(false)` and `expect(BUILTIN_CATEGORIES.has('places')).toBe(true)`.)

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/k8s/ipc-redis.test.ts`
Expected: FAIL (the handler still creates a pod / `execution` still builtin).

- [ ] **Step 4: Remove the `tool_pod_request` handler + ack producer in ipc-redis.ts**

In `src/k8s/ipc-redis.ts`, delete the entire `case 'tool_pod_request':` block (the case label through its `break;`, ~lines 751-793, including the `tool_pod_ack` XADD it publishes).

- [ ] **Step 5: Drop `'execution'` from BUILTIN_CATEGORIES**

In `src/k8s/ipc-redis.ts` line 279:

```typescript
const BUILTIN_CATEGORIES = new Set(['execution', 'places']);
```
becomes:
```typescript
const BUILTIN_CATEGORIES = new Set(['places']);
```

If `BUILTIN_CATEGORIES` is not already exported and Step 2 asserts on it, add `export` here.

- [ ] **Step 6: Run the ipc-redis test to confirm it passes**

Run: `npx vitest run src/k8s/ipc-redis.test.ts`
Expected: PASS.

- [ ] **Step 7: Remove the agent-runner's dead category dispatch**

In `container/agent-runner/src/index.ts`, delete: the `TOOL_CATEGORY` map (329-339), the `TOOL_SERVER_NAME` map (341-345), the `POD_ACK_TIMEOUT` constant (348), and the entire `callToolViaRedis` function (350-414). In `InputStreamManager`, delete the `waitForToolPodAck` method (and the `tool_pod_ack`-specific handling) — but KEEP `poll`, `blockPoll`, `drainUserMessages`, `hasCloseSignal`, `_enqueue`, since they are still used for follow-up/close signals. In `_enqueue`, the `category`/`podJobId` fields on `InputEntry` were only for acks; leave the struct as-is (harmless) or trim `category`/`podJobId` from `InputEntry` and the `_enqueue` push if `tsc` reports them unused — verify with the typecheck in Step 10.

- [ ] **Step 8: Update the stale comments**

In `container/agent-runner/src/index.ts`, replace the file-header comment block's tool-routing description (lines 11-18, the "Tool calls: all routed via Redis streams…/Execution tools…/Browser tools…" paragraph) with:

```
 * Tool calls: catalog tools are routed BY NAME through the orchestrator's
 *   kubeclaw:spawn-tool-pod stream → sidecar tool pod → kubeclaw:toolresults
 *   (identical to the channel's DirectLLMRunner). IPC tools (send_message,
 *   schedule_task, …) publish to Redis directly, no tool pod.
```

And fix the superuser comment (lines 20-22) — change "Only set by the orchestrator for privileged groups." to "Only set by the bootstrap Job (Mode 1); never on normal agent jobs."

- [ ] **Step 9: Remove the dead `executeToolLocal` cases (gated)**

Run: `grep -rn "createToolPodJob" src | grep -v '\.test\.'` to enumerate callers. Confirm the only remaining caller passes `category: 'places'` (the spawn watcher builtin branch). If so, in `container/agent-runner/src/tool-server.ts` `executeToolLocal`, remove the `execution` cases (`bash`/`read`/`write`/`edit`/`glob`/`grep`/`todoWrite`/`notebookEdit`) and the `browser` cases (`webFetch`/`webSearch`/`agentBrowser`), leaving the `task`/`taskOutput`/`taskStop` cases and the `default` throw. Do NOT touch anything `places`-related. If any non-places caller of `createToolPodJob` remains, SKIP this step and note it in the task report (the cases stay until the places follow-on).

- [ ] **Step 10: Narrow the category union (gated)**

If Step 9 succeeded (only `places` flows through `createToolPodJob`), narrow the union in `src/k8s/types.ts` (`ToolPodJobSpec.category`) and `src/k8s/job-runner.ts` (`createToolPodJob` param + any `as 'browser' | 'execution' | 'places'` casts in `ipc-redis.ts` line ~1050) from `'execution' | 'browser' | 'places'` to `'places'`. Run `npx tsc --noEmit` at the root and `cd container/agent-runner && npx tsc --noEmit && cd ../..` to surface any now-broken references; fix them. If narrowing causes widespread churn beyond these files, leave the union as-is (it is harmless) and note it.

- [ ] **Step 11: Run the full suite + typechecks**

Run:
```bash
npx vitest run
npx tsc --noEmit
cd container/agent-runner && npx tsc --noEmit && cd ../..
```
Expected: all PASS / no type errors.

- [ ] **Step 12: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
npx prettier --write container/agent-runner/src/index.ts container/agent-runner/src/tool-server.ts
git add container/agent-runner/src/index.ts container/agent-runner/src/tool-server.ts src/k8s/ipc-redis.ts src/k8s/ipc-redis.test.ts src/k8s/types.ts src/k8s/job-runner.ts
git commit -m "refactor: retire dead tool_pod_request/execution-category machinery"
```

---

## Task 6: End-to-end — agent job runs catalog tools via the sidecar bridge

**Why:** Verify the whole path: an agent Job loads the catalog, calls `bash`/`bash_persist` by name, the orchestrator spawns the sidecar, and the result returns.

**Files:**
- Create: `e2e/agent-runner-catalog.test.ts`

- [ ] **Step 1: Find the e2e harness conventions**

Read an existing minikube-live e2e (e.g. the combined-journey test referenced in recent commits `d9f79dc`/`d55a532`, and any `e2e/*.test.ts` for sidecar tool pods). Note: how it gates on cluster/docker availability (`ctx.skip()`), how it deploys the chart, how it submits an agent job/prompt, and how it asserts on Redis result streams or messages. Reuse that harness exactly.

- [ ] **Step 2: Write the e2e test**

Create `e2e/agent-runner-catalog.test.ts` following that harness. The test must:
1. Skip cleanly (`ctx.skip()`) when the cluster/docker is unavailable (match the existing pattern — do NOT silently pass).
2. Deploy/upgrade the chart so the `kubeclaw-tools` ConfigMap and agent image are present.
3. Submit an agent job (non-bootstrap, e.g. via a prompt that forces a `bash` call like "run `echo kubeclaw-e2e-marker` and report the output").
4. Assert the agent's final message contains `kubeclaw-e2e-marker` (proving `bash` executed through the sidecar bridge).
5. Submit a second prompt forcing `bash_persist` to write a file under `/workspace/group` and a follow-up that reads it back, asserting persistence across the group PVC.

Keep assertions resilient (poll with a timeout, as the neighbouring e2e does). Do not hardcode image tags the harness already parameterizes.

- [ ] **Step 3: Run the e2e (or confirm clean skip)**

Run: `npx vitest run e2e/agent-runner-catalog.test.ts`
Expected: PASS if a cluster is available; otherwise a clean SKIP (not a silent pass). If the environment has no cluster, confirm the skip path triggers and move on.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add e2e/agent-runner-catalog.test.ts
git commit -m "test(e2e): agent job runs bash/bash_persist catalog tools via sidecar bridge"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite: `npx vitest run` → all green.
- [ ] Typecheck both packages: `npx tsc --noEmit` and `cd container/agent-runner && npx tsc --noEmit && cd ../..`.
- [ ] Helm still renders: `helm template helm/kubeclaw >/dev/null && echo OK`.
- [ ] Grep proves the dead machinery is gone: `grep -rn "tool_pod_request\|TOOL_CATEGORY\|callToolViaRedis" container/agent-runner/src src | grep -v '\.test\.'` → no matches (except possibly in unrelated comments).
- [ ] Bootstrap untouched: `git diff main -- src/k8s/bootstrap-runner.ts` → empty.

## Self-review notes (author)

- **Spec coverage:** §0 → Task 0; §1 (reader) → Task 1; §1 (mount) → Task 2; §3 (dispatch) → Task 3; §2 (assembly/ACL) → Task 4; §4 (dead-code) → Task 5; testing §5 → Tasks 0-6. All spec sections map to a task.
- **Type consistency:** `callCatalogToolViaRedis(redis, agentJobId, groupFolder, channel, spec, args, spawnedTools)` is defined in Task 3 and consumed with the same arg order in Task 4. `buildToolDefinitions({...})` options object defined and consumed consistently across Task 4. `CatalogTool` (name/description/parameters/channels?/timeout?) defined in Task 1 and used in Tasks 3-4. `ToolSpec.timeout` added in Task 0 and consumed by `createSidecarToolPodJob` (Task 0) and the reader (Task 1).
- **Gated deletions:** Task 5 steps 1/9/10 require grep proof before removing, so a missed producer fails loudly rather than silently breaking.
