# /cancel Preemption + Channel Service Chart Fix — Design

**Date:** 2026-06-18
**Status:** Draft for review
**Origin:** Debugging the `cancel-command` e2e suite (Story 49) on minikube.

## Problem

The `cancel-command` e2e suite (`KUBECLAW_E2E_CANCEL=1`) fails. Investigation
on a live minikube cluster found four distinct issues:

1. **Harness uses a non-existent API.** The test POSTs
   `{content, sender, chat_jid}` to `/message` and reads SSE from that
   response. The real contract is `POST /message {text}` (returns JSON `{id}`)
   plus a separate SSE channel `GET /stream`. The wrong body 400s, so nothing
   dispatches ("No Running agent pod found"), and no SSE is ever read.

2. **NetworkPolicy blocks the mock LLM.** With `networkPolicy.enabled` (default
   true), the channel pod's egress policy blocks it from reaching the in-cluster
   `kubeclaw-mock-llm` Service. The mock receives zero requests; the LLM call
   times out; no tool job dispatches. The suite never disables netpol.

3. **Chart bug: channel Service is gated on `networkPolicy.enabled`.** In
   `helm/kubeclaw/templates/channel-pods.yaml`, the channel `Service` and the
   metrics `Service` are rendered *inside*
   `{{- if and $cfg.httpPort $.Values.networkPolicy.enabled }}`. Disabling
   networkPolicy — which the chart's own comment calls a safe troubleshooting
   toggle ("Disable to troubleshoot connectivity issues") — therefore **deletes
   the channel Service**, making the channel unreachable via its Service. The
   metrics Service is additionally mis-nested inside `{{- if $cfg.ingress }}`, so
   it only renders when an ingress is configured. This is a real deployment
   defect, independent of the test.

4. **`/cancel` cannot preempt a running tool job.** `/cancel` is processed by
   the per-group message loop in `channel-runner.ts`. But `execute_agent` runs
   `await executeToolJob(...)`, which **blocks that loop** until the agent job
   finishes (it block-reads the job's Redis result stream). A `/cancel` message
   sent afterwards sits in the queue unprocessed, so the channel never sends the
   `job.cancel` IPC. Story 49 AC1 ("`/cancel` returns 'Cancelled' within 5 s
   while a job runs") cannot hold. Confirmed via live logs: the queued `/cancel`
   was never processed while the agent ran.

**Decision (user):** treat #4 as a product bug — make `/cancel` actually preempt
a running tool job — rather than re-scoping the test to `DELETE /jobs/<id>`.

## What already works (no change needed)

The orchestrator side of cancellation is already complete
(`src/k8s/ipc-redis.ts`, `job.cancel` group-level path):

- Finds the active K8s job for the group (`activeAgentJobsByGroup`).
- `jobRunner.stopJob(jobName)` deletes the job (cascade-deletes the pod).
- Publishes a `"Cancelled"` notice to the group's output channel → SSE.
- Writes the cancel result to the caller's result stream.

When the job is deleted, the spawn handler's `runToolJob().then/.catch`
(ipc-redis.ts:1242+) writes the job's result stream, which **unblocks the
channel's `executeToolJob`** — so the message loop frees up for the next
message. (The implementation must verify `waitForJobCompletion` returns on
deletion; if it can hang, add explicit handling so the result stream is always
written on cancel.)

The single missing link is: **the channel never sends the `job.cancel` IPC
because `/cancel` is stuck behind the blocked turn.**

## Design

### Component A — Chart fix (independent, ship first)

`helm/kubeclaw/templates/channel-pods.yaml`: restructure the post-Deployment
block so:

- The ingress **NetworkPolicy** stays gated on
  `{{- if and $cfg.httpPort $.Values.networkPolicy.enabled }}`.
- The channel **Service** renders whenever `$cfg.httpPort` is set, regardless of
  `networkPolicy.enabled`.
- The **Ingress** stays gated on `$cfg.httpPort` + `$cfg.ingress.enabled`.
- The metrics **Service** renders for the channel unconditionally (it is no
  longer nested inside the ingress conditional), matching the always-present
  metrics container port.

Add/extend helm static tests (the repo has
`refactor/extract-helm-template-static-tests` patterns / `helm template`
assertions) to assert: with `networkPolicy.enabled=false` and an http channel,
the `kubeclaw-channel-<name>` Service and `-metrics` Service still render, and
the ingress NetworkPolicy does not.

### Component B — Out-of-band `/cancel` in the HTTP channel

In `src/channels/http.ts`, the `POST /message` handler (JSON path), before
calling `handleInbound`, detect `isCancelCommand(text)`. When matched, handle it
out-of-band instead of queueing:

- Resolve `jid = http:<username>`, `groupFolder = registeredGroups()[jid]?.folder
  ?? jid` (same resolution as `/jobs`).
- Call a `cancelGroupJobFn(groupFolder, chatJid)` that sends the group-level
  `job.cancel` IPC (no `jobId`) and awaits the result — same envelope as
  `channel-runner.ts buildCancelFn()` / the existing `killJobFn` pattern, lazy
  Redis import, injectable for unit tests.
- Return `200 {id}` to the POST as usual (the user-facing reply arrives on SSE).

This bypasses the per-group message loop entirely, so `/cancel` is actioned
immediately even while a turn is blocked in `executeToolJob`.

**Reply delivery / de-duplication.** The orchestrator already publishes
`"Cancelled"` to SSE on a successful group cancel. To avoid a double reply, the
HTTP out-of-band handler must NOT also send `"Cancelled"`; it only emits the
user-facing reply for the `no_active_job` result (`"No active job"`), which the
orchestrator does not publish. (Audit the existing channel-runner queued path
for the same potential double-send and align both on a single source of the
notice.)

**Scope.** This change is HTTP-channel-specific (the boundary where the e2e and
real web clients enter). Other channels keep the existing queued `/cancel` path;
making preemption fully channel-agnostic (priority handling in the shared loop)
is explicitly out of scope here — call it out as future work.

### Component C — Test harness rewrite (`e2e/cancel-command.test.ts`)

Rewrite against the real contract, following the passing `concurrent-sse.test.ts`
pattern:

- Helpers: `openSse(user,pass)` → `GET /stream`, collect `data:` lines;
  `postMessage(user,pass,text)` → `POST /message {text}`.
- `setupTestCluster` with `extraSet` including
  `secrets.openaiBaseUrl=http://kubeclaw-mock-llm.<ns>.svc:11434/v1` **and**
  `networkPolicy.enabled=false` (now safe because of Component A; the channel
  Service survives, and the channel can reach the mock).
- AC1: queue `execute_agent` on the mock → `postMessage(slow task)` → wait for
  `app=kubeclaw-agent` pod Running → `postMessage('/cancel')` → assert SSE
  contains `Cancelled` within 5 s.
- AC2: within 30 s, no `app=kubeclaw-agent` pod Running.
- AC3: after cancel, a subsequent `postMessage` dispatches (the loop unblocked).
- AC4: `/cancel` with no active job → SSE contains `No active job`.

### Component D — Tests at three levels

- **Unit:** the `/cancel` out-of-band branch in `http.ts` with an injected
  `cancelGroupJobFn` — asserts it is called with the right group/chat, is NOT
  queued (handleInbound not invoked), and that `no_active_job` produces a
  `"No active job"` SSE reply while `cancelled` produces no duplicate.
  (`handleCancelCommand` itself is already unit-covered.)
- **Integration:** the orchestrator `job.cancel` group path preempts and writes
  the tool-job result stream so a blocked `executeToolJob` unblocks (extend
  existing ipc-redis / job-runner integration tests).
- **E2E:** Component C, run green on minikube.

## Risks / open items

- Verify `waitForJobCompletion` returns promptly when a running job is deleted
  (so `executeToolJob` unblocks for AC3). If it can hang, the orchestrator
  `job.cancel` handler must explicitly write the agent job's result stream on
  cancel (it currently writes only the *cancel* result stream). This requires
  mapping `groupFolder → agentJobId`; today only `groupFolder → jobName` is
  tracked.
- Confirm no double `"Cancelled"` reply across the orchestrator notice and any
  channel-side send (both HTTP out-of-band and the channel-runner queued path).
- minikube e2e build: Component A/B change `src/`, so `global-setup.ts` (now
  rebuilds on source change, per the prune fix) will rebuild the orchestrator
  image automatically.
