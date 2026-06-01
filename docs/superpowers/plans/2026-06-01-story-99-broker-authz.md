# Story 99: Credential broker pod is Ready and rejects unauthenticated `/authz` requests

## Goal

Verify that the credential-broker pod becomes Ready after a helm install with credential-injection enabled, and that its `/authz` endpoint returns HTTP 401 for requests without a Bearer token.

## Architecture

`src/index.ts` contains a `KUBECLAW_MODE` dispatcher: when the env var is set to `credential-broker`, it dynamically imports and starts `src/credential-broker/index.ts` (the broker entrypoint) instead of the orchestrator process. The broker's `ext-authz.ts` handler implements the `/authz` Envoy external-authorisation endpoint and enforces Bearer-token authentication, returning 401 for unauthenticated requests. The e2e test in `e2e/credential-broker.test.ts` re-tags the `kubeclaw-orchestrator:latest` image already loaded by global-setup into the minikube docker daemon, helm-installs into an isolated namespace, waits for the deployment rollout, then runs a `curlimages/curl` pod inside the cluster to hit the broker's ClusterIP service directly — no port-forward required.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster:** real minikube, namespace `kubeclaw-e2e-broker`
- **Image build:** `docker tag` inside `eval $(minikube docker-env)` (re-tags existing image, avoids concurrent BuildKit races)
- **Helm:** `helm upgrade --install` with `credentialInjection.mode=sidecar`, `orchestrator.replicas=0`
- **HTTP probe:** `kubectl run --rm` with `curlimages/curl:8.10.1`
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/credential-broker.test.ts` | 2-test e2e suite (pod Ready + /authz 401) |
| `src/credential-broker/index.ts` | Broker entrypoint, started when `KUBECLAW_MODE=credential-broker` |
| `src/credential-broker/ext-authz.ts` | `/authz` handler — enforces Bearer-token check, returns 401 on missing token |
| `src/index.ts` | `KUBECLAW_MODE` dispatcher (line ~228) |
| `helm/kubeclaw/templates/credential-broker-deployment.yaml` | Helm chart resource for the broker Deployment |

## Tasks (retrospective)

### AC 1 — Broker pod reaches Ready within rollout timeout

`beforeAll` calls `helm upgrade --install` with `credentialInjection.mode=sidecar` and `orchestrator.replicas=0`, then immediately runs `kubectl rollout status deployment/kubeclaw-credential-broker --timeout=120s`. The broker pod needs no PVC and starts within seconds; the orchestrator and Redis are suppressed. `it('broker pod is Ready')` confirms `readyReplicas == 1` via jsonpath query.

### AC 2 — `/authz` returns 401 without Bearer token

`it('/authz returns 401 without Bearer token')` runs `kubectl run --rm probe-no-auth` with `curlimages/curl:8.10.1`, POSTing to `http://kubeclaw-credential-broker.<NS>.svc:8080/authz` with only `X-Forwarded-Authority` set and no `Authorization` header. The test asserts the output contains `401`.

### AC 3 — Broker image built from the current worktree

`buildBrokerImage()` re-tags `kubeclaw-orchestrator:latest` (loaded by global-setup) to `kubeclaw-orchestrator:e2e-broker` inside the minikube docker daemon. A non-`latest` tag triggers `imagePullPolicy: IfNotPresent`, preventing Kubernetes from attempting a registry pull for a local-only image.

### AC 4 — Isolated namespace `kubeclaw-e2e-broker`

`beforeAll` waits for any lingering `kubeclaw-e2e-broker` namespace to be fully deleted, then creates it fresh. `afterAll` runs `helm uninstall` and `kubectl delete ns --wait=false`, ensuring no cross-test namespace pollution.

### AC 5 — Cluster lock serialization

`acquireClusterLock()` is called in the first `beforeAll` and the lock is released in `afterAll`. This serializes helm-installing test suites so concurrent vitest workers cannot race on the shared minikube cluster.

### Verification

Run: `npm run test:e2e -- credential-broker`

Expected: **2 / 2 tests pass** (broker pod Ready + /authz 401).

Runtime: 5–15 minutes (includes helm install + rollout wait).
