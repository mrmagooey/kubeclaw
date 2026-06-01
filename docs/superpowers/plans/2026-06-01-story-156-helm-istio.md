# Story 156: Helm Chart `mode=istio` — Istio Sidecar + EnvoyFilter Render Correctly — Retrospective Plan

**Date:** 2026-06-01
**Story:** 156 — Helm chart `mode=istio` — Istio sidecar + EnvoyFilter render correctly
**Status:** passing 22/22
**Test command:** `npm run test:e2e -- helm-chart -t "mode=istio"`
**Test file:** `e2e/helm-chart.test.ts` — `describe('helm template — mode=istio', ...)` at line 846

---

## What was verified

The e2e suite for Story 156 exercises 22 tests (plus 1 skipped) inside the `helm template — mode=istio` describe block. All tests are `helm template`-based — no live Istio cluster is required. Key assertions:

1. **Renders cleanly without errors** — `helm template` exits 0 with `credentialInjection.mode=istio`.
2. **Sidecar resource** — output contains `kind: Sidecar` (Istio sidecar scope restriction).
3. **4 built-in ServiceEntry resources** — one per upstream AI provider (Anthropic, OpenAI, OpenRouter, VoyageAI).
4. **Gateway and VirtualService** — egress gateway routing resources present.
5. **EnvoyFilter for ext_authz** — `kind: EnvoyFilter` with `ext_authz` configuration present.
6. **Lua substitution filter ordering** — `envoy-substitution-filter.lua` marker appears _after_ `envoy.filters.http.ext_authz` in the output, confirming the INSERT_AFTER patch is rendered in the correct sequence.
7. **5 ServiceEntry resources with one additionalDestination** — chart correctly appends a dynamic ServiceEntry when `credentialInjection.istio.additionalDestinations[0]` is set.
8. **Namespace ownership removed** — the chart no longer renders a `Namespace` resource (test is `.skip`-ped with an explanatory comment).
9. **Orchestrator sidecar inject=false** — orchestrator pod has `sidecar.istio.io/inject: "false"` to opt out of the mesh sidecar.
10. **No credential-sidecar container** — in istio mode the in-pod Envoy sidecar is not injected by the chart.
11. **Istio-mode NetworkPolicies** — `kubeclaw-broker-ingress-istio` policy rendered.
12. **Egress gateway Deployment** — `kubeclaw-istio-egressgateway` Deployment present.
13. **HTTP listener, not HTTPS PASSTHROUGH** — Gateway port 80 with `protocol: HTTP`; no `mode: PASSTHROUGH`.
14. **VirtualService `http:` routes, not `tls:`** — confirms plain HTTP routing through the egress gateway (TLS origination happens at the gateway, not the workload).
15. **DestinationRules per built-in HTTPS destination** — one DR per provider, enforcing TLS origination at the gateway.
16. **ServiceEntry two-port pattern** — each SE exposes both workload HTTP port and upstream TLS port.
17. **Egress gateway Service port 80** — service exposes 80, not 443.
18. **HTTP base URL envs injected** — channel and capability pods receive `http://` base URL env vars (not `https://`) in istio mode.
19. **Test fixture sub-suite (4 tests)** — with `testFixture.enabled=true`: mock-upstream Deployment+Service rendered; ServiceEntry/Gateway server/VS routes appended; test-mock mapping in broker ConfigMap; test-mock-token in secrets. No DestinationRule for the mock (it is HTTP, not HTTPS).

---

## Implementation: `helm/kubeclaw/templates/`

The istio mode is gated throughout by `{{- if eq .Values.credentialInjection.mode "istio" -}}`. Key files:

### `istio-envoyfilter.yaml`

Three chained `configPatches` on the egress gateway's `HTTP_FILTER` chain:

1. **INSERT_BEFORE router** — Lua filter `set-forwarded-authority` that copies `:authority` → `x-forwarded-authority` and coerces the method to POST before ext_authz sees the request.
2. **INSERT_BEFORE router** — `envoy.filters.http.ext_authz` HTTP filter pointing to the credential broker (`http://kubeclaw-credential-broker.<namespace>.svc.cluster.local:<port>`), with `path_prefix: /authz`. Allowed upstream response headers include `x-kubeclaw-substitutions` and `x-kubeclaw-policy`.
3. **INSERT_AFTER ext_authz** — Lua substitution filter sourced from `files/envoy-substitution-filter.lua` via `.Files.Get`, indented 16 spaces for correct YAML embedding. Performs placeholder substitution and strips the broker's response headers before forwarding upstream.

### Other istio-mode templates

- `istio-sidecar.yaml` — Istio `Sidecar` resource restricting egress scope.
- `istio-serviceentries.yaml` — One `ServiceEntry` per configured destination (4 built-in + dynamic `additionalDestinations`). Each exposes two ports: workload-facing HTTP and upstream TLS.
- `istio-egress.yaml` — Egress gateway `Deployment`, `Service` (port 80), `Gateway` (HTTP), `VirtualService` (http: routes), and `DestinationRule` (TLS origination) per destination.
- `networkpolicies-istio.yaml` — `kubeclaw-broker-ingress-istio` NetworkPolicy allowing the egress gateway to reach the credential broker.
- `istio-test-fixture.yaml` — Conditional mock-upstream resources for e2e testing (`testFixture.enabled=true`).

---

## Notes

- The Namespace resource was removed from the chart in commit `52c5dd9`. Operators must label the namespace `istio-injection: enabled` themselves; NOTES.txt documents the requirement.
- The `.skip` test for Namespace rendering is retained as documentation of the intentional removal.
- No LLM dependency; all rendering is pure Helm/Go templating with `.Files.Get` for the Lua payload.
