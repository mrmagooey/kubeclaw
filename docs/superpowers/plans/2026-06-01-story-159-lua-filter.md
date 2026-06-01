# Story 159: Helm Chart Lua Substitution Filter — Retrospective Plan

**Date:** 2026-06-01
**Story:** 159 — Helm chart Lua substitution filter — Envoy rewrites Authorization header
**Status:** passing 3/3
**Test command:** `npm run test:e2e -- helm-chart -t "Lua substitution"`
**Test file:** `e2e/helm-chart.test.ts` — `describe('helm template — Lua substitution filter', ...)` at line 1029

---

## What was verified

The e2e suite for Story 159 exercises 3 tests inside the `helm template — Lua substitution filter` describe block. All tests are `helm template`-based — no live cluster is required. Key assertions:

1. **Sidecar mode contains Lua filter** — `helm template` with `credentialInjection.mode=sidecar` renders output containing `envoy.filters.http.lua`, `x-kubeclaw-substitutions`, and `x-kubeclaw-policy`.
2. **Lua filter located inside the sidecar ConfigMap** — the rendered output splits on YAML document boundaries and asserts the `kubeclaw-envoy-sidecar` ConfigMap document specifically contains `envoy.filters.http.lua` and `x-kubeclaw-substitutions`.
3. **Istio mode embeds the substitution filter** — covered by the `helm template — mode=istio` suite (also passing): `Lua substitution filter in istio EnvoyFilter` asserts the Lua source is present in the EnvoyFilter resource and appears after the ext_authz filter in document order.

---

## Implementation

### `helm/kubeclaw/files/envoy-substitution-filter.lua`

Standalone Lua script (~174 lines) embedded by Helm's `.Files.Get` mechanism. Responsibilities:

- **Minimal base64 decoder** — pure Lua implementation; no external libraries required in Envoy's sandboxed Lua runtime.
- **Binary content-type guard** — skips body substitution for `application/octet-stream`, `image/*`, `audio/*`, `video/*`.
- **Policy header parsing** — parses `x-kubeclaw-policy: positions=header,body;per=10;total=50` to control which substitution positions are enabled and enforce per-placeholder / total substitution count limits.
- **Substitution header parsing** — parses `x-kubeclaw-substitutions: <placeholder>=<b64value>;...` wire format; base64-decodes each value before substitution.
- **Header substitution** — collects all headers into a table first (cannot mutate during iteration via `pairs(hdrs)`), then replaces placeholder strings in header values.
- **Body substitution** — reads the request body up to 1 MB; replaces placeholder strings in non-binary bodies.
- **Limit enforcement** — responds with HTTP 503 `substitution_limit_exceeded` if per-placeholder or total substitution counts exceed policy limits.
- **Header stripping** — removes `x-kubeclaw-substitutions` and `x-kubeclaw-policy` unconditionally before the request continues to the upstream.

A key implementation note: the Envoy Lua headers object exposes the `__pairs` metamethod, so iteration must use `pairs(hdrs)` — not `hdrs:pairs()` (which throws a nil-value error and silently swallows the rest of `envoy_on_request`).

### `helm/kubeclaw/templates/istio-envoyfilter.yaml`

Gated by `{{- if eq .Values.credentialInjection.mode "istio" -}}`. Renders a single `EnvoyFilter` resource (`kubeclaw-credential-authz`) with three chained `configPatches` targeting the egress gateway's HTTP filter chain:

1. **INSERT_BEFORE router** — inline Lua filter `envoy.filters.http.lua.set-forwarded-authority`: copies `:authority` → `x-forwarded-authority` (stripping port suffix) and coerces the method to POST so ext_authz receives POST requests to the credential broker.
2. **INSERT_BEFORE router** — `envoy.filters.http.ext_authz` HTTP filter pointing to `kubeclaw-credential-broker.<namespace>.svc.cluster.local:<port>` with `path_prefix: /authz`. Allowed upstream response headers include `x-kubeclaw-substitutions` and `x-kubeclaw-policy` so they pass through to the next filter.
3. **INSERT_AFTER ext_authz** — `envoy.filters.http.lua` substitution filter sourced via `.Files.Get "files/envoy-substitution-filter.lua" | indent 16`. The 16-space indent is required for the YAML `inline_string:` block to be syntactically valid.

---

## Notes

- No LLM dependency; all rendering is pure Helm/Go templating with `.Files.Get` for the Lua payload.
- The sidecar mode path (`credentialInjection.mode=sidecar`) also embeds the Lua script — it appears in the `kubeclaw-envoy-sidecar` ConfigMap for the in-pod Envoy sidecar rather than in an EnvoyFilter resource.
- The `helm template — mode=istio` suite (Story 156) already covered the istio-mode Lua filter embedding; Story 159 adds explicit coverage for the sidecar-mode path and the ConfigMap location assertion.
