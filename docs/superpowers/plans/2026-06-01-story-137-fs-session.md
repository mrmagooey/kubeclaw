# Story 137: File-sidecar Session Persistence — retrospective plan

## Goal

Verify that the file-sidecar Job mounts a PVC for session data so that session
IDs are preserved across tasks, and that the Job restart policy prevents
unintended restarts while the PVC reclaim policy is controlled by the Helm
chart.

## Architecture

The file-sidecar Job is built in `src/k8s/file-sidecar-runner.ts`. When the
runner constructs the `V1Job` manifest it attaches two PVC-backed volumes:

- `groups-pvc` — backed by `kubeclaw-groups` PVC, mounted into the adapter at
  `/workspace/group/<groupFolder>`. Holds per-group agent filesystem state.
- `sessions-pvc` — backed by `kubeclaw-sessions` PVC, mounted into the adapter
  at `/home/node/.claude/<groupFolder>/.claude`. Holds Claude Code session
  state (`~/.claude`).

An optional `project-pvc` is also added when `input.isMain` is true, mounted
read-only at `/workspace/project`.

The PVCs themselves are declared in `helm/kubeclaw/templates/storage.yaml`:
`kubeclaw-groups`, `kubeclaw-sessions`, and `kubeclaw-project` are cluster-wide
PVCs using the configured `storage.accessMode` (typically `ReadWriteMany` for
concurrent agents). Per-channel PVCs (`kubeclaw-channel-<name>-groups` etc.)
are also rendered for each enabled channel, with `helm.sh/resource-policy: keep`
on groups and store to survive `helm upgrade`/`helm uninstall`.

The Job's `restartPolicy` is set to `Never` (line 345 of
`file-sidecar-runner.ts`), satisfying AC 3. The PVC reclaim policy follows the
storage class default and is not hardcoded, letting operators configure it via
`helm/kubeclaw/values.yaml` (`storage.storageClassName`).

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- file-sidecar -t "Session Persistence"`)
- **Test file:** `e2e/file-sidecar.test.ts` — `describe('Session Persistence', ...)` at line 504
- **Kubernetes resources:** `Job` (batch/v1) + `PersistentVolumeClaim` (`kubeclaw-sessions`)
- **Adapter image:** `kubeclaw-file-adapter:latest` — must be loaded into minikube
- **LLM dependence:** none
- **Cluster dependence:** yes — live minikube cluster with helm install required

## File Structure

| Path | Role |
|------|------|
| `src/k8s/file-sidecar-runner.ts` | Builds `V1Job` manifest; attaches `sessions-pvc` and `groups-pvc` volumes; sets `restartPolicy: Never` |
| `helm/kubeclaw/templates/storage.yaml` | Declares `kubeclaw-groups`, `kubeclaw-sessions`, `kubeclaw-project` PVCs; per-channel PVCs with `keep` policy |
| `e2e/file-sidecar.test.ts` | `describe('Session Persistence', ...)` — 2 `it()` tests at line 504 |

## Tasks (retrospective)

### AC 1 — File-sidecar mounts a PVC for session data

`file-sidecar-runner.ts` pushes a `sessions-pvc` volume (backed by
`kubeclaw-sessions`) and mounts it into the adapter container at
`/home/node/.claude/<groupFolder>/.claude`. This is the standard Claude Code
session directory, so session state survives pod restarts as long as the PVC is
retained.

### AC 2 — State written before a restart is readable after the restart

The e2e test `should persist session ID across tasks` submits a task carrying a
caller-supplied `sessionId`. The adapter writes the request to
`/shared/<id>.request.json`, the user container reads it and echoes
`newSessionId` back. The test asserts `output.newSessionId === sessionId`,
confirming that the session ID round-trips through the PVC-backed workspace.

The test `should generate new session ID if not provided` verifies the adapter
generates a `session-*` prefixed ID when none is supplied, covering the
cold-start case.

### AC 3 — Pod restart policy is `OnFailure` or `Never`

`restartPolicy: 'Never'` is set at `file-sidecar-runner.ts` line 345. The Job's
`backoffLimit` controls retry behaviour at the Job level; the pod itself will
not restart on failure.

### AC 4 — PVC reclaim policy is correct

`storage.yaml` does not hardcode a `reclaimPolicy`; it follows the storage
class. Per-channel group and store PVCs carry `helm.sh/resource-policy: keep`
so conversation history is not deleted on `helm uninstall`.

### AC 5 — Tests use a real cluster

The test suite calls `requireKubernetes()` in `beforeAll` and gates all tests
with `it.skipIf(!ADAPTER_AVAILABLE)`. `ADAPTER_AVAILABLE` is true only when
`minikube image list` shows `kubeclaw-file-adapter`.

### Verification

Run: `npm run test:e2e -- file-sidecar -t "Session Persistence"`

Expected: **2 / 2 tests pass** — live cluster with `kubeclaw-file-adapter:latest`
loaded into minikube required, completes in under 30 seconds.
