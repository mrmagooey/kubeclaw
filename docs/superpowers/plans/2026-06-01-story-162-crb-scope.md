# Story 162: Helm Chart ClusterRoleBinding Name is Release-Scoped

> **Retrospective plan** — implementation already exists; all tests pass. Tasks below describe what was built and how it was verified.

**Goal:** Ensure the credential broker's `ClusterRoleBinding` name includes the Helm release name so that two simultaneous chart installs on the same cluster never collide on this cluster-scoped resource.

**Architecture:** `ClusterRoleBinding` resources are cluster-scoped (not namespace-scoped), so two `helm install` invocations using the same static CRB name would conflict with "already exists". Fixing this requires templating the CRB name with `{{ .Release.Name }}`. The test is a pure `helm template` render — no cluster required.

**Tech Stack:** vitest (e2e runner), `helm template` (no cluster), `spawnSync`

---

## Retrospective

This plan is retrospective — the implementation already exists and all 2/2 tests in the `ClusterRoleBinding name is release-scoped (collision regression)` describe block pass.

Run command: `npm run test:e2e -- helm-chart -t "ClusterRoleBinding"`
Result: **2 / 2 passed** (66 unrelated tests skipped, 68 total)

---

## File Structure

| Path | Role |
|------|------|
| `e2e/helm-chart.test.ts` | E2e test suite — `describe('ClusterRoleBinding name is release-scoped (collision regression)', ...)` at line 797 |
| `helm/kubeclaw/templates/credential-broker.yaml` | CRB definition at line 59; name is `{{ .Release.Name }}-credential-broker-tokenreview` |

---

## Tasks (retrospective — already implemented)

### Task 1: Release-scope the CRB name (AC 1, 2, 3)

**File:** `helm/kubeclaw/templates/credential-broker.yaml` — `kind: ClusterRoleBinding` at line 59

The CRB name was changed from the static string `kubeclaw-credential-broker-tokenreview` to the templated value `{{ .Release.Name }}-credential-broker-tokenreview`. A comment was added above the CRB explaining the rationale:

```yaml
# TokenReview is cluster-scoped — minimum required cluster permission.
# Name is release-scoped so multiple Helm releases in different namespaces
# can coexist without colliding on this cluster-scoped resource.
```

- [x] **Step 1: Template CRB name with release name**

`name: {{ .Release.Name }}-credential-broker-tokenreview` at `helm/kubeclaw/templates/credential-broker.yaml:61`.

- [x] **Step 2: Verify single-release render**

```bash
npm run test:e2e -- helm-chart -t "ClusterRoleBinding"
```

Expected: `name: my-release-credential-broker-tokenreview` present, hardcoded `kubeclaw-credential-broker-tokenreview` absent.

- [x] **Step 3: Verify two-release render produces distinct CRB names**

```bash
npm run test:e2e -- helm-chart -t "ClusterRoleBinding"
```

Expected: `alpha-release-credential-broker-tokenreview` and `beta-release-credential-broker-tokenreview` are distinct — each release's output does not contain the other's CRB name.

---

## Verification

Run the ClusterRoleBinding scoping tests (helm template only — no cluster required):

```bash
npm run test:e2e -- helm-chart -t "ClusterRoleBinding"
```

Expected: **2 / 2 tests pass** — pure helm template render, no cluster access needed.
