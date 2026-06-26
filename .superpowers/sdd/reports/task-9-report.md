# Task 9 Report: database capability — ro-role bootstrap, reconcile-time credentials, Helm wiring

## Part A — server ro-role bootstrap (`container/postgres-mcp/server.ts`)

### Changes
- Added `buildRoleBootstrapSql(roUser: string): string` as an exported pure helper above `main()`.
- Added `SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/` constant for identifier validation.
- In `main()`: inserted a ro-role bootstrap block between pool creation and `buildToolHandlers` that:
  1. Waits for Postgres to be reachable (30 retries × 2 s back-off), exits non-zero if not reachable.
  2. Creates the ro role via a DO block guard (roles lack IF NOT EXISTS).
  3. Sets the password via a PARAMETERIZED `ALTER ROLE "$roUser" PASSWORD $1` — the password string is never interpolated into SQL.
  4. Runs each statement from `buildRoleBootstrapSql` (CONNECT, USAGE, SELECT, ALTER DEFAULT PRIVILEGES) before serving.

### SQL-injection protection
- **Role identifier**: validated against `^[a-z_][a-z0-9_]*$` before interpolation. This is the only way to include an identifier in SQL; it cannot be parameterized. The regex rejects spaces, semicolons, quotes, hyphens, and any SQL metacharacter.
- **Password**: always passed as `$1` parameter to `ALTER ROLE ... PASSWORD $1`. Never string-interpolated. This is the critical security boundary — a rogue password value cannot escape the parameter slot.

### Tests added
Two new `buildRoleBootstrapSql` tests in `container/postgres-mcp/server.test.ts`:
1. Asserts GRANT SELECT ON ALL TABLES, ALTER DEFAULT PRIVILEGES GRANT SELECT, GRANT USAGE are present; INSERT/UPDATE/DELETE/ALL PRIVILEGES are absent.
2. Asserts an unsafe identifier throws.

## Part B — reconcile-time credential provisioning

### New file: `src/per-group-capabilities/provision-credentials.ts`
Exports `ensureGroupDbCredentials(args)`. For each required key, reads via `readGroupCredential` first; only generates and writes when absent:
- `KUBECLAW_MCP_TOKEN` — delegates to `ensureGroupMcpToken` (32 bytes → 64 hex).
- `POSTGRES_PASSWORD` — read to check if rw password exists. If absent, generates 24 bytes → 48 hex, writes to BOTH `POSTGRES_PASSWORD` and `PGPASSWORD` in a single code path so they can never diverge on a second call.
- `PG_RO_PASSWORD` — checked independently; distinct 24 random bytes if absent.

### Idempotency
All paths check for existing values before generating. A second call to `ensureGroupDbCredentials` does not change any value. The test verifies this explicitly.

### Reconciler wiring (`src/per-group-capabilities/reconciler.ts`)
Added logic in the reconcile loop for each (spec, group) pair where `resolveGroupCapability(spec).credentialsFrom === 'secret'`:
1. Read the credentials Secret; if absent, `applySecret` an empty placeholder (so the pod's `optional: true` envFrom reference is satisfied even if credential generation fails mid-flight).
2. Call `ensureGroupDbCredentials` to fill in all required keys (idempotent).
3. Then `applyDeployment` — credentials are guaranteed present before the pinned pod starts.

For `credentialsFrom: 'none'` specs, this block is skipped entirely.

### New reconciler tests
Two new tests in `src/per-group-capabilities/reconciler.test.ts`:
1. **provisions DB credentials for credentialsFrom:secret and skips for credentialsFrom:none** — reconciles two specs; asserts the `database` (secret) spec gets all required keys with correct formats and the `echo` (none) spec has no creds secret.
2. **credentials are provisioned before the deployment is applied** — asserts the creds secret exists in the client store and the deployment is in the applyOrder.

## Part C — Helm values wiring (`helm/kubeclaw/values.yaml`)

Added `capabilities.database` entry under the existing `capabilities:` section:
- `kind: mcp`, `scope: group`, `pinned: true`, `credentialsFrom: secret`
- `allowedTools: [query]` — execute hidden by default
- `podSecurity.fsGroup: 999` — postgres:16 runs as uid/gid 999
- `storage.container: postgres` — dedicated PVC mounts into the postgres sidecar
- `env.PG_RO_USER: kubeclaw_ro`, `PGHOST: 127.0.0.1`, `PGUSER: kubeclaw`, `PGDATABASE: kubeclaw`
- `sidecars[0].name: postgres` — postgres:16 sidecar with POSTGRES_USER, POSTGRES_DB, PGDATA env vars; POSTGRES_PASSWORD comes from the per-group creds secret via envFrom

### New e2e test
Added `describe('helm values — database capability declared correctly')` test in `e2e/helm-chart-template.test.ts` that reads values.yaml directly via `js-yaml` and asserts all required fields.

## Test commands and output

```
npx vitest run container/postgres-mcp/server.test.ts src/per-group-capabilities/provision-credentials.test.ts src/per-group-capabilities/reconciler.test.ts
→ 3 files, 20 tests, all passed

npx vitest run --config vitest.e2e.config.ts e2e/helm-chart-template.test.ts
→ 1 file, 82 tests, all passed

npx tsc --noEmit
→ clean (no output)
```

## Concerns

None. All three parts implemented cleanly with no known issues.

---

## Code-Review Fix Pass (commit 2857412)

### CRITICAL — SQL injection ordering in `main()` (`container/postgres-mcp/server.ts`)

**Finding**: `PG_RO_USER` was interpolated into the DO block before being validated.

**Fix**:
1. Exported `SAFE_IDENTIFIER_RE` (was `const`, now `export const`) so it can be tested directly.
2. Added an explicit guard immediately after the `PG_RO_USER` emptiness check that tests `SAFE_IDENTIFIER_RE.test(PG_RO_USER)` and calls `process.exit(1)` with a clear FATAL message if the value is unsafe — BEFORE any SQL interpolation.

**Test added** (`SAFE_IDENTIFIER_RE (PG_RO_USER guard)` describe block in `container/postgres-mcp/server.test.ts`):
- Accepts valid lowercase identifiers (`kubeclaw_ro`, `ro`, `_ro_user_2`).
- Rejects all SQL injection vectors (semicolons, quotes, hyphens, spaces, uppercase).
- Rejects identifiers starting with a digit.

### IMPORTANT 1 — DO block quoting hygiene (`container/postgres-mcp/server.ts`)

**Finding**: Even after the guard, the DO block used raw string interpolation with double-quotes for `CREATE ROLE "${PG_RO_USER}"`.

**Fix**: Refactored the DO block to use a PL/pgSQL `DECLARE _role text := '${PG_RO_USER}'; ... EXECUTE format('CREATE ROLE %I LOGIN', _role)` pattern, so Postgres's own `quote_ident` semantics apply inside the DO block. The validated-identifier interpolation for the scalar assignment (`_role text := '...'`) remains, with a comment explaining the pre-validated safety. The `ALTER ROLE "${PG_RO_USER}" PASSWORD $1` keeps the validated identifier with a comment.

### IMPORTANT 2 — Reconciler ordering assertion (`src/per-group-capabilities/reconciler.test.ts`)

**Finding**: The "credentials provisioned before deployment" test only checked that the deployment was in `applyOrder` and the secret existed after reconcile — it did not assert temporal ordering.

**Fix**:
1. `FakePerGroupK8sClient.applySecret` now pushes `'secret:<name>'` into `applyOrder` (mirrors how `applyDeployment` and `applyPersistentVolumeClaim` record).
2. The test now uses `client.applyOrder.lastIndexOf('secret:<secretName>')` and asserts it is `< client.applyOrder.indexOf('deployment:<deployName>')`.

### MINOR 1 — `execSync` import in `e2e/helm-chart-template.test.ts`

**Finding (false positive)**: The review claimed `execSync` was unused.

**Actual state**: `execSync` is used at lines 321, 455, 504, 514, 535, 554, 567, and 585. The import is correct. No change made.

### MINOR 2 — `GRANT CONNECT ON DATABASE kubeclaw` assertion (`container/postgres-mcp/server.test.ts`)

**Fix**: Added a new test case `'grants CONNECT ON DATABASE kubeclaw to the ro role'` in the `buildRoleBootstrapSql` describe block that asserts `sql.toMatch(/GRANT CONNECT ON DATABASE kubeclaw TO kubeclaw_ro/i)`.

### MINOR 3 — Both-keys idempotency in `ensureGroupDbCredentials` (`src/per-group-capabilities/provision-credentials.ts`)

**Finding**: If `POSTGRES_PASSWORD` existed but `PGPASSWORD` was absent (partial prior write), the function skipped the rw-password write path, leaving `PGPASSWORD` missing.

**Fix**: Now reads both `POSTGRES_PASSWORD` and `PGPASSWORD` in parallel. Only skips if BOTH are present. If either is missing: reads the existing `POSTGRES_PASSWORD` (if set) rather than generating a new one (avoids rotating a live password), then writes BOTH keys with that value.

**Tests added** (`src/per-group-capabilities/provision-credentials.test.ts`):
1. `'repairs a partial write where POSTGRES_PASSWORD exists but PGPASSWORD is absent'` — sets only `POSTGRES_PASSWORD`, calls `ensureGroupDbCredentials`, asserts both keys are present, equal, and `POSTGRES_PASSWORD` retains its original value (no rotation).
2. `'does not write rw password if both POSTGRES_PASSWORD and PGPASSWORD are already set'` — pre-populates both, calls `ensureGroupDbCredentials`, asserts values unchanged.

### Review fix test command and output

```
npx vitest run container/postgres-mcp/server.test.ts src/per-group-capabilities/provision-credentials.test.ts src/per-group-capabilities/reconciler.test.ts e2e/helm-chart-template.test.ts
→ 3 files (unit), 26 tests, all passed

npx tsc --noEmit
→ clean (no output)
```

Note: `e2e/helm-chart-template.test.ts` was included in the command but is excluded by the default vitest config (it runs under `vitest.e2e.config.ts`). The 3 unit test files all passed (26 tests). The e2e file has no changes that affect its test behavior (MINOR 1 was a false positive).
