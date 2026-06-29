# Fold MCP Capabilities Into the Runner Image — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host the filesystem and database MCP capability servers inside the existing `kubeclaw-agent` runner image, selected at runtime via `mcp-server.js --server <filesystem|database>`, and delete the two custom capability images.

**Architecture:** Mirror the tool-bridge pattern (same agent image, different `command:`). New source lives in `container/agent-runner/src/mcp/` and compiles into `/app/dist/mcp-server.js` via the agent image's existing `tsc` step. The capability provisioning layer (`src/per-group-capabilities/`) is already image/command-agnostic, so only `helm/kubeclaw/values.yaml` changes there. The `postgres:16` sidecar stays a public image.

**Tech Stack:** TypeScript, Node 22, `@modelcontextprotocol/sdk`, `pg` (dynamic import), Vitest, Helm.

## Global Constraints

- Target image is **`kubeclaw-agent:latest`** (matches the `getContainerImage()` default the tool-bridge uses). Do NOT fold into the orchestrator image.
- Runtime selector is the CLI arg **`--server filesystem|database`**; pass `--root <path>` (filesystem) and `--port <n>` (both, default 3000). The database command MUST pass `--port 3000` (provisioning injects no `PORT` env var).
- `pg` MUST be imported **dynamically** (`await import('pg')`), never statically.
- Preserve every safety property: filesystem path-safety + `KUBECLAW_FS_MAX_FILE_BYTES`; database RO/RW role split, `query`(ro)/`execute`(gated rw), `KUBECLAW_DB_STATEMENT_TIMEOUT_MS`, `KUBECLAW_DB_MAX_ROWS`, boot-time RO-role creation, bearer-token `/mcp` auth. Each server keeps `/health` and `/mcp`.
- Keep the tree building and `npm test` green after every task.
- Node binary path for this environment: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`. A husky pre-commit hook runs `npm`, so keep that on PATH when committing.
- `npm test` includes tests under `src/**`, `setup/**`, `skills-engine/**`, `container/agent-runner/**`, `container/postgres-mcp/**` (`vitest.config.ts:15-21`). The old `container/mcp-bundle/` tests are NOT in this set (separate config).

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `container/agent-runner/package.json` (+ lockfile) | Add `@modelcontextprotocol/sdk`, `pg`, `@types/pg` | Modify |
| `container/agent-runner/src/mcp/filesystem/paths.ts` | Path-safety helper (`resolveSafePath`) | Create (port from `container/mcp-bundle/filesystem/paths.js`) |
| `container/agent-runner/src/mcp/filesystem/server.ts` | Filesystem MCP server; `start({root,port})` | Create (port from `container/mcp-bundle/filesystem/server.js`) |
| `container/agent-runner/src/mcp/filesystem/*.test.ts` | Ported unit tests | Create |
| `container/agent-runner/src/mcp/database/server.ts` | Database MCP server; `start({port})`; dynamic pg | Create (move from `container/postgres-mcp/server.ts`) |
| `container/agent-runner/src/mcp/database/server.test.ts` | Ported unit test | Create |
| `container/agent-runner/src/mcp-server.ts` | CLI dispatcher → `/app/dist/mcp-server.js` | Create |
| `container/agent-runner/src/mcp-server.test.ts` | Dispatcher unit test | Create |
| `helm/kubeclaw/values.yaml` | Swap both capabilities to agent image + `mcp-server.js` command | Modify |
| `e2e/helm-chart-template.test.ts` | Update DB capability render assertions | Modify |
| `container/build.sh` | Remove mcp-bundle target/handler/summary | Modify |
| `vitest.config.ts` | Remove dead `container/postgres-mcp/**` glob | Modify |
| `container/mcp-bundle/`, `container/postgres-mcp/` | Old custom images | Delete |
| `e2e/filesystem-mcp-integration.test.ts` | Use agent image (lines 24,141,223) | Modify |
| `e2e/minikube-live-database-capability.test.ts` | Use agent image build/load | Modify |
| `docs/PER_GROUP_CAPABILITIES.md`, `docs/TESTING.md`, changelog | Drop custom-image references | Modify |

---

## Task 1: Add MCP + pg dependencies to agent-runner

**Files:**
- Modify: `container/agent-runner/package.json` (+ regenerate `container/agent-runner/package-lock.json`)

**Interfaces:**
- Produces: `@modelcontextprotocol/sdk` and `pg` resolvable from `container/agent-runner/`, so later tasks' imports compile.

- [ ] **Step 1: Read the current deps** in `container/agent-runner/package.json` and the root `package.json` (to copy the exact `@modelcontextprotocol/sdk` version the repo already uses, target `^1.29.0`).

- [ ] **Step 2: Add dependencies.** In `container/agent-runner/package.json`, add to `dependencies`: `"@modelcontextprotocol/sdk": "^1.29.0"` and `"pg": "^8.13.0"`; add to `devDependencies`: `"@types/pg": "^8.11.0"`. (Match the existing version style; if root pins a different patch of the SDK, use root's.)

- [ ] **Step 3: Regenerate the lockfile.**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd container/agent-runner && npm install`
Expected: updates `package-lock.json`, exits 0.

- [ ] **Step 4: Verify a clean install resolves.**

Run: `cd container/agent-runner && npm ci`
Expected: exits 0, `node_modules/@modelcontextprotocol` and `node_modules/pg` present.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/package.json container/agent-runner/package-lock.json
git commit -m "build(agent-runner): add @modelcontextprotocol/sdk + pg for folded MCP servers"
```

---

## Task 2: Port the filesystem MCP server to TypeScript

**Files:**
- Create: `container/agent-runner/src/mcp/filesystem/paths.ts`, `.../filesystem/server.ts`
- Test: `container/agent-runner/src/mcp/filesystem/paths.test.ts`, `.../filesystem/server.test.ts`
- Read (source to port): `container/mcp-bundle/filesystem/paths.js`, `.../filesystem/server.js`, and their existing tests in `container/mcp-bundle/filesystem/`.

**Interfaces:**
- Produces:
  - `paths.ts`: `export function resolveSafePath(root: string, userPath: string): string` — same semantics as the JS original (reject absolute paths / `..` traversal / symlink escape; return the resolved absolute path under `root`).
  - `server.ts`: `export async function start(opts: { root: string; port: number }): Promise<void>` — boots the HTTP server serving `/health` and `/mcp` (StreamableHTTPServerTransport), exposing the 5 tools (read_file, write_file, list_directory, search_files, create_directory) with the `KUBECLAW_FS_MAX_FILE_BYTES` cap. Refactor the original's top-level `--root`/port reading OUT of the module (the dispatcher passes `opts`); keep all tool logic identical.

- [ ] **Step 1: Port the failing tests first.** Copy the existing `paths` and `server` test cases from `container/mcp-bundle/filesystem/*.test.*` into the new `*.test.ts` files, converting to TS and importing from the new `./paths.js` / `./server.js` paths. Cover at minimum: `resolveSafePath` rejects `..` and absolute paths and accepts a normal nested path; a `read_file`/`write_file` round-trip under a temp root; oversized write rejected by the byte cap.

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npx vitest run container/agent-runner/src/mcp/filesystem`
Expected: FAIL — modules `./paths`, `./server` not found.

- [ ] **Step 3: Port `paths.ts`.** Translate `container/mcp-bundle/filesystem/paths.js` to TS (add types; keep logic byte-for-byte). Export `resolveSafePath`.

- [ ] **Step 4: Port `server.ts`.** Translate `container/mcp-bundle/filesystem/server.js` to TS. Extract `start({ root, port })`; move the file-size cap read (`KUBECLAW_FS_MAX_FILE_BYTES`) to module scope or inside `start`; keep the 5 tool handlers and the `/health` + `/mcp` wiring unchanged. Import `@modelcontextprotocol/sdk` server + `StreamableHTTPServerTransport` exactly as the original.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run container/agent-runner/src/mcp/filesystem`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/mcp/filesystem
git commit -m "feat(agent-runner): port filesystem MCP server to TypeScript"
```

---

## Task 3: Move the database MCP server into agent-runner

**Files:**
- Create: `container/agent-runner/src/mcp/database/server.ts`
- Test: `container/agent-runner/src/mcp/database/server.test.ts`
- Read (source to move): `container/postgres-mcp/server.ts` and its test (`container/postgres-mcp/*.test.ts`).

**Interfaces:**
- Produces: `server.ts`: `export async function start(opts: { port: number }): Promise<void>` — boots the DB MCP server. Keep the pure, testable `buildToolHandlers(...)` (or equivalently named) export the original test targets, the RO/RW pool routing, `query`/`execute`, statement timeout, row cap, bearer-token check, and boot-time RO-role creation. **Keep `await import('pg')` dynamic.** Replace the original top-level `process.env.PORT ?? '3000'` listen with `opts.port`.

- [ ] **Step 1: Port the failing test first.** Copy the existing `container/postgres-mcp/*.test.ts` into `container/agent-runner/src/mcp/database/server.test.ts`, fixing import paths. It should exercise the pure tool-handler logic (RO vs RW pool selection, row-cap truncation, rejecting non-string sql) without a live Postgres.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run container/agent-runner/src/mcp/database`
Expected: FAIL — module `./server` not found.

- [ ] **Step 3: Move `server.ts`.** Copy `container/postgres-mcp/server.ts` to the new path; change the listen port to come from `opts.port`; export `start({ port })`; keep everything else (dynamic pg, role bootstrap, handlers, bearer auth) identical. Do NOT delete `container/postgres-mcp/` yet (Task 6).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run container/agent-runner/src/mcp/database`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/mcp/database
git commit -m "feat(agent-runner): move database MCP server into agent-runner (dynamic pg)"
```

---

## Task 4: Add the `mcp-server.ts` dispatcher

**Files:**
- Create: `container/agent-runner/src/mcp-server.ts`
- Test: `container/agent-runner/src/mcp-server.test.ts`
- Read: `container/agent-runner/src/tool-server.ts` (for the existing entrypoint style), `container/mcp-bundle/index.js` (existing `--server` arg parsing).

**Interfaces:**
- Consumes: `./mcp/filesystem/server.js` `start({root,port})`, `./mcp/database/server.js` `start({port})`.
- Produces: a CLI entrypoint compiled to `/app/dist/mcp-server.js`. Parses `--server`, `--root` (default `/data`), `--port` (default `3000`). Dispatches; on missing/unknown `--server` writes an error to stderr and exits with code 2. Export a pure `parseArgs(argv: string[]): { server: string; root: string; port: number }` for testing.

- [ ] **Step 1: Write the failing test.** Test `parseArgs`: `--server filesystem --root /data --port 3000` → `{server:'filesystem',root:'/data',port:3000}`; `--server database` → defaults root `/data`, port `3000`; missing `--server` throws (or returns a sentinel the main handler turns into exit 2); unknown `--server foo` is rejected by the dispatcher. (Test `parseArgs` + the unknown-server rejection path; do not boot real servers.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run container/agent-runner/src/mcp-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mcp-server.ts`.** `parseArgs` + a `main()` that switches on `server`: `filesystem` → `import('./mcp/filesystem/server.js').then(m => m.start({root,port}))`; `database` → `import('./mcp/database/server.js').then(m => m.start({port}))`; default → `console.error(...)`, `process.exit(2)`. Guard `main()` behind an `import.meta`/`process.argv[1]` entrypoint check so importing the module in tests does not run it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run container/agent-runner/src/mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the agent image build emits `dist/mcp-server.js`.** Confirm `container/agent-runner/tsconfig.json` includes `src/**` (so `src/mcp/**` and `src/mcp-server.ts` compile) — it does via `src/**`; no Dockerfile change is needed because `container/Dockerfile` runs the same `tsc` that already produces `dist/tool-server.js`. If a typecheck script exists, run it:

Run: `npx tsc --noEmit -p container/agent-runner/tsconfig.json`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/mcp-server.ts container/agent-runner/src/mcp-server.test.ts
git commit -m "feat(agent-runner): add mcp-server.js --server dispatcher"
```

---

## Task 5: Point the Helm capabilities at the agent image

**Files:**
- Modify: `helm/kubeclaw/values.yaml` (filesystem ~268-294, database ~296-329)
- Test: `e2e/helm-chart-template.test.ts`

**Interfaces:**
- Produces: rendered Deployments whose capability container uses `kubeclaw-agent:latest` + the `mcp-server.js` command.

- [ ] **Step 1: Update the integration test first.** In `e2e/helm-chart-template.test.ts`, find the database (and any filesystem) capability assertions (search for `kubeclaw-postgres-mcp` / `kubeclaw-mcp-bundle`) and change expectations to `image: kubeclaw-agent:latest` and the new `command`. Add an assertion that the rendered chart contains **no** `kubeclaw-mcp-bundle` or `kubeclaw-postgres-mcp` image reference.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npx vitest run e2e/helm-chart-template.test.ts`
Expected: FAIL (values.yaml still has the old images).

- [ ] **Step 3: Edit `values.yaml`.** Filesystem capability: set `image: kubeclaw-agent:latest` and `command: ["node", "/app/dist/mcp-server.js", "--server", "filesystem", "--root", "/data", "--port", "3000"]`. Database capability: set `image: kubeclaw-agent:latest` and `command: ["node", "/app/dist/mcp-server.js", "--server", "database", "--port", "3000"]`. Leave all other fields untouched (PVC mount, allowedTools, credentialsFrom, the `postgres:16` sidecars block, pinned, fsGroup, storage, env, resources).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run e2e/helm-chart-template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/values.yaml e2e/helm-chart-template.test.ts
git commit -m "feat(helm): run filesystem+database capabilities from the agent image"
```

---

## Task 6: Delete the custom images and purge stale references

**Files:**
- Delete: `container/mcp-bundle/`, `container/postgres-mcp/`
- Modify: `container/build.sh`, `vitest.config.ts`, `e2e/filesystem-mcp-integration.test.ts`, `e2e/minikube-live-database-capability.test.ts`

**Interfaces:**
- Produces: a tree with no first-party MCP image and no dangling references; `npm test` still green (the moved tests now run under the agent-runner glob).

- [ ] **Step 1: Update the filesystem e2e test** (`e2e/filesystem-mcp-integration.test.ts`): line ~24 `BUNDLE_IMAGE = 'kubeclaw-mcp-bundle:test'` → `'kubeclaw-agent:test'`; line ~141 `./container/mcp-bundle/build.sh ${BUNDLE_IMAGE}` → build the agent image (`./container/build.sh --agent` or the existing agent-image build helper the suite uses — match how other e2e tests build the agent image); line ~223 `getCachedSchemas('filesystem', BUNDLE_IMAGE)` follows the renamed var. Also update the capability `command` used in the test to the new `mcp-server.js --server filesystem ...` if the test sets it inline.

- [ ] **Step 2: Update the database e2e test** (`e2e/minikube-live-database-capability.test.ts`): replace the `kubeclaw-postgres-mcp:latest` build-from-`container/postgres-mcp` and `minikube image load` steps with building/loading the agent image; update any inline image/command expectations to the agent image + `mcp-server.js --server database`.

- [ ] **Step 3: Trim `container/build.sh`.** Remove the `--mcp-bundle` case block, the `--all` handler line setting `BUILD_MCP_BUNDLE=true`, and the mcp-bundle line in the summary block. (No `postgres-mcp` target exists there.)

- [ ] **Step 4: Remove the dead vitest glob.** In `vitest.config.ts`, delete the `'container/postgres-mcp/**/*.test.ts'` include line (the moved DB test is covered by the existing `'container/agent-runner/**/*.test.ts'` line).

- [ ] **Step 5: Delete the directories.**

```bash
git rm -r container/mcp-bundle container/postgres-mcp
```

- [ ] **Step 6: Verify no stale references remain.**

Run: `grep -rIn "mcp-bundle\|postgres-mcp" --include='*.ts' --include='*.js' --include='*.sh' --include='*.yaml' --include='*.yml' . | grep -v node_modules | grep -v docs/superpowers`
Expected: no hits in source/scripts/helm/CI (docs handled in Task 7).

- [ ] **Step 7: Run the full unit suite.**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npm test`
Expected: green (only any pre-existing unrelated failures, e.g. agent-runner package-resolution if its node_modules weren't installed — install with `cd container/agent-runner && npm ci` if so).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: delete kubeclaw-mcp-bundle + kubeclaw-postgres-mcp images; purge references"
```

---

## Task 7: Update documentation

**Files:**
- Modify: `docs/PER_GROUP_CAPABILITIES.md`, `docs/TESTING.md`, and the changelog (search the repo for `CHANGELOG`).

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `docs/PER_GROUP_CAPABILITIES.md`.** Replace references to `kubeclaw-mcp-bundle` / `kubeclaw-postgres-mcp` (and any separate-registry-pin guidance) with the folded-in model: capabilities run from `kubeclaw-agent` via `mcp-server.js --server <name>`; the `postgres:16` sidecar remains.

- [ ] **Step 2: Update `docs/TESTING.md`** wherever it tells contributors to build the old capability images for e2e — point to building the agent image instead.

- [ ] **Step 3: Add a changelog entry** noting the consolidation and that the two capability images are removed (folded into the agent image).

- [ ] **Step 4: Verify docs have no stale image references.**

Run: `grep -rIn "kubeclaw-mcp-bundle\|kubeclaw-postgres-mcp" docs/ README.md CHANGELOG.md 2>/dev/null | grep -v superpowers/plans | grep -v superpowers/specs`
Expected: no hits (outside the spec/plan we authored).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: fold MCP capability images into the agent runner image"
```

---

## Self-Review notes

- **Spec coverage:** entrypoint+dispatcher (T4), filesystem TS port (T2), database move (T3), deps (T1), values.yaml swap (T5), build.sh/vitest/e2e/deletions (T6), docs (T7), cross-branch `unit-tests.yml` note (spec only — that file isn't on this branch). All spec sections map to a task.
- **No placeholders:** port/move tasks reference the exact source files + the precise interface changes (`start({...})`, dynamic pg, `--port`); the structural edits give exact line anchors.
- **Type consistency:** `start(opts)` signatures and `parseArgs` shape are consistent across T2/T3/T4; the dispatcher consumes exactly what T2/T3 export.
