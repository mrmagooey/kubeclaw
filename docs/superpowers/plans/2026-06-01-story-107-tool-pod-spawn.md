# Story 107: Tool-pod spawn watcher creates the right K8s Job for each spawn type — retrospective plan

**Goal:** Verify that `startToolPodSpawnWatcher()` in `src/k8s/ipc-redis.ts` correctly consumes messages from the `kubeclaw:spawn-tool-pod` Redis stream and delegates to `jobRunner.createToolPodJob()` (standard) or `jobRunner.createSidecarToolPodJob()` (sidecar/file) in `src/k8s/job-runner.ts`, producing K8s Jobs with the correct labels, containers, and volumes. All three acceptance criteria are covered by the three `it()` tests in `e2e/tool-pod-spawn.test.ts`.

**Architecture:** The orchestrator calls `startToolPodSpawnWatcher()` at startup (wired in `src/index.ts:594`). The watcher opens a dedicated Redis connection via `createStreamWatcherClient()` and enters a blocking `XREAD` loop on `kubeclaw:spawn-tool-pod`, tracking `lastId` incrementally (seeded via `resolveStreamTip()` to avoid the `$`-race). Each message carries `agentJobId`, `groupFolder`, `category`, `timeout`, and optionally `toolImage`/`toolPattern`/`toolPort`. When `toolImage` is absent the watcher calls `createToolPodJob()` which builds a single-container Job (`app=kubeclaw-tool-pod`); when `toolImage` is present it calls `createSidecarToolPodJob()` which builds a two-container Job (`kubeclaw-tool-bridge` + `user-tool`, label `app=kubeclaw-sidecar-tool`), adding an `emptyDir` shared volume when `toolPattern=file`. Both paths create the Job in `this.namespace` (the orchestrator's namespace) and are naturally idempotent on retry because the Job name is derived from `groupFolder + category` (standard) or a truncated `agentJobId` suffix + tool name (sidecar).

**Tech Stack:** TypeScript (orchestrator), ioredis (`XREAD BLOCK`), `@kubernetes/client-node` batch API (`createNamespacedJob`), vitest (e2e), live minikube cluster + helm chart (`npm run test:e2e`).

---

## File structure

```
src/k8s/ipc-redis.ts
  resolveStreamTip()            # seeds lastId from xrevrange to avoid $ race
  startToolPodSpawnWatcher()    # XREAD loop; dispatches to jobRunner

src/k8s/job-runner.ts
  createToolPodJob()            # single-container Job, label app=kubeclaw-tool-pod
  createSidecarToolPodJob()     # two-container Job, label app=kubeclaw-sidecar-tool
                                # + emptyDir volume when pattern=file

src/k8s/redis-client.ts
  getSpawnToolPodStream()       # returns 'kubeclaw:spawn-tool-pod'

src/index.ts                    # calls startToolPodSpawnWatcher() at line 594

e2e/
  tool-pod-spawn.test.ts        # 3 it() tests covering ACs 1–5
```

---

## Tasks per acceptance criterion

- [x] **AC1 — standard spawn creates single-container Job (app=kubeclaw-tool-pod)**
  - Message without `toolImage` dispatches to `createToolPodJob()`.
  - Job has exactly one container (`tool-server`), label `app=kubeclaw-tool-pod`, and `kubeclaw/agent-job=<agentJobId>`.
  - e2e test: xadd without `toolImage`; `pollForJob('app=kubeclaw-tool-pod,kubeclaw/agent-job=<id>')` resolves; asserts `containers.length === 1`, `KUBECLAW_TOOL_JOB_ID`, `KUBECLAW_CATEGORY`.

- [x] **AC2 — sidecar spawn creates two-container Job (app=kubeclaw-sidecar-tool)**
  - Message with `toolImage` dispatches to `createSidecarToolPodJob()`.
  - Job has two containers: `kubeclaw-tool-bridge` (bridge image) and `user-tool` (toolImage).
  - Bridge env includes `KUBECLAW_TOOL_MODE=http-bridge`, `KUBECLAW_CATEGORY`, `KUBECLAW_TOOL_JOB_ID`.
  - e2e test: xadd with `toolImage=alpine:latest`, `toolPattern=http`; asserts container names and bridge env vars.

- [x] **AC3 — file-pattern sidecar includes shared emptyDir volume**
  - `createSidecarToolPodJob()` detects `pattern=file`, pushes `{ name: 'shared', emptyDir: {} }` to volumes and mounts it in both containers at `/shared`.
  - Bridge env sets `KUBECLAW_TOOL_MODE=file-bridge`.
  - e2e test: xadd with `toolPattern=file`; asserts `volumes` contains `{ name: 'shared', emptyDir: {} }` and `KUBECLAW_TOOL_MODE=file-bridge`.

- [x] **AC4 — Jobs created in orchestrator's namespace, idempotent on retry**
  - Both job builders pass `namespace: this.namespace` to `createNamespacedJob`.
  - Standard job name: `buildJobName(groupFolder + '-' + category)` (deterministic from input).
  - Sidecar job name: `kubeclaw-stool-<agentId[-8:]>-<safeTool>` (deterministic from input).
  - Errors from `createNamespacedJob` are caught and logged; the loop continues.

- [x] **AC5 — watcher polls Redis stream incrementally**
  - `resolveStreamTip()` seeds `lastId` from `xrevrange` before the loop begins.
  - Each processed message updates `lastId = id`, so the next `XREAD` starts from the right offset.
  - Tests trim the stream (`redis.del`) and wait 6 s before publishing to avoid the lastId race.

---

## Retrospective

Implementation was complete before this plan was written. All three e2e tests passed on first run (3/3) against a live minikube cluster with the helm chart deployed. No gaps found.
