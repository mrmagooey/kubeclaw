# Story 117: Tool-server idle timeout — pod exits cleanly when no calls arrive

## Goal

Verify that a tool-server pod calls `process.exit(0)` when its idle timer fires and no tool calls have arrived within the configured window, causing the K8s Job to reach `status.succeeded > 0` rather than being killed by the K8s `activeDeadlineSeconds` deadline.

## Architecture

`container/agent-runner/src/tool-server.ts` reads `IDLE_TIMEOUT` from the environment (defaulting to 30 minutes). On startup it calls `resetIdleTimer()`, which arms a `setTimeout` for `idleTimeout` milliseconds. Each received tool-call message resets the timer. If the timer fires without any message arriving, `process.exit(0)` is called, completing the K8s Job cleanly. The orchestrator maps the `timeout` field from the Redis spawn-stream entry to this env var when creating the Job. Tests publish a spawn message with `timeout=20000` (20s) and make no tool calls, then poll `kubectl get jobs` until the Job becomes terminal.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- tool-server-idle-timeout`)
- **Cluster:** real minikube, namespace from `getNamespace()`
- **Redis:** shared Redis client from `getSharedRedis()` — publishes spawn-stream entries
- **K8s polling:** `kubectl get jobs` via `spawnSync`, polling every 3 s up to 60 s
- **LLM dependence:** none

## File Structure

| File | Role |
|---|---|
| `e2e/tool-server-idle-timeout.test.ts` | E2E test suite (2 `it()` blocks) |
| `container/agent-runner/src/tool-server.ts` | Idle-timeout handler (`resetIdleTimer`, `process.exit(0)`) |
| `e2e/setup.ts` | `requireKubernetes`, `getSharedRedis`, `getNamespace` helpers |

## Tasks per AC

| AC | Verification |
|---|---|
| AC1 — exits on idle | Test 1 publishes a spawn with `timeout=20000`, makes no calls, polls until job terminal |
| AC2 — `succeeded > 0` | Test asserts `status.succeeded > 0`; logs "exited cleanly via idle timeout" |
| AC3 — exits exactly once | Single `setTimeout` per `resetIdleTimer` call; old timer cleared before new one set |
| AC4 — exit code 0 | `process.exit(0)` in the idle handler; K8s records succeeded (not failed) |
| AC5 — deterministic | Test 2 spawns a second pod and verifies the K8s Job is created within the expected window |

## Retrospective

Implementation was already present in `container/agent-runner/src/tool-server.ts` before this story was promoted. The idle-timer logic (`resetIdleTimer` / `setTimeout` / `process.exit(0)`) satisfies all five ACs directly. The e2e tests were written to match the existing behavior: Test 1 waits for the job to reach a terminal state within 3× the timeout (60 s), and Test 2 verifies the Job object is created and running (will self-terminate later). No implementation changes were required; the story needed documentation and test promotion only.
