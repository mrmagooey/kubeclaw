# Story 150: Helm Chart Orchestrator Deployment — Retrospective Plan

**Date:** 2026-06-01
**Story:** 150 — Helm chart orchestrator Deployment — exists, ready, healthy
**Status:** passing 2/2
**Test command:** `npm run test:e2e -- helm-chart -t "orchestrator deployment"`
**Test file:** `e2e/helm-chart.test.ts` — `describe('orchestrator deployment', ...)` at line 618

---

## What was verified

The e2e suite for Story 150 exercises two tests inside the `orchestrator deployment` describe block:

1. **Deployment manifest exists with correct env vars** — `helm template` renders a `Deployment/kubeclaw-orchestrator` with `replicas: 1`, `MAX_CONCURRENT_JOBS=5`, a `REDIS_URL` pointing at `kubeclaw-redis`, and `KUBECLAW_NAMESPACE` set to the release namespace. This is a pure template rendering test (no cluster required).

2. **Deployment becomes ready when orchestrator image is present in minikube** — polls `kubectl get deployment kubeclaw-orchestrator` for `readyReplicas=1`, with early exits for `CrashLoopBackOff`, `ErrImagePull`, `ImagePullBackOff`, `CreateContainerConfigError`, non-zero restart counts, and container termination events. In the CI / no-image environment this test exits cleanly via the `orchestratorImagePresent` guard.

---

## Implementation: `helm/kubeclaw/templates/orchestrator.yaml`

The template renders the following Kubernetes resources in a single multi-document YAML file:

| Resource | Name | Purpose |
|---|---|---|
| `ServiceAccount` | `kubeclaw-orchestrator` | Pod identity for RBAC |
| `Role` | `kubeclaw-job-manager` | Grants batch/jobs, pods/log, secrets, deployments, deployments/scale, services, PVCs, ingresses, configmaps |
| `RoleBinding` | `kubeclaw-orchestrator-binding` | Binds SA to role |
| `Deployment` | `kubeclaw-orchestrator` | Main orchestrator workload |
| `Service` (conditional) | `kubeclaw-admin` | Admin HTTP port, only when `orchestrator.admin.enabled` |
| `Service` | `kubeclaw-orchestrator` | Metrics port, ClusterIP |

### Deployment details

- **initContainer** `fix-permissions` (busybox): `chown -R 1000:1000` on `/app/groups`, `/app/store`, `/data/sessions`.
- **Container** `orchestrator`: runs as UID/GID 1000, drops all capabilities, uses `RuntimeDefault` seccomp.
- **Probes**: liveness on `/liveness:8080` (15s delay, 30s period), readiness on `/health:8080` (30s delay, 10s period).
- **Volumes**: three PVCs (`kubeclaw-groups`, `kubeclaw-store`, `kubeclaw-sessions`) and an optional `kubeclaw-specialists-baseline` ConfigMap.
- **Resources**: fully driven by `values.orchestrator.resources` (no hardcoded limits).
- **Istio mode**: when `credentialInjection.mode=istio`, adds `sidecar.istio.io/inject: "false"` annotation so the orchestrator is excluded from the mesh.
- **RAG**: when `rag.enabled`, injects `QDRANT_URL`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `RAG_TOP_K`, `RAG_SCORE_THRESHOLD`, and conditionally `VOYAGE_API_KEY`.
- **Admin HTTP**: when `orchestrator.admin.enabled`, injects `ADMIN_HTTP_PORT`, `ADMIN_HTTP_USERNAME`, `ADMIN_HTTP_PASSWORD` (from secret).

### Key design decisions

- The orchestrator does **not** call LLM providers directly — channels own LLM conversations per the four-tier architecture. API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) are present in the env for future use and are marked `optional: true`.
- `runAsUser: 0` on the pod-level `securityContext` with `runAsNonRoot: false` is required only to allow the initContainer to chown directories; the main container overrides this to UID 1000.
- The `deployments/scale` verb is separate from `update` on deployments — required for `replaceNamespacedDeploymentScale` calls in the idle-sweeper.

---

## Test result summary

```
Test Files  1 passed (1)
      Tests  2 passed | 66 skipped (68)
   Duration  54.62s
```

All 2 orchestrator deployment tests passed. The 66 skipped tests belong to other describe blocks in `helm-chart.test.ts` that were not targeted by the `-t` filter.
