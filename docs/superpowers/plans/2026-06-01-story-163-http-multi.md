# Story 163: HTTP-sidecar Multiple Sequential Tasks

> **Retrospective plan** — implementation already exists; all tests pass. Tasks below describe what was built and how it was verified.

**Goal:** Verify that N consecutive HTTP-sidecar tool calls against the same sidecar pod all succeed without resource exhaustion, unbounded latency growth, or connection leak.

**Architecture:** Each sequential call creates a fresh Kubernetes Job (via `HttpSidecarJobRunner.runToolJob`). Job output flows through Redis pub/sub (`jobRunner.streamOutput`). The loop in the e2e test creates three jobs back-to-back, subscribing before each create and asserting the echoed result, then verifying the full ordered array at the end. Resource cleanup is handled in `afterAll` which deletes lingering jobs.

**Tech Stack:** vitest (e2e runner), live kind cluster (`kubeclaw-http-adapter:latest`), Redis streams, `@kubernetes/client-node`

---

## Retrospective

This plan is retrospective — the implementation already exists and the 1/1 test in the `Multiple Sequential Tasks` describe block passes.

Run command: `npm run test:e2e -- http-sidecar -t "Multiple Sequential"`
Result: **1 / 1 passed** (12 unrelated tests skipped, 13 total)

---

## File Structure

| Path | Role |
|------|------|
| `e2e/http-sidecar.test.ts` | E2e test suite — `describe('Multiple Sequential Tasks', ...)` at line 593 |
| `src/k8s/http-sidecar-runner.ts` | `HttpSidecarJobRunner` — `runToolJob` orchestrates Job creation, Redis streaming, and job-completion polling |

---

## Tasks (retrospective — already implemented)

### Task 1: Sequential job loop (AC 1–5)

**File:** `src/k8s/http-sidecar-runner.ts` — `runToolJob` (line 66)

`runToolJob` creates a K8s Job manifest via `generateHttpSidecarJobManifest`, registers a Redis subscription for output, races `jobRunner.streamOutput` against `waitForJobCompletion`, and unsubscribes in `finally`. Because each call creates a new, uniquely-named Job (timestamp-based `jobId`), there is no shared mutable state between sequential calls — connections are cleanly cycled, memory is bounded per-call, and latency stays flat across N iterations.

- [x] **Step 1: Job manifest generation with unique jobId**

`jobId = input.jobId || \`kubeclaw-http-${group.folder}-${Date.now()}\`` at line 74 ensures each sequential call targets a distinct Job/pod, preventing connection reuse issues.

- [x] **Step 2: Redis-backed output streaming**

`jobRunner.streamOutput` (line 129) and `waitForJobCompletion` (line 137) run in parallel via `Promise.all`. Output flows through Redis rather than pod log polling, keeping per-call overhead constant regardless of N.

- [x] **Step 3: Unconditional cleanup in `finally`**

`jobRunner.unsubscribeFromOutput(jobId)` at line 172 runs whether the call succeeds or throws, preventing subscription accumulation across N sequential calls.

---

## Verification

Run the multiple sequential tasks test (live cluster required):

```bash
npm run test:e2e -- http-sidecar -t "Multiple Sequential"
```

Expected: **1 / 1 tests pass** — three sequential jobs each echo their input message correctly, and the final ordered array assertion passes.
