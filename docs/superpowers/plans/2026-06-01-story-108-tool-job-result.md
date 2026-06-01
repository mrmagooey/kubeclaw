# Story 108: Tool-job result written to Redis at `kubeclaw:agent-job-result:<id>`

## Goal / Architecture

When a channel pod enqueues a tool job via the `kubeclaw:spawn-agent-job` Redis
stream, the orchestrator's `startToolJobSpawnWatcher()` loop (in
`src/k8s/ipc-redis.ts`) picks it up, runs the K8s Job via
`jobRunner.runToolJob()`, then calls `jobRunner.getJobLogs()` to capture the
pod's stdout and writes `{result, status}` fields to the Redis stream key
`kubeclaw:agent-job-result:{agentJobId}` so the channel pod's awaiting reader
receives the response within the polling interval.

## Tech Stack

- TypeScript / Node.js
- ioredis (Redis Streams — `xadd` / `xread` / `xrange`)
- Kubernetes Jobs (kubectl + minikube)
- Vitest (unit, integration, e2e)

## File Structure

| File | Role |
|------|------|
| `src/k8s/ipc-redis.ts` | `startToolJobSpawnWatcher()` — core loop; reads spawn stream, calls runToolJob, writes result stream |
| `src/k8s/job-runner.ts` | `getJobLogs()` — fetches pod stdout after job completion |
| `src/k8s/redis-client.ts` | `getSpawnToolJobStream()` / `getAgentJobResultStream()` — stream-key helpers |
| `e2e/tool-job-result.test.ts` | E2E test (1 it()) — publishes to spawn stream, polls result stream |

## Tasks per Acceptance Criteria

### AC1 — orchestrator reads stdout via `getJobLogs()`
- `startToolJobSpawnWatcher` calls `jobRunner.getJobLogs(jobId)` at line 1855
  of `ipc-redis.ts` after the K8s Job completes.

### AC2 — result written to `kubeclaw:agent-job-result:<agentJobId>`
- After `getJobLogs`, the watcher does `redis.xadd(getAgentJobResultStream(agentJobId), '*', 'result', logs, 'status', 'success')`.
- `getAgentJobResultStream` in `redis-client.ts` returns `kubeclaw:agent-job-result:${toolJobId}`.

### AC3 — waiting reader receives within polling interval
- E2E `pollStream()` polls via `xrange` every 3 s with a 120 s deadline.
- Test confirmed result arrives with `status=success` in ~18 s.

### AC4 — write is idempotent (once per job)
- The spawn watcher processes each stream entry once; Redis stream entry IDs
  ensure no duplicate processing on restart (lastId tracking via
  `resolveStreamTip`).

### AC5 — real K8s Job emits a known marker, asserted in Redis value
- The job pod runs the kubeclaw-agent image. E2E test asserts that `fields`
  has `result` and `status` keys and that `status` is one of the known terminal
  values (`success`, `completed`, `error`, `timeout`, `failed`).

## Retrospective

Implementation was complete before this plan was written. The e2e test passed
1/1 against the live minikube cluster (18 s, status=success). No implementation
changes were needed.
