# Story 95: Filesystem MCP per-group capability schema-scrape and read/write round-trip

## Goal

Provision a per-group `filesystem` MCP capability, scrape its tool schemas into the orchestrator cache, and verify sandboxed read/write round-trips with path-traversal protection via real Kubernetes.

## Architecture

The per-group capability reconcile loop (`src/per-group-capabilities/index.ts`) calls `reconcileGroupCapabilities` which scales up a dedicated pod per group (`scaleUpInstance`) and then runs `scrapeMissingSchemas` to call `tools/list` against the live MCP pod and persist results via `schema-cache.ts`. The filesystem MCP server (`container/mcp-bundle`, serving the `@modelcontextprotocol/server-filesystem` package) exposes 5 tools (`read_file`, `write_file`, `list_directory`, `delete_path`, `move_path`) and enforces a chroot-style mount root so paths outside it are rejected. The orchestrator populates the schema-cache before advertising filesystem tools to any LLM, ensuring the advertised schema is always live-scraped from the real server image.

## Tech Stack

- Test runner: vitest (e2e mode, tag `e2e`)
- Cluster: real minikube / k8s (`isKubernetesAvailable()` guard)
- MCP client: `@modelcontextprotocol/sdk` StreamableHTTPClientTransport against a real per-group pod
- No LLM involvement — schema scrape and round-trip operate below the LLM layer

## File Structure

- `e2e/filesystem-mcp-integration.test.ts` — 3 `it()` blocks covering schema-scrape, write/read round-trip, and path-traversal rejection
- `src/per-group-capabilities/index.ts` — `reconcileGroupCapabilities`, `scrapeMissingSchemas`, `scaleUpInstance`, `groupHash`, `RealPerGroupK8sClient`
- `src/per-group-capabilities/schema-cache.ts` — `getCachedSchemas`, schema persistence layer
- `container/mcp-bundle/` — Docker image bundling the filesystem MCP server with the HTTP adapter

## Tasks (retrospective)

### AC 1: Schema-scrape caches all 5 tools end-to-end

`reconcileGroupCapabilities` + `scrapeMissingSchemas` call the live filesystem MCP pod's `tools/list` endpoint and persist 5 tool schemas via `schema-cache.ts`. The `schema_scrape_completed` log confirms `tool_count: 5`.

### AC 2: write_file / read_file round-trips byte-identical content

`scaleUpInstance` wires the group pod, then a direct `McpClient` call sequence (`write_file` → `read_file`) through the per-group pod returns the original bytes unchanged, proving request/response framing and in-pod persistence.

### AC 3: Path-traversal attempts are rejected

The filesystem MCP server validates every path against the configured mount root. Calls with `../` segments or absolute paths outside the root return an MCP error before any filesystem access occurs.

### AC 4: Per-group isolation (group mount scoping)

Each group's pod is scoped to its own PVC mount. The test uses separate group IDs (`fs-itest-1`, `fs-itest-2`, `fs-itest-3`) to confirm isolation at the Kubernetes pod / PVC level.

### AC 5: Real Kubernetes (no mocks)

`RealPerGroupK8sClient` issues live `kubectl` / k8s API calls. The test is guarded by `isKubernetesAvailable()` and skips on clusters where the orchestrator is not deployed.

### Verification

Run: `npm run test:e2e -- filesystem-mcp-integration`

Expected: **3 / 3 passing** (schema-scrape, write-then-read, path-traversal).
