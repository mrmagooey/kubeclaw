# Story 175: Bootstrap timeout atomically cleans up the partial channel install

**Date:** 2026-06-06  
**Status:** Implementation plan

## 1. Overview

Story 175 adds the orchestrator-side cleanup path for bootstrap Jobs that expire
via Kubernetes `activeDeadlineSeconds`. When the Job deadline fires because the
admin abandoned the dialogue, the orchestrator must:

1. Delete the K8s Job (idempotent — NotFound OK).
2. Delete the runtime PVC (idempotent).
3. Defensively delete any partial Secret (idempotent).
4. Publish a `{ type: 'timeout', text: '...' }` SSE message to `kubeclaw:bootstrap:<bootstrapJobId>`.
5. Free the `instanceName` from `activeBootstraps` so a retry succeeds.
6. On orchestrator restart: reconcile orphaned bootstrap Jobs via `reconcileOrphanedBootstrapsOnStartup`.

## 2. Files to touch

### New additions to `src/k8s/bootstrap-runner.ts`

All Story 175 logic lives here, reusing the existing dep-injection pattern.

**`cleanupBootstrapResources(bootstrapJobId, instanceName, deps, opts)`**

- `deps` — `CleanupBootstrapDeps` interface:
  ```ts
  interface CleanupBootstrapDeps {
    deleteJob(jobName: string): Promise<void>;
    deletePvc(pvcName: string): Promise<void>;
    deleteSecret(secretName: string): Promise<void>;
    publishSse(topic: string, payload: { type: string; text: string }): Promise<void>;
    activeBootstraps: Map<string, string>;
  }
  ```
- Steps (each in independent try/catch; warn on non-NotFound errors):
  1. `deleteJob('kubeclaw-bootstrap-<instanceName>')`
  2. `deletePvc('kubeclaw-channel-<instanceName>-runtime')`
  3. `deleteSecret('kubeclaw-channel-<instanceName>-credentials')`
  4. `publishSse('kubeclaw:bootstrap:<bootstrapJobId>', { type: 'timeout', text: '...' })`
  5. `activeBootstraps.delete(instanceName)` — always runs, regardless of prior failures.

**`waitForBootstrapJobCompletion(instanceName, bootstrapJobId, deps, opts)`**

- New function. Wraps `waitForJobCompletion` (from `job-runner.ts` `JobRunner` class) but:
  - Does NOT use `JobRunner` class directly — instead injects a `waitForJob` callback to keep the module testable.
  - Accepts `timeoutMs = (BOOTSTRAP_SKILL_TIMEOUT_SECONDS + 60) * 1000` (60 s grace period above the K8s deadline for condition propagation latency; documented in code).
  - Detects `DeadlineExceeded` by catching errors where the message contains "DeadlineExceeded".
  - On `DeadlineExceeded`: calls `cleanupBootstrapResources`.
  - On success or other failure: logs and returns.

**`reconcileOrphanedBootstrapsOnStartup(deps)`**

- Pattern exactly mirrors `reconcileOrphanedJobsOnStartup` in `orphan-jobs.ts`.
- `ReconcileOrphanedBootstrapsDeps` interface:
  ```ts
  interface ReconcileOrphanedBootstrapsDeps {
    /** List failed bootstrap Jobs with kubeclaw.io/role=bootstrap label */
    listFailedBootstrapJobs(): Promise<FailedBootstrapJob[]>;
    cleanup: CleanupBootstrapDeps;
    timeoutMs?: number; // default 30_000
  }
  interface FailedBootstrapJob {
    jobName: string;
    instanceName: string;  // from 'kubeclaw-channel' label
    bootstrapJobId: string; // from 'kubeclaw.io/bootstrap-job-id' label
    failureReason: string;  // 'DeadlineExceeded' or other
  }
  ```
- Bounded by `timeoutMs` deadline loop (same pattern as `orphan-jobs.ts`).
- For each orphan with `failureReason=DeadlineExceeded` (or any Failed): calls `cleanupBootstrapResources`.
- Idempotent: `cleanupBootstrapResources` uses try/catch; NotFound is silently swallowed.

### `src/k8s/bootstrap-runner.ts` — minor extensions

- Export `CleanupBootstrapDeps`, `ReconcileOrphanedBootstrapsDeps`, `FailedBootstrapJob` types.
- Export `cleanupBootstrapResources`, `waitForBootstrapJobCompletion`, `reconcileOrphanedBootstrapsOnStartup`.

### `src/index.ts`

- Import `reconcileOrphanedBootstrapsOnStartup`.
- Wire `listFailedBootstrapJobs` using `BatchV1Api.listNamespacedJob` with label selector `kubeclaw.io/role=bootstrap` + filter for `status.conditions[].type=Failed`.
- Call `reconcileOrphanedBootstrapsOnStartup(...)` in the startup sequence (after `registerBootstrapDeps`).

### New test files

- **`src/k8s/bootstrap-runner.test.ts`** — EXTEND (already exists from Story 174).
  - `cleanupBootstrapResources` unit tests:
    - All three K8s deletes called in order.
    - SSE publish called with correct topic and payload.
    - `activeBootstraps` entry removed.
    - NotFound errors are swallowed (delete is idempotent).
    - Non-NotFound errors logged at warn but cleanup continues.
    - `activeBootstraps` entry removed even when all deletions fail.
  - `waitForBootstrapJobCompletion` unit tests:
    - Calls cleanup on DeadlineExceeded.
    - Does NOT call cleanup on success.
    - Passes correct `timeoutMs` (BOOTSTRAP_SKILL_TIMEOUT_SECONDS + 60) * 1000.

- **`src/k8s/bootstrap-runner.integration.test.ts`** — EXTEND (already exists from Story 174).
  - `reconcileOrphanedBootstrapsOnStartup` integration tests:
    - With a pre-canned failed Job (reason=DeadlineExceeded): cleanup called, map cleared.
    - With an already-absent instance (cleanup deps return NotFound): no error.
    - With non-DeadlineExceeded failure: cleanup still called (defensive).
    - Respects `timeoutMs` deadline.

- **`e2e/minikube-live-bootstrap-timeout.test.ts`** — NEW.
  - Pattern after `e2e/minikube-live-admin-shell.test.ts`.
  - Uses `BOOTSTRAP_SKILL_TIMEOUT_SECONDS=60` (via helm `--set`).
  - Scenario: call `bootstrap_channel_from_skill`, subscribe to SSE, don't respond, wait for timeout SSE, verify PVC/Job deleted, verify retry succeeds.

## 3. `BOOTSTRAP_SKILL_TIMEOUT_SECONDS` (AC5) arithmetic

```
timeoutMs = (BOOTSTRAP_SKILL_TIMEOUT_SECONDS + 60) * 1000
```

The K8s Job's `activeDeadlineSeconds` = `BOOTSTRAP_SKILL_TIMEOUT_SECONDS`.  
K8s fires the condition within seconds of the deadline.  
The orchestrator polls every 5 s.  
The 60 s grace period is ample time for K8s to propagate the condition before the orchestrator's own poll loop times out.

With the test override `BOOTSTRAP_SKILL_TIMEOUT_SECONDS=60`:  
- Job deadline fires at 60 s.  
- Orchestrator polls for up to 120 s.  
- The `DeadlineExceeded` condition is observed well within 120 s.

## 4. Implementation approach for `waitForBootstrapJobCompletion`

Rather than calling `JobRunner.waitForJobCompletion` directly (which embeds K8s polling), we:

1. Accept an injectable `waitForJob(jobName: string, timeoutMs: number): Promise<void>` callback.
2. In production (index.ts wiring), the callback delegates to `jobRunner.waitForJobCompletion(jobName, timeoutMs)`.
3. In tests, the callback is a vi.fn() that rejects with "DeadlineExceeded: ..." to simulate the timeout.

This keeps `bootstrap-runner.ts` independently testable without a real cluster.

## 5. Key design decisions

- **NotFound swallowing**: Each delete step checks if the error is a 404/NotFound variant and calls `logger.debug` if so, `logger.warn` for other errors. This matches the pattern in `job-runner.ts#stopJob`.
- **SSE publish is best-effort**: Wrapped in its own try/catch; failure is logged at warn but does not prevent `activeBootstraps.delete`.
- **`activeBootstraps.delete` is unconditional**: Called in a `finally`-equivalent block (sequential after all steps, regardless of prior failures).
- **No new Redis subscriber**: The SSE publish uses `getRedisClient().publish(topic, JSON.stringify(payload))` — same mechanism as Story 174's `publishSse`.
- **`reconcileOrphanedBootstrapsOnStartup` does NOT populate `activeBootstraps`**: It only cleans up. The map is empty on startup; orphan cleanup doesn't re-add entries.

## 6. Test surfaces summary

| AC | Unit tests | Integration tests | E2E tests |
|----|-----------|-------------------|-----------|
| AC1: cleanupBootstrapResources | bootstrap-runner.test.ts | bootstrap-runner.integration.test.ts | e2e (implicitly) |
| AC2: SSE timeout notice | bootstrap-runner.test.ts | bootstrap-runner.integration.test.ts | minikube-live-bootstrap-timeout.test.ts |
| AC3: instance freed | bootstrap-runner.test.ts | bootstrap-runner.integration.test.ts | minikube-live-bootstrap-timeout.test.ts |
| AC4: orphan reconcile | bootstrap-runner.test.ts | bootstrap-runner.integration.test.ts | N/A (integration sufficient) |
| AC5: BOOTSTRAP_SKILL_TIMEOUT_SECONDS | bootstrap-runner.test.ts | — | minikube-live-bootstrap-timeout.test.ts |
