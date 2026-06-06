# Story 177 Implementation Plan: `remove_channel` deletes per-channel runtime PVCs

**Date:** 2026-06-06
**Story:** Story 177 — `remove_channel` deletes per-channel runtime PVCs
**Branch:** worktree-agent-ab672dd34d4536472

---

## Background

Story 174 introduced `bootstrapChannelFromSkill` which creates:
- `kubeclaw-channel-<instance>-runtime` PVC (labelled `kubeclaw-channel: <instanceName>`)
- `kubeclaw-bootstrap-<instance>` Job (labelled `kubeclaw-channel: <instanceName>`)

The existing `removeChannel` (Story 1) deleted PVCs by hardcoded name suffixes (`-groups`, `-store`, `-sessions`). The runtime PVC (`-runtime`) was not covered, causing orphaned PVCs after bootstrap-installed channel removal.

## Label conventions

Both `channel-setup.ts` (steady-state setup) and `bootstrap-runner.ts` (bootstrap) stamp:

```
kubeclaw-channel: <instanceName>
```

on PVCs, Secrets, Deployments, and Jobs they create. This label is the canonical key for label-based cleanup.

## Implementation

### Where the changes live

**`src/skills/orchestrator/channel-remove.ts`** — primary change file.

### What changes

1. **Add `BatchV1Api` to `getK8sClients()`** — needed for Job list/delete.

2. **Replace hardcoded PVC name loop** with:
   - `listPvcNamesByLabel(instanceName)` — calls `CoreV1Api.listNamespacedPersistentVolumeClaim` with `labelSelector: 'kubeclaw-channel=<instanceName>'`
   - Delete each returned PVC by name (same `tryDeletePvc` helper, now called per-item)

3. **Add Job cleanup (AC5)** via:
   - `listJobNamesByLabel(instanceName)` — calls `BatchV1Api.listNamespacedJob` with `labelSelector: 'kubeclaw-channel=<instanceName>'`
   - `tryDeleteJob(name)` — deletes each Job; NotFound → 'absent'

4. **Summary format** — unchanged (deleted/alreadyAbsent arrays, same string format).

5. **Empty label list** — when no labelled PVCs are found (legacy channel or fully absent), an "already absent" placeholder entry is added: `<no PVCs labelled kubeclaw-channel=<instanceName>>`.

### Idempotency

- All deletes wrapped in try/catch; NotFound silently swallowed (returns 'absent').
- `listPvcNamesByLabel` returns empty on no match → loop body skipped → second call is a no-op.
- `listJobNamesByLabel` returns empty on no match → no job deletes attempted.

### Backwards-compatibility

- Legacy channel with only a data PVC (pre-Story 174): label selector returns that one PVC, deletes it, completes normally (AC4).
- Channel with no PVCs at all: list returns empty, placeholder added to `alreadyAbsent`, no error.

### bootstrap-runner.ts — no changes needed

`src/k8s/bootstrap-runner.ts` already stamps `kubeclaw-channel: <instanceName>` on both the runtime PVC and the bootstrap Job (confirmed in Story 174 implementation). No modification required.

### channel-setup.ts — no changes needed

`src/skills/orchestrator/channel-setup.ts` already stamps `kubeclaw-channel: <instanceName>` on PVCs and Secrets (confirmed in Story 174 implementation). No modification required.

## Test plan

**File:** `src/skills/orchestrator/channel-remove.test.ts`

Mock `@kubernetes/client-node` with `MockBatchV1Api` in addition to existing mocks.

| AC | Test case | Mock setup |
|----|-----------|------------|
| AC1 | All 4 PVCs deleted by label | `listPvc` returns 4 items (groups, store, sessions, runtime) |
| AC1 | Label selector string is correct | Asserts `labelSelector: 'kubeclaw-channel=<instance>'` |
| AC2 | Summary names each PVC | `listPvc` returns 2 PVCs; asserts both in summary |
| AC2 | "Already absent" for 404 PVCs | `listPvc` returns 1 item; `deletePvc` throws 404 |
| AC2 | Absent placeholder when list empty | `listPvc` returns empty; placeholder in `alreadyAbsent` |
| AC3 | Second call is idempotent | All mocks return 404 / empty list |
| AC4 | Legacy data-PVC-only channel | `listPvc` returns 1 legacy item; completes without error |
| AC4 | Fully legacy (no PVCs at all) | `listPvc` returns empty; no crash |
| AC5 | Bootstrap Job deleted alongside runtime PVC | `listJob` returns 1 Job; `deleteJob` called |
| AC5 | Job label selector is correct | Asserts `labelSelector: 'kubeclaw-channel=<instance>'` |
| AC5 | Jobs appear in summary | `deleteJob` succeeds; job name in `result.deleted` |
| regression | Deployment + secret + labelled PVCs | All present and deleted |
| regression | Non-404 error propagates | `deleteDeployment` rejects with 500 |
| regression | Correct deployment/secret names | Named args assertion |

Total: **14 tests**, all green.

## Files changed

| File | Change |
|------|--------|
| `src/skills/orchestrator/channel-remove.ts` | Switch PVC deletion to label-based; add Job label-based deletion |
| `src/skills/orchestrator/channel-remove.test.ts` | Rewrite tests for Story 177 (14 tests covering all 5 ACs + regressions) |
| `src/skills/orchestrator/channel-setup.ts` | Copied from kubeclaw main (labels already stamped) |
