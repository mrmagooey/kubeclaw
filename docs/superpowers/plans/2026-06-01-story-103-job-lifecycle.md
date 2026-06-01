# Story 103 — K8s `JobRunner` monitors job completion and retrieves logs

## Goal

Verify that `JobRunner.waitForJobCompletion()` correctly polls the Kubernetes API until `status.succeeded > 0`, that `getJobLogs()` retrieves pod stdout via `CoreV1Api.readNamespacedPodLog`, and that `waitForJobCompletion()` throws a `DeadlineExceededError` when a job's `activeDeadlineSeconds` is exceeded.

## Architecture

`JobRunner.waitForJobCompletion` (src/k8s/job-runner.ts:1305) polls `BatchV1Api.readNamespacedJob` every 5 seconds until `status.succeeded > 0` (return), `status.failed > 0` with reason `DeadlineExceeded` (throw `DeadlineExceededError`), or the caller-supplied timeout elapses (throw generic timeout error). `JobRunner.getJobLogs` (src/k8s/job-runner.ts:1471) queries `CoreV1Api.listNamespacedPod` with `labelSelector: job-name=<jobName>`, picks the first pod, and calls `CoreV1Api.readNamespacedPodLog` against the `agent` container. Both methods operate against real Kubernetes API endpoints — no mocks.

## Tech Stack

- Runtime: Node.js / TypeScript
- K8s client: `@kubernetes/client-node` (`BatchV1Api`, `CoreV1Api`)
- Test runner: Vitest (e2e config)
- Cluster: minikube (live, required)
- Test image: `kubeclaw-agent:latest` (loaded by global-setup)

## File Structure

| Path | Role |
|---|---|
| `e2e/job-lifecycle.test.ts` | E2E test — 3 `it()` blocks covering ACs 1–3 |
| `src/k8s/job-runner.ts` | Implementation — `waitForJobCompletion` (line 1305), `getJobLogs` (line 1471) |
| `e2e/setup.ts` | Shared helpers: `requireKubernetes()`, `getNamespace()` |
| `e2e/global-setup.ts` | Loads `kubeclaw-agent:latest` into minikube docker daemon |

## Tasks

### AC 1 — `waitForJobCompletion` detects success
- Create a Job (`kubeclaw-agent:latest`, command `echo <marker> && exit 0`)
- Call `waitForJobCompletion(jobName, 60_000)`; expect it to resolve without error
- Timeout guard: vitest test timeout 90 s

### AC 2 — `getJobLogs` retrieves pod stdout
- Create a Job with a distinct marker string
- `waitForJobCompletion` → `getJobLogs`
- Assert `logs.includes(marker)`

### AC 3 — `waitForJobCompletion` throws on `activeDeadlineSeconds` exceeded
- Create a Job (`sleep 300`, `activeDeadlineSeconds: 5`)
- Call `waitForJobCompletion(jobName, 30_000)`
- Expect rejection (Vitest `.rejects.toThrow()`)

### AC 4 — Real K8s Job (no fakes)
- Verified by test structure: `kubectl apply` creates the Job manifest; the K8s reconciler runs it
- No mock `Job` object anywhere in the test file

### AC 5 — Image loaded by global-setup
- `e2e/global-setup.ts` checks for and conditionally builds `kubeclaw-agent:latest` in the minikube daemon
- Test `beforeAll` verifies availability and skips gracefully if missing

### Verification

```
npm run test:e2e -- job-lifecycle
```

Expected: 3/3 passing.

## Retrospective

Implementation was pre-existing (Stories 43/46 already required `DeadlineExceededError` and `OOMKilledError` paths). Story 103 adds standalone e2e coverage over the polling and log-retrieval paths without any new production code. All three tests passed on first run (3/3, ~16 s wall time against live minikube).
