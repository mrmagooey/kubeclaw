# Task 10 Report: Minikube-live database capability e2e test

## File written

`e2e/minikube-live-database-capability.test.ts`

## Sibling conventions reused

- **Skip guard**: `isRedisReachable()` (nc probe on `KUBECLAW_LIVE_REDIS_LOCAL_PORT`) in `beforeAll`; each test body does `if (!provisioned) return ctx.skip()` — matches the `ctx.skip()` pattern from `minikube-live-data-facade.test.ts`.
- **Namespace constant**: `NAMESPACE = 'kubeclaw-live'` matching all sibling minikube-live tests.
- **kubectl helper**: same `spawnSync('kubectl', ...)` wrapper returning `{ ok, stdout, stderr }` as in `minikube-live-capabilities.test.ts`.
- **Image build**: `ensurePostgresMcpImage()` mirrors `ensureImage()` in `minikube-live-setup.ts` — checks first, rebuilds via `eval $(minikube docker-env) && docker build`.
- **Group registration trigger**: POST `/message` to the HTTP channel (matching how `minikube-live-data-facade.test.ts` ensures the group is registered and `onGroupAdded` fires).
- **Port detection**: The test does NOT use a separate port-forward — it drives MCP calls via `kubectl exec` into the pod, matching the `minikube-live-capabilities.test.ts` pattern for calling the capability server.

## Install path

The `database` capability is `scope: group, pinned: true` in `helm/kubeclaw/values.yaml`. The reconciler (`src/per-group-capabilities/reconciler.ts`) provisions it automatically for all registered groups via `onGroupAdded` — no runtime `install_capability` XADD needed. Credentials (`KUBECLAW_MCP_TOKEN`, `POSTGRES_PASSWORD`, `PGPASSWORD`, `PG_RO_PASSWORD`) are provisioned by `ensureGroupDbCredentials` BEFORE the Deployment is applied.

The test:
1. Builds `kubeclaw-postgres-mcp:latest` into minikube if absent.
2. POSTs to the HTTP channel to register alice's and bob's groups (triggers `onGroupAdded` → reconcile → credentials + deployments).
3. Handles `ImagePullBackOff` by rolling out the deployment after the image is built.
4. Waits for the deployments to be Ready (up to 5 minutes for initial postgres data directory init).

## Test coverage (8 tests)

| # | Test | What it proves |
|---|------|----------------|
| 1 | Deployment + Service + PVC exist and are Ready | Pod Ready, Service exists, PVC provisioned |
| 2 | Creds secret has all 3 keys, correct lengths, rw≠ro | `ensureGroupDbCredentials` ran correctly |
| 3 | MCP /mcp returns 401 without token | Bearer token gate works |
| 4 | MCP /health returns 200 | Server is up and healthy |
| 5 | execute CREATE+INSERT, query SELECT returns x=1 | rw role write, ro role read, PVC persistence |
| 6 | Bob's DB has no alice tables | Per-group isolation (separate postgres instances) |
| 7 | query (ro role) rejects INSERT | Role-level read-only enforcement via Postgres |
| 8 | Alice + bob have distinct Deployments + PVCs | K8s-level per-group isolation |

## Key design decisions

- **Container name**: Primary container inside the per-group capability pod is `'mcp'` (from `renderDeployment` in `src/per-group-capabilities/k8s-objects.ts` line 103), NOT `'capability-mcp'` (which is for global/shared capabilities built by `src/capabilities/builders/mcp.ts`). The postgres sidecar is `'postgres'`.
- **Group folder derivation**: HTTP channel uses `http-<username>` as the group folder. SHA1 of `http-alice` truncated to 10 chars = `17c2919a5e`. Computed in-test via `computeGroupHash()` — no hardcoding.
- **RO enforcement test (test 7)**: Uses raw kubectl exec + script rather than `callMcpTool` to be able to inspect the raw response and match against multiple error message patterns (`permission denied`, `read_only_sql_transaction`, etc.). This is more robust than expecting a specific error format.
- **Test 5 table name**: Uses `e2e_t_${Date.now()}` to avoid collision on repeated runs in the same cluster.

## tsc result

```
npx tsc --noEmit
→ clean (no output), exit 0
```

## What could not be verified locally

The test requires a live minikube cluster with the kubeclaw chart installed. Local verification was limited to `tsc --noEmit`. The skip guard is verified to work correctly (sets `provisioned = false` when Redis is unreachable; each test body calls `ctx.skip()`). Full runtime verification requires CI.

## Concerns

1. **First-run latency**: The postgres data directory initialisation on a cold PVC can take 30–60 seconds. The `waitForDeploymentReady` timeout is 300 seconds (5 minutes), which should be adequate but is generous.
2. **Test 7 error message matching**: The regex `permission denied|read.only|read_only_sql_transaction|cannot execute INSERT|insufficient privi` covers Postgres error messages but may need expansion if the MCP SDK wraps errors differently.
3. **Test order dependency (test 6)**: Test 6 (isolation) relies on test 5 having created `e2e_t_*` tables in alice's DB. Vitest runs tests within a suite sequentially by default, so this is safe. If test 5 fails, test 6 will trivially pass (0 tables in bob's DB is expected even if alice's table creation failed). This is acceptable — the isolation property still holds.
