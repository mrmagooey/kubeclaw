# Story 105: Credential-injection sidecar mode — retrospective plan

**Goal:** Verify that the credential-injection sidecar mode renders correctly via Helm and stamps the configured header on outbound requests from tool pods, while leaving non-catalog hosts unstamped. All five acceptance criteria are exercised by the `'credential-injection sidecar mode (e2e)'` describe block in `e2e/credential-injection.test.ts`.

**Architecture:** When `credentialInjection.mode=sidecar` is set, the Helm chart injects a `credential-broker` container (running `KUBECLAW_MODE=credential-broker`) alongside every tool pod. The broker starts an HTTP server (port 8080) that reads its catalog from a ConfigMap and resolves credentials from a bound K8s Secret; it implements an Envoy `ext_authz` endpoint so the sidecar proxy can request header stamping for matching destination hosts. `src/index.ts` branches on `KUBECLAW_MODE` at line 228 to import and start the broker via `src/credential-broker/index.ts`, completely separate from the orchestrator code path.

**Tech Stack:** TypeScript (broker, orchestrator), Helm (chart rendering + mode flag), Kubernetes TokenRequest API (workload identity via `src/credential-broker/identity.ts`), Envoy proxy (sidecar dataplane), vitest (unit), k8s cluster + `npm run test:e2e` (e2e).

---

## File structure

```
src/credential-broker/
  index.ts                   # HTTP server + startup; reads ConfigMap + Secret
  config.ts                  # broker config schema (zod)
  config.test.ts
  resolver.ts                # (workload identity, dest host) → credential lookup
  resolver.test.ts
  k8s-secret-source.ts       # pulls credentials from K8s Secrets
  k8s-secret-source.test.ts
  ext-authz.ts               # Envoy ext_authz request/response handler — stamps header
  ext-authz.test.ts
  identity.ts                # TokenReview-based workload identity verification
  identity.test.ts
  audit.ts                   # structured audit log (pino)
  metrics.ts                 # prom-client metrics
  metrics.test.ts
  pod-informer.ts            # watches Pods for owner-group annotation
  pod-informer.test.ts
  spiffe.ts                  # SPIFFE identity parsing (istio mode helper)
  spiffe.test.ts
  substitution-policy.ts     # credential substitution policy
  substitution-policy.test.ts

src/index.ts                 # branches on KUBECLAW_MODE=credential-broker → startBroker()

helm/kubeclaw/templates/
  credential-broker.yaml          # ServiceAccount, Role, RoleBinding, ClusterRoleBinding, Deployment
  credential-broker-config.yaml   # ConfigMap with broker catalog config
  credential-broker-servicemonitor.yaml  # Prometheus ServiceMonitor (optional)

e2e/
  credential-injection.test.ts    # 'credential-injection sidecar mode (e2e)' describe at line 94
```

---

## Tasks per acceptance criterion

- [x] **AC1 — helm install succeeds, sidecar running**
  - `credential-broker.yaml` Deployment is rendered when `credentialInjection.mode != "off"`.
  - Sidecar container image inherits the same image tag as the main kubeclaw image.
  - e2e test: `helm install --set credentialInjection.mode=sidecar ...` completes without error; `kubectl get pods` shows broker pod `Running`.

- [x] **AC2 — sidecar reads ConfigMap + Secret at startup**
  - `src/credential-broker/index.ts` mounts `BROKER_CONFIG_PATH` (default `/etc/credential-broker/config.yaml`) from `credential-broker-config.yaml` ConfigMap.
  - `src/credential-broker/k8s-secret-source.ts` fetches the bound credential Secret via K8s API on startup.
  - e2e test: broker pod logs show `config loaded` and `secret source ready` within readiness window.

- [x] **AC3 — outbound request via sidecar has configured header stamped**
  - `src/credential-broker/ext-authz.ts` receives the ext_authz check request, resolves the credential via `Resolver`, and returns the `X-Goog-Api-Key` (or configured) header in the `OkHttpResponse` headers.
  - Envoy sidecar injects the header on the upstream request before egress.
  - e2e test: test pod sends HTTP request to catalog host through the proxy; captured upstream request includes the expected header.

- [x] **AC4 — non-catalog hosts not stamped**
  - `Resolver.resolve()` returns `null` when destination host is absent from the catalog.
  - `ext-authz.ts` returns a `DeniedHttpResponse` (or plain `OkHttpResponse` with no header) for uncatalogued hosts per configured policy.
  - e2e test: test pod sends request to a non-catalog host; captured request has no credential header; sidecar denies or passes through without stamping.

- [x] **AC5 — sidecar-mode e2e tests pass against real cluster**
  - Test file: `e2e/credential-injection.test.ts`, describe block at line 94.
  - Run: `npm run test:e2e -- credential-injection -t "sidecar mode"`.
  - All tests in the describe block pass (no skips counted as passing).

---

## Retrospective

Implementation was complete before this plan was written. Tests were run against the live minikube cluster (`minikube` node, `v1.35.1`) on 2026-06-01. All five ACs verified green by the e2e suite.
