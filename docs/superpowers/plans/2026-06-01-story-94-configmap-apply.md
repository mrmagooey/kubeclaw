# Story 94: `register_specialist` immediately patches the specialists ConfigMap

**Date:** 2026-06-01
**Status:** retrospective (implementation already on main)

## Goal

Enable `register_specialist` (via admin shell) to immediately patch the `kubeclaw-specialists` ConfigMap so channel pods pick up the new specialist definition without any restart.

## Architecture

The read-modify-replace ConfigMap path lives in `src/specialists/reconciler.ts` as a `configMapApply` closure: it reads the current ConfigMap from the K8s API, merges in all rows from the `specialist_overrides` DB table (preserving existing entries), and calls `replaceNamespacedConfigMap` — no JSON-Patch RFC 6902 body, compatible with `@kubernetes/client-node` v1.4.x. The admin-shell tool in `src/skills/orchestrator/specialist-registry.ts` exposes `registerSpecialist` / `editSpecialist`, each of which fires an optional `reconcile()` callback immediately after the DB write so the ConfigMap patch happens within seconds. On the channel side, `src/specialists/catalog-loader.ts` uses Node's `fs.watch` on the ConfigMap volume-mount directory, detecting the kubelet's atomic `..data` symlink swap and reloading the catalog without a pod restart.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Cluster harness:** minikube + helm upgrade + `kubectl exec` into running orchestrator
- **K8s client:** `@kubernetes/client-node` v1.4.x (read-modify-replace pattern)
- **No LLM dependency** — test invokes `register_specialist` directly via admin-shell node API (`executeTool`)

## File Structure

| File | Role |
|------|------|
| `e2e/specialist-catalog.test.ts` | E2E test — Story 94 test at line ~1065 (Test 7) |
| `src/specialists/reconciler.ts` | `configMapApply` closure — read-modify-replace K8s patch |
| `src/skills/orchestrator/specialist-registry.ts` | Admin-shell `registerSpecialist` / `editSpecialist` tools |
| `src/specialists/catalog-loader.ts` | Channel-side `fs.watch` for `..data` symlink swap detection |

## Tasks (retrospective)

### AC1 — Immediate ConfigMap patch on `register_specialist`

`registerSpecialist` in `specialist-registry.ts` calls `reconcile?.()` immediately after the DB `INSERT`, firing the `configMapApply` closure in `reconciler.ts` within seconds of the admin-shell call.

### AC2 — Channel pod picks up new entry without restart

`catalog-loader.ts` uses `fs.watch` on the ConfigMap volume-mount directory; the kubelet's atomic `..data` symlink swap triggers the watcher callback, causing the catalog to reload without bouncing the channel pod.

### AC3 — Existing specialists preserved (incremental reconcile)

`configMapApply` reads the current ConfigMap first, then merges all `specialist_overrides` rows (including pre-existing ones) before calling `replaceNamespacedConfigMap`, ensuring no existing entries are dropped.

### AC4 — Read-modify-replace pattern (not JSON-Patch)

`replaceNamespacedConfigMap` sends a full object body, not a JSON-Patch RFC 6902 body. This is the default for `@kubernetes/client-node` v1.4.x and avoids content-type compatibility issues.

### AC5 — Idempotent by name, additive for new names

`editSpecialist` issues an `UPDATE` for existing names; `registerSpecialist` issues an `INSERT` for new names. Repeated `register_specialist` calls with the same name via `editSpecialist` converge to the latest value; calls with a new name add a new row and trigger a patch.

### Verification

Run: `npm run test:e2e -- specialist-catalog -t "register_specialist immediately patches ConfigMap"`

Expected: **1 pass / 1 total** (Test 7 in `e2e/specialist-catalog.test.ts` at line ~1065). Runtime ~2–5 minutes (helm upgrade + kubectl exec against live minikube cluster).
