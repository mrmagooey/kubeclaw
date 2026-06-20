# Deterministic Channel-Source Delivery (exec-push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LLM-transcribed channel code in Path-B bootstrap with real, editable source files that the orchestrator pushes deterministically onto the bootstrap pod's `/runtime` PVC over the existing Kubernetes `exec` channel.

**Architecture:** Channel source lives as ordinary files in the repo (`helm/kubeclaw/files/channel-src/<type>/`), is shipped to the orchestrator via a Helm-built ConfigMap (same pattern as bootstrap skills), and is streamed into the live bootstrap pod via `Exec.exec` stdin (`cat > /runtime/<file>`) — mirroring the existing read path (`read-bootstrap-pvc-files.ts`). The bootstrap skill no longer writes channel code; it only stages npm package files, gathers credentials, and commits. No new HTTP server, Service, or NetworkPolicy. No hash/TOCTOU is added on the code path (the orchestrator is the trusted source and delivery is deterministic); the existing `package.json`/`package-lock.json` manifest hash is untouched.

**Tech Stack:** TypeScript (Node 22), `@kubernetes/client-node` (`Exec`, `CoreV1Api`), Vitest, Helm, minikube-live e2e harness.

## Global Constraints

- Node `>=20` (repo targets v22 per `.nvmrc`). Run `npm`/`npx` with Node 22 on PATH (`export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"`) — the husky pre-commit hook needs it.
- All new behaviour must have unit, integration, and e2e coverage (repo testing policy). Where a level genuinely does not apply, say so in the task.
- Channel pods have **zero** Kubernetes API access (`automountServiceAccountToken: false`) — all privileged steps stay orchestrator-side. Do not add k8s access to channel or bootstrap pods.
- The steady-state channel pod mounts the runtime PVC **read-only** and runs `node /app/channel-loader.js`, which `import()`s `/runtime/channel-entry.js`. The entrypoint file MUST end up at exactly `/runtime/channel-entry.js`.
- ConfigMap hard limit is ~1 MB total; channel source for v1 must fit. Document this; do not add chunking.
- v1 scope: **in-repo source only**, delivered via Helm. The admin-shell HTTP upload + SQLite per-file storage (runtime add without image/helm change) is an explicit **out-of-scope follow-up** (see "Deferred" section) — do not build it here.
- Commit messages end with the repo's `Co-Authored-By` trailer.

---

## File Structure

**New files:**
- `src/k8s/write-bootstrap-pvc-files.ts` — exec-stdin push of files into the bootstrap pod (mirror of `read-bootstrap-pvc-files.ts`).
- `src/k8s/write-bootstrap-pvc-files.test.ts` — unit tests (fake `Exec`).
- `src/channel-src/loader.ts` — read channel source files for a type from the mounted ConfigMap dir; decode `<type>__<relpath>` keys.
- `src/channel-src/loader.test.ts` — unit tests (temp dir).
- `helm/kubeclaw/templates/channel-src-configmap.yaml` — Helm ConfigMap built from `files/channel-src/**`.
- `helm/kubeclaw/files/channel-src/http-echo/channel-entry.js` — http-echo source, extracted from the skill (the migration / e2e proof).
- `helm/kubeclaw/files/channel-src/nanoid-echo/channel-entry.js` + `.../package.json` source — dependency-bearing demo channel (proves `npm ci` + third-party import).
- `helm/kubeclaw/files/bootstrap-skills/bootstrap-nanoid-echo.md` — skill for the demo channel.
- `e2e/minikube-live-channel-src-push.test.ts` — e2e for the dependency-bearing demo channel.
- `docs/DEVELOPING_A_CHANNEL.md` — the refined developer workflow + the `bootstrap-signal` worked template.
- `helm/kubeclaw/files/channel-src/signal/channel-entry.js` + manifest + `helm/kubeclaw/files/bootstrap-skills/bootstrap-signal.md` — documented (not e2e'd) Signal template.

**Modified files:**
- `src/k8s/ipc-redis-bootstrap.ts` — add `writeChannelSource` dep to `CommitDeps`; call it after TOCTOU pass, before `createDeployment`.
- `src/k8s/ipc-redis-bootstrap.test.ts` — assert the push happens and ordering/error behaviour.
- The production wiring site that constructs `processCommitChannelConfig`'s deps (in `src/index.ts` / wherever `CommitDeps` is assembled) — supply `writeChannelSource`.
- `helm/kubeclaw/templates/orchestrator.yaml` — mount the new ConfigMap at `/etc/kubeclaw/channel-src`.
- `helm/kubeclaw/files/bootstrap-skills/bootstrap-http-echo.md` — delete the `local_write channel-entry.js` step.
- `e2e/minikube-live-bootstrap-channel-http-echo.test.ts` — confirm/adjust for the new delivery (no behavioural change expected).

---

## Task 1: `writeBootstrapPvcFiles` — exec-stdin push module

**Files:**
- Create: `src/k8s/write-bootstrap-pvc-files.ts`
- Test: `src/k8s/write-bootstrap-pvc-files.test.ts`

**Interfaces:**
- Consumes: `@kubernetes/client-node` `CoreV1Api.listNamespacedPod`, `Exec.exec`.
- Produces:
  - `interface ChannelSourceFile { path: string; content: string }` (`path` is relative to `/runtime`, e.g. `channel-entry.js` or `lib/util.js`).
  - `interface WriteBootstrapPvcFilesDeps { coreApi: Pick<CoreV1Api,'listNamespacedPod'>; exec: Pick<Exec,'exec'>; namespace: string }`
  - `async function writeBootstrapPvcFiles(deps: WriteBootstrapPvcFilesDeps, instanceName: string, files: ChannelSourceFile[]): Promise<void>`
  - `function assertSafeRelPath(p: string): void` (throws on `..`, absolute, or out-of-charset paths).

Target the **main bootstrap container** (RW `/runtime`), not the read-only `inspector` sidecar. Confirm the container name from the bootstrap Job spec in `src/k8s/bootstrap-runner.ts` (search the `containers:` array for the one mounting `/runtime` read-write); use that literal as `BOOTSTRAP_CONTAINER`. The example below assumes `'bootstrap'` — replace if the spec differs.

- [ ] **Step 1: Write the failing test**

```ts
// src/k8s/write-bootstrap-pvc-files.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  writeBootstrapPvcFiles,
  assertSafeRelPath,
} from './write-bootstrap-pvc-files.js';
import { Writable } from 'node:stream';

function fakeExec(captures: Array<{ cmd: string[]; stdin: string }>) {
  return {
    exec: vi.fn(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        cmd: string[],
        _stdout: Writable,
        _stderr: Writable,
        stdin: NodeJS.ReadableStream | null,
        _tty: boolean,
        statusCb: (s: { status: string }) => void,
      ) => {
        let stdinData = '';
        if (stdin) {
          for await (const chunk of stdin as AsyncIterable<Buffer | string>) {
            stdinData += chunk.toString();
          }
        }
        captures.push({ cmd, stdin: stdinData });
        statusCb({ status: 'Success' });
        const ws: any = { on: (ev: string, cb: () => void) => { if (ev === 'close') setImmediate(cb); return ws; } };
        return ws;
      },
    ),
  };
}

function fakeCore(podName: string | undefined) {
  return {
    listNamespacedPod: vi.fn(async () => ({
      items: podName ? [{ metadata: { name: podName } }] : [],
    })),
  };
}

describe('assertSafeRelPath', () => {
  it('accepts normal relative paths', () => {
    expect(() => assertSafeRelPath('channel-entry.js')).not.toThrow();
    expect(() => assertSafeRelPath('lib/util.js')).not.toThrow();
  });
  it('rejects traversal and absolute paths', () => {
    expect(() => assertSafeRelPath('../escape.js')).toThrow();
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow();
    expect(() => assertSafeRelPath('a/../../b')).toThrow();
  });
});

describe('writeBootstrapPvcFiles', () => {
  it('streams each file to /runtime via exec stdin', async () => {
    const captures: Array<{ cmd: string[]; stdin: string }> = [];
    const deps = { coreApi: fakeCore('bootstrap-pod-xyz') as any, exec: fakeExec(captures) as any, namespace: 'kubeclaw' };
    await writeBootstrapPvcFiles(deps, 'signal', [
      { path: 'channel-entry.js', content: 'export const x = 1;\n' },
      { path: 'lib/util.js', content: 'export const y = 2;\n' },
    ]);
    expect(captures).toHaveLength(2);
    expect(captures[0].cmd.join(' ')).toContain('/runtime/channel-entry.js');
    expect(captures[0].stdin).toBe('export const x = 1;\n');
    expect(captures[1].cmd.join(' ')).toContain('/runtime/lib/util.js');
    expect(captures[1].stdin).toBe('export const y = 2;\n');
  });

  it('throws when no running bootstrap pod exists', async () => {
    const deps = { coreApi: fakeCore(undefined) as any, exec: fakeExec([]) as any, namespace: 'kubeclaw' };
    await expect(writeBootstrapPvcFiles(deps, 'signal', [])).rejects.toThrow(/No running bootstrap pod/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/k8s/write-bootstrap-pvc-files.test.ts`
Expected: FAIL — module not found / exports undefined.

- [ ] **Step 3: Write the implementation**

```ts
// src/k8s/write-bootstrap-pvc-files.ts
import { Readable, Writable } from 'node:stream';
import type { CoreV1Api, Exec, V1Status } from '@kubernetes/client-node';

/**
 * Push channel source files onto a bootstrap pod's /runtime PVC via the
 * Kubernetes Exec API (stdin → `cat > /runtime/<path>`). The deterministic
 * counterpart of read-bootstrap-pvc-files.ts: the orchestrator owns the bytes,
 * so no hash/TOCTOU is needed on this path.
 */
export interface ChannelSourceFile {
  /** Path relative to /runtime, e.g. "channel-entry.js" or "lib/util.js". */
  path: string;
  content: string;
}

export interface WriteBootstrapPvcFilesDeps {
  coreApi: Pick<CoreV1Api, 'listNamespacedPod'>;
  exec: Pick<Exec, 'exec'>;
  namespace: string;
}

// The bootstrap Job's main container mounts /runtime read-write. The inspector
// sidecar mounts it read-only and MUST NOT be targeted for writes.
const BOOTSTRAP_CONTAINER = 'bootstrap';
const RUNTIME_DIR = '/runtime';
const SAFE_REL_PATH = /^(?!.*(^|\/)\.\.(\/|$))[-._a-zA-Z0-9]+(\/[-._a-zA-Z0-9]+)*$/;

export function assertSafeRelPath(p: string): void {
  if (p.startsWith('/') || !SAFE_REL_PATH.test(p)) {
    throw new Error(`Unsafe channel source path: ${JSON.stringify(p)}`);
  }
}

export async function writeBootstrapPvcFiles(
  deps: WriteBootstrapPvcFilesDeps,
  instanceName: string,
  files: ChannelSourceFile[],
): Promise<void> {
  const podList = await deps.coreApi.listNamespacedPod({
    namespace: deps.namespace,
    labelSelector: `kubeclaw-channel=${instanceName},kubeclaw.io/role=bootstrap`,
    fieldSelector: 'status.phase=Running',
  });
  const podName = podList.items[0]?.metadata?.name;
  if (!podName) {
    throw new Error(`No running bootstrap pod found for instance ${instanceName}`);
  }

  for (const file of files) {
    assertSafeRelPath(file.path);
    await execWrite(deps, podName, file);
  }
}

function execWrite(
  deps: WriteBootstrapPvcFilesDeps,
  podName: string,
  file: ChannelSourceFile,
): Promise<void> {
  const full = `${RUNTIME_DIR}/${file.path}`;
  // mkdir -p the parent, then write stdin to the file. `full` is validated to a
  // safe charset above, so it is shell-safe to interpolate.
  const command = ['sh', '-c', `mkdir -p "$(dirname '${full}')" && cat > '${full}'`];

  return new Promise<void>((resolve, reject) => {
    let stderr = '';
    let status: V1Status | undefined;
    const outStream = new Writable({ write(_c, _e, cb) { cb(); } });
    const errStream = new Writable({ write(c, _e, cb) { stderr += c.toString(); cb(); } });
    const inStream = Readable.from([file.content]);

    deps.exec
      .exec(
        deps.namespace,
        podName,
        BOOTSTRAP_CONTAINER,
        command,
        outStream,
        errStream,
        inStream,
        false,
        (s) => { status = s; },
      )
      .then((ws) => {
        ws.on('close', () => {
          if (status?.status === 'Failure') {
            reject(new Error(`exec write ${full} in ${podName} failed: ${status.message ?? stderr.trim() ?? 'unknown'}`));
          } else {
            resolve();
          }
        });
        ws.on('error', reject);
      })
      .catch(reject);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/k8s/write-bootstrap-pvc-files.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"
npx tsc --noEmit && npx vitest run src/k8s/write-bootstrap-pvc-files.test.ts
git add src/k8s/write-bootstrap-pvc-files.ts src/k8s/write-bootstrap-pvc-files.test.ts
git commit -m "feat(bootstrap): exec-stdin push of channel source onto /runtime"
```

---

## Task 2: Channel-source loader (read mounted ConfigMap dir)

**Files:**
- Create: `src/channel-src/loader.ts`
- Test: `src/channel-src/loader.test.ts`

**Interfaces:**
- Consumes: filesystem (`node:fs`).
- Produces:
  - `function decodeKey(fileName: string): { channelType: string; relPath: string } | null` — `"signal__channel-entry.js"` → `{ channelType: 'signal', relPath: 'channel-entry.js' }`; `"signal__lib__util.js"` → `{ 'signal', 'lib/util.js' }`. Returns `null` if no `__` separator.
  - `function loadChannelSource(channelType: string, baselineDir?: string): ChannelSourceFile[]` (default `baselineDir = '/etc/kubeclaw/channel-src'`). Returns the files for that type, `relPath` decoded, sorted by `relPath`. Returns `[]` if the dir is absent.

The Helm ConfigMap (Task 4) encodes each repo file `files/channel-src/<type>/<relpath>` as a single ConfigMap key `<type>__<relpath-with-slashes-as-__>`. `__` is reserved in channel-source filenames.

- [ ] **Step 1: Write the failing test**

```ts
// src/channel-src/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeKey, loadChannelSource } from './loader.js';

describe('decodeKey', () => {
  it('splits type and flat file', () => {
    expect(decodeKey('signal__channel-entry.js')).toEqual({ channelType: 'signal', relPath: 'channel-entry.js' });
  });
  it('decodes nested paths', () => {
    expect(decodeKey('signal__lib__util.js')).toEqual({ channelType: 'signal', relPath: 'lib/util.js' });
  });
  it('returns null without a separator', () => {
    expect(decodeKey('placeholder')).toBeNull();
  });
});

describe('loadChannelSource', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'csrc-'));
    writeFileSync(join(dir, 'signal__channel-entry.js'), 'A');
    writeFileSync(join(dir, 'signal__lib__util.js'), 'B');
    writeFileSync(join(dir, 'http-echo__channel-entry.js'), 'C');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns only the requested type, decoded and sorted', () => {
    const files = loadChannelSource('signal', dir);
    expect(files).toEqual([
      { path: 'channel-entry.js', content: 'A' },
      { path: 'lib/util.js', content: 'B' },
    ]);
  });
  it('returns [] for an absent dir', () => {
    expect(loadChannelSource('signal', join(dir, 'nope'))).toEqual([]);
  });
  it('returns [] for an unknown type', () => {
    expect(loadChannelSource('telegram', dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channel-src/loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/channel-src/loader.ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelSourceFile } from '../k8s/write-bootstrap-pvc-files.js';

const DEFAULT_DIR = '/etc/kubeclaw/channel-src';
const SEP = '__';

export function decodeKey(fileName: string): { channelType: string; relPath: string } | null {
  const idx = fileName.indexOf(SEP);
  if (idx <= 0) return null;
  const channelType = fileName.slice(0, idx);
  const relPath = fileName.slice(idx + SEP.length).split(SEP).join('/');
  if (!relPath) return null;
  return { channelType, relPath };
}

export function loadChannelSource(
  channelType: string,
  baselineDir: string = DEFAULT_DIR,
): ChannelSourceFile[] {
  if (!existsSync(baselineDir)) return [];
  const out: ChannelSourceFile[] = [];
  for (const name of readdirSync(baselineDir)) {
    const decoded = decodeKey(name);
    if (!decoded || decoded.channelType !== channelType) continue;
    out.push({ path: decoded.relPath, content: readFileSync(join(baselineDir, name), 'utf8') });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/channel-src/loader.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"
npx tsc --noEmit && npx vitest run src/channel-src/loader.test.ts
git add src/channel-src/loader.ts src/channel-src/loader.test.ts
git commit -m "feat(bootstrap): channel-source loader for mounted ConfigMap dir"
```

---

## Task 3: Wire the push into the commit handler

**Files:**
- Modify: `src/k8s/ipc-redis-bootstrap.ts` (the `CommitDeps` interface near line 70–135 and `processCommitChannelConfig` near line 149; insert the push just before the steady-state Deployment is built/created around line 350–421).
- Modify: `src/k8s/ipc-redis-bootstrap.test.ts`
- Modify: production wiring that builds the `deps` for `processCommitChannelConfig` (grep for `processCommitChannelConfig(` and for where `createDeployment:` is supplied — likely `src/index.ts`).

**Interfaces:**
- Consumes: `writeBootstrapPvcFiles` (Task 1), `loadChannelSource` (Task 2).
- Produces: extend `CommitDeps` with
  `writeChannelSource: (instanceName: string, channelType: string) => Promise<void>;`
  Production impl: `(instance, type) => writeBootstrapPvcFiles({ coreApi, exec, namespace }, instance, loadChannelSource(type))`.

Behaviour: after the manifest hash matches (TOCTOU pass) and **before** `deps.createDeployment(...)`, call `await deps.writeChannelSource(instance_name, channel_type)`. On failure, publish a structured error `{ ok: false, code: 'CHANNEL_SOURCE_PUSH_FAILED', error }` to the reply channel and return early — do **not** create the steady-state Deployment.

- [ ] **Step 1: Write the failing test** (add to `ipc-redis-bootstrap.test.ts`)

```ts
it('pushes channel source before creating the steady-state Deployment', async () => {
  const calls: string[] = [];
  const deps = makeCommitDeps({
    // makeCommitDeps is the existing test helper that stubs readBootstrapPvcFiles
    // to return manifest-matching package files (hash passes).
    writeChannelSource: vi.fn(async () => { calls.push('push'); }),
    createDeployment: vi.fn(async () => { calls.push('deploy'); }),
  });
  await processCommitChannelConfig(deps, validCommitPayload); // channel_type/instance set
  expect(deps.writeChannelSource).toHaveBeenCalledWith(validCommitPayload.instance_name, validCommitPayload.channel_type);
  expect(calls).toEqual(['push', 'deploy']); // ordering: push then deploy
});

it('aborts (no Deployment) when the source push fails', async () => {
  const deps = makeCommitDeps({
    writeChannelSource: vi.fn(async () => { throw new Error('exec boom'); }),
    createDeployment: vi.fn(async () => {}),
  });
  const res = await processCommitChannelConfig(deps, validCommitPayload);
  expect(deps.createDeployment).not.toHaveBeenCalled();
  expect(res).toMatchObject({ ok: false, code: 'CHANNEL_SOURCE_PUSH_FAILED' });
});
```

If `makeCommitDeps`/`validCommitPayload` helpers do not already exist in the test file, build them by following the existing success-path test in `ipc-redis-bootstrap.test.ts` (reuse its dep stubs and a payload whose `runtime_pvc_lock_hash`/package files hash-match).

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"; npx vitest run src/k8s/ipc-redis-bootstrap.test.ts`
Expected: FAIL — `writeChannelSource` not on deps / not called / ordering wrong.

- [ ] **Step 3: Implement**

In `src/k8s/ipc-redis-bootstrap.ts`:

1. Add to the `CommitDeps` interface:
```ts
/** Push the registered channel source files onto the bootstrap pod's /runtime. */
writeChannelSource: (instanceName: string, channelType: string) => Promise<void>;
```

2. In `processCommitChannelConfig`, in the create-new-channel branch, immediately before the steady-state Deployment is built (the `const deployment: V1Deployment = {...}` at ~line 353):
```ts
// Deterministically deliver the channel's source onto /runtime while the
// bootstrap pod is still alive (RW mount). The steady-state pod mounts the
// same PVC read-only and imports /runtime/channel-entry.js.
try {
  await deps.writeChannelSource(instance_name, channel_type);
} catch (e) {
  const error = e instanceof Error ? e.message : String(e);
  logger.error({ instance_name, channel_type, error }, 'commit_channel_config: channel source push failed');
  await deps.publishReply(replyChannel, { ok: false, code: 'CHANNEL_SOURCE_PUSH_FAILED', error }).catch(() => {});
  return { ok: false, code: 'CHANNEL_SOURCE_PUSH_FAILED', error };
}
```
(Match the surrounding code's exact reply/return shape — copy the field names used by the MANIFEST_DIVERGENCE branch nearby.)

3. In the production wiring (grep `processCommitChannelConfig(` / where `createDeployment` is provided), add:
```ts
writeChannelSource: (instance, type) =>
  writeBootstrapPvcFiles(
    { coreApi: getK8sClients().coreV1, exec: getExec(), namespace: NAMESPACE },
    instance,
    loadChannelSource(type),
  ),
```
Use the same `Exec`/`CoreV1Api` accessors that `read-bootstrap-pvc-files` is wired with at its call site (grep `readBootstrapPvcFiles(` to find them).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/k8s/ipc-redis-bootstrap.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/ipc-redis-bootstrap.ts src/k8s/ipc-redis-bootstrap.test.ts src/index.ts
git commit -m "feat(bootstrap): deliver channel source on commit before steady-state Deployment"
```

---

## Task 4: Helm ConfigMap + orchestrator mount

**Files:**
- Create: `helm/kubeclaw/templates/channel-src-configmap.yaml`
- Modify: `helm/kubeclaw/templates/orchestrator.yaml` (volumes + volumeMounts, mirroring the `bootstrap-skills-baseline` entries at lines ~282 and ~297)
- Create: `helm/kubeclaw/files/channel-src/.gitkeep` (so the dir exists even before any channel is added)

**Interfaces:**
- Produces: ConfigMap `kubeclaw-channel-src`, mounted read-only at `/etc/kubeclaw/channel-src` in the orchestrator pod. Keys are `<type>__<relpath-__-encoded>`; values are file contents.

This is a config/scaffolding task — no unit test (Helm templating). It is verified by Task 5's e2e and by a `helm template` lint in Step 3.

- [ ] **Step 1: Create the ConfigMap template**

```yaml
# helm/kubeclaw/templates/channel-src-configmap.yaml
---
# kubeclaw-channel-src: real channel source files shipped to the orchestrator.
# Built from helm/kubeclaw/files/channel-src/<type>/<relpath>. Each file becomes
# one key "<type>__<relpath with '/' replaced by '__'>". The orchestrator mounts
# this read-only at /etc/kubeclaw/channel-src and pushes a type's files onto a
# bootstrap pod's /runtime at commit time. Keep total size < ~1 MB (ConfigMap limit).
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-channel-src
  namespace: {{ include "kubeclaw.namespace" . }}
  labels:
    app: kubeclaw
    component: channel-src
data:
  {{- $found := false }}
  {{- range $path, $_ := .Files.Glob "files/channel-src/**" }}
  {{- $found = true }}
  {{- $key := $path | trimPrefix "files/channel-src/" | replace "/" "__" }}
  {{ $key }}: |
    {{ $.Files.Get $path | indent 4 | trimAll " " }}
  {{- end }}
  {{- if not $found }}
  _placeholder: ""
  {{- end }}
```

- [ ] **Step 2: Add the orchestrator volume + mount**

In `helm/kubeclaw/templates/orchestrator.yaml`, add to `volumeMounts` (next to `bootstrap-skills-baseline` ~line 282):
```yaml
            - name: channel-src
              mountPath: /etc/kubeclaw/channel-src
              readOnly: true
```
and to `volumes` (next to the `specialists-baseline`/`bootstrap-skills-baseline` volumes ~line 297):
```yaml
        - name: channel-src
          configMap:
            name: kubeclaw-channel-src
```

- [ ] **Step 3: Lint the chart renders**

Run:
```bash
export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"
helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml --show-only templates/channel-src-configmap.yaml
helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml | grep -A3 'name: channel-src'
```
Expected: the ConfigMap renders (with `_placeholder` while empty) and the orchestrator mount/volume appears.

- [ ] **Step 4: Commit**

```bash
git add helm/kubeclaw/templates/channel-src-configmap.yaml helm/kubeclaw/templates/orchestrator.yaml helm/kubeclaw/files/channel-src/.gitkeep
git commit -m "feat(bootstrap): ship channel source to orchestrator via ConfigMap mount"
```

---

## Task 5: Migrate http-echo to deterministic delivery (e2e proof)

**Files:**
- Create: `helm/kubeclaw/files/channel-src/http-echo/channel-entry.js`
- Modify: `helm/kubeclaw/files/bootstrap-skills/bootstrap-http-echo.md` (delete the code-writing step)
- Modify (if needed): `e2e/minikube-live-bootstrap-channel-http-echo.test.ts`

**Interfaces:** none new — this exercises Tasks 1–4 end to end. http-echo has zero npm deps, so it isolates the code-delivery change.

- [ ] **Step 1: Extract the source to a real file**

Copy the JavaScript currently embedded in `bootstrap-http-echo.md` Step 3 (lines 73–99) verbatim into `helm/kubeclaw/files/channel-src/http-echo/channel-entry.js`:
```js
import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const INSTANCE = process.env.KUBECLAW_CHANNEL || 'http-echo';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', channel: INSTANCE }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ channel: INSTANCE, method: req.method, url: req.url, headers: req.headers }));
});

server.listen(PORT, '0.0.0.0', () => { console.error('[http-echo] listening on port ' + PORT); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

- [ ] **Step 2: Remove the `local_write` step from the skill**

In `bootstrap-http-echo.md`, delete the entire "## Step 3: Write the channel entrypoint" section (lines ~64–103). Renumber the commit step. Add one line under the intro: "The orchestrator delivers `/runtime/channel-entry.js` deterministically at commit time — this skill only stages package files, asks for the port, and commits." Keep Step 1 (package files), the port question, and the commit step.

- [ ] **Step 3: Build images + run the http-echo bootstrap e2e**

Run:
```bash
export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"
npm run test:minikube-live -- minikube-live-bootstrap-channel-http-echo
```
Expected: PASS — the bootstrapped http-echo channel still responds (now via pushed source, not LLM transcription). The global setup rebuilds the orchestrator image (so the new commit-handler code + ConfigMap ship). If assertions reference the old skill flow, update them to the new flow (no behavioural change to the channel itself).

- [ ] **Step 4: Commit**

```bash
git add helm/kubeclaw/files/channel-src/http-echo/channel-entry.js helm/kubeclaw/files/bootstrap-skills/bootstrap-http-echo.md e2e/minikube-live-bootstrap-channel-http-echo.test.ts
git commit -m "refactor(bootstrap): http-echo source delivered via exec-push, not local_write"
```

---

## Task 6: Dependency-bearing demo channel (proves npm import end-to-end)

**Files:**
- Create: `helm/kubeclaw/files/channel-src/nanoid-echo/channel-entry.js`
- Create: `helm/kubeclaw/files/bootstrap-skills/bootstrap-nanoid-echo.md`
- Create: manifest entry (a `bootstrap.channelManifests.nanoid-echo` block with `package.json` depending on a small pure-JS package such as `nanoid` + its `package-lock.json`) in `helm/kubeclaw/values-minikube.yaml`
- Create: `e2e/minikube-live-channel-src-push.test.ts`

**Interfaces:** none new — proves "self-contained code that imports a third-party npm package" works through the new path (the user's stated Signal requirement, made deterministic and CI-runnable without external credentials).

- [ ] **Step 1: Write the demo channel source**

```js
// helm/kubeclaw/files/channel-src/nanoid-echo/channel-entry.js
import http from 'node:http';
import { nanoid } from 'nanoid';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok' })); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: nanoid(), url: req.url })); // proves the npm dep resolved
});
server.listen(PORT, '0.0.0.0', () => console.error('[nanoid-echo] listening on ' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

- [ ] **Step 2: Write the manifest + skill**

Add `bootstrap.channelManifests.nanoid-echo` to `values-minikube.yaml` with a `package.json` of `{"name":"nanoid-echo-runtime","version":"1.0.0","dependencies":{"nanoid":"5.0.7"}}` and a matching `package-lock.json` (generate it with `npm i --package-lock-only nanoid@5.0.7` in a scratch dir and paste). Compute `manifestHash` with the canonical-hash snippet from `bootstrap-http-echo.md` Step 4. Write `bootstrap-nanoid-echo.md` mirroring the slimmed http-echo skill **plus** an `npm ci --prefix /runtime --omit=dev --ignore-scripts` step after staging the package files.

- [ ] **Step 3: Write the e2e**

Model on `e2e/minikube-live-bootstrap-channel-http-echo.test.ts`: register manifest + skill (or rely on the helm baseline), call `bootstrap_channel_from_skill('bootstrap-nanoid-echo')`, wait for the steady-state channel pod, curl it, and assert the JSON body contains a 21-char `id` (nanoid default) — proving the pushed source ran and the third-party import resolved.

- [ ] **Step 4: Run it**

Run: `npm run test:minikube-live -- minikube-live-channel-src-push`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/files/channel-src/nanoid-echo helm/kubeclaw/files/bootstrap-skills/bootstrap-nanoid-echo.md helm/kubeclaw/values-minikube.yaml e2e/minikube-live-channel-src-push.test.ts
git commit -m "test(bootstrap): e2e proves npm-dependency channel via exec-push delivery"
```

---

## Task 7: Signal template + developer docs

**Files:**
- Create: `helm/kubeclaw/files/channel-src/signal/channel-entry.js` (template/skeleton — real source, but not e2e'd since Signal needs an account)
- Create: a `signal` manifest block (commented template) + `helm/kubeclaw/files/bootstrap-skills/bootstrap-signal.md`
- Create: `docs/DEVELOPING_A_CHANNEL.md`

**Interfaces:** none — documentation + a worked template.

- [ ] **Step 1: Write the Signal skeleton + skill** as an editable, reviewable example: a `SignalChannel` `channel-entry.js` importing a pure-JS Signal client dependency, reading creds from env (`SIGNAL_PHONE_NUMBER`), and implementing the `Channel` contract. Note in a header comment that native-binding Signal libraries fight `npm ci --ignore-scripts` and need a pure-JS client.

- [ ] **Step 2: Write `docs/DEVELOPING_A_CHANNEL.md`** covering: the `Channel`/`ChannelFactory` contract; the three delivery paths; and the refined Path-B workflow (write `files/channel-src/<type>/*.js` as real files → declare deps in the manifest → `register_*`/helm → orchestrator exec-pushes to `/runtime` → steady-state imports it). State the v1 constraint (in-repo source via Helm) and link the Deferred follow-up below.

- [ ] **Step 3: Commit**

```bash
git add helm/kubeclaw/files/channel-src/signal helm/kubeclaw/files/bootstrap-skills/bootstrap-signal.md docs/DEVELOPING_A_CHANNEL.md
git commit -m "docs(channel): developing-a-channel guide + signal template"
```

---

## Final verification

- [ ] **Full unit/integration suite:** `npx vitest run` → all pass.
- [ ] **Typecheck:** `npx tsc --noEmit` → clean.
- [ ] **E2E:** `npm run test:minikube-live -- minikube-live-bootstrap-channel-http-echo minikube-live-channel-src-push` → both pass.
- [ ] **Spec-compliance + code-quality review** (two-stage, separate reviewer subagents) before reporting complete.

---

## Deferred (explicitly out of scope for this plan)

- **Runtime upload without Helm/image change:** an authenticated `POST /channel-src/<type>` route on the **existing admin HTTP server** (port 9090, Basic auth, `kubeclaw-admin` Service) that accepts a tarball, unpacks it to **per-file SQLite rows** (`channel_source_files(channel_type, path, content)`), and feeds a reconciler that writes the live `kubeclaw-channel-src` ConfigMap (baseline + overrides), mirroring the channel-manifest reconciler. This achieves "add a channel to a running cluster without a Helm upgrade." Build it as a follow-up once the exec-push core (this plan) is proven.
- **Per-file `tar` push** (instead of per-file `cat`) for many-file channels — only if a channel's file count makes per-file exec calls a latency problem. Per-file `cat` is chosen here to avoid a `tar` binary dependency in `node:22-slim` and to mirror the existing read path exactly.

## Self-review notes

- **Spec coverage:** drop code hash → Tasks 1/3 add none and the plan states it explicitly; store-as-code → Tasks 4/5/6 use real repo files; transfer mechanism investigated → exec-push chosen (Task 1), HTTP-accept documented as Deferred; imports third-party npm → Task 6 proves it. ✔
- **Type consistency:** `ChannelSourceFile` defined in Task 1 and imported by Tasks 2/3; `writeChannelSource` signature identical in the `CommitDeps` extension and the wiring. ✔
- **Container name caveat:** `BOOTSTRAP_CONTAINER = 'bootstrap'` is an assumption — Task 1 instructs verifying the RW-`/runtime` container name from `bootstrap-runner.ts` before relying on it. ✔
