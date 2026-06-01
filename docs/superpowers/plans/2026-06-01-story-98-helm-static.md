# Story 98: Helm chart `static checks` — lint + template render without errors

## Goal

Verify that `helm lint` and `helm template` succeed for every supported value combination in the chart, catching syntax errors and missing helpers before any Kubernetes cluster is involved.

## Architecture

The chart lives under `helm/kubeclaw/` and contains templates for every core resource class: namespace, secrets, network policies, PVCs, configmaps, RBAC objects, and the orchestrator Deployment. The `helm chart static checks` describe block in `e2e/helm-chart.test.ts` shells out directly to the `helm` CLI — running `helm lint helm/kubeclaw/` and `helm template helm/kubeclaw/ [--set ...]` — and then parses the rendered YAML with js-yaml to assert on resource kinds and field values. Because the tests call only `helm lint` and `helm template` (no `kubectl apply`), no live Kubernetes cluster is required.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- helm-chart -t "helm chart static checks"`)
- **Helm CLI:** `helm lint` and `helm template` (must be on PATH)
- **YAML parsing:** js-yaml — resources extracted by `kind` and `metadata.name` and asserted inline
- **LLM dependence:** none
- **Cluster dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/helm-chart.test.ts` | `describe('helm chart static checks', ...)` block (line 228) — 7 `it()` tests |
| `helm/kubeclaw/` | The chart directory (`Chart.yaml`, `values.yaml`, `templates/*.yaml`) |

## Tasks (retrospective)

### AC 1 — `helm lint` passes with zero errors

`helm lint helm/kubeclaw/` is run as a child process; the test asserts exit code 0 and that stdout does not contain `[ERROR]`. Warnings are tolerated.

### AC 2 — Default `helm template` renders valid YAML

`helm template helm/kubeclaw/` is run and its stdout is split on `---` and parsed with js-yaml. The test asserts no parse errors are thrown — confirming no nil-reference panics or template syntax failures in the default value set.

### AC 3 — Rendered output contains expected core resources

After parsing the default template output, the test asserts that the set of rendered `kind` values includes: `Deployment` (orchestrator), `Namespace`, `Secret`, `NetworkPolicy`, `PersistentVolumeClaim`, `ConfigMap`, `ServiceAccount`, `Role`, and `RoleBinding`.

### AC 4 — `imagePullPolicy` is `Always` when `image.registry` is set

`helm template` is called with `--set image.registry=registry.example.com`. The orchestrator `Deployment` is extracted and the test asserts `spec.template.spec.containers[0].imagePullPolicy == "Always"`.

### AC 5 — Secrets omitted when `existingSecret` is set

`helm template` is called with `--set existingSecret=my-existing-secret`. The test asserts no resource of kind `Secret` and name `kubeclaw-secrets` appears in the rendered output.

### AC 6 — NetworkPolicy omitted when `networkPolicy.enabled` is false

`helm template` is called with `--set networkPolicy.enabled=false`. The test asserts no `NetworkPolicy` resources appear in the output.

### AC 7 — `storageClassName` and `accessMode` overrides applied

Two separate `helm template` invocations assert: (a) setting `storage.storageClass=fast` injects `storageClassName: fast` into all PVC specs; (b) setting `storage.accessMode=ReadWriteMany` sets `accessModes: [ReadWriteMany]` on all group PVCs.

### Verification

Run: `npm run test:e2e -- helm-chart -t "helm chart static checks"`

Expected: **7 / 7 tests pass** — no Kubernetes cluster required, completes in under 30 seconds.
