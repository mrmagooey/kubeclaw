# Filesystem MCP Capability — Design

**Date:** 2026-05-18
**Status:** Approved (brainstorming)
**Phase:** Phase B, Spec 2 of 3 (consumer wiring done; this is the first real consumer; docling is Spec 3)
**Foundation:** Phase A (`05eef2f`) + Phase B Spec 1 consumer wiring (`069a152`).

## Goal

Ship the first real per-group MCP capability: a **filesystem server** packaged in a new `kubeclaw-mcp-bundle` container image and declared default-on in `helm/kubeclaw/values.yaml`. Each registered group gets its own filesystem pod (per Phase A's `scope: group` machinery) with the group's PVC subPath mounted at `/data`. The LLM gets five tools (`mcp__filesystem__read_file`, `write_file`, `list_directory`, `search_files`, `create_directory`) via the Spec 1 consumer wiring.

## Non-goals

- `delete_file` / `move_file` — bundle ships these handlers but they're omitted from default `allowedTools`. Operators extend their values if they want them.
- File-content search — only filename/glob via `search_files`. Content search waits for a future ripgrep-backed capability.
- Watch / file-change events — pull-only model.
- Binary content extraction (PDF/image preview) — `read_file` returns raw bytes for binaries; document conversion is Spec 3's docling.
- Cross-group file sharing — each per-group pod sees only its own PVC subPath.
- PVC quota enforcement — rely on PVC sizing.
- Multiple bundle servers in one Deployment — bundle image hosts the *code* for several MCP server kinds, but each per-group Deployment runs exactly one (selected via `--server`).
- Docling — separate spec.

## Background

Phase A built per-(group × capability) Deployments with scale-to-zero. Phase B Spec 1 wired the channel runtime to discover and call those Deployments lazily. Both ship without a real default-on consumer; admin-shell or `values.yaml` is required to install anything group-scoped. This spec adds the first real consumer so a stock kubeclaw install gives every group a working filesystem out of the box.

Choosing filesystem first (not docling) because: it's lightweight, default-on is safe, validates the Phase B foundation under realistic load, and unlocks the LLM's ability to persist artifacts beyond `CLAUDE.md`.

## Architecture

### Container packaging

A new **`kubeclaw-mcp-bundle`** image — Node-based, single image, multiple MCP server kinds selected via `--server <name>` arg.

```
container/mcp-bundle/
  Dockerfile           # node:20-alpine base, installs @modelcontextprotocol/sdk
  package.json
  index.js             # entrypoint: parses --server arg + dispatch
  filesystem/
    server.js          # the 5 tools + HTTP transport wiring (~150 LOC)
    server.test.js     # path-safety + tool unit tests
    paths.js           # path-resolution + safety helpers
    paths.test.js
  build.sh             # docker build wrapper
```

Why a bundle and not a dedicated `kubeclaw-mcp-filesystem` image:
- The bundle pays for itself within 2–3 MCP server kinds. Future Node-based MCPs (time, sequential-thinking, github, slack) can share it without a new image-build pipeline each time.
- Single Dockerfile, single registry tag, single Helm `image:` reference parameterised by `command`.
- Smaller total registry footprint as more MCPs ship.

Why not use upstream `@modelcontextprotocol/server-filesystem` directly:
- Upstream is stdio-only. Per-group capabilities run Streamable HTTP. Bridging stdio→HTTP adds a process + watcher.
- The 5 filesystem tools are ~150 LOC implemented directly against `@modelcontextprotocol/sdk`. Cleaner control over the exact surface (no shipping `delete_file` / `move_file` by default).
- Pattern is already proven by `container/echo-mcp/` in Phase A.

`index.js` reads `--server` and (server-specific) args like `--root`, instantiates the matching server module, wires it to `StreamableHTTPServerTransport` using the per-request factory pattern from Spec 1's bug fix (`container/echo-mcp/index.js` commit `c038192`). `/health` returns 200 for the K8s readinessProbe (Spec 1 bug fix `307483b`).

### Tool surface (default `allowedTools`)

- `read_file(path)` → file contents (string, UTF-8)
- `write_file(path, content)` → ok
- `list_directory(path)` → array of `{name, type: 'file'|'dir', size?: number}`
- `search_files(path, pattern)` → array of matching relative paths (glob, e.g. `**/*.md`)
- `create_directory(path)` → ok (idempotent)

All `path` arguments are relative to `--root` (`/data` in production). Absolute paths and traversal escapes (`../`) are rejected. Symlinks are resolved then re-validated against the root.

The bundle's filesystem server *also* ships `delete_file` and `move_file` handlers, but they're not in default `allowedTools`. Operators who want them add them to their `values.yaml` override.

### File-size cap

`read_file` and `write_file` are capped at **100 MiB** per call by default. This is enforced in the tool handler before any I/O.

Rationale: MCP tool calls are JSON-encoded HTTP bodies. A 100 MiB write peaks ~200-300 MiB resident memory during JSON.parse (V8's UTF-16 internal string repr can double, plus the HTTP body buffer). Without a cap, the bundle silently OOMs on large writes.

- `write_file`: check `Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES` → MCP-protocol error result.
- `read_file`: `fs.stat` first; check `stat.size > MAX_FILE_BYTES` → error.
- Both errors are user-readable: `{isError: true, content: [{type:'text', text: 'file exceeds 100MiB limit'}]}`.

Constant `MAX_FILE_BYTES = Number(process.env.KUBECLAW_FS_MAX_FILE_BYTES) || 100 * 1024 * 1024`.

Operator override path:
```yaml
capabilities:
  filesystem:
    env:
      KUBECLAW_FS_MAX_FILE_BYTES: "524288000"     # 500 MiB
      NODE_OPTIONS: "--max-old-space-size=1024"
    resources:
      memoryLimit: 2Gi
```

### Path safety

`container/mcp-bundle/filesystem/paths.js` exports:

```js
resolveSafePath(root: string, rawPath: string): string  // throws on escape
```

Behavior:
1. Reject absolute paths (`path.isAbsolute(rawPath)` → throw).
2. Reject paths containing `..` segments after normalization (`path.posix.normalize`).
3. `fs.realpath` the resolved path; verify it still starts with `root` (catches symlink escape: a user-controlled symlink could point to `/etc`).
4. Return the realpath'd absolute path.

Defense in depth: the K8s PVC subPath mount means the kernel only exposes `groups/<folder>/` from the shared PVC. A successful traversal would still hit kernel-level isolation. The application-level checks exist to surface clean error messages rather than mysterious ENOENT/EACCES.

### Bundle Dockerfile shape

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
COPY filesystem ./filesystem
EXPOSE 3000
CMD ["node", "index.js"]
```

`build.sh` wraps this with a sensible tag default.

Image size: `node:20-alpine` (~50MB) + `@modelcontextprotocol/sdk` + small deps → ~80MB total.

### Helm wiring

Append to `helm/kubeclaw/values.yaml` `capabilities:` block (default-on):

```yaml
capabilities:
  filesystem:
    kind: mcp
    scope: group
    image: "{{ .Values.image.registry }}/kubeclaw-mcp-bundle:{{ .Chart.AppVersion }}"
    command: ["node", "/app/index.js", "--server", "filesystem", "--root", "/data"]
    port: 3000
    path: /mcp
    volumeFromGroupPvc: true
    credentialsFrom: none
    scaleDownAfterIdleSeconds: 600
    allowedTools:
      - read_file
      - write_file
      - list_directory
      - search_files
      - create_directory
    env:
      KUBECLAW_FS_MAX_FILE_BYTES: "104857600"        # 100 MiB
      NODE_OPTIONS: "--max-old-space-size=384"        # headroom for JSON-decode
    resources:
      memoryRequest: 128Mi
      memoryLimit: 512Mi
      cpuRequest: 50m
      cpuLimit: 500m
```

The Phase A reconciler turns this into a per-(group × capability) Deployment with:
- `subPath: groups/<group-folder>` mount of the shared PVC at `/data`
- Labels for the per-group NetworkPolicy
- `replicas: 0` at rest
- `readinessProbe` on `/health` (Spec 1 fix)

### Lifecycle (no code changes — uses Phase A + B Spec 1 paths)

1. `helm install` / `helm upgrade` → `values.yaml` `filesystem` entry lands in `CAPABILITIES_VALUES`.
2. Orchestrator startup `initPerGroupCapabilityLifecycle` runs the reconciler; per-group Deployments materialise at `replicas: 0`.
3. Schema scraper (Phase B Spec 1) runs on its 60s timer; scales the first per-group filesystem pod to 1, calls `tools/list`, caches schemas in `capability_tool_schemas`, scales back to 0.
4. `notifyAllChannels` push includes the `mcp-group` entry for `filesystem` with cached schemas.
5. Channel runtime's `McpManager` (Phase B Spec 1) advertises `mcp__filesystem__read_file` etc. in the LLM tool list.
6. LLM calls `mcp__filesystem__write_file({path: 'notes.md', content: '...'})`. Manager parses prefix, requires `ctx.groupFolder`, publishes discovery request, orchestrator scales pod up, returns endpoint, manager opens one-shot MCP HTTP session, forwards `tools/call`.
7. After `scaleDownAfterIdleSeconds` (600s default), sweeper scales pod back to 0.

## Memory budget summary

| Phase | Resident memory (worst case 100 MiB write) |
|---|---|
| Idle (replicas: 0) | 0 |
| Active idle (replicas: 1, no traffic) | ~30-50 MiB (Node baseline) |
| Mid-write of 100 MiB content | ~200-300 MiB (HTTP buffer + JSON.parse double-buffer + Node heap) |
| Pod `memoryLimit` | 512 MiB |
| Headroom | ~40-60% above peak |

## Tests

All three levels per project policy.

### Unit — inside the bundle

`container/mcp-bundle/filesystem/server.test.js` + `paths.test.js`. Run via the bundle's own `npm test`, optionally surfaced via a top-level `npm run test:bundles` script.

Coverage:
- All 5 tools round-trip against a tmp dir
- `read_file` of `../../etc/passwd` → error (path traversal)
- `write_file` to `/etc/foo` → error (outside root)
- Symlink escape: write a symlink pointing to `/etc`, then `read_file` it → error after `realpath` validation
- `search_files` glob behavior (`*.md`, `**/notes*`, `**/*.{md,txt}`)
- `create_directory` is idempotent (no error if dir exists, no error if parent missing — uses `recursive: true`)
- `write_file` content-size cap: ≥100 MiB → error
- `read_file` file-size cap: target file >100 MiB → error
- Hidden file rules: `.foo` is readable/writable; `..` is rejected as traversal

Not part of the main `npm test` from the repo root — bundle's tests live in the container subdir and the bundle's package.json scripts. CI can run them via `cd container/mcp-bundle && npm test`.

### Integration — real K8s

`e2e/filesystem-mcp-integration.test.ts`. Gated on `isKubernetesAvailable()` like the Phase A/B-Spec-1 integration tests.

Scenarios:

1. **Schema scrape end-to-end.** Build + load the bundle image. Reconcile a group with the `filesystem` capability. Run `scrapeMissingSchemas`. Assert `capability_tool_schemas` row written with all 5 tools and their inputSchemas.
2. **Write-then-read round-trip.** Reconcile group "fs-itest-1". `scaleUpInstance`, port-forward, MCP `write_file path=notes.md content="hello"`, then MCP `read_file path=notes.md`, assert `"hello"`. Also verify the file exists on the K8s PVC (kubectl exec into the pod, `cat /data/notes.md`).
3. **Two-group isolation.** Reconcile groups A and B. A writes `secret-a` to `notes.md`. B reads `notes.md` — file not found OR returns nothing (kernel-level isolation via PVC subPath). Confirms one group's writes are invisible to another.
4. **Path traversal rejected.** MCP `read_file path="../../etc/passwd"` → error result.
5. **Size cap enforced (smoke).** MCP `write_file` with 150 MiB content → error result; pod still alive afterward (no OOM kill).

Build the bundle image in `beforeAll` (re-uses Spec 1's pattern).

### E2E — full Helm install

`e2e/filesystem-mcp-e2e.test.ts`. Placeholder per Spec 1 — the meaningful coverage is in the integration test above; full LLM-driven roundtrip waits for mock-LLM + channel-pod infrastructure that's not yet in `e2e/`.

The placeholder reconciles a Helm install scenario:
- Build + load bundle image
- Wait for orchestrator to publish a `capabilities_update` containing the `mcp-group` filesystem entry (poll a channel pod's view)
- Assert the entry's `state: 'ready'` and tool schemas appear after the scraper runs

This proves the Helm-install path is wired correctly without requiring a working channel-pod LLM loop.

## Migration

**Additive — no breaking change.** Operators upgrading from Phase B Spec 1 get `filesystem` enabled automatically. Each registered group gets a `mcp-filesystem-<hash>` Deployment at `replicas: 0` on next reconcile; cold-start on first tool call (~5-10s including image pull on minikube, faster on warm clusters).

CHANGELOG entry under `## Unreleased` → "Features":

```markdown
- **Filesystem MCP capability (Phase B Spec 2)** — default-on. Each registered
  group gets a per-group `kubeclaw-mcp-bundle` pod (scales to zero when idle)
  exposing five tools to the LLM under the `mcp__filesystem__*` prefix:
  `read_file`, `write_file`, `list_directory`, `search_files`,
  `create_directory`. Files are stored on the group's PVC subPath; 100 MiB
  file-size cap (configurable via `KUBECLAW_FS_MAX_FILE_BYTES`).
- **New container image `kubeclaw-mcp-bundle`** — Node-based, hosts multiple
  MCP server kinds selected via `--server` arg. Filesystem is the first
  inhabitant; future Node MCPs (time, sequential-thinking, github) will
  share it.
```

Docs additions:
- `docs/PER_GROUP_CAPABILITIES.md`: new section "Filesystem MCP" with the tool list, the size cap, and the operator override pattern for raising the cap.
- `README.md`: brief mention under "Capabilities" — every group has filesystem out of the box.

## Phasing

Tasks naturally order:

1. Bundle skeleton — `container/mcp-bundle/{Dockerfile, package.json, build.sh}` + `index.js` with `--server` switch dispatching to the filesystem module. (The existing `container/echo-mcp/` stays as a separate test-only container; the bundle does not absorb it.)
2. Path-safety helpers — `container/mcp-bundle/filesystem/paths.js` + tests.
3. Filesystem server — `container/mcp-bundle/filesystem/server.js` (5 tools + transport wiring + size cap).
4. Bundle unit tests — server.test.js + paths.test.js.
5. Bundle Dockerfile finalisation + `build.sh`.
6. Helm `values.yaml` `filesystem` entry.
7. Integration test — `e2e/filesystem-mcp-integration.test.ts`.
8. E2E placeholder — `e2e/filesystem-mcp-e2e.test.ts`.
9. Docs + CHANGELOG.
10. Final sweep.

~10 tasks. Smaller than Spec 1.

## Non-goals deliberately not in this spec

- **Tool extensions** (delete_file, move_file in default allowlist). v2 if demand.
- **Content-search tools** (ripgrep, grep). Separate capability if needed.
- **Multipart / streaming writes**. The 100 MiB cap covers personal-AI workloads; v2 if needed.
- **Per-tool rate limiting**. Pod is already scope-to-group; flooding affects only that group.
- **Audit logging beyond pino**. Existing structured logs sufficient.
- **Filesystem-level permissions** (read-only mounts, etc.). Single uid:gid in the container.

## Open questions surfaced but punted

- **Race between schema scrape and channel-side discovery**: same as Phase B Spec 1 — first-ever turn referencing filesystem may see `state: 'pending-schema'` if the scrape hasn't completed yet. Channels filter such entries from `getTools()` so the LLM never sees a half-cooked tool. Acceptable; documented.
- **Pod gets evicted mid-write**: the 100 MiB write is one HTTP request; eviction kills the response. Client (channel-pod's `callOneShotMcp`) sees a connection error and returns a clean MCP error result to the LLM. The partial file on disk is whatever the kernel flushed — `fs.writeFile` does this atomically per the kernel; either the file is the old content or the new content (no truncation). The LLM can retry. Acceptable for v1.
- **PVC quota**: a single group writing 100 MiB files will eventually fill the shared PVC. We rely on operator PVC sizing for v1; per-group quotas are a future feature.

## References

- Phase A foundation: `docs/superpowers/specs/2026-05-17-per-group-mcp-capabilities-phase-a-design.md`
- Phase B Spec 1 (consumer wiring): `docs/superpowers/specs/2026-05-17-per-group-mcp-consumer-wiring-design.md`
- Phase A's echo MCP container (pattern reference): `container/echo-mcp/`
- Phase A k8s-objects (where `volumeFromGroupPvc` is rendered): `src/per-group-capabilities/k8s-objects.ts`
- Upstream filesystem MCP server (not used directly; reference for tool surface): `@modelcontextprotocol/server-filesystem` on npm

---

**Approval state:** Conversationally approved 2026-05-18 in brainstorming session.
