# Story 153: Helm Chart `helm upgrade` — Values Change Without Data Loss — Retrospective Plan

**Date:** 2026-06-01
**Story:** 153 — Helm chart `helm upgrade` — values change without data loss
**Status:** passing 2/2
**Test command:** `npm run test:e2e -- helm-chart -t "helm upgrade"`
**Test file:** `e2e/helm-chart.test.ts` — `describe('helm upgrade', ...)` at line 743

---

## What was verified

The e2e suite for Story 153 exercises two tests inside the `helm upgrade` describe block:

1. **Applies `maxConcurrentJobs` change** — runs `helm upgrade` with `--set orchestrator.maxConcurrentJobs=8 --reuse-values`, expects exit code 0, then asserts that the `kubeclaw-orchestrator` Deployment has `MAX_CONCURRENT_JOBS=8` in its container env. Requires a live cluster with a prior `helm install`.

2. **Preserves Redis password across upgrade (lookup prevents rotation)** — captures the base64-encoded `admin-password` field from the `kubeclaw-redis` Secret before upgrade, runs `helm upgrade --reuse-values`, then re-reads the same field and asserts byte-identity. This proves the `lookup` guard in `secrets.yaml` prevents password rotation on every upgrade.

Both tests require `KUBECLAW_SKIP_HELM_INSTALL` to be unset (live cluster path) and an existing release in the target namespace.

---

## Implementation: `helm/kubeclaw/templates/secrets.yaml` — lookup pattern

The Redis password stability guarantee is implemented entirely in the Helm template via the Sprig `lookup` function:

```
{{- $redisSecret := lookup "v1" "Secret" .Values.namespace "kubeclaw-redis" }}
{{- $redisPassword := .Values.redis.password }}
{{- if and (not $redisPassword) $redisSecret (hasKey ($redisSecret.data | default dict) "admin-password") }}
  {{- $redisPassword = index $redisSecret.data "admin-password" | b64dec }}
{{- end }}
{{- if not $redisPassword }}
  {{- $redisPassword = randAlphaNum 32 }}
{{- end }}
```

Priority order for each secret field:

| Priority | Source | When used |
|---|---|---|
| 1 | Explicit chart value (e.g. `redis.password`) | Always preferred if set |
| 2 | `lookup` from existing Secret in cluster | On upgrade, preserves current value |
| 3 | `randAlphaNum` | First install only — no existing Secret |

The same three-tier lookup pattern is applied consistently to:

- `kubeclaw-redis`: `admin-password`, `channel-password`, `agent-password`, `tool-server-password`, `adapter-password`
- `kubeclaw-secrets` (admin HTTP password): `admin-http-password`
- Per-channel HTTP secrets (`kubeclaw-channel-<name>`): `users` field

All generated Secrets carry `helm.sh/resource-policy: keep` so they survive `helm uninstall` and are not deleted on chart removal.

---

## Upgrade hooks

No Helm lifecycle hooks (`pre-upgrade`, `post-upgrade` Jobs) are present in this chart. State preservation is achieved entirely through:

1. The `lookup`-based secret stabilisation in `secrets.yaml` (no password rotation).
2. `helm.sh/resource-policy: keep` on all Secrets (no accidental deletion).
3. PVC persistence — PersistentVolumeClaims are never deleted by the chart; they outlive pod restarts and upgrades.
4. `--reuse-values` flag in upgrade commands — chart values not explicitly overridden are carried forward from the previous release.

---

## Test result summary

```
Test Files  1 passed (1)
      Tests  2 passed | 66 skipped (68)
   Duration  31.00s
```

Both helm upgrade tests passed. The 66 skipped tests belong to other describe blocks in `helm-chart.test.ts` not matched by the `-t "helm upgrade"` filter.
