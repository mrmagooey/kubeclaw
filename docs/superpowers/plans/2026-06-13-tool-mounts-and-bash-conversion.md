# Tool Mounts + jq-free File-Bridge + bash Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-tool storage/mount dimension (none/scratch/group) and a jq-free file-bridge so stock images can be driven by the bridge via a KubeClaw wrapper + a `run` template, then convert **bash** into two stock-`alpine` catalog tools (`bash` scratch, `bash_persist` group) — leaving web/search/browser and the in-process local path for a follow-on.

**Architecture:** A tool declares `mount` (none/scratch/group) + `run` (a shell command template) in its `ToolSpec`. For `pattern: file`, `createSidecarToolPodJob` sets the user-tool container's entrypoint to a jq-free wrapper (ConfigMap), mounts an emptyDir (`scratch`) or the group PVC subPath (`group`, gated by a default-deny `TOOL_GROUP_MOUNT_ALLOWLIST`, never on the bridge container) at `/work`, and passes `KUBECLAW_TOOL_RUN`/`WORKDIR`. The bridge (`tool-server.ts`) exchanges per-field request files and stdout/stderr/exit response files with the wrapper over a shared emptyDir via atomic directory renames. bash leaves the static built-in maps and ships as catalog baseline entries.

**Tech Stack:** TypeScript (Node), vitest, the sidecar bridge (`container/agent-runner/src/tool-server.ts`), the tool catalog (`src/tools/types.ts`), `src/k8s/job-runner.ts`, Helm. Spec: `docs/superpowers/specs/2026-06-13-tool-mounts-and-bash-conversion-design.md`.

---

## Pre-flight notes for the implementer

- **Node/PATH:** `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH` before every `npm`/`node`/`npx`. The root `node_modules` is built against Node 24. The bridge lives in `container/agent-runner/` — build it with `cd container/agent-runner && npm install --no-audit --no-fund && npm run build` (its `node_modules` may be absent in a fresh worktree; install once).
- **Husky:** the pre-commit hook runs `prettier --write "src/**/*.ts"`; it may reformat `src/` files (harmless). Re-stage happens automatically. A leftover prettier drift at the end is committed as a `style:` commit (see Task 11).
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Single test file:** `npx vitest run src/path/file.test.ts`. Full suite: `npm test`. e2e: `--config vitest.e2e.config.ts`.
- **Build-green invariant:** each commit must compile (`npm run build`) and pass `npm test`. The file-bridge protocol change (Task 3/4) is breaking for the existing file-bridge tests in `e2e/sidecar-tool-pod.test.ts`; those are migrated **in the same task** that changes the protocol.

**Verified current shapes (do not re-derive):**
- `src/tools/types.ts`: `ToolSpec` (`pattern: 'http'|'file'|'acp'`, plus `requestMapping?`, `healthPath?`, `channels?`, `command?`); `ALLOWED_KEYS`; `RESERVED_NAMES = {web_fetch, web_search, browser, bash, places_search, execution}`; `validateTool` checks `parameters` is an object at ~line 165; `parseToolCatalog`.
- `src/config.ts`: `TOOL_IMAGE_ALLOWLIST` (~235), private `imageMatchesPattern(image, pattern)` (~246), `assertToolImageAllowed` (~258, permits all when empty).
- `container/agent-runner/src/tool-server.ts`: `SHARED_DIR` const, `idleTimeout` const, `MAX_TOOL_OUTPUT_BYTES`; `executeToolBridgeFile(tool, input, requestId)` (current request.json/response.json + 500ms poll + `File bridge timeout`); dispatch `if (toolMode === 'file-bridge') return executeToolBridgeFile(...)`.
- `src/k8s/job-runner.ts` `createSidecarToolPodJob`: `isFileBridge` (~1717), `bridgeMounts`/`userMounts`/`volumes` arrays (~1803-1833), `userEnv = [{name:'PORT',value:String(port)}]` (~1801), the user-tool container spec with `volumeMounts: userMounts` (~1871) and `command` set from `toolSpec.command` if present.
- `src/runtime/direct-llm-runner.ts`: `TOOLS` array (bash entry ~194), `TOOL_SERVER_NAME` (bash ~465), `TOOL_CATEGORY` (bash ~474).
- `helm/kubeclaw/templates/configmaps.yaml` + `k8s/35-configmaps.yaml`: the `kubeclaw-tool-wrapper` ConfigMap (jq-based today).

**Three-level test mapping:** Unit — `src/tools/types.test.ts`, `src/config.test.ts`, `src/tool-server-mapping.test.ts` (add a file-bridge protocol describe), `src/k8s/job-runner.test.ts`. Integration — `e2e/sidecar-tool-pod.test.ts` (real bridge subprocess + real wrapper over a temp `/shared`). E2E — `e2e/tool-pod-spawn.test.ts` / a minikube-live bash test (+ migrate `e2e/minikube-live-bash-data-pvc.test.ts`).

---

### Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 0.1: Verify clean state + HEAD**

```bash
cd /home/peter/projects/kubeclaw
git status --porcelain      # Expected: empty
git rev-parse HEAD          # Cut the branch from here (has the committed spec)
```

- [ ] **Step 0.2: Branch** — executor's worktree skill handles this; in-place fallback: `git checkout -b feat/tool-mounts-bash`. Expected: on `feat/tool-mounts-bash`.

---

### Task 1: `ToolSpec` mount + run fields, validation, param-name guard

**Files:**
- Modify: `src/tools/types.ts`
- Test: `src/tools/types.test.ts`

- [ ] **Step 1.1: Write the failing tests** — add to `src/tools/types.test.ts` (the file has a `base` valid http-tool fixture and a `describe('validateTool', ...)`):

```typescript
describe('validateTool — mount + run', () => {
  const fileBase = {
    name: 'bash',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    image: 'alpine:latest',
    pattern: 'file' as const,
  };

  it('accepts mount: scratch with a run template', () => {
    expect(validateTool({ ...fileBase, mount: 'scratch', run: 'sh -c "$(cat "$INPUT_DIR/command")"' })).toEqual({ ok: true });
  });
  it('accepts mount: group + mountReadOnly', () => {
    expect(validateTool({ ...fileBase, mount: 'group', mountReadOnly: true, run: 'cat x' })).toEqual({ ok: true });
  });
  it('defaults are fine when mount/run absent on a file tool', () => {
    // run is optional at the type level; a file tool may rely on an image-native protocol
    expect(validateTool(fileBase)).toEqual({ ok: true });
  });
  it('rejects an unknown mount value', () => {
    expect(validateTool({ ...fileBase, mount: 'host' }).ok).toBe(false);
  });
  it('rejects mountReadOnly without mount: group', () => {
    expect(validateTool({ ...fileBase, mount: 'scratch', mountReadOnly: true }).ok).toBe(false);
  });
  it('rejects a non-boolean mountReadOnly', () => {
    expect(validateTool({ ...fileBase, mount: 'group', mountReadOnly: 'yes' }).ok).toBe(false);
  });
  it('rejects run on a non-file pattern', () => {
    expect(validateTool({ ...base, run: 'sh -c x' }).ok).toBe(false); // base is pattern: http
  });
  it('rejects an empty run', () => {
    expect(validateTool({ ...fileBase, run: '' }).ok).toBe(false);
  });
  it('rejects a parameter property name with unsafe chars', () => {
    expect(
      validateTool({ ...fileBase, parameters: { type: 'object', properties: { '../evil': { type: 'string' } } } }).ok,
    ).toBe(false);
  });
  it('accepts safe parameter property names', () => {
    expect(
      validateTool({ ...fileBase, parameters: { type: 'object', properties: { file_path: { type: 'string' }, n2: {} } } }).ok,
    ).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/tools/types.test.ts
```

Expected: new tests FAIL (fields/validation absent).

- [ ] **Step 1.3: Add the fields** — in `src/tools/types.ts`, add to the `ToolSpec` interface (after `requestMapping?`):

```typescript
  /** Filesystem the tool's container gets (file pattern). Default 'none'. */
  mount?: 'none' | 'scratch' | 'group';
  /** Only with mount: 'group'. Default false (read-write). */
  mountReadOnly?: boolean;
  /** Per-request shell command template run by the wrapper in the user-tool
   *  container; references fields as "$(cat "$INPUT_DIR/<field>")". pattern 'file' only. */
  run?: string;
```

Add `'mount'`, `'mountReadOnly'`, `'run'` to `ALLOWED_KEYS`.

- [ ] **Step 1.4: Add validation** — in `validateTool`, after the existing `pattern` and `parameters` checks, add:

```typescript
  if (obj.mount !== undefined && !['none', 'scratch', 'group'].includes(obj.mount as string)) {
    return { ok: false, error: 'mount must be one of none|scratch|group' };
  }
  if (obj.mountReadOnly !== undefined) {
    if (typeof obj.mountReadOnly !== 'boolean')
      return { ok: false, error: 'mountReadOnly must be a boolean' };
    if (obj.mount !== 'group')
      return { ok: false, error: 'mountReadOnly is only valid with mount: group' };
  }
  if (obj.run !== undefined) {
    if (obj.pattern !== 'file')
      return { ok: false, error: 'run is only allowed when pattern is "file"' };
    if (typeof obj.run !== 'string' || obj.run.length === 0)
      return { ok: false, error: 'run must be a non-empty string' };
  }
  // Parameter property names become request filenames — guard against traversal.
  if (obj.parameters && typeof obj.parameters === 'object') {
    const props = (obj.parameters as { properties?: unknown }).properties;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return { ok: false, error: `parameter property name not allowed: ${JSON.stringify(key)}` };
        }
      }
    }
  }
```

- [ ] **Step 1.5: Drop `bash` from `RESERVED_NAMES`** — remove the `'bash'` entry (bash is becoming a catalog tool). Keep `web_fetch`, `web_search`, `browser`, `places_search`, `execution`.

- [ ] **Step 1.6: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/tools/types.test.ts
```

Expected: build clean; all pass.

- [ ] **Step 1.7: Commit**

```bash
git add src/tools/types.ts src/tools/types.test.ts
git commit -m "feat(tools): ToolSpec mount/mountReadOnly/run + param-name guard; unreserve bash

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `TOOL_GROUP_MOUNT_ALLOWLIST` + `assertGroupMountAllowed`

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 2.1: Write the failing tests** — add to `src/config.test.ts` (mirror how it tests `TOOL_IMAGE_ALLOWLIST`/`assertToolImageAllowed`; the allowlist is read from `process.env` at import, so use the same env-manipulation pattern the file already uses — if it uses `vi.resetModules()` + dynamic import, follow that):

```typescript
describe('assertGroupMountAllowed', () => {
  it('denies everything when the allowlist is empty (default-deny)', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = '';
    vi.resetModules();
    const { assertGroupMountAllowed } = await import('./config.js');
    expect(() => assertGroupMountAllowed('alpine:latest')).toThrow(/not permitted to mount the group filesystem/);
  });
  it('allows an image matching a pattern', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:*,registry.example.com/exec:*';
    vi.resetModules();
    const { assertGroupMountAllowed } = await import('./config.js');
    expect(() => assertGroupMountAllowed('alpine:latest')).not.toThrow();
    expect(() => assertGroupMountAllowed('registry.example.com/exec:1')).not.toThrow();
  });
  it('denies an image not matching any pattern', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:*';
    vi.resetModules();
    const { assertGroupMountAllowed } = await import('./config.js');
    expect(() => assertGroupMountAllowed('ubuntu:latest')).toThrow();
  });
});
```

(If `config.test.ts` reads the constant once at module top rather than re-importing, match its actual idiom — the key assertions are: empty → deny, match → allow, no-match → deny.)

- [ ] **Step 2.2: Run to verify failure**

```bash
npx vitest run src/config.test.ts
```

Expected: FAIL — `assertGroupMountAllowed` not exported.

- [ ] **Step 2.3: Implement** — in `src/config.ts`, after `assertToolImageAllowed`:

```typescript
// --- Group-mount Image Allowlist (default-DENY) ---
// Images permitted to mount the group PVC into their tool container.
// Unlike TOOL_IMAGE_ALLOWLIST (permits all when empty), this permits NOTHING
// when empty — group-filesystem access is opt-in per image.
export const TOOL_GROUP_MOUNT_ALLOWLIST: string[] = (
  process.env.TOOL_GROUP_MOUNT_ALLOWLIST || ''
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function assertGroupMountAllowed(image: string): void {
  const allowed = TOOL_GROUP_MOUNT_ALLOWLIST.some((pattern) =>
    imageMatchesPattern(image, pattern),
  );
  if (!allowed) {
    throw new Error(
      `Tool image '${image}' is not permitted to mount the group filesystem. ` +
        `Add it to TOOL_GROUP_MOUNT_ALLOWLIST. Permitted patterns: ${TOOL_GROUP_MOUNT_ALLOWLIST.join(', ') || '(none)'}`,
    );
  }
}
```

(`imageMatchesPattern` is already defined in this file — reuse it; no need to export it.)

- [ ] **Step 2.4: Build + test**

```bash
npm run build
npx vitest run src/config.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(tools): TOOL_GROUP_MOUNT_ALLOWLIST + assertGroupMountAllowed (default-deny)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: jq-free file-bridge protocol (bridge side)

Rewrite `executeToolBridgeFile` to the per-field directory protocol with atomic renames and separate stdout/stderr/exit. Update the file-bridge integration tests in the same task (the protocol is breaking).

**Files:**
- Modify: `container/agent-runner/src/tool-server.ts`
- Test: `src/tool-server-mapping.test.ts` (add a file-bridge describe), and `e2e/sidecar-tool-pod.test.ts` (migrate the existing file-bridge tests in Task 8 — here, just keep the unit-level coverage green)

- [ ] **Step 3.1: Write the failing unit test** — add to `src/tool-server-mapping.test.ts` (it already has the `vi.hoisted` env + `vi.mock('redis', ...)` preamble and imports from `'../container/agent-runner/src/tool-server.js'`). Export `executeToolBridgeFile` for testing (Step 3.3 adds `export`). This test drives the bridge against a real temp `/shared` dir, simulating the wrapper by hand:

```typescript
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeToolBridgeFile } from '../container/agent-runner/src/tool-server.js';

describe('executeToolBridgeFile — per-field protocol', () => {
  it('writes declared fields and returns stdout on exit 0', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'fb-'));
    process.env.KUBECLAW_SHARED_DIR = shared;
    // declared fields for this tool, passed so the bridge writes only these:
    const call = executeToolBridgeFile('bash', { command: 'echo hi', bogus: 'x' }, 'r1', ['command']);
    // simulate the wrapper: wait for req dir, then write a resp dir atomically
    const reqInput = join(shared, 'req', 'r1', 'input');
    // poll briefly for the request to appear
    for (let i = 0; i < 50 && !existsSync(reqInput); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(reqInput).sort()).toEqual(['command']); // bogus dropped
    expect(readFileSync(join(reqInput, 'command'), 'utf-8')).toBe('echo hi');
    const tmp = join(shared, '.resp.r1.tmp'); mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'response'), 'hi\n');
    writeFileSync(join(tmp, 'stderr'), '');
    writeFileSync(join(tmp, 'exit_code'), '0');
    require('fs').renameSync(tmp, join(shared, 'resp', 'r1'));
    const result = await call;
    expect(result).toBe('hi\n');
    rmSync(shared, { recursive: true, force: true });
  });

  it('returns an error containing stderr on non-zero exit', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'fb-'));
    process.env.KUBECLAW_SHARED_DIR = shared;
    const call = executeToolBridgeFile('bash', { command: 'boom' }, 'r2', ['command']);
    for (let i = 0; i < 50 && !existsSync(join(shared, 'req', 'r2')); i++) await new Promise((r) => setTimeout(r, 20));
    const tmp = join(shared, '.resp.r2.tmp'); mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'response'), '');
    writeFileSync(join(tmp, 'stderr'), 'command not found');
    writeFileSync(join(tmp, 'exit_code'), '127');
    require('fs').renameSync(tmp, join(shared, 'resp', 'r2'));
    await expect(call).rejects.toThrow(/127.*command not found|command not found/);
    rmSync(shared, { recursive: true, force: true });
  });
});
```

Note: `executeToolBridgeFile` gains a 4th parameter `declaredFields: string[]` (Step 3.3). The dispatch call site (Step 3.4) passes the declared field names.

- [ ] **Step 3.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
cd container/agent-runner && npm install --no-audit --no-fund && npm run build && cd ../..
npx vitest run src/tool-server-mapping.test.ts
```

Expected: FAIL (new signature/protocol absent).

- [ ] **Step 3.3: Rewrite `executeToolBridgeFile`** — replace the current implementation in `container/agent-runner/src/tool-server.ts`:

```typescript
export async function executeToolBridgeFile(
  tool: string,
  input: Record<string, unknown>,
  requestId: string,
  declaredFields: string[],
): Promise<unknown> {
  const sharedDir = process.env.KUBECLAW_SHARED_DIR || SHARED_DIR;
  const reqDir = path.join(sharedDir, 'req', requestId);
  const respDir = path.join(sharedDir, 'resp', requestId);

  // Build the request under a hidden temp dir, then atomically rename into place.
  const tmpReq = path.join(sharedDir, `.req.${requestId}.tmp`);
  const tmpInput = path.join(tmpReq, 'input');
  fs.mkdirSync(tmpInput, { recursive: true });
  for (const field of declaredFields) {
    if (!(field in input)) continue; // omit fields the call didn't provide
    const v = input[field];
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    fs.writeFileSync(path.join(tmpInput, field), text);
  }
  fs.mkdirSync(path.join(sharedDir, 'req'), { recursive: true });
  fs.renameSync(tmpReq, reqDir); // atomic publish

  const deadline = Date.now() + idleTimeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(respDir)) {
      const exit = fs.readFileSync(path.join(respDir, 'exit_code'), 'utf-8').trim();
      const stdout = fs.existsSync(path.join(respDir, 'response'))
        ? fs.readFileSync(path.join(respDir, 'response'), 'utf-8')
        : '';
      const stderr = fs.existsSync(path.join(respDir, 'stderr'))
        ? fs.readFileSync(path.join(respDir, 'stderr'), 'utf-8')
        : '';
      fs.rmSync(respDir, { recursive: true, force: true });
      if (exit !== '0') {
        throw new Error(`exit ${exit}: ${stderr.slice(0, MAX_TOOL_OUTPUT_BYTES)}`);
      }
      return stdout.slice(0, MAX_TOOL_OUTPUT_BYTES);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('File bridge timeout');
}
```

(Only fields in `declaredFields` are written — the traversal guard's runtime half. `KUBECLAW_SHARED_DIR` override lets the unit test point at a temp dir.)

- [ ] **Step 3.4: Update the dispatch call site** — find where `executeToolBridgeFile` is called (the `if (toolMode === 'file-bridge')` branch in `executeTool`). The bridge must know the declared field names. Pass them from a new env var `KUBECLAW_TOOL_FIELDS` (a comma-separated list set by job-runner from the ToolSpec's `parameters.properties` keys). At the top of `tool-server.ts` near other env reads:

```typescript
const declaredFields = (process.env.KUBECLAW_TOOL_FIELDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
```

And the call becomes:

```typescript
if (toolMode === 'file-bridge') return executeToolBridgeFile(tool, input, requestId, declaredFields);
```

- [ ] **Step 3.5: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
cd container/agent-runner && npm run build && cd ../..
npx vitest run src/tool-server-mapping.test.ts src/tool-server-bridge.test.ts
```

Expected: PASS (http/acp bridge tests unaffected; new file-bridge tests pass).

- [ ] **Step 3.6: Commit**

```bash
git add container/agent-runner/src/tool-server.ts src/tool-server-mapping.test.ts
git commit -m "feat(tool-bridge): jq-free per-field file-bridge protocol (atomic dirs, split stdout/stderr)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: jq-free wrapper ConfigMap

Replace the `kubeclaw-tool-wrapper` ConfigMap with the jq-free wrapper (busybox `sh`, `$INPUT_DIR`/`$WORKDIR`, runs `$KUBECLAW_TOOL_RUN`, atomic publish).

**Files:**
- Modify: `helm/kubeclaw/templates/configmaps.yaml`
- Modify: `k8s/35-configmaps.yaml`

- [ ] **Step 4.1: Replace the wrapper script** — in both files, replace the `kubeclaw-tool-wrapper` ConfigMap's `data.tool-wrapper.sh` content with:

```yaml
  tool-wrapper.sh: |
    #!/bin/sh
    # jq-free file-bridge wrapper. Runs in the (stock) user-tool container as its
    # command. Watches /shared/req/<id> dirs, runs $KUBECLAW_TOOL_RUN in $WORKDIR
    # with $INPUT_DIR pointing at the request's per-field input files, and writes
    # the response (stdout/stderr/exit_code) back atomically. Uses only sh.
    S=/shared
    mkdir -p "$S/req" "$S/resp"
    : "${KUBECLAW_POLL_INTERVAL:=1}"
    : "${WORKDIR:=/tmp}"
    log() { echo "[tool-wrapper] $*" >&2; }
    log "watching $S/req (WORKDIR=$WORKDIR)"
    while true; do
      for d in "$S"/req/*/; do
        [ -d "$d" ] || continue
        id=$(basename "$d")
        export INPUT_DIR="$d/input"
        out=$(cd "$WORKDIR" && sh -c "$KUBECLAW_TOOL_RUN" 2>/tmp/.tool_err); rc=$?
        t=$(mktemp -d "$S/.resp.$id.XXXXXX")
        printf '%s' "$out" > "$t/response"
        cat /tmp/.tool_err 2>/dev/null > "$t/stderr" || : > "$t/stderr"
        printf '%s' "$rc" > "$t/exit_code"
        mv "$t" "$S/resp/$id"
        rm -rf "$d"
      done
      sleep "$KUBECLAW_POLL_INTERVAL"
    done
```

Keep the ConfigMap name (`kubeclaw-tool-wrapper`), namespace templating, and the `k8s/35-configmaps.yaml` literal-namespace form. Update any header comment that described the old jq/`$@` behavior.

- [ ] **Step 4.2: Verify Helm renders + YAML valid**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
helm template kubeclaw helm/kubeclaw | grep -A30 'kubeclaw-tool-wrapper' | grep -E 'INPUT_DIR|KUBECLAW_TOOL_RUN|mktemp' | head
python3 -c "import yaml; list(yaml.safe_load_all(open('k8s/35-configmaps.yaml'))); print('k8s yaml OK')"
```

Expected: the wrapper renders with `INPUT_DIR`/`KUBECLAW_TOOL_RUN`/`mktemp`; raw YAML parses.

- [ ] **Step 4.3: Commit**

```bash
git add helm/kubeclaw/templates/configmaps.yaml k8s/35-configmaps.yaml
git commit -m "feat(tool-bridge): jq-free kubeclaw-tool-wrapper (INPUT_DIR + run template)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `createSidecarToolPodJob` — wrapper command, mounts, run/fields env

**Files:**
- Modify: `src/k8s/job-runner.ts`
- Test: `src/k8s/job-runner.test.ts`

- [ ] **Step 5.1: Write the failing tests** — in `src/k8s/job-runner.test.ts`, inside `describe('createSidecarToolPodJob', ...)` (reuse `baseSpec`; build a file-pattern spec). The job-runner test file mocks `../config.js` — add `assertGroupMountAllowed: vi.fn()` to that mock factory (and have one test make it throw):

```typescript
    const fileSpec = (mount?: string, extra: Record<string, unknown> = {}) => ({
      ...baseSpec,
      toolSpec: {
        ...baseSpec.toolSpec,
        pattern: 'file' as const,
        image: 'alpine:latest',
        run: 'sh -c "$(cat "$INPUT_DIR/command")"',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        ...(mount ? { mount } : {}),
        ...extra,
      },
    });

    it('sets the user-tool command to the wrapper and passes run + fields env', async () => {
      await jobRunner.createSidecarToolPodJob(fileSpec('scratch'));
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const user = call.body.spec.template.spec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.command).toEqual(['/bin/sh', '/kubeclaw/tool-wrapper.sh']);
      const env = Object.fromEntries(user.env.map((e: any) => [e.name, e.value]));
      expect(env.KUBECLAW_TOOL_RUN).toBe('sh -c "$(cat "$INPUT_DIR/command")"');
      expect(env.WORKDIR).toBe('/work');
      expect(env.KUBECLAW_TOOL_FIELDS).toBe('command');
    });

    it('mount: scratch adds a work emptyDir at /work on the user container', async () => {
      await jobRunner.createSidecarToolPodJob(fileSpec('scratch'));
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const podSpec = call.body.spec.template.spec;
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.volumeMounts).toContainEqual({ name: 'work', mountPath: '/work' });
      expect(podSpec.volumes).toContainEqual({ name: 'work', emptyDir: {} });
      // bridge container must NOT get the work volume
      const bridge = podSpec.containers.find((c: any) => c.name === 'kubeclaw-tool-bridge');
      expect(bridge.volumeMounts.map((m: any) => m.name)).not.toContain('work');
    });

    it('mount: group mounts the group PVC subPath at /work (RW) and checks the allowlist', async () => {
      await jobRunner.createSidecarToolPodJob(fileSpec('group'));
      expect(assertGroupMountAllowed).toHaveBeenCalledWith('alpine:latest');
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const podSpec = call.body.spec.template.spec;
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.volumeMounts).toContainEqual({ name: 'work', mountPath: '/work', subPath: baseSpec.groupFolder, readOnly: false });
      expect(podSpec.volumes).toContainEqual({ name: 'work', persistentVolumeClaim: { claimName: 'kubeclaw-groups' } });
    });

    it('mount: group honors mountReadOnly', async () => {
      await jobRunner.createSidecarToolPodJob(fileSpec('group', { mountReadOnly: true }));
      const call = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0];
      const user = call.body.spec.template.spec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.volumeMounts.find((m: any) => m.name === 'work').readOnly).toBe(true);
    });

    it('mount: group throws when the image is not allowlisted', async () => {
      (assertGroupMountAllowed as any).mockImplementationOnce(() => { throw new Error('not permitted'); });
      await expect(jobRunner.createSidecarToolPodJob(fileSpec('group'))).rejects.toThrow('not permitted');
    });
```

(Reuse `baseSpec.groupFolder`/`groupsPvc`; if `baseSpec` doesn't set `groupsPvc`, the default `'kubeclaw-groups'` applies — assert that. Import `assertGroupMountAllowed` from the mocked config in the test's mock factory.)

- [ ] **Step 5.2: Run to verify failure**

```bash
npx vitest run src/k8s/job-runner.test.ts
```

Expected: new tests FAIL.

- [ ] **Step 5.3: Implement** — in `createSidecarToolPodJob` (`src/k8s/job-runner.ts`):

Add the import near the top: `import { assertGroupMountAllowed } from '../config.js';` (confirm `../config.js` is the right relative path from `src/k8s/`).

In the `if (isFileBridge) { ... }` block that currently wires `shared` + `tool-wrapper`, extend it to also wire the mount and compute the wrapper command/env. Replace the file-bridge wiring with:

```typescript
    let workEnv: { name: string; value: string }[] = [];
    if (isFileBridge) {
      bridgeMounts.push({ name: 'shared', mountPath: '/shared' });
      userMounts.push({ name: 'shared', mountPath: '/shared' });
      userMounts.push({ name: 'tool-wrapper', mountPath: '/kubeclaw', readOnly: true });
      volumes.push({ name: 'shared', emptyDir: {} });
      volumes.push({
        name: 'tool-wrapper',
        configMap: { name: 'kubeclaw-tool-wrapper', defaultMode: 0o755, optional: true },
      });

      const mount = toolSpec.mount ?? 'none';
      if (mount === 'scratch') {
        userMounts.push({ name: 'work', mountPath: '/work' });
        volumes.push({ name: 'work', emptyDir: {} });
        workEnv = [{ name: 'WORKDIR', value: '/work' }];
      } else if (mount === 'group') {
        assertGroupMountAllowed(toolSpec.image); // throws if not allowlisted
        userMounts.push({
          name: 'work',
          mountPath: '/work',
          subPath: spec.groupFolder,
          readOnly: toolSpec.mountReadOnly ?? false,
        } as any);
        volumes.push({
          name: 'work',
          persistentVolumeClaim: { claimName: spec.groupsPvc ?? 'kubeclaw-groups' },
        });
        workEnv = [{ name: 'WORKDIR', value: '/work' }];
      } else {
        workEnv = [{ name: 'WORKDIR', value: '/tmp' }];
      }
    }
```

Build the user-tool container's env and command for the file-bridge `run` case. Where `userEnv` is defined, extend it; and set the container `command` to the wrapper when `isFileBridge && toolSpec.run`:

```typescript
    const declaredFieldNames = Object.keys(
      ((toolSpec.parameters as { properties?: Record<string, unknown> })?.properties) ?? {},
    );
    const userEnv = [
      { name: 'PORT', value: String(port) },
      ...(isFileBridge && toolSpec.run
        ? [
            { name: 'KUBECLAW_TOOL_RUN', value: toolSpec.run },
            { name: 'KUBECLAW_TOOL_FIELDS', value: declaredFieldNames.join(',') },
            ...workEnv,
          ]
        : []),
    ];
```

And in the user-tool container spec, set the command to the wrapper for file-bridge `run` tools (overriding any operator `command`):

```typescript
              {
                name: 'user-tool',
                image: toolSpec.image,
                ...(isFileBridge && toolSpec.run
                  ? { command: ['/bin/sh', '/kubeclaw/tool-wrapper.sh'] }
                  : toolSpec.command
                    ? { command: toolSpec.command }
                    : {}),
                env: userEnv,
                volumeMounts: userMounts,
                ...
              }
```

(Confirm `spec.groupsPvc`/`spec.groupFolder` are on `SidecarToolPodJobSpec` — they are, currently unused; now used. The bridge container keeps `bridgeMounts` (shared only) — it never gets `work`.)

- [ ] **Step 5.4: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/k8s/job-runner.test.ts
```

Expected: PASS.

- [ ] **Step 5.5: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "feat(tools): wire wrapper command + scratch/group mount + run/fields env in sidecar tool pods

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Remove `bash` from the static built-in maps

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts`
- Test: `src/runtime/direct-llm-runner.test.ts` (adjust if it asserts on the bash static tool)

- [ ] **Step 6.1: Check for tests referencing the static bash tool**

```bash
grep -n "'bash'\|\"bash\"\|bash" src/runtime/direct-llm-runner.test.ts | head
```

Note any test asserting `bash` appears in the static `TOOLS`/`TOOL_CATEGORY` — it will change.

- [ ] **Step 6.2: Remove bash from the maps** — in `src/runtime/direct-llm-runner.ts`:
- Delete the `bash` entry object from the `TOOLS` array (the `name: 'bash'` function definition, ~line 194).
- Delete `bash: 'bash'` from `TOOL_SERVER_NAME` (~465).
- Delete `bash: 'execution'` from `TOOL_CATEGORY` (~474).

(web_fetch/web_search/browser/places_search entries stay untouched.)

- [ ] **Step 6.3: Fix any affected test** — if Step 6.1 found a test asserting bash in the static surface, update it to reflect bash is no longer a static tool (it's now catalog-provided). If a test enumerates `TOOLS` names, drop `bash` from the expectation.

- [ ] **Step 6.4: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/runtime/direct-llm-runner.test.ts
```

Expected: build clean; tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts
git commit -m "refactor(tools): remove bash from static built-in maps (now a catalog tool)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Helm — bash/bash_persist baseline + group-mount allowlist default

**Files:**
- Modify: `helm/kubeclaw/values.yaml`
- Modify: `helm/kubeclaw/values-minikube.yaml`
- Modify: `helm/kubeclaw/templates/orchestrator.yaml`

- [ ] **Step 7.1: Add the baseline tools + allowlist value** — in `helm/kubeclaw/values.yaml`, replace the empty `tools: []` with the two bash entries, and add the group-mount allowlist under `orchestrator`:

```yaml
tools:
  - name: bash
    description: Run a shell command in an ephemeral sandbox (no persistent changes; returns the command output).
    parameters:
      type: object
      properties:
        command: { type: string }
      required: [command]
    image: alpine:latest
    pattern: file
    mount: scratch
    run: 'sh -c "$(cat "$INPUT_DIR/command")"'
  - name: bash_persist
    description: Run a shell command against the group's persistent files. Changes are saved to the group filesystem.
    parameters:
      type: object
      properties:
        command: { type: string }
      required: [command]
    image: alpine:latest
    pattern: file
    mount: group
    run: 'sh -c "$(cat "$INPUT_DIR/command")"'
```

Under the `orchestrator:` block (where `toolImageAllowlist` lives — grep for it), add:

```yaml
  # Images permitted to mount the group PVC into their tool container.
  # Default-deny: empty allows nothing. alpine:* enables the bash_persist tool.
  toolGroupMountAllowlist: "alpine:*"
```

- [ ] **Step 7.2: Wire the env in the orchestrator template** — in `helm/kubeclaw/templates/orchestrator.yaml`, find where `TOOL_IMAGE_ALLOWLIST` is set from `.Values.orchestrator.toolImageAllowlist` and add a sibling:

```yaml
            - name: TOOL_GROUP_MOUNT_ALLOWLIST
              value: {{ .Values.orchestrator.toolGroupMountAllowlist | default "" | quote }}
```

- [ ] **Step 7.3: minikube values** — in `helm/kubeclaw/values-minikube.yaml`, if it overrides `tools:` or `orchestrator.toolImageAllowlist`, mirror: ensure `orchestrator.toolGroupMountAllowlist` includes `alpine:*` (or inherit the default). If `values-minikube.yaml` sets `tools: []`, replace with the same two entries (so minikube ships them). If it doesn't mention `tools`, the base default applies — no change needed.

- [ ] **Step 7.4: Verify Helm renders**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
helm template kubeclaw helm/kubeclaw | grep -E 'name: bash|bash_persist|TOOL_GROUP_MOUNT_ALLOWLIST|mount.*group' | head
helm template kubeclaw helm/kubeclaw >/dev/null && echo "helm OK"
```

Expected: the two tools appear in the rendered `kubeclaw-tools`/`kubeclaw-tools-baseline` ConfigMap JSON; the env var is set; `helm OK`.

- [ ] **Step 7.5: Commit**

```bash
git add helm/kubeclaw/values.yaml helm/kubeclaw/values-minikube.yaml helm/kubeclaw/templates/orchestrator.yaml
git commit -m "feat(tools): ship bash + bash_persist catalog baseline; default group-mount allowlist alpine:*

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Integration test — real bridge + real wrapper over a temp /shared

Prove the bridge's per-field protocol and the actual wrapper script interoperate, with the wrapper running the `run` template (using `sh`, no jq). Extend `e2e/sidecar-tool-pod.test.ts`; migrate its existing file-bridge tests to the new protocol.

**Files:**
- Modify: `e2e/sidecar-tool-pod.test.ts`

- [ ] **Step 8.1: Read the harness + locate the old file-bridge tests**

Read `e2e/sidecar-tool-pod.test.ts`: how it spawns the compiled bridge (`node dist/tool-server.js`, env, `KUBECLAW_TOOL_MODE=file-bridge`, `KUBECLAW_SHARED_DIR`), seeds toolcalls, reads toolresults. Find the existing file-bridge test(s) that used the OLD `request.json`/`response.json` + jq wrapper — these break under the new protocol and must be rewritten here.

- [ ] **Step 8.2: Migrate + add file-bridge tests** — run the bridge subprocess in `file-bridge` mode pointed at a temp `/shared`, and run the **real wrapper script** (`helm/kubeclaw/templates/...` content is templated; use the literal copy from `k8s/35-configmaps.yaml` or extract the script body to a temp file) as a second subprocess in a temp container-like working dir with `WORKDIR`, `KUBECLAW_TOOL_RUN`, `INPUT_DIR` semantics. Cover:
  1. **scratch bash:** `KUBECLAW_TOOL_RUN='sh -c "$(cat "$INPUT_DIR/command")"'`, WORKDIR=temp scratch; seed a `bash` call with `{command:'echo hello'}`; assert the toolresult is `hello\n`.
  2. **non-zero exit:** `{command:'exit 3'}` → assert the toolresult is an error containing `exit 3`.
  3. **persistence semantics:** WORKDIR=a temp dir representing the group mount; call 1 `{command:'echo data > f.txt'}`; call 2 `{command:'cat f.txt'}` → assert `data`. (Same WORKDIR across calls simulates the group PVC.)
  4. **declared-fields guard:** seed a call with an extra undeclared field; assert only declared field files appear in `/shared/req/<id>/input` (the bridge dropped the undeclared one).

Use the existing dynamic-port/cleanup conventions; run the **actual** wrapper script (not a reimplementation) so the jq-free `sh` logic is what's tested. If running the literal ConfigMap wrapper as a subprocess is awkward in the harness, extract its `tool-wrapper.sh` body to a temp file in `beforeAll` and run `sh <that file>` — but it must be the real script content.

- [ ] **Step 8.3: Run**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run e2e/sidecar-tool-pod.test.ts --config vitest.e2e.config.ts 2>&1 | tail -8
```

Expected: PASS (migrated + new file-bridge tests; http/acp tests still green).

- [ ] **Step 8.4: Commit**

```bash
git add e2e/sidecar-tool-pod.test.ts
git commit -m "test(tool-bridge): integration coverage for jq-free file-bridge + real wrapper + run template

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end (minikube-live) — bash on stock alpine

Prove a registered `bash`/`bash_persist` catalog tool spawns a stock `alpine` sidecar pod with the wrapper + the right mount, on the real cluster. Migrate the existing execution-category bash test.

**Files:**
- Modify: `e2e/minikube-live-bash-data-pvc.test.ts` (migrate from execution-category to the catalog/file-bridge form) OR add a focused test to `e2e/tool-pod-spawn.test.ts`
- Gated on `kubectl get nodes`.

- [ ] **Step 9.1: Read the existing live harness** — read `e2e/minikube-live-bash-data-pvc.test.ts` and `e2e/tool-pod-spawn.test.ts`: how they trigger a sidecar tool pod spawn and read the created Job's containers/env/volumes. Choose the lighter faithful path: directly call `jobRunner.createSidecarToolPodJob` with a file/scratch and a file/group spec (image `alpine:latest`, the bash `run`), then assert against the real created Job.

- [ ] **Step 9.2: Add/migrate the live assertions** — assert on a real cluster:
  1. file+scratch: Job has `kubeclaw-tool-bridge` + `user-tool` (alpine) containers; user-tool `command` is the wrapper; a `work` emptyDir at `/work`; env `KUBECLAW_TOOL_RUN`/`WORKDIR=/work`/`KUBECLAW_TOOL_FIELDS=command`.
  2. file+group: user-tool has the group PVC at `/work` subPath=groupFolder; bridge container does NOT have `work`.
  3. (If feasible to run end-to-end through Redis) a `bash_persist` write then read returns the data; a `bash` (scratch) write does not persist across pods. If a full LLM-driven run is too heavy, the manifest-level assertions in (1)/(2) plus the integration test in Task 8 cover behavior — state which you did.

  Migrate the old execution-category bash assertions (label `app=kubeclaw-tool-pod`, category=execution) to the new `app=kubeclaw-sidecar-tool` + file-bridge form.

- [ ] **Step 9.3: Run (if cluster available)**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
kubectl get nodes >/dev/null 2>&1 && npx vitest run e2e/minikube-live-bash-data-pvc.test.ts e2e/tool-pod-spawn.test.ts --config vitest.e2e.config.ts 2>&1 | tail -8 || echo "No cluster — note in report"
```

Expected if cluster present: PASS. If skipped, say so explicitly.

- [ ] **Step 9.4: Commit**

```bash
git add e2e/minikube-live-bash-data-pvc.test.ts e2e/tool-pod-spawn.test.ts
git commit -m "test(tools): minikube-live coverage for bash on stock alpine via mounts + file-bridge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Docs

**Files:**
- Modify: `docs/TOOL_BRIDGE.md`

- [ ] **Step 10.1: Document the mount dimension + file-bridge run model** — add sections to `docs/TOOL_BRIDGE.md`:
  - **Mounts:** `mount: none|scratch|group`, `mountReadOnly`; group requires `TOOL_GROUP_MOUNT_ALLOWLIST` (default-deny, ships `alpine:*`); group is the calling group's PVC subPath at `/work`, never mounted on the bridge container.
  - **file-bridge + `run`:** the jq-free protocol (per-field `req/{id}/input/*` dirs, `resp/{id}/{response,stderr,exit_code}`, atomic renames), the KubeClaw wrapper as the container command, `$INPUT_DIR`/`$WORKDIR`, stdout-on-success/stderr-on-failure, declared-fields-only (traversal guard).
  - A worked example: the `bash`/`bash_persist` catalog entries (stock `alpine`, `run: 'sh -c "$(cat "$INPUT_DIR/command")"'`).
  - Note: http/acp + request-mapping are unchanged; the old jq/`$@` wrapper contract is replaced.

Verify field names/behaviors against the code before writing.

- [ ] **Step 10.2: Commit**

```bash
git add docs/TOOL_BRIDGE.md
git commit -m "docs: tool mounts + jq-free file-bridge run model + bash example

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification + final review

- [ ] **Step 11.1: Clean builds + full unit suite**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build && cd container/agent-runner && npm run build && cd ../..
npm test 2>&1 | grep -E "Test Files|Tests "
```

Expected: all pass.

- [ ] **Step 11.2: Integration + (if cluster) minikube-live**

```bash
npm run test:e2e -- e2e/sidecar-tool-pod.test.ts e2e/tool-catalog-spawn.test.ts 2>&1 | tail -4
kubectl get nodes >/dev/null 2>&1 && npm run test:e2e -- e2e/minikube-live-bash-data-pvc.test.ts e2e/tool-pod-spawn.test.ts 2>&1 | tail -4 || echo "No cluster — skipped"
```

Expected: pass (or live skipped with a note).

- [ ] **Step 11.3: Helm + raw YAML**

```bash
helm template kubeclaw helm/kubeclaw >/dev/null && echo "helm OK"
python3 -c "import yaml; list(yaml.safe_load_all(open('k8s/35-configmaps.yaml'))); print('k8s yaml OK')"
```

- [ ] **Step 11.4: Commit any prettier drift**

```bash
git checkout -- e2e/results/ 2>/dev/null; git status --porcelain
# if only prettier reformats remain:
git add -A && git commit -m "style(tools): apply prettier formatting left by pre-commit hook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 11.5: Two-stage review** — run spec-compliance then code-quality review per the project policy before reporting complete.

---

## Out of scope (do not do these here)

- Converting **web_fetch / web_search / browser** to stock chromium images, and removing the in-process `tool-server` local path (`executeToolLocal`, `createToolPodJob(execution|browser)`, `BUILTIN_CATEGORIES`). These stay; this spec leaves them working unchanged.
- The Envoy **credential sidecar on tool pods** (needed for web_search's Brave API on a stock image).
- Re-creating dedicated file-op tools (read/write/edit/glob/grep/…) as separate stock-image catalog tools — `bash_persist` covers them.
- Per-call mount selection, operator-named PVCs, generic volume specs (all deferred from brainstorming).
- Removing the now-unused `execution` category machinery (goes with the local-path removal follow-on).
