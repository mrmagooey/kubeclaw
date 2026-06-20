# Channel Migration — Foundation + IRC Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the single generic image host runtime-delivered channel adapters under `channel-runner.js`, and cut `irc` over to that path (installed via the bootstrap flow), proving the architecture end-to-end on the smallest channel.

**Architecture:** A new in-image **Channel SDK** is dependency-injected into a runtime adapter that `channel-runner.js` loads from `/runtime/channel-entry.js`; the adapter self-registers via the resident `registerChannel`. The steady-state Deployment chooses its entrypoint by a `hostMode` field on the channel **manifest** (`channel-runner` for SDK channels, default `standalone` for echo demos), and `channel-runner` mode mounts the groups/store/sessions PVCs the host needs. IRC is rewritten as an SDK adapter and installed via the bootstrap flow; its compiled-in/`setup_channel`/Helm paths are removed (clean cutover).

**Tech Stack:** TypeScript (Node 22), `@kubernetes/client-node`, Vitest, Helm, the exec-push bootstrap system (already on `main`), `irc-upd`.

## Global Constraints

- Node `>=20` (repo targets v22 per `.nvmrc`). Run `npm`/`npx`/`git commit` with Node 22 on PATH: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"` (the husky pre-commit hook needs it).
- All new behaviour needs unit, integration, and e2e coverage. Where a level genuinely does not apply, say so in the task.
- **Single image only** — no new `channel-base` image. The steady-state SDK-channel pod runs `node dist/channel-runner.js` on the existing `kubeclaw-agent`/orchestrator image (both already contain `dist/channel-runner.js`).
- **SDK via dependency injection** — the adapter default-exports `register(sdk)`; the host calls it with the resident SDK object. The adapter's only *runtime* imports are its own npm deps. SDK types are dev-time only.
- **Clean cutover** for irc: no dual in-image/runtime path. Remove compiled-in registration, `setup_channel` applicability, and Helm `channels:` install for irc.
- `hostMode` lives on the channel **manifest** object (`'standalone' | 'channel-runner'`, default `'standalone'`). The commit handler reads it; it is never reported by the bootstrap pod.
- Channel/bootstrap pods keep **zero** Kubernetes API access (`automountServiceAccountToken: false`).
- Commit messages end with the repo's `Co-Authored-By` trailer.

---

## File Structure

**New files:**
- `src/channel-sdk/index.ts` — the `ChannelSdk` interface + `buildChannelSdk()` (assembles the injected object) + `RuntimeAdapterRegister` type.
- `src/channel-sdk/index.test.ts` — unit tests.
- `src/channel-sdk/load-runtime-adapter.ts` — `loadRuntimeChannelAdapter(sdk, entryPath?)`.
- `src/channel-sdk/load-runtime-adapter.test.ts` — unit tests (fake adapter from temp dir).
- `helm/kubeclaw/files/channel-src/irc/channel-entry.js` — the irc SDK adapter.
- `helm/kubeclaw/files/bootstrap-skills/bootstrap-irc.md` — irc bootstrap skill.
- `src/channel-src/irc-adapter.test.ts` — ported irc unit tests (the adapter's pure logic).
- `e2e/minikube-live-channel-irc-bootstrap.test.ts` — irc bootstrap e2e.

**Modified files:**
- `src/channel-runner.ts` — call `loadRuntimeChannelAdapter` before `getChannelFactory`.
- `src/channel-manifests/reconciler.ts` — carry `hostMode` through the manifest entry → ConfigMap.
- `src/skills/orchestrator/channel-manifest-registry.ts` — accept/validate optional `hostMode`.
- `helm/kubeclaw/templates/channel-manifests-configmap.yaml` — pass `hostMode` into the baseline ConfigMap JSON.
- `src/k8s/ipc-redis-bootstrap.ts` — `getChannelHostMode` dep + `createPvc` dep; host-selector branch in the Deployment builder (command + groups/store/sessions PVCs).
- `src/index.ts` — wire the two new deps.
- `src/channels/index.ts` — remove `import './irc.js';`.
- `src/skills/orchestrator/channel-setup.ts` — remove the irc `buildSecretData` branch (cutover).
- `helm/kubeclaw/values-minikube.yaml` — add the irc manifest with `hostMode: channel-runner`.
- `e2e/minikube-live-setup.ts` — replace the Helm `channels.irc.*` install + irc Secret pre-create with bootstrap registration (`--set-json` manifest + `--set-file` skill); keep test-ircd.

**Deleted files:**
- `src/channels/irc.ts` — becomes the runtime adapter (O1: single source under `files/channel-src/irc/`).
- `src/channels/irc.test.ts` — ported to `src/channel-src/irc-adapter.test.ts` and the e2e.

---

## Task 1: Channel SDK module

**Files:**
- Create: `src/channel-sdk/index.ts`
- Test: `src/channel-sdk/index.test.ts`

**Interfaces:**
- Produces:
  - `interface ChannelSdk { registerChannel: typeof registerChannel; logger: typeof logger; readEnvFile: typeof readEnvFile; assistantName: string }`
  - `type RuntimeAdapterRegister = (sdk: ChannelSdk) => void`
  - `function buildChannelSdk(): ChannelSdk`

- [ ] **Step 1: Write the failing test**

```ts
// src/channel-sdk/index.test.ts
import { describe, it, expect } from 'vitest';
import { buildChannelSdk } from './index.js';
import { registerChannel } from '../channels/registry.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { ASSISTANT_NAME } from '../config.js';

describe('buildChannelSdk', () => {
  it('exposes the resident singletons and assistant name', () => {
    const sdk = buildChannelSdk();
    expect(sdk.registerChannel).toBe(registerChannel);
    expect(sdk.logger).toBe(logger);
    expect(sdk.readEnvFile).toBe(readEnvFile);
    expect(sdk.assistantName).toBe(ASSISTANT_NAME);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"; npx vitest run src/channel-sdk/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channel-sdk/index.ts
/**
 * Channel SDK — the curated, stable surface the single generic image exposes to
 * runtime-delivered channel adapters. The host (channel-runner) injects an
 * instance of ChannelSdk into an adapter's default-exported register(sdk)
 * function; the adapter calls sdk.registerChannel(...) exactly as a compiled-in
 * channel does. Adapters depend ONLY on this surface from the image; everything
 * else is their own npm dependency.
 */
import { registerChannel } from '../channels/registry.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { ASSISTANT_NAME } from '../config.js';

export interface ChannelSdk {
  registerChannel: typeof registerChannel;
  logger: typeof logger;
  readEnvFile: typeof readEnvFile;
  assistantName: string;
}

/** Signature an adapter module must default-export. */
export type RuntimeAdapterRegister = (sdk: ChannelSdk) => void;

export function buildChannelSdk(): ChannelSdk {
  return {
    registerChannel,
    logger,
    readEnvFile,
    assistantName: ASSISTANT_NAME,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/channel-sdk/index.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/channel-sdk/index.ts src/channel-sdk/index.test.ts
git commit -m "feat(channel-sdk): injected SDK surface for runtime channel adapters"
```

---

## Task 2: `loadRuntimeChannelAdapter`

**Files:**
- Create: `src/channel-sdk/load-runtime-adapter.ts`
- Test: `src/channel-sdk/load-runtime-adapter.test.ts`

**Interfaces:**
- Consumes: `ChannelSdk`, `RuntimeAdapterRegister` (Task 1).
- Produces: `async function loadRuntimeChannelAdapter(sdk: ChannelSdk, entryPath?: string): Promise<boolean>` — returns `true` if an adapter was loaded and its `register(sdk)` invoked; `false` if `entryPath` does not exist. **Throws** if the file exists but cannot be imported or lacks a function default export.

- [ ] **Step 1: Write the failing test**

```ts
// src/channel-sdk/load-runtime-adapter.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeChannelAdapter } from './load-runtime-adapter.js';
import type { ChannelSdk } from './index.js';

function fakeSdk(): ChannelSdk {
  return {
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    readEnvFile: vi.fn(() => ({})),
    assistantName: 'Andy',
  };
}

describe('loadRuntimeChannelAdapter', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rta-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns false when the entry file is absent', async () => {
    const loaded = await loadRuntimeChannelAdapter(fakeSdk(), join(dir, 'nope.js'));
    expect(loaded).toBe(false);
  });

  it('imports the adapter and invokes its default register(sdk)', async () => {
    const entry = join(dir, 'channel-entry.mjs');
    writeFileSync(entry, `export default function register(sdk){ sdk.registerChannel('fake', () => null); }`);
    const sdk = fakeSdk();
    const loaded = await loadRuntimeChannelAdapter(sdk, entry);
    expect(loaded).toBe(true);
    expect(sdk.registerChannel).toHaveBeenCalledWith('fake', expect.any(Function));
  });

  it('throws when the default export is not a function', async () => {
    const entry = join(dir, 'bad.mjs');
    writeFileSync(entry, `export default 42;`);
    await expect(loadRuntimeChannelAdapter(fakeSdk(), entry)).rejects.toThrow(/default export.*function/i);
  });
});
```

Note: test files use the `.mjs` extension so Node treats them as ESM regardless of the temp dir's package.json; the production default path is `/runtime/channel-entry.js` (Node 22 auto-detects ESM for `import` syntax — confirmed in the exec-push work).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channel-sdk/load-runtime-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/channel-sdk/load-runtime-adapter.ts
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ChannelSdk, RuntimeAdapterRegister } from './index.js';

const DEFAULT_ENTRY = '/runtime/channel-entry.js';

/**
 * Load a runtime-delivered channel adapter and invoke its register(sdk).
 * Returns false if no adapter is present (the pod has only compiled-in
 * channels). Throws if the file exists but is not a valid adapter — a runtime
 * channel pod with a broken adapter must crash-loop with an actionable error,
 * not silently run nothing.
 */
export async function loadRuntimeChannelAdapter(
  sdk: ChannelSdk,
  entryPath: string = DEFAULT_ENTRY,
): Promise<boolean> {
  if (!existsSync(entryPath)) return false;
  const mod = (await import(pathToFileURL(entryPath).href)) as {
    default?: unknown;
  };
  const register = mod.default;
  if (typeof register !== 'function') {
    throw new Error(
      `Runtime channel adapter at ${entryPath} must have a function default export register(sdk); got ${typeof register}`,
    );
  }
  (register as RuntimeAdapterRegister)(sdk);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/channel-sdk/load-runtime-adapter.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/channel-sdk/load-runtime-adapter.ts src/channel-sdk/load-runtime-adapter.test.ts
git commit -m "feat(channel-sdk): load + invoke a runtime channel adapter"
```

---

## Task 3: Wire adapter loading into `channel-runner.ts`

**Files:**
- Modify: `src/channel-runner.ts` (the factory-lookup region at lines 3567–3576; imports near the top)
- Test: `src/channel-runner.test.ts` (add a focused test) — if the existing test harness cannot exercise `main()`, add a unit test around an extracted helper instead and say so in the report.

**Interfaces:**
- Consumes: `buildChannelSdk` (Task 1), `loadRuntimeChannelAdapter` (Task 2).

- [ ] **Step 1: Implement the wiring**

Add imports near the other channel imports in `src/channel-runner.ts`:
```ts
import { buildChannelSdk } from './channel-sdk/index.js';
import { loadRuntimeChannelAdapter } from './channel-sdk/load-runtime-adapter.js';
```

Immediately **before** `const factory = getChannelFactory(KUBECLAW_CHANNEL_TYPE);` (line 3569), insert:
```ts
  // Load a runtime-delivered channel adapter (bootstrap channels on the
  // single-image path). It self-registers via the resident registerChannel,
  // so the getChannelFactory lookup below resolves it exactly like a
  // compiled-in channel. Absent file → no-op (compiled-in channels only).
  const loadedRuntimeAdapter = await loadRuntimeChannelAdapter(buildChannelSdk());
  if (loadedRuntimeAdapter) {
    logger.info(
      { type: KUBECLAW_CHANNEL_TYPE },
      'Loaded runtime channel adapter from /runtime/channel-entry.js',
    );
  }
```

(The existing `getChannelFactory` → `factory(channelOpts)` → `connectWithRetry` flow is unchanged.)

- [ ] **Step 2: Add a test**

In `src/channel-runner.test.ts`, add a test that imports `loadRuntimeChannelAdapter`, registers a fake adapter into a temp `/runtime`-style path, and asserts the resident registry resolves the type afterward. If `main()` is not unit-testable in the existing harness (likely — it does Redis/DB I/O), assert instead that `loadRuntimeChannelAdapter(buildChannelSdk(), <temp adapter>)` causes `getChannelFactory('<type>')` to return a factory:

```ts
import { getChannelFactory } from './channels/registry.js';
import { buildChannelSdk } from './channel-sdk/index.js';
import { loadRuntimeChannelAdapter } from './channel-sdk/load-runtime-adapter.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('a runtime adapter self-registers into the resident factory registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-'));
  const entry = join(dir, 'entry.mjs');
  writeFileSync(entry, `export default (sdk) => sdk.registerChannel('runtime-test', () => null);`);
  expect(getChannelFactory('runtime-test')).toBeUndefined();
  await loadRuntimeChannelAdapter(buildChannelSdk(), entry);
  expect(getChannelFactory('runtime-test')).toBeTypeOf('function');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/channel-runner.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 4: Commit**

```bash
git add src/channel-runner.ts src/channel-runner.test.ts
git commit -m "feat(channel-runner): load runtime channel adapter before factory lookup"
```

---

## Task 4: `hostMode` on the channel manifest

**Files:**
- Modify: `src/channel-manifests/reconciler.ts` (the `BaselineFileContent`/entry types + merge/render so `hostMode` survives into the live ConfigMap)
- Modify: `src/skills/orchestrator/channel-manifest-registry.ts` (accept optional `hostMode` on registration; default `'standalone'`)
- Modify: `helm/kubeclaw/templates/channel-manifests-configmap.yaml` (emit `hostMode` in each baseline JSON)
- Test: `src/channel-manifests/reconciler.test.ts`, `src/skills/orchestrator/channel-manifest-registry.test.ts`

**Interfaces:**
- Produces: each manifest ConfigMap entry JSON gains `"hostMode": "standalone" | "channel-runner"` (default `"standalone"`). A reader can `JSON.parse(cm.data['<type>.json']).hostMode`.

- [ ] **Step 1: Write failing tests**

In `src/channel-manifests/reconciler.test.ts`, add: a baseline entry whose JSON includes `hostMode: 'channel-runner'` survives the merge+render into the rendered ConfigMap data; an entry without `hostMode` renders with `hostMode: 'standalone'`. In `channel-manifest-registry.test.ts`, add: `registerChannelManifest` accepts a `hostMode` arg and persists it; omitting it defaults `'standalone'`; an invalid value (`'bogus'`) is rejected with an error. (Model the assertions on the existing tests in each file — reuse their fixtures and the `mergeManifests`/`registerChannelManifest` entry points.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channel-manifests/reconciler.test.ts src/skills/orchestrator/channel-manifest-registry.test.ts`
Expected: FAIL — `hostMode` unknown.

- [ ] **Step 3: Implement**

- In `src/channel-manifests/reconciler.ts`: extend `BaselineFileContent` (and the in-memory entry type) with `hostMode?: 'standalone' | 'channel-runner'`; in the render path, write `hostMode: entry.hostMode ?? 'standalone'` into the per-type JSON object alongside `packageJson`/`packageLockJson`/`manifestHash`. Keep the merge (`admin override wins`) unchanged.
- In `src/skills/orchestrator/channel-manifest-registry.ts`: add an optional `host_mode` to the register args; validate it is one of `'standalone'|'channel-runner'` (reject others); persist it (SQLite column `host_mode TEXT` defaulting `'standalone'` — add a `CREATE TABLE`/`ALTER` guard mirroring the existing schema-guard pattern in `src/db.ts`); pass it into the reconciled entry.
- In `helm/kubeclaw/templates/channel-manifests-configmap.yaml`: where each baseline entry's JSON is built from `.Values.bootstrap.channelManifests`, include `"hostMode": "{{ $manifest.hostMode | default "standalone" }}"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channel-manifests/reconciler.test.ts src/skills/orchestrator/channel-manifest-registry.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Lint the helm render**

Run: `helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml --show-only templates/channel-manifests-configmap.yaml | grep -A2 hostMode || echo "no hostMode yet (no manifest sets it until Task 8)"`
Expected: renders without error.

- [ ] **Step 6: Commit**

```bash
git add src/channel-manifests/reconciler.ts src/channel-manifests/reconciler.test.ts src/skills/orchestrator/channel-manifest-registry.ts src/skills/orchestrator/channel-manifest-registry.test.ts helm/kubeclaw/templates/channel-manifests-configmap.yaml
git commit -m "feat(bootstrap): hostMode on channel manifest (default standalone)"
```

---

## Task 5: Commit handler — host-selector + groups/store/sessions PVCs

**Files:**
- Modify: `src/k8s/ipc-redis-bootstrap.ts` (`CommitChannelConfigDeps` + the Deployment builder at lines 384–450)
- Modify: `src/index.ts` (wire the new deps)
- Test: `src/k8s/ipc-redis-bootstrap.test.ts`

**Interfaces:**
- Consumes: the manifest `hostMode` (Task 4).
- Produces: extend `CommitChannelConfigDeps` with:
  - `getChannelHostMode(channelType: string): Promise<'standalone' | 'channel-runner'>` (default `'standalone'` if the manifest entry lacks it / is unreadable).
  - `createPvc(name: string, sizeGi: number): Promise<void>` (idempotent — NotFound-create, AlreadyExists-ignore).
- Behaviour: after the source push succeeds, read `hostMode = await deps.getChannelHostMode(channel_type)`. For `'channel-runner'`: command `['node','dist/channel-runner.js']`; create + mount the three PVCs `kubeclaw-channel-<instance>-{groups,store,sessions}` at `/app/groups`, `/app/store`, `/data/sessions` (sizes 2/1/1 Gi, mirroring `channel-setup.ts`), keeping `/runtime` read-only. For `'standalone'` (default): unchanged (`['node','/app/channel-loader.js']`, only `/runtime`).

- [ ] **Step 1: Write failing tests** (extend `ipc-redis-bootstrap.test.ts`)

Add two tests, reusing the existing `makeDeps`/`validPayload` helpers (extend `makeDeps` defaults with `getChannelHostMode: vi.fn(async () => 'standalone')` and `createPvc: vi.fn(async () => {})`):

```ts
it('standalone hostMode → channel-loader command, only runtime volume', async () => {
  const deps = makeDeps({ getChannelHostMode: vi.fn(async () => 'standalone') });
  let built: any;
  deps.createDeployment = vi.fn(async (b) => { built = b; });
  await processCommitChannelConfig(validPayload, deps, 'kubeclaw', 'kubeclaw-agent:latest');
  const c = built.spec.template.spec.containers[0];
  expect(c.command).toEqual(['node', '/app/channel-loader.js']);
  expect(built.spec.template.spec.volumes.map((v: any) => v.name)).toEqual(['runtime']);
  expect(deps.createPvc).not.toHaveBeenCalled();
});

it('channel-runner hostMode → channel-runner command + groups/store/sessions PVCs mounted', async () => {
  const deps = makeDeps({ getChannelHostMode: vi.fn(async () => 'channel-runner') });
  let built: any;
  deps.createDeployment = vi.fn(async (b) => { built = b; });
  await processCommitChannelConfig(validPayload, deps, 'kubeclaw', 'kubeclaw-agent:latest');
  const c = built.spec.template.spec.containers[0];
  expect(c.command).toEqual(['node', 'dist/channel-runner.js']);
  const mountPaths = c.volumeMounts.map((m: any) => m.mountPath).sort();
  expect(mountPaths).toEqual(['/app/groups', '/app/store', '/data/sessions', '/runtime'].sort());
  const inst = validPayload.instance_name;
  expect(deps.createPvc).toHaveBeenCalledWith(`kubeclaw-channel-${inst}-groups`, 2);
  expect(deps.createPvc).toHaveBeenCalledWith(`kubeclaw-channel-${inst}-store`, 1);
  expect(deps.createPvc).toHaveBeenCalledWith(`kubeclaw-channel-${inst}-sessions`, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/k8s/ipc-redis-bootstrap.test.ts`
Expected: FAIL — `getChannelHostMode`/`createPvc` not on deps; command always channel-loader.

- [ ] **Step 3: Implement**

In `src/k8s/ipc-redis-bootstrap.ts`:
1. Add to `CommitChannelConfigDeps`:
```ts
  /** Read the channel manifest's hostMode (default 'standalone'). */
  getChannelHostMode(channelType: string): Promise<'standalone' | 'channel-runner'>;
  /** Create a PVC (idempotent; NotFound-create, AlreadyExists-ignore). */
  createPvc(name: string, sizeGi: number): Promise<void>;
```
2. In `processCommitChannelConfig`, after the `writeChannelSource` try/catch (after line 382) and before building `deployment`:
```ts
      const hostMode = await deps.getChannelHostMode(channel_type);
      const channelRunnerMode = hostMode === 'channel-runner';

      const extraVolumes: Array<{ name: string; claimName: string; mountPath: string; sizeGi: number }> = channelRunnerMode
        ? [
            { name: 'groups', claimName: `kubeclaw-channel-${instance_name}-groups`, mountPath: '/app/groups', sizeGi: 2 },
            { name: 'store', claimName: `kubeclaw-channel-${instance_name}-store`, mountPath: '/app/store', sizeGi: 1 },
            { name: 'sessions', claimName: `kubeclaw-channel-${instance_name}-sessions`, mountPath: '/data/sessions', sizeGi: 1 },
          ]
        : [];
      for (const v of extraVolumes) await deps.createPvc(v.claimName, v.sizeGi);
```
3. Change the container `command` (line 420) to:
```ts
                  command: channelRunnerMode
                    ? ['node', 'dist/channel-runner.js']
                    : ['node', '/app/channel-loader.js'],
```
4. Append the extra mounts/volumes to the existing `volumeMounts` (after the runtime mount, line 433) and `volumes` (after the runtime volume, line 446):
```ts
                  ...extraVolumes.map((v) => ({ name: v.name, mountPath: v.mountPath })),
```
```ts
                ...extraVolumes.map((v) => ({ name: v.name, persistentVolumeClaim: { claimName: v.claimName } })),
```

In `src/index.ts`, add the two deps to the `registerBootstrapDeps`/commit deps object:
```ts
      getChannelHostMode: async (channelType: string) => {
        try {
          const cm = await coreApi.readNamespacedConfigMap({
            name: 'kubeclaw-channel-manifests',
            namespace: KUBECLAW_NAMESPACE,
          });
          const raw = cm.data?.[`${channelType}.json`];
          if (!raw) return 'standalone';
          const hm = (JSON.parse(raw) as { hostMode?: string }).hostMode;
          return hm === 'channel-runner' ? 'channel-runner' : 'standalone';
        } catch {
          return 'standalone';
        }
      },
      createPvc: async (name: string, sizeGi: number) => {
        try {
          await coreApi.createNamespacedPersistentVolumeClaim({
            namespace: KUBECLAW_NAMESPACE,
            body: {
              apiVersion: 'v1',
              kind: 'PersistentVolumeClaim',
              metadata: { name, labels: { 'kubeclaw/channel-pvc': 'true' } },
              spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: `${sizeGi}Gi` } } },
            },
          });
        } catch (err: any) {
          if (err?.statusCode === 409 || err?.body?.code === 409) return;
          throw err;
        }
      },
```
(Mirror the exact `coreApi` accessor and error-shape pattern already used by `createSecret`/`deletePvc` in `src/index.ts`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/k8s/ipc-redis-bootstrap.test.ts && npx tsc --noEmit`
Expected: PASS, clean (existing tests still green — `makeDeps` defaults `getChannelHostMode` → `'standalone'` keeps prior behaviour).

- [ ] **Step 5: Commit**

```bash
git add src/k8s/ipc-redis-bootstrap.ts src/k8s/ipc-redis-bootstrap.test.ts src/index.ts
git commit -m "feat(bootstrap): host-selector + groups/store/sessions PVCs for channel-runner mode"
```

---

## Task 6: IRC SDK adapter

**Files:**
- Create: `helm/kubeclaw/files/channel-src/irc/channel-entry.js`
- Create: `src/channel-src/irc-adapter.test.ts` (ports the pure-logic assertions from `src/channels/irc.test.ts`)

**Interfaces:**
- Consumes: the injected `ChannelSdk` (Task 1) — `sdk.registerChannel`, `sdk.logger`, `sdk.readEnvFile`, `sdk.assistantName`.
- Produces: default export `register(sdk)` that registers the `irc` factory.

- [ ] **Step 1: Write the adapter**

Create `helm/kubeclaw/files/channel-src/irc/channel-entry.js` — the `IRCChannel` class body copied verbatim from the current `src/channels/irc.ts` (lines defining `IRCChannel`, `parseJid`, `connect`, `handleMessage`, `sendMessage`, `isConnected`, `ownsJid`, `disconnect`, and `parseConfig`), with these exact substitutions:
- Replace the top imports. The only runtime import is `import IRC from 'irc-upd';`. Remove the `../config.js`, `../env.js`, `../logger.js`, `./registry.js`, `../types.js` imports.
- `parseConfig()` uses `sdk.readEnvFile(...)` instead of the imported `readEnvFile`; `logger.*` → `sdk.logger.*`; the `ASSISTANT_NAME` reference in `handleMessage` → `sdk.assistantName` (thread `sdk` to where it's needed: capture `sdk` in a module-level `let sdk;` set inside `register`, OR pass `sdk` into the `IRCChannel` constructor — prefer the constructor: add `sdk` as a 3rd constructor arg and store `this.sdk`).
- Replace the trailing `registerChannel('irc', …)` call with:
```js
export default function register(sdk) {
  const config = parseConfig(sdk);
  // parseConfig moved to take sdk for readEnvFile/logger; if config is null the
  // factory still registers and returns null when invoked (creds missing).
  sdk.registerChannel('irc', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new IRCChannel(cfg, opts, sdk);
  });
}
```
- `console.log` debug lines may stay (they're harmless) or be converted to `sdk.logger.debug` — keep them as-is to preserve behaviour parity with the current file.
- The file is plain ESM `.js` (Node 22 auto-detects ESM). `node --check` must pass.

(The complete current `IRCChannel` source is in `src/channels/irc.ts`; copy it and apply the substitutions above. Do not change any channel behaviour — only the dependency wiring.)

- [ ] **Step 2: Write the ported unit test**

Create `src/channel-src/irc-adapter.test.ts`. Because the adapter is a `.js` file under `helm/`, test its pure logic by importing it and exercising the registered factory against a fake SDK. Port the meaningful assertions from `src/channels/irc.test.ts` (JID parsing, `ownsJid`, message-trigger rewriting, send chunking). Example skeleton:

```ts
import { describe, it, expect, vi } from 'vitest';
import register from '../../helm/kubeclaw/files/channel-src/irc/channel-entry.js';

function fakeSdk(env: Record<string,string>) {
  const factories: Record<string, any> = {};
  return {
    sdk: {
      registerChannel: (name: string, f: any) => { factories[name] = f; },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      readEnvFile: () => env,
      assistantName: 'Andy',
    },
    factories,
  };
}

it('registers an irc factory that builds a channel when creds are present', () => {
  const { sdk, factories } = fakeSdk({ IRC_SERVER: 'irc.test', IRC_NICK: 'bot', IRC_CHANNELS: '#x' });
  register(sdk);
  const ch = factories['irc']({ onMessage: vi.fn(), onChatMetadata: vi.fn(), registeredGroups: () => ({}) });
  expect(ch).not.toBeNull();
  expect(ch.ownsJid('irc:#x@irc.test:6697')).toBe(true);
  expect(ch.ownsJid('http:alice')).toBe(false);
});

it('factory returns null when creds are missing', () => {
  const { sdk, factories } = fakeSdk({});
  register(sdk);
  expect(factories['irc']({ onMessage: vi.fn(), onChatMetadata: vi.fn(), registeredGroups: () => ({}) })).toBeNull();
});
```
Port the remaining behavioural assertions (message rewrite with `@Andy`, send chunking at 480 chars) from the original test, adapting them to drive the channel built from the factory.

- [ ] **Step 3: Verify**

Run:
```bash
export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"
node --check helm/kubeclaw/files/channel-src/irc/channel-entry.js && echo IRC_JS_OK
npx vitest run src/channel-src/irc-adapter.test.ts
helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml --show-only templates/channel-src-configmap.yaml | grep 'irc__channel-entry.js'
```
Expected: `IRC_JS_OK`, tests pass, the ConfigMap key `irc__channel-entry.js` renders.

- [ ] **Step 4: Commit**

```bash
git add helm/kubeclaw/files/channel-src/irc/channel-entry.js src/channel-src/irc-adapter.test.ts
git commit -m "feat(channel-irc): irc as an SDK runtime adapter"
```

---

## Task 7: IRC bootstrap manifest

**Files:**
- Modify: `helm/kubeclaw/values-minikube.yaml` (add `bootstrap.channelManifests.irc`)
- (The manifest is consumed at e2e time via `--set-json` in Task 10.)

**Interfaces:**
- Produces: an `irc` manifest entry with `hostMode: channel-runner`, declaring `irc-upd` at its repo-pinned version, with a real lockfile + canonical sha256 `manifestHash`.

- [ ] **Step 1: Generate the lockfile + hash**

Run (scratch dir):
```bash
export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"
IRC_VER=$(node -e "console.log(require('/home/peter/projects/kubeclaw/.claude/worktrees/channel-src-exec-push/node_modules/irc-upd/package.json').version)")
echo "irc-upd version: $IRC_VER"
TMP=$(mktemp -d); cd "$TMP"
npm i --package-lock-only --omit=dev "irc-upd@$IRC_VER" >/dev/null 2>&1
# package.json:
node -e "console.log(JSON.stringify({name:'irc-runtime',version:'1.0.0',dependencies:{'irc-upd':process.env.IRC_VER}}))" IRC_VER="$IRC_VER"
# compute hash with the canonical routine
```
Use the package.json `{"name":"irc-runtime","version":"1.0.0","dependencies":{"irc-upd":"<ver>"}}` and the generated `package-lock.json`; compute `manifestHash` with the canonical-sha256 snippet from `bootstrap-nanoid-echo.md` Step 4 over those exact byte strings.

- [ ] **Step 2: Add the manifest to `values-minikube.yaml`**

Under `bootstrap.channelManifests:` (next to `nanoid-echo`), add (using the EXACT byte strings you hashed):
```yaml
    irc:
      hostMode: channel-runner
      packageJson: |
        {"name":"irc-runtime","version":"1.0.0","dependencies":{"irc-upd":"<ver>"}}
      packageLockJson: |
        <the generated package-lock.json, single line or block — must match the hashed bytes>
      manifestHash: "<computed hash>"
```

- [ ] **Step 3: Verify hash + render**

Run: recompute the hash from the embedded strings and confirm it equals `manifestHash`; then `helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml --show-only templates/channel-manifests-configmap.yaml | grep -A1 '"irc"\|irc.json'` renders with `hostMode`.
Expected: hashes match; renders.

- [ ] **Step 4: Commit**

```bash
git add helm/kubeclaw/values-minikube.yaml
git commit -m "feat(channel-irc): irc bootstrap manifest (hostMode channel-runner, irc-upd)"
```

---

## Task 8: IRC bootstrap skill

**Files:**
- Create: `helm/kubeclaw/files/bootstrap-skills/bootstrap-irc.md`

**Interfaces:** consumed by the bootstrap flow; frontmatter `channelType: irc`, `manifestVersion` matching Task 7.

- [ ] **Step 1: Write the skill**

Mirror `helm/kubeclaw/files/bootstrap-skills/bootstrap-nanoid-echo.md` exactly, changing: channel name → irc; `channelType: irc`; the manifest filename in Step 1 → `/workspace/manifests/irc.json`; Step 2 `npm ci` confirmation file → `/runtime/node_modules/irc-upd/package.json`; Step 3 asks the four IRC settings instead of a port:
```
expectedQuestions:
  - "IRC server hostname?"
  - "IRC port? (default 6697)"
  - "Bot nickname?"
  - "Comma-separated channels to join (e.g. #ops,#general)?"
```
Step 4 `commit_channel_config` `secret_data` → `{ "IRC_SERVER": "...", "IRC_PORT": "...", "IRC_NICK": "...", "IRC_CHANNELS": "..." }`, `channel_type: irc`. Keep the canonical-hash compute step verbatim. (No `hostMode` in the skill — it lives on the manifest.)

- [ ] **Step 2: Verify frontmatter parses**

Run: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"; npx tsc --noEmit` (no code change; sanity) and visually confirm the frontmatter matches the `bootstrap-nanoid-echo.md` shape. If a frontmatter-parse unit harness exists (`src/runtime/skill-format.test.ts`), add a case loading this skill's text and asserting `channelType==='irc'`.

- [ ] **Step 3: Commit**

```bash
git add helm/kubeclaw/files/bootstrap-skills/bootstrap-irc.md
git commit -m "feat(channel-irc): irc bootstrap skill"
```

---

## Task 9: Clean cutover — remove compiled-in irc + setup_channel irc

**Files:**
- Modify: `src/channels/index.ts` (remove `import './irc.js';`)
- Delete: `src/channels/irc.ts`, `src/channels/irc.test.ts`
- Modify: `src/skills/orchestrator/channel-setup.ts` (remove the `if (type === 'irc')` branch in `buildSecretData`)

**Interfaces:** none new — irc is no longer compiled-in or installable via `setup_channel`.

- [ ] **Step 1: Remove the registration + source**

- In `src/channels/index.ts`, delete the two lines:
```ts
// irc
import './irc.js';
```
- `git rm src/channels/irc.ts src/channels/irc.test.ts` (the pure-logic coverage now lives in `src/channel-src/irc-adapter.test.ts` from Task 6).
- In `src/skills/orchestrator/channel-setup.ts`, remove the irc branch in `buildSecretData`:
```ts
  if (type === 'irc') {
    if (input.server) data['IRC_SERVER'] = input.server;
    if (input.nick) data['IRC_NICK'] = input.nick;
    if (input.channels) data['IRC_CHANNELS'] = input.channels;
  }
```
(Leave other channel branches untouched. If `channel-setup.test.ts` asserts irc secret-building, remove/adjust that case.)

- [ ] **Step 2: Verify the build + suite**

Run: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"; npx tsc --noEmit && npx vitest run`
Expected: clean typecheck (no dangling `./irc.js` import); full unit/integration suite green. Fix any test that referenced the removed irc source (e.g. a `channels/index` registration test asserting `irc` is registered at import — that expectation is now wrong and should be removed, since irc registers at runtime via the adapter).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(channel-irc): clean cutover — remove compiled-in irc + setup_channel irc"
```

---

## Task 10: Repoint the live harness to bootstrap irc

**Files:**
- Modify: `e2e/minikube-live-setup.ts`

**Interfaces:** the live cluster installs irc via the bootstrap flow (manifest + skill baked at helm time), not the Helm `channels:` block.

- [ ] **Step 1: Edit the harness**

In `e2e/minikube-live-setup.ts`:
- **Remove** the `kubeclaw-channel-irc` Secret pre-create block (the `kubectl delete secret … kubeclaw-channel-irc` + `kubectl create secret … kubeclaw-channel-irc …`).
- **Remove** the `--set channels.irc.*` args (the whole `channels.irc.enabled/type/envVars[…]` block).
- **Keep** the `capabilities.test-ircd.*` lines (the e2e still needs the test IRC daemon).
- **Add** irc to the `--set-json bootstrap.channelManifests=...` value (alongside http-echo + nanoid-echo) using the EXACT manifest strings from Task 7 (escaped as the existing entries are), including `"hostMode":"channel-runner"`.
- **Add** `--set-file` `bootstrap.skills.bootstrap-irc=helm/kubeclaw/files/bootstrap-skills/bootstrap-irc.md`.

- [ ] **Step 2: Verify the harness still type-checks / renders**

Run: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"; npx tsc --noEmit` and `helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml >/dev/null && echo HELM_OK`.
Expected: clean; `HELM_OK`.

- [ ] **Step 3: Commit**

```bash
git add e2e/minikube-live-setup.ts
git commit -m "test(e2e): install irc via bootstrap flow, not helm channels block"
```

---

## Task 11: IRC bootstrap e2e

**Files:**
- Create: `e2e/minikube-live-channel-irc-bootstrap.test.ts`

**Interfaces:** end-to-end proof on minikube.

- [ ] **Step 1: Write the e2e**

Model on `e2e/minikube-live-bootstrap-channel-http-echo.test.ts` and `e2e/minikube-live-channel-src-push.test.ts`. Drive the bootstrap of irc via the admin shell (`bootstrap_channel_from_skill('bootstrap-irc')`), answering the four IRC questions with the test-ircd values (`server=kubeclaw-capability-test-ircd`, `port=6667`, `nick=kubeclaw-bot`, `channels=#live-test`). Assert:
- AC1: a bootstrap Job appears with `KUBECLAW_BOOTSTRAP_SKILL`/`bootstrap-irc`.
- AC3: a steady-state Deployment `kubeclaw-channel-<instance>` is created whose container **command is `node dist/channel-runner.js`** (host-selector picked channel-runner) and which mounts the groups/store/sessions volumes.
- AC4 (the load-bearing one): the channel connects to the test ircd and a message sent to `#live-test` is received by the agent loop and a reply is delivered back to irc. Reuse the test-ircd interaction pattern from the pre-existing irc e2e (the daemon exposes an HTTP side-channel via `kubectl exec`, per `e2e/fixtures/test-ircd`).

Gate/skip cleanly if the cluster is unavailable; budget timeouts like the sibling bootstrap e2e (90s pod wait + dialogue).

- [ ] **Step 2: Run the e2e**

Run: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"; npm run test:minikube-live -- minikube-live-channel-irc-bootstrap`
Expected: PASS (global setup re-points the cluster; the LLM endpoint comes from the worktree `.env.test.local`).

- [ ] **Step 3: Commit**

```bash
git add e2e/minikube-live-channel-irc-bootstrap.test.ts
git commit -m "test(e2e): irc bootstrapped end-to-end via the runtime-adapter host path"
```

---

## Final verification

- [ ] **Unit/integration:** `npx vitest run` → all pass; `npx tsc --noEmit` clean.
- [ ] **Helm:** `helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml >/dev/null` renders.
- [ ] **E2E:** `npm run test:minikube-live -- minikube-live-channel-irc-bootstrap minikube-live-bootstrap-channel-http-echo minikube-live-channel-src-push` → all green (irc on the new path; echo demos still standalone — proves the host-selector both ways).
- [ ] **Spec-compliance + code-quality review** (two-stage, separate reviewers) before reporting complete.

---

## Self-review notes

- **Spec coverage:** SDK (T1) ✔; host loads adapter (T2,T3) ✔; host-selector + PVCs/O2 (T4,T5) ✔; irc adapter/O1 (T6,T9) ✔; manifest+skill install (T7,T8) ✔; clean cutover/setup_channel+helm (T9,T10) ✔; e2e (T11) ✔. O3 resolved by putting hostMode on the manifest (T4/T5) rather than skill frontmatter — documented deviation, same goal, less plumbing, orchestrator-authoritative.
- **Type consistency:** `ChannelSdk`/`RuntimeAdapterRegister` defined in T1, consumed in T2/T3/T6; `getChannelHostMode`/`createPvc` signatures identical in the `CommitChannelConfigDeps` extension (T5) and the `src/index.ts` wiring (T5); `hostMode` literal `'standalone'|'channel-runner'` consistent across T4/T5/T7.
- **Placeholder scan:** the only "fill-in" values are the irc-upd version + lockfile + hash (T7) and the ported test bodies (T6) — these are generated/derived by explicit commands in-task, not placeholders.
- **Watch items for the implementer:** T3 (`main()` may not be unit-testable — fall back to the helper-level test, stated); T6 (`parseConfig` must take `sdk`; thread `sdk` via the constructor); T9 (a `channels/index` registration test may assert irc — remove that expectation).
