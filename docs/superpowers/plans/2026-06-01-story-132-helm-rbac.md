# Story 132: Helm Chart Namespace + RBAC + ConfigMaps

> **Retrospective plan** — implementation already exists; all tests pass. Tasks below describe what was built and how it was verified.

**Goal:** Verify the helm chart correctly renders a `Namespace` object with pod-security labels, RBAC objects (Role / RoleBinding / ClusterRoleBinding) with correct verbs, and ConfigMaps for the orchestrator runner wrappers — against a live minikube cluster.

**Architecture:** The chart delegates namespace creation to `--create-namespace` / pre-install `kubectl label`, so the Namespace itself is not a chart-managed resource. RBAC lives in two template files: `orchestrator.yaml` (ServiceAccount + Role `kubeclaw-job-manager` + RoleBinding `kubeclaw-orchestrator-binding`) and `credential-broker.yaml` (broker SA + Role + RoleBinding + ClusterRoleBinding `<release>-credential-broker-tokenreview`). ConfigMaps live in `configmaps.yaml` (`kubeclaw-runner-wrapper` and `kubeclaw-wrapper-script`).

**Tech Stack:** vitest (e2e runner), kubectl, helm, live minikube cluster (`requireKubernetes()`)

---

## Retrospective

This plan is retrospective — the implementation already exists and all 10/10 tests across the `namespace`, `configmaps`, and `RBAC` describe blocks pass.

Run command: `npm run test:e2e -- helm-chart -t "namespace|configmaps|RBAC"`
Result: **10 / 10 passed** (58 unrelated tests skipped, 68 total)

---

## File Structure

| Path | Role |
|------|------|
| `e2e/helm-chart.test.ts` | Full e2e test suite — `describe('namespace', ...)` (line 330), `describe('configmaps', ...)` (line 434), `describe('RBAC', ...)` (line 454) |
| `helm/kubeclaw/templates/orchestrator.yaml` | ServiceAccount `kubeclaw-orchestrator`, Role `kubeclaw-job-manager`, RoleBinding `kubeclaw-orchestrator-binding`, orchestrator Deployment |
| `helm/kubeclaw/templates/credential-broker.yaml` | ServiceAccount `kubeclaw-credential-broker`, Role + RoleBinding, ClusterRoleBinding `<release>-credential-broker-tokenreview` |
| `helm/kubeclaw/templates/configmaps.yaml` | ConfigMaps `kubeclaw-runner-wrapper` and `kubeclaw-wrapper-script` (runner-wrapper.sh shell script) |

---

## Tasks (retrospective — already implemented)

### Task 1: Namespace (AC 1)

**Files:**
- `e2e/helm-chart.test.ts` — `describe('namespace', ...)` at line 330

The chart no longer manages the `Namespace` resource directly. Instead, the `beforeAll` block pre-creates the namespace via `kubectl create namespace` then applies labels (`pod-security.kubernetes.io/enforce=privileged`, `pod-security.kubernetes.io/enforce-version=latest`) and helm ownership annotations. The namespace test then fetches the namespace object and asserts the label is present.

- [x] **Step 1: Pre-create namespace with pod-security label**

`kubectl label namespace kubeclaw-helm-test pod-security.kubernetes.io/enforce=privileged` applied in `beforeAll`.

- [x] **Step 2: Verify namespace exists with correct label**

```
npm run test:e2e -- helm-chart -t "namespace"
```

Expected: 1 / 1 PASS

---

### Task 2: ConfigMaps (AC 3)

**Files:**
- `helm/kubeclaw/templates/configmaps.yaml` — defines two ConfigMaps
- `e2e/helm-chart.test.ts` — `describe('configmaps', ...)` at line 434

`kubeclaw-runner-wrapper` is mounted at `/scripts` by the sidecar-job-runner. `kubeclaw-wrapper-script` is mounted at `/workspace/runner-wrapper.sh` by the file-sidecar-runner. Both contain the same `runner-wrapper.sh` shell script that polls `$KUBECLAW_INPUT_DIR` for task JSON files and writes results to `$KUBECLAW_OUTPUT_DIR`.

- [x] **Step 1: Render ConfigMaps in chart**

Both ConfigMaps defined in `helm/kubeclaw/templates/configmaps.yaml` with `namespace: {{ .Values.namespace }}`.

- [x] **Step 2: Verify ConfigMap keys**

```
npm run test:e2e -- helm-chart -t "configmaps"
```

Expected: 2 / 2 PASS — asserts `runner-wrapper.sh` key exists and contains `INPUT_DIR` / `OUTPUT_DIR` strings.

---

### Task 3: RBAC — ServiceAccount (AC 4)

**Files:**
- `helm/kubeclaw/templates/orchestrator.yaml` — `kind: ServiceAccount` at top of file
- `e2e/helm-chart.test.ts` — `it('kubeclaw-orchestrator ServiceAccount exists', ...)`

The orchestrator ServiceAccount is defined at the top of `orchestrator.yaml` in the chart namespace. The test verifies it is queryable via `kubectl get serviceaccount kubeclaw-orchestrator`.

- [x] **Step 1: Define ServiceAccount in chart**

`kubeclaw-orchestrator` ServiceAccount at `helm/kubeclaw/templates/orchestrator.yaml:1`.

- [x] **Step 2: Verify SA exists on cluster**

```
npm run test:e2e -- helm-chart -t "RBAC"
```

Expected: SA test PASS

---

### Task 4: RBAC — Role and RoleBinding (AC 2)

**Files:**
- `helm/kubeclaw/templates/orchestrator.yaml` — Role `kubeclaw-job-manager` + RoleBinding `kubeclaw-orchestrator-binding`
- `e2e/helm-chart.test.ts` — Role and RoleBinding `it()` tests

`kubeclaw-job-manager` grants: `batch/jobs` (create, get, list, watch, delete), `pods` + `pods/log` (get/list/watch), `secrets` (create/update/patch/delete/get/list), `deployments` + `deployments/scale`, `services`, `persistentvolumeclaims`, `ingresses`, `configmaps`.

The RoleBinding `kubeclaw-orchestrator-binding` ties the `kubeclaw-orchestrator` ServiceAccount to this Role.

Tests verify:
- Job CRUD verbs (create, get, list, delete) present in batch/jobs rule
- `pods/log` get verb present
- RoleBinding references `kubeclaw-job-manager` role and `kubeclaw-orchestrator` subject
- `kubectl auth can-i create jobs --as system:serviceaccount:<ns>:kubeclaw-orchestrator` returns `yes`
- `kubectl auth can-i delete namespaces --as ...` returns `no` (least-privilege)
- Orchestrator Role includes secret write verbs (create, update, patch, delete, get, list)

- [x] **Step 1: Define Role with correct rules**

`kubeclaw-job-manager` Role at `helm/kubeclaw/templates/orchestrator.yaml:10`.

- [x] **Step 2: Define RoleBinding**

`kubeclaw-orchestrator-binding` at `helm/kubeclaw/templates/orchestrator.yaml:57`.

- [x] **Step 3: Verify on cluster**

```
npm run test:e2e -- helm-chart -t "RBAC"
```

Expected: all 7 RBAC tests PASS

---

### Task 5: RBAC — Credential Broker (AC 2)

**Files:**
- `helm/kubeclaw/templates/credential-broker.yaml` — broker SA + Role + RoleBinding + ClusterRoleBinding
- `e2e/helm-chart.test.ts` — `it('broker Role widens to namespace-wide secrets...')`

The broker Role (`kubeclaw-credential-broker`) grants `get/list/watch` on `secrets` (namespace-wide, no `resourceNames` restriction) and `pods`. The ClusterRoleBinding `<release>-credential-broker-tokenreview` binds the broker SA to `system:auth-delegator` for TokenReview access (cluster-scoped). The CRB name is release-scoped to allow multiple chart installs to coexist.

- [x] **Step 1: Define broker Role without resourceNames restriction**

Accepted risk documented in `credential-broker.yaml` — broker needs to read dynamically-named per-group secrets.

- [x] **Step 2: Verify broker Role on cluster**

```
npm run test:e2e -- helm-chart -t "RBAC"
```

Expected: broker Role test PASS

---

## Verification

Run all namespace + configmaps + RBAC tests:

```bash
npm run test:e2e -- helm-chart -t "namespace|configmaps|RBAC"
```

Expected: **10 / 10 tests pass** — requires a live minikube cluster with helm chart pre-installed by the `beforeAll` harness.
