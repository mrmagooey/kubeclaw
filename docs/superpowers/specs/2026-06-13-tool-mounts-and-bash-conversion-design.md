# Tool Mounts + jq-free File-Bridge + bash Conversion — Design

**Status:** Approved (brainstorming complete)
**Date:** 2026-06-13
**Author:** Peter + Claude

## Problem & goal

KubeClaw's container-shaped built-in tools (bash, web_fetch, web_search, browser)
run via an **in-process execution path**: `tool-server.js` implements them itself
(`executeToolLocal`) inside a `kubeclaw-agent` tool pod (categories
`execution`/`browser`). The goal is to make built-ins ordinary **catalog tools
driven through the sidecar bridge on stock, unmodified images** — no first-party
images, no in-process execution — with the bridge acting purely as the interface
between a stock tool container and the KubeClaw ecosystem.

Two enabling capabilities are missing and are the subject of this spec:

1. **A storage/mount dimension** so a tool can declare what filesystem its
   container gets (ephemeral scratch vs the group's persistent filesystem) —
   without ever mounting a user PVC into the bridge, and gated so only trusted
   images can touch the group filesystem.
2. **A jq-free file-bridge** so a *stock* image (e.g. `alpine`, which has busybox
   `sh` but no `jq`, and no HTTP server) can be driven by the bridge using only a
   KubeClaw-supplied wrapper + a declared command — with the image untouched.

This spec delivers both, plus the first built-in conversion — **bash** — as the
proof and the immediate payoff. Other built-ins follow later (see Scope).

## Scope

**In scope (this spec):**
- The mount dimension on `ToolSpec`: `mount` (none/scratch/group), `mountReadOnly`,
  gated by a dedicated group-mount image allowlist; wired into the user-tool
  container by `createSidecarToolPodJob`.
- A redesigned, jq-free file-bridge: per-field request files, atomic directory
  renames, separate stdout/stderr capture, declared-fields-only writing with
  parameter-name validation (path-traversal guard).
- A new `ToolSpec.run` field (the per-request shell command template), valid only
  for `pattern: file`; KubeClaw wires the wrapper as the container entrypoint.
- A new jq-free `kubeclaw-tool-wrapper` ConfigMap (replaces the current one).
- **bash** converted to two default catalog entries on stock `alpine`: `bash`
  (ephemeral, scratch) and `bash_persist` (persistent, group-mounted RW). bash
  removed from the static built-in maps.
- Tests at all three levels.

**Out of scope (tracked follow-ons):**
- Converting **web_fetch / web_search / browser** to stock chromium images, and
  the consequent **removal of the in-process `tool-server` local path**
  (`executeToolLocal`, `createToolPodJob(execution|browser)`,
  `BUILTIN_CATEGORIES`). These stay exactly as they are today. web_search
  additionally needs the Envoy **credential sidecar on tool pods** (it makes an
  authenticated Brave API call a stock image can't), which is its own hardening
  item. The in-process path therefore remains until that follow-on; this spec
  does not delete it.
- Re-creating the dedicated file-op tools (read/write/edit/glob/grep/…) as
  separate stock-image catalog tools: a group-mounted `bash_persist` shell
  performs all of them (`cat`, `sed`, `grep`, `find`), so they are not
  re-created. They remain available via the in-process path until the local-path
  removal follow-on, after which `bash_persist` covers the need.
- Per-tool-pod credential injection, output-cap hardening, etc. (gap-3).

## Decisions (from brainstorming)

1. **No `builtin` execution kind.** The bridge only interfaces; it never executes
   a tool. Filesystem-coupled tools run in the (stock) user-tool container, which
   gets the mount.
2. **Mount taxonomy:** `none | scratch | group`.
3. **Per-tool, operator-declared** (not per-call). Two bash situations → two
   registered tools.
4. **Group-mount gating:** default-none; a `group` mount additionally requires the
   tool's image to match a dedicated `TOOL_GROUP_MOUNT_ALLOWLIST` (separate from
   `TOOL_IMAGE_ALLOWLIST`); `mountReadOnly` supported. Default-deny.
5. **jq-free file-bridge** via per-field files + a KubeClaw wrapper + a per-tool
   `run` template; **no custom images**.
6. **stderr:** captured separately; result = stdout on success, stderr (+ exit
   code) on failure; a tool wanting merge puts `2>&1` in its own `run` template.
7. **`run` is a new flat field**, gated to `pattern: file`.
8. **Inputs:** the bridge writes only fields **declared** in the tool's
   `parameters.properties` (operator-authored, names validated `[A-Za-z0-9_]`),
   silently dropping undeclared keys — confining request filenames to a safe set
   regardless of what the model sends. Free-form input rides inside a declared
   `object` field's value (file content), never as new filenames.

## Component 1 — Mount dimension (`ToolSpec`)

New optional fields (`src/tools/types.ts`):

```typescript
// on ToolSpec:
/** Filesystem the tool's container gets. Default 'none'.
 *  - none:    no volume.
 *  - scratch: an emptyDir at /work (WORKDIR=/work), discarded after the run.
 *  - group:   the calling group's PVC subPath at /work (WORKDIR=/work).
 *             Requires the image to match TOOL_GROUP_MOUNT_ALLOWLIST. */
mount?: 'none' | 'scratch' | 'group';
/** Only meaningful for mount: 'group'. Default false (read-write). */
mountReadOnly?: boolean;
```

- Mount path is fixed at `/work`; the wrapper exports `WORKDIR=/work` and runs the
  command there. For `mount: none`, `WORKDIR=/tmp` (always-writable, present in
  any image).
- For `mount: group`, the subPath is the **groupFolder** (per-group isolation),
  set by KubeClaw — never operator-chosen.

**Validation** (`validateTool`): `mount` ∈ the three values; `mountReadOnly` a
boolean; `mountReadOnly` only with `mount: 'group'`. (The image-allowlist gate is
enforced at spawn, not registration — see Component 4 — because the allowlist is a
deploy-time value.)

## Component 2 — jq-free file-bridge protocol

Redesign the file-bridge so a stock image needs no JSON parser. The shared volume
is an `emptyDir` at `/shared`, mounted in both the `kubeclaw-tool-bridge`
(trusted) and `user-tool` (stock) containers.

### Request (bridge → container), `/shared/req/{id}/`

```
/shared/req/{id}/
  input/
    <field>        # one file per DECLARED input field; raw string, or JSON text for object/array values
```

The bridge (Node, has JSON) builds the request under a hidden temp dir and
**atomically `mv`s** it to `/shared/req/{id}` (a directory rename on one
filesystem is atomic, so a partial request is never visible). It writes **only
fields present in the tool's `parameters.properties`**; undeclared keys from the
model are dropped (traversal guard).

### Response (container → bridge), `/shared/resp/{id}/`

```
/shared/resp/{id}/
  response       # stdout (raw bytes, what the run command printed)
  stderr         # stderr (raw bytes)
  exit_code      # the command's exit status
```

Built under a hidden temp dir and atomically `mv`'d to `/shared/resp/{id}`.

### Bridge loop (`executeToolBridgeFile` rewrite, `tool-server.ts`)

1. Write the per-field request dir; atomic-rename into `/shared/req/{id}`.
2. Poll for `/shared/resp/{id}` every 500 ms until `idleTimeout`.
3. On appearance: read `exit_code`; `0` → `result = response` (truncated to
   `MAX_TOOL_OUTPUT_BYTES`); non-zero → `error = "exit {code}: {stderr}"` (stderr
   truncated). `rm -rf` the resp dir.
4. Timeout → `File bridge timeout`.

(Request files in `/shared/req/{id}` are removed by the wrapper after it
responds; the emptyDir is discarded with the pod regardless.)

### The wrapper (`kubeclaw-tool-wrapper` ConfigMap — replaces the current jq-based one)

Mounted read-only at `/kubeclaw`, set by KubeClaw as the user-tool container's
`command`. Uses only busybox `sh`:

```sh
#!/bin/sh
S=/shared; mkdir -p "$S/req" "$S/resp"
: "${KUBECLAW_POLL_INTERVAL:=1}"
: "${WORKDIR:=/tmp}"
while true; do
  for d in "$S"/req/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    export INPUT_DIR="$d/input"
    out=$(cd "$WORKDIR" && sh -c "$KUBECLAW_TOOL_RUN" 2>/tmp/.err); rc=$?
    t=$(mktemp -d "$S/.resp.$id.XXXXXX")
    printf '%s' "$out"            > "$t/response"
    cat /tmp/.err 2>/dev/null     > "$t/stderr" || : > "$t/stderr"
    printf '%s' "$rc"             > "$t/exit_code"
    mv "$t" "$S/resp/$id"
    rm -rf "$d"
  done
  sleep "$KUBECLAW_POLL_INTERVAL"
done
```

Safety: the `run` template references field values by path with double-quoting,
e.g. `"$(cat "$INPUT_DIR/url")"` — command substitution expands to a single word
that `sh` does **not** re-evaluate, so a value containing `$(…)`/backticks is
inert. (`bash`’s contract is to execute its `command` value — that's intended,
sandboxed by the container + mount.) No `eval`, no dynamic variable names, no `jq`.

## Component 3 — `ToolSpec.run` + wiring at spawn

New field (`src/tools/types.ts`):

```typescript
/** Per-request shell command template, run by the wrapper in the user-tool
 *  container. References input fields by path: "$(cat "$INPUT_DIR/<field>")".
 *  Valid only when pattern is 'file'. */
run?: string;
```

**Validation** (`validateTool`): `run` is a non-empty string only when
`pattern === 'file'` (rejected otherwise), mirroring how `requestMapping` is
gated to `pattern: 'http'`.

**`createSidecarToolPodJob` (file pattern), `src/k8s/job-runner.ts`:**
- The user-tool container's `command` is set by KubeClaw to
  `['/bin/sh', '/kubeclaw/tool-wrapper.sh']` (operator `command` is ignored for
  file-bridge `run` tools — KubeClaw owns the entrypoint; the wrapper is the
  transport).
- Env on the user-tool container: `KUBECLAW_TOOL_RUN = toolSpec.run`,
  `WORKDIR` (per mount), `KUBECLAW_POLL_INTERVAL` (optional).
- Volumes/mounts:
  - `shared` emptyDir at `/shared` on both containers (existing).
  - `tool-wrapper` ConfigMap at `/kubeclaw` on the user-tool container (existing).
  - **mount = scratch:** an additional `work` emptyDir at `/work` on the user-tool
    container; `WORKDIR=/work`.
  - **mount = group:** the group PVC (`spec.groupsPvc ?? 'kubeclaw-groups'`)
    mounted at `/work` `subPath=spec.groupFolder`, `readOnly=toolSpec.mountReadOnly`,
    on the user-tool container; `WORKDIR=/work`. **Gated:** call
    `assertGroupMountAllowed(toolSpec.image)` first — throw (failing the spawn,
    surfaced as a tool error) if the image is not in `TOOL_GROUP_MOUNT_ALLOWLIST`.
  - **mount = none:** no extra volume; `WORKDIR=/tmp`.

The `kubeclaw-tool-bridge` container never gets the group PVC — only the
user-tool (stock) container does, and only when explicitly allowlisted.

## Component 4 — group-mount allowlist (`src/config.ts` + Helm)

Mirror `TOOL_IMAGE_ALLOWLIST`:

```typescript
export const TOOL_GROUP_MOUNT_ALLOWLIST: string[] = (process.env.TOOL_GROUP_MOUNT_ALLOWLIST || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Throws if `image` may not mount the group PVC. Default-DENY: an empty
 *  allowlist permits nothing (unlike TOOL_IMAGE_ALLOWLIST, which permits all
 *  when empty). Group-FS access is opt-in per image. */
export function assertGroupMountAllowed(image: string): void {
  const ok = TOOL_GROUP_MOUNT_ALLOWLIST.some((p) => imageMatchesPattern(image, p));
  if (!ok) throw new Error(`Tool image '${image}' is not permitted to mount the group filesystem (TOOL_GROUP_MOUNT_ALLOWLIST)`);
}
```

Note the deliberate asymmetry: `TOOL_IMAGE_ALLOWLIST` permits all when empty (a
convenience for dev); `TOOL_GROUP_MOUNT_ALLOWLIST` permits **nothing** when empty
(group-FS access must be consciously granted). Helm: `orchestrator.toolGroupMountAllowlist`
→ env `TOOL_GROUP_MOUNT_ALLOWLIST` on the orchestrator. The default ships
`alpine:*` (so the `bash_persist` baseline tool works); operators narrow/extend it.

## Component 5 — bash conversion

bash leaves the static built-in surface and becomes catalog entries:

- `src/runtime/direct-llm-runner.ts`: remove `bash` from `TOOLS`, `TOOL_CATEGORY`,
  `TOOL_SERVER_NAME`. (web_fetch/web_search/browser stay — untouched.)
- `src/tools/types.ts`: remove `bash` from `RESERVED_NAMES` (it's a catalog tool
  now). `execution` is no longer produced by any built-in; the
  `BUILTIN_CATEGORIES`/`createToolPodJob(execution)` machinery is left in place
  (now unused for bash) and removed in the local-path follow-on. `web_fetch`/
  `web_search`/`browser`/`places_search` remain reserved.

Two default Helm `tools:` baseline entries:

```yaml
tools:
  - name: bash
    description: Run a shell command in an ephemeral sandbox (no persistent changes; returns output).
    parameters:
      type: object
      properties: { command: { type: string } }
      required: [command]
    image: alpine:latest
    pattern: file
    mount: scratch
    run: 'sh -c "$(cat "$INPUT_DIR/command")"'
  - name: bash_persist
    description: Run a shell command against the group's persistent files. Changes are saved.
    parameters:
      type: object
      properties: { command: { type: string } }
      required: [command]
    image: alpine:latest
    pattern: file
    mount: group          # RW; alpine:* is on the group-mount allowlist by default
    run: 'sh -c "$(cat "$INPUT_DIR/command")"'
```

Both surface to the channel LLM via the existing catalog path (`getForChannel`);
the channel sends only the tool name at spawn; the orchestrator resolves the spec
(including `mount`/`run`) and builds the alpine sidecar pod with the wrapper.

## Error handling

| Condition | Behavior |
|---|---|
| Run command exits non-zero | `error = "exit {code}: {stderr}"` on the toolresults stream. |
| Missing declared field referenced by `run` | `cat "$INPUT_DIR/x"` finds nothing → empty; the run command behaves as with an empty arg. (Declared-required fields are enforced by the LLM schema upstream.) |
| Undeclared field in the model's call | Silently dropped by the bridge (not written) — traversal guard. |
| Image not on group-mount allowlist (mount: group) | Spawn throws → tool error `not permitted to mount the group filesystem`. |
| No response by idleTimeout | `File bridge timeout`. |
| Group PVC subPath isolation | Enforced by KubeClaw (subPath=groupFolder); operator can't widen it. |

## Testing (three levels)

**Unit:**
- `validateTool`: `mount` enum; `mountReadOnly` boolean + only-with-group; `run`
  non-empty + only-with-`pattern:file`; parameter field-names validated
  `[A-Za-z0-9_]` (reject a property name with `/`/`..`).
- `assertGroupMountAllowed`: empty allowlist denies; pattern match allows; default
  `alpine:*` allows `alpine:latest`.
- `executeToolBridgeFile` (bridge): writes only declared fields; atomic-rename
  request dir; reads response/exit_code; exit 0 → result=stdout, non-zero →
  error with stderr; truncation. (Pure-ish; tmpdir-backed like existing
  tool-server tests.)
- `createSidecarToolPodJob` (job-runner): file+scratch → `work` emptyDir at /work +
  WORKDIR=/work + wrapper command + KUBECLAW_TOOL_RUN; file+group(allowed) → group
  PVC subPath at /work (RO honored) + allowlist checked; file+group(not allowed) →
  throws; `command` set to the wrapper, not the operator's.

**Integration** (real compiled bridge subprocess + a real stock `alpine`
*image semantics* via the new wrapper over a real temp `/shared`, mirroring
`e2e/sidecar-tool-pod.test.ts`): a scratch-bash call runs `echo` and returns
stdout; a non-zero command surfaces as an error with stderr; a group-style call
writes a file under `/work` and a second call reads it back (persistence proven
via the shared mount). The wrapper is exercised as the real script.

**End-to-end (minikube-live):** register the `bash` (scratch) and `bash_persist`
(group) catalog tools; invoke each; assert (1) an `alpine` sidecar tool pod
spawns with the `kubeclaw-tool-bridge` + `user-tool` containers, the wrapper
command, and the correct mount (emptyDir vs group PVC subPath); (2) a
`bash_persist` write lands in the group PVC and is visible to a later call; (3) a
`bash` (scratch) write does not persist. Migrate the existing
`minikube-live-bash-data-pvc` and `alpine-tool-execution` tests (which use the old
execution-category path / old wrapper) to the new catalog + file-bridge contract.

## Key files

| File | Change |
|---|---|
| `src/tools/types.ts` | Add `mount`, `mountReadOnly`, `run`; validate them + parameter field-names; drop `bash` from `RESERVED_NAMES` |
| `src/config.ts` | `TOOL_GROUP_MOUNT_ALLOWLIST` + `assertGroupMountAllowed` (default-deny) |
| `container/agent-runner/src/tool-server.ts` | Rewrite `executeToolBridgeFile` to the per-field dir protocol (jq-free, separate stdout/stderr/exit) |
| `helm/kubeclaw/templates/configmaps.yaml`, `k8s/35-configmaps.yaml` | Replace `kubeclaw-tool-wrapper` with the jq-free wrapper |
| `src/k8s/job-runner.ts` | `createSidecarToolPodJob` file-pattern: wrapper command, mount wiring (scratch/group/none), WORKDIR/KUBECLAW_TOOL_RUN env, group-mount allowlist gate |
| `src/runtime/direct-llm-runner.ts` | Remove `bash` from TOOLS/TOOL_CATEGORY/TOOL_SERVER_NAME |
| `helm/kubeclaw/values.yaml`, `values-minikube.yaml` | `tools:` baseline `bash`+`bash_persist`; `orchestrator.toolGroupMountAllowlist` default `alpine:*` |
| Tests | unit (types/config/bridge/job-runner), integration (e2e/sidecar-tool-pod), e2e (minikube-live bash) |

## Backward compatibility / migration

- The file-bridge **protocol changes** (request.json → per-field dirs). No
  production file-bridge tools exist (catalog ships empty); the
  `alpine-tool-execution` e2e and the old `kubeclaw-tool-wrapper` migrate to the
  new contract. http/acp patterns and request-mapping are untouched.
- web_fetch/web_search/browser and the in-process local path are unchanged — they
  remain until the follow-on. So the channel LLM still sees those three as before;
  only `bash` moves to the catalog (as `bash`+`bash_persist`).
- `ToolSpec.command` (entrypoint override) remains for http/acp tools; for
  file-bridge `run` tools KubeClaw owns the entrypoint (the wrapper).
