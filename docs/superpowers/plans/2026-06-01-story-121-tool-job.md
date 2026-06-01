# Story 121: Tool-job lifecycle — Job creation, pod execution, completion, cleanup

## Goal

Verify the full Kubernetes Job lifecycle for KubeClaw tool-jobs: valid Job manifests with the correct labels are created via the K8s API, their pods run to completion, and finished Jobs are cleaned up without resource leaks.

## Architecture

Job manifests are constructed by `JobRunner` in `src/k8s/job-runner.ts`, which wraps the `@kubernetes/client-node` `BatchV1Api` / `CoreV1Api`. `buildJobName()` generates deterministic Job names from a folder slug; resource limits, image references, and Redis credentials are pulled from `src/config.ts`. The e2e suite in `e2e/tool-job.test.ts` exercises the full lifecycle end-to-end against a live minikube cluster using raw `kubectl` calls rather than the TypeScript API, validating that the label schema (`app: kubeclaw-agent`, `type: tool-job`) and TTL-based cleanup policy are observable through the Kubernetes control plane.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- tool-job`)
- **Cluster:** real minikube, namespace `kubeclaw` (default from `getNamespace()`)
- **K8s client:** `kubectl` CLI (execSync) for manifest application and status inspection
- **Job cleanup:** `ttlSecondsAfterFinished` on Job spec; fallback `kubectl delete job`
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/tool-job.test.ts` | 9-test e2e suite (Templates / Creation / Execution / Completion / Cleanup) |
| `src/k8s/job-runner.ts` | `JobRunner` class — `buildJobName()`, job creation, watch/poll, cleanup |
| `src/config.ts` | Resource limits, image refs, namespace, TTL constants |
| `e2e/setup.ts` | `requireKubernetes()`, `getNamespace()` helpers |

## Tasks (retrospective)

### AC 1 — Valid Job templates with expected labels

`describe('Tool Job Templates')` contains two tests: one queries `kubectl get jobs -l type=tool-job -o json` and asserts the response has an `items` array (or falls back to verifying `kubectl auth can-i list jobs`); the second asserts `kubectl auth can-i create jobs --namespace=kubeclaw` returns `yes`. These confirm the label schema is recognised by the cluster and the service account has the required RBAC.

### AC 2 — Job Creation via K8s API

`describe('Job Creation')` applies a hand-crafted manifest with `kubectl apply` (labels `app: kubeclaw-agent`, `type: tool-job`, image `busybox`, command `echo hello`) and asserts the job appears in `kubectl get job`. A second test waits up to 30 s for `status.succeeded` to become `1`, confirming the pod ran to completion.

### AC 3 — Pod Execution

`describe('Job Pod Execution')` lists pods with `-l job-name=<jobName>` and asserts at least one pod is found. This validates that the scheduler placed a pod and it is observable through the pod API.

### AC 4 — Completion detection

`describe('Job Completion')` polls `kubectl get job -o jsonpath` for `status.succeeded >= 1` within a 60 s deadline and asserts the job completed successfully. A second test captures `kubectl logs` for the job pod and asserts the expected output (`hello`) is present.

### AC 5 — Cleanup

`describe('Job Cleanup')` verifies two cleanup paths: the TTL controller removes the job after `ttlSecondsAfterFinished: 10` (polling up to 30 s for the job to disappear from `kubectl get job`), and a separate test exercises manual deletion via `kubectl delete job --grace-period=0 --force` and confirms the job no longer exists.
