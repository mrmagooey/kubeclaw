# Story 96: Per-group MCP consumer wakes from zero and round-trips an MCP call

## Goal

Verify that the orchestrator's per-group capability reconciler can scale a deployment from zero to one replica on demand, scrape `tools/list` via `streamableHttp`, cache the schemas, and complete a live MCP tool-call round-trip — all without touching the LLM layer.

## Architecture

`reconcileGroupCapabilities` in `src/per-group-capabilities/index.ts` drives the full lifecycle: it calls `scaleUpInstance` (via `RealPerGroupK8sClient`) to bring a scaled-to-zero deployment to one ready replica, then `scrapeMissingSchemas` to open a `StreamableHTTPClientTransport` connection to the pod's `/mcp` endpoint and populate the schema-cache table. The discovery client in `src/capabilities/discovery.ts` re-uses the same scale-up path and then makes a live JSON-RPC tool call through the in-cluster (port-forwarded) endpoint. After each operation the deployment is scaled back to zero to prove the idle-cost saving.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube, namespace `kubeclaw-test-pgc` (no mock K8s API)
- **Test image:** `kubeclaw-echo-mcp:test` built and loaded into minikube by `container/echo-mcp/build.sh` in `beforeAll`
- **MCP transport:** `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport`
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/per-group-mcp-consumer-integration.test.ts` | 2-block e2e test (schema scraper + discovery round-trip) |
| `src/per-group-capabilities/index.ts` | `reconcileGroupCapabilities`, `scaleUpInstance`, `scrapeMissingSchemas`, `RealPerGroupK8sClient`, `groupHash` |
| `src/per-group-capabilities/schema-cache.ts` | `getCachedSchemas`, schema-cache DB table |
| `src/capabilities/discovery.ts` | Discovery client that routes MCP calls to per-group pods |
| `container/echo-mcp/build.sh` | Builds and loads `kubeclaw-echo-mcp:test` into minikube |

## Tasks (retrospective)

### AC 1 — Schema-scraper scales from zero, scrapes, and scales back

`scrapeMissingSchemas` exercises `RealPerGroupK8sClient.scaleDeployment(name, 1)`, waits for the pod ready condition, opens a `StreamableHTTPClientTransport` to `http://<pod-ip>:<port>/mcp`, calls `tools/list`, stores results in the schema-cache table, then calls `scaleDeployment(name, 0)`. All steps exercised in a single `it()` block inside `per-group-mcp-consumer-integration.test.ts`.

### AC 2 — Schema-cache populated and readable

After the scrape, `getCachedSchemas(groupId, capabilityName)` returns a non-empty array of `McpToolSchema` records from the SQLite schema-cache table. The test asserts at least one schema with a non-empty `name` field.

### AC 3 — Discovery-client round-trip returns expected result

A second `it()` block calls the discovery client with an `echo` tool invocation. The client scales up the deployment, resolves the pod endpoint, sends a `tools/call` JSON-RPC request over `StreamableHTTPClientTransport`, and asserts the returned content matches the echoed input.

### AC 4 — Repeat calls succeed (no leftover lock or scale-confusion)

The test's `afterEach` hook calls `__resetDbForTest()` and `_resetDiscoveryDepsForTest()` to clear state between iterations, confirming no persistent lock or stale replica-count confusion.

### AC 5 — Real K8s client used throughout

`RealPerGroupK8sClient` is instantiated directly (not a mock). All `kubectl` interactions go to the live minikube cluster in `kubeclaw-test-pgc`.

### Verification

Run: `npm run test:e2e -- per-group-mcp-consumer-integration`

Expected: **2 / 2 tests pass** (schema-scraper end-to-end + discovery-client round-trip).

Runtime: 5–15 minutes (includes `beforeAll` image build + minikube load).
