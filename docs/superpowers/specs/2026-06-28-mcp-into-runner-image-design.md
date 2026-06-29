# Fold MCP capabilities into the runner image — design

**Date:** 2026-06-28
**Status:** Approved (auto-develop; independent coherence review = coherent)

## Goal

Eliminate the two first-party MCP **capability** images and host their MCP servers
inside the existing **`kubeclaw-agent`** runner image, selected at runtime — the same
"one image, specialized by `command:`" pattern the **tool-bridge** sidecar already uses
(`node /app/dist/tool-server.js`). Overarching principle: **avoid first-party custom
images as much as possible.**

Images being folded in:

- **`kubeclaw-mcp-bundle`** (filesystem capability) — `container/mcp-bundle/`
- **`kubeclaw-postgres-mcp`** (database capability) — `container/postgres-mcp/`

## Non-goals

- The `postgres:16` **sidecar** stays a public image (third-party stateful engine; only
  the Node MCP-wrapper container folds into the agent image).
- No change to the capability provisioning framework — `src/per-group-capabilities/` and
  `src/capabilities/` are already image/command-agnostic (they pass `spec.image`,
  `command`, `sidecars`, `storage`, `env`, `credentialsFrom` from `values.yaml` straight
  through; container security forces `runAsUser: 1000` regardless of the Dockerfile, so
  switching to the agent image is a no-op for filesystem PVC permissions).
- No new MCP servers beyond the existing two (YAGNI — the `--server` dispatcher gets
  exactly `filesystem` and `database`).

## Design

### Runtime entrypoint + dispatcher

Add `container/agent-runner/src/mcp-server.ts`, compiled by the existing `tsc` step into
`/app/dist/mcp-server.js` (next to `tool-server.ts`). It:

- Parses CLI args: `--server <filesystem|database>` (required), plus passthrough options
  `--root <path>` (filesystem) and `--port <n>` (both, default `3000`).
- Dispatches to the selected server module's `start()`.
- On a missing/unknown `--server`, prints a clear error to stderr and exits non-zero
  (preserve mcp-bundle's existing exit-code-2 behavior).

> **Port handling (from coherence review):** `postgres-mcp/server.ts` currently reads
> `process.env.PORT ?? '3000'`, but the provisioning code injects no `PORT` env var.
> The dispatcher MUST accept `--port` and pass it to both servers, and the `database`
> command in `values.yaml` MUST include `--port 3000`, so the listen port is explicit
> and tracks `spec.port` rather than relying on a coincidental default.

### Server source moves into the agent-runner tree

- Port `container/mcp-bundle/filesystem/{server.js,paths.js}` →
  `container/agent-runner/src/mcp/filesystem/{server.ts,paths.ts}` (**TypeScript**), and
  port their tests to `*.test.ts`. Export a `start({ root, port })` function; preserve
  path-safety (`resolveSafePath`) and the `KUBECLAW_FS_MAX_FILE_BYTES` cap, and keep the
  five tools (read_file, write_file, list_directory, search_files, create_directory) and
  the `/health` + `/mcp` HTTP endpoints.
- Move `container/postgres-mcp/server.ts` → `container/agent-runner/src/mcp/database/server.ts`
  and its test. Export a `start({ port })`. Keep **dynamic** `import('pg')` (so non-DB
  pods and unit tests don't load `pg`). Preserve the RO/RW role split, `query`
  (read-only) + gated `execute` (read-write), `KUBECLAW_DB_STATEMENT_TIMEOUT_MS`,
  `KUBECLAW_DB_MAX_ROWS`, the boot-time RO-role creation, and bearer-token auth on `/mcp`.

### Dependencies

Add to `container/agent-runner/package.json`:

- `@modelcontextprotocol/sdk` — align with the root repo (`^1.29.0`). Verify the ported
  TS compiles against this version (`StreamableHTTPServerTransport` is stable there).
- `pg` (`^8.x`) + `@types/pg` (dev).

Regenerate `container/agent-runner/package-lock.json`.

### Helm `values.yaml` capability specs

`helm/kubeclaw/values.yaml` — change only the `image:`/`command:` of the two capabilities;
leave every other field (PVC mount, `allowedTools`, `credentialsFrom`, the `postgres:16`
`sidecars` block, `pinned`, `podSecurity.fsGroup`, `storage`, `env`, `resources`) unchanged.

```yaml
# filesystem (currently ~lines 268-294)
    image: kubeclaw-agent:latest
    command: ["node", "/app/dist/mcp-server.js", "--server", "filesystem", "--root", "/data", "--port", "3000"]

# database (currently ~lines 296-329)
    image: kubeclaw-agent:latest
    command: ["node", "/app/dist/mcp-server.js", "--server", "database", "--port", "3000"]
```

Use `kubeclaw-agent:latest` to match the `getContainerImage()` default the tool-bridge uses.

### Removals

- Delete `container/mcp-bundle/` and `container/postgres-mcp/` directories (incl. their
  Dockerfiles, package.json, lockfiles, tests).
- `container/build.sh`: remove the `--mcp-bundle` case block, the `--all` handler line
  that sets `BUILD_MCP_BUNDLE=true`, and the mcp-bundle line in the summary block.
  (`postgres-mcp` has no existing build.sh target — nothing to remove there.)
- `vitest.config.ts`: remove the now-dead `container/postgres-mcp/**/*.test.ts` include
  glob (the moved DB tests are picked up by the existing `container/agent-runner/**/*.test.ts`
  glob).

### Tests + docs to update (concrete references from coherence review)

- `e2e/filesystem-mcp-integration.test.ts`:
  - `BUNDLE_IMAGE = 'kubeclaw-mcp-bundle:test'` → the agent image (`kubeclaw-agent:test`).
  - The `./container/mcp-bundle/build.sh ...` invocation → build the agent image instead.
  - `getCachedSchemas('filesystem', BUNDLE_IMAGE)` → follows the image-var rename (the
    schema cache is keyed by `(capabilityName, image)`).
- `e2e/minikube-live-database-capability.test.ts`: replace `kubeclaw-postgres-mcp:latest`
  build/load with the agent image + new command.
- `e2e/helm-chart-template.test.ts`: update the database capability assertions to expect
  the agent image + `mcp-server.js --server database` command.
- Docs: `docs/PER_GROUP_CAPABILITIES.md`, `docs/TESTING.md`, and the changelog — replace
  references to the two custom images with the folded-in agent-image model.

### Cross-branch reconciliation note (not part of this branch)

A separate in-flight branch `ci/replace-workflows` adds `.github/workflows/unit-tests.yml`
which runs `npm ci --prefix container/postgres-mcp` and lists that lockfile in
`cache-dependency-path`. After this change deletes `container/postgres-mcp/`, those two
lines must be dropped (the DB tests now live under `container/agent-runner`, whose deps
are already installed). This is recorded here so it's reconciled when the two branches
land together; it is **not** edited on this branch (the file doesn't exist on `main`).

## Safety properties preserved

- Filesystem: path-traversal guard + file-size cap; runs as uid 1000 (unchanged).
- Database: RO/RW Postgres role split, statement timeout, row cap, bearer-token `/mcp`
  auth, per-group creds; `postgres:16` sidecar + 5Gi PVC + `pinned` unchanged.
- Runtime isolation unchanged: each capability still runs as its own hardened pod with a
  per-group NetworkPolicy and per-group credentials. The only change is that the MCP
  server *code* now ships inside the agent image (accepted security trade-off).

## Testing strategy (all three levels)

- **Unit:** `mcp-server.ts` dispatcher (unknown/missing `--server` → non-zero exit;
  `--root`/`--port` parsing); filesystem path-safety + size-cap; database tool handlers
  (RO vs RW pool routing, row cap, timeout, bearer auth) — ported from existing tests,
  run under the agent-runner build.
- **Integration:** `helm-chart-template.test.ts` renders the chart and asserts both
  capabilities now use `kubeclaw-agent` + the `mcp-server.js` command.
- **E2E:** `filesystem-mcp-integration` and `minikube-live-database-capability` build/load
  the agent image and exercise the capability end-to-end. (These require a cluster and are
  CI-gated like the rest of the e2e suite.)

## Acceptance criteria

1. The agent image builds and contains `/app/dist/mcp-server.js`; `--server filesystem`
   and `--server database` both start and serve `/health` + `/mcp`.
2. `helm/kubeclaw/values.yaml` references no first-party MCP image — both capabilities use
   `kubeclaw-agent:latest` + an `mcp-server.js` command.
3. `container/mcp-bundle/` and `container/postgres-mcp/` are gone; `build.sh`,
   `vitest.config.ts`, e2e tests, and docs contain no stale references.
4. `npm test` (root + agent-runner) is green; `npm run build` and the agent image build
   are clean.
