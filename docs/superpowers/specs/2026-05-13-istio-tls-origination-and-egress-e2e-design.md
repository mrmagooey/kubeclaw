# Istio mode: TLS origination at the egress gateway + end-to-end egress e2e test

**Date:** 2026-05-13
**Status:** Design — approved by user; awaiting spec-review gate before implementation plan
**Supersedes:** the PASSTHROUGH listener decision in `docs/superpowers/plans/2026-05-10-credential-injection-istio.md` (line 2497 and `istio-egress.yaml` lines 91–94).

## Problem

The `credentialInjection.mode=istio` chart ships an `EnvoyFilter` that patches the
egress gateway to invoke the credential-broker via `ext_authz` and stamp the
`Authorization` header on each upstream request. The Gateway listener is configured
with `protocol: HTTPS` and `tls.mode: PASSTHROUGH`. Those two are mutually
incompatible: a PASSTHROUGH listener in Envoy is realised as a `tcp_proxy` +
`tls_inspector` filter chain, not an `http_connection_manager` chain. The
EnvoyFilter's `INSERT_BEFORE envoy.filters.http.router` match clause therefore
never finds a target, ext_authz is never installed on the listener, the broker is
never called, and no `Authorization` header is stamped. Workload traffic exits the
mesh as opaque TLS straight to the upstream — functionally identical to having no
broker at all.

No existing e2e test exercises the request path; the suite asserts only on
manifest shape and deployment readiness. This is what allowed the defect to ship.

## Goal

1. Fix the istio-mode chart so the credential-injection chain actually runs
   end-to-end: workload egress → workload sidecar → mesh mTLS → gateway HCM →
   ext_authz to broker → header stamped → TLS originated to upstream.
2. Add an end-to-end test that proves the chain by observing both the
   broker-stamped header arriving at a mock upstream and the audit record at the
   broker, so this class of defect cannot ship undetected again.

## Non-goals

- No change to `mode=sidecar` or `mode=off` behaviour. All sidecar-mode templates,
  broker mapping config, per-pod Envoy sidecar bootstrap, and tests continue to
  render and run unchanged.
- No change to the broker code (`src/credential-broker/*.ts`). The broker's
  XFCC SPIFFE-identity dispatch path is already correct; only the chart was
  wrong.
- No change to `kubeclaw-egress-ca-tls` / the internal CA. The internal CA
  remains the sidecar-mode primitive and is not used in istio mode under this
  design.
- No support for ambient mode, waypoints, or alternative service meshes
  (Linkerd, Cilium service mesh). Those remain explicit out-of-scope items per
  the original plan.
- No negative-path e2e test (broker returns 403 → gateway denies). Flagged as
  follow-up.

## Design

### Architecture

The canonical Istio bearer-stamping pattern from the upstream Istio docs
(["Egress Gateway TLS Origination for a single host"](https://istio.io/latest/docs/tasks/traffic-management/egress/egress-gateway-tls-origination/)):

- Workload SDK is configured with `http://<host>` base URLs (no client-side
  TLS).
- Workload pod has an Istio sidecar injected by namespace label
  (`istio-injection=enabled`). iptables in the workload's netns redirect all
  egress to the sidecar's port 15001.
- The workload sidecar matches a `VirtualService` HTTP route for the
  destination host and forwards the request to the `kubeclaw-istio-egressgateway`
  over mesh mTLS (the sidecars on both legs authenticate each other via
  SPIFFE certificates from istiod). The request is *HTTP at the application
  layer* and *mTLS at the transport layer*: the gateway sees plaintext HTTP
  headers after Envoy decrypts the mTLS stream, but bytes on the wire between
  pods are SPIFFE-rooted-mTLS-encrypted end-to-end.
- The gateway terminates mesh mTLS and runs an HTTP listener (port 80). HCM
  dispatches `ext_authz` to the broker.
- The broker reads the workload's SPIFFE identity from the
  `x-forwarded-client-cert` header Envoy populates on the inner HTTP request,
  resolves the mapping, reads the credential from `kubeclaw-secrets`, and
  returns `200 { authorization: "Bearer <secret>" }`.
- Envoy overwrites the inbound `Authorization` header with the broker's value
  (per `authorization_response.allowed_upstream_headers: exact: authorization`).
- A per-destination `DestinationRule` with `trafficPolicy.tls.mode: SIMPLE` and
  `sni: <host>` causes the gateway to originate TLS to the real upstream on
  port 443, using the public CA bundle.

### Rejected alternative: MITM impersonation with internal CA

Keep workload `https://` URLs by having the gateway present internal-CA-signed
certificates for `api.openai.com` etc., with the workload's CA bundle augmented
to trust the internal CA. Workable but requires per-destination cert
provisioning, CA injection into every workload's `/etc/ssl/certs`, and SAN
maintenance as destinations are added. Substantially more chart surface than
the canonical pattern with no operational benefit, since workloads already get
their base URLs from configurable envs. Not chosen.

### Components

#### Chart templates (modified)

`helm/kubeclaw/templates/istio-egress.yaml`

- Gateway server block: change `protocol: HTTPS` → `protocol: HTTP`, drop the
  `tls:` block.
- Gateway listener port: 80 (was 443).
- VirtualService: replace the `tls:` block with an `http:` block. Two route
  legs per destination: `match: gateways: [mesh]` routes mesh-internal HTTP to
  the egress gateway; `match: gateways: [kubeclaw-egressgateway]` routes from
  the gateway to the upstream host with the upstream port.
- Add a `DestinationRule` per destination **where `upstreamProtocol == "HTTPS"`**
  (i.e. all built-ins; the test fixture's mock upstream is HTTP and gets no
  DestinationRule). Spec:
  ```yaml
  apiVersion: networking.istio.io/v1
  kind: DestinationRule
  metadata:
    name: kubeclaw-egress-tls-<host-slug>
    namespace: <namespace>
  spec:
    host: <host>
    trafficPolicy:
      portLevelSettings:
        - port:
            number: <upstreamPort>   # 443 for built-ins
          tls:
            mode: SIMPLE
            sni: <host>
            caCertificates: /etc/ssl/certs/ca-certificates.crt
  ```

`helm/kubeclaw/templates/istio-serviceentries.yaml`

- Each `ServiceEntry` now declares two ports: a workload-facing `number: 80,
  protocol: HTTP, name: http` port and an upstream `number: <upstreamPort>,
  protocol: HTTPS, name: tls` port.
- `resolution: DNS` remains.

`helm/kubeclaw/templates/istio-envoyfilter.yaml`

- No structural change. The HCM filter chain match clause is unchanged; once
  the listener is HTTP, the patch attaches as intended.
- Optional refinement: change `path_prefix: /authz` and the `allowed_headers`
  patterns to exact-match the headers we actually need (already correct in the
  current template; verify in implementation).

`helm/kubeclaw/templates/_helpers.tpl`

- `kubeclaw.egressDestinations` now emits records with this shape:
  ```
  { host, port: 80, upstreamPort, upstreamProtocol: "HTTP"|"HTTPS" }
  ```
  where `port` (workload-facing) is always 80, `upstreamPort` defaults to 443
  for built-ins and is configurable for `additionalDestinations`, and
  `upstreamProtocol` drives whether downstream templates render a
  `DestinationRule` (HTTPS only — HTTP destinations need no TLS origination).
- When `credentialInjection.istio.testFixture.enabled` is true, the helper
  appends one extra record for the mock upstream:
  `{ host: "mock-upstream.kubeclaw-test", port: 80, upstreamPort: 80, upstreamProtocol: "HTTP" }`.
  This single change makes all downstream templates (`ServiceEntry`, Gateway,
  VirtualService, DestinationRule) pick up the test destination automatically;
  no template duplication.
- New helper `kubeclaw.istioBaseUrlEnv` returns an env block for three of
  the four built-in destinations (openai, anthropic, openrouter) with
  `http://<host>` values, for use in pod specs. Voyage is intentionally
  omitted: its SDK doesn't standardise on a `VOYAGE_BASE_URL` env
  (most Python SDKs use `VOYAGEAI_API_URL`), so an injected default
  could either be ignored or actively conflict with operator config.
  Operators using voyage set the appropriate base-URL env on their
  workload pod themselves.

`helm/kubeclaw/templates/channel-pods.yaml`, `capability-pods.yaml`

- When `mode=istio`, include the `kubeclaw.istioBaseUrlEnv` block in each
  container's env.

`src/k8s/job-runner.ts`

- When `CREDENTIAL_INJECTION_MODE=istio` (and `auditOnly=false`), the function
  generating the tool-job pod spec must apply two distinct transformations
  in place of today's wholesale env stripping:

  1. **Base-URL injection.** Drop any `valueFrom.secretKeyRef` env entries
     for `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENROUTER_BASE_URL`, and
     replace them with literal `value:` envs pointing at the http:// hostnames
     (`http://api.openai.com`, `http://api.anthropic.com`,
     `http://openrouter.ai`).
  2. **API-key substitution (replaces today's stripping).** For
     `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
     `VOYAGE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`:
     today these are stripped entirely. Change behaviour to substitute the
     literal string `"injected-by-broker"` so SDKs that enforce client-side
     key presence (notably OpenAI's official SDK) construct successfully.
     The placeholder is overwritten by the gateway's ext_authz response on
     every request and never leaves the cluster.

  When `auditOnly=true` in istio mode, both transformations are skipped:
  the API keys and base URLs are left untouched (matching today's audit-only
  semantics — workload behaves as if injection were off, broker logs the
  decision but the request path is undisturbed).

#### Chart templates (new)

`helm/kubeclaw/templates/istio-test-fixture.yaml` (new, gated on
`credentialInjection.istio.testFixture.enabled`)

Renders, only when the flag is true:

- `Deployment kubeclaw-mock-upstream` running `mendhak/http-https-echo:31` on
  port 80 with `sidecar.istio.io/inject: "false"`. `runAsNonRoot: true`,
  `readOnlyRootFilesystem: true` (the echo image supports this), drop all
  caps.
- `Service kubeclaw-mock-upstream` (ClusterIP, port 80).

The `ServiceEntry`, `Gateway` server entry, and `VirtualService` HTTP routes
for hostname `mock-upstream.kubeclaw-test` are NOT rendered here. They are
produced automatically by the existing `istio-egress.yaml` /
`istio-serviceentries.yaml` templates, because `kubeclaw.egressDestinations`
(see _helpers.tpl section above) appends the mock as a record when
`testFixture.enabled=true`. No template duplication.

The `ServiceEntry` resolution strategy for the mock is `resolution: DNS` with
explicit `endpoints: [- address: kubeclaw-mock-upstream.<namespace>.svc.cluster.local]`
so the gateway resolves the in-cluster Service hostname rather than attempting
public DNS for `mock-upstream.kubeclaw-test`. The helper's record carries the
endpoint address for the test entry; the built-in records have no `endpoints`
field and use DNS for the public hostname directly.

No `DestinationRule` is rendered for the mock (`upstreamProtocol: "HTTP"`).

#### Broker config (modified)

`helm/kubeclaw/templates/credential-broker-config.yaml`

- When `credentialInjection.istio.testFixture.enabled` is true, append a
  fifth mapping to `mappings`:
  ```yaml
  - id: test-mock
    destinations: ["mock-upstream.kubeclaw-test"]
    identities: ["sa/kubeclaw-tool-job"]
    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: test-mock-token }
    headerScheme: bearer
  ```

#### Secret (modified)

`helm/kubeclaw/templates/secrets.yaml`

- When `testFixture.enabled` is true, include `test-mock-token: "test-token-12345"`
  in the rendered Secret data (literal value, base64-encoded by Helm).

#### Values (new fields)

`helm/kubeclaw/values.yaml`

```yaml
credentialInjection:
  istio:
    # additionalDestinations: each entry is "host[:upstreamPort]".
    # The workload-facing listener is always HTTP on port 80; upstreamPort
    # (default 443) is the port the gateway originates TLS to.
    # Example: ["my-mcp.internal:8443"] → gateway accepts HTTP on 80 and
    # originates TLS to my-mcp.internal:8443.
    additionalDestinations: []

    # testFixture: e2e-only knob. Renders an in-cluster mock upstream and
    # adds a broker mapping for it. Never enable in production.
    testFixture:
      enabled: false
```

### End-to-end test

`e2e/credential-injection-istio.test.ts` — new `it` case at the end of the
existing suite. `beforeAll` is extended with two flags:

```
--set credentialInjection.istio.testFixture.enabled=true
```

(`additionalDestinations` is not needed — the test fixture renders its own
ServiceEntry/Gateway/VirtualService entries for the mock host.)

The test:

1. Wait for `deployment/kubeclaw-mock-upstream` to be Ready (added once in
   `beforeAll`, after the helm install).
2. Spawn a probe pod:
   ```
   kubectl run kubeclaw-egress-probe -n kubeclaw \
     --image=curlimages/curl:8.10.1 \
     --restart=Never \
     --overrides='{"spec":{"serviceAccountName":"kubeclaw-tool-job"}}' \
     --command -- sh -c '
       set -e
       resp=$(curl -sS -H "Authorization: Bearer placeholder" \
         http://mock-upstream.kubeclaw-test/echo)
       echo "RESPONSE_BEGIN"
       echo "$resp"
       echo "RESPONSE_END"
       curl -sS -X POST http://localhost:15020/quitquitquit
     '
   ```
3. Poll for the pod to reach `Succeeded` or `Failed`, max 30s.
4. `kubectl logs kubeclaw-egress-probe`, slice out the JSON between
   `RESPONSE_BEGIN`/`RESPONSE_END`, parse it.
5. **Primary assertion:** `body.headers.authorization === "Bearer test-token-12345"`.
   This proves the gateway overwrote the workload's placeholder with the
   broker-supplied credential.
6. **Secondary assertion:** within `kubectl logs deployment/kubeclaw-credential-broker --since=120s`,
   find an audit JSON line with all of:
   - `identity == "sa/kubeclaw-tool-job"`
   - `destination == "mock-upstream.kubeclaw-test"`
   - `mappingId == "test-mock"`
   - `status == 200`
7. Cleanup: `kubectl delete pod kubeclaw-egress-probe -n kubeclaw --wait=false`
   (also covered by `afterAll`'s namespace delete).

The two assertion legs are non-redundant: leg 5 proves the gateway applied the
broker's response header, leg 6 proves the broker observed the workload's
SPIFFE identity correctly. A regression that breaks only one would still be
caught.

### CI workflow

`.github/workflows/e2e-istio.yml` — add two `kind load docker-image` steps
before the test run so the curl and echo images are present in-cluster
deterministically:

```
docker pull mendhak/http-https-echo:31
kind load docker-image mendhak/http-https-echo:31 --name kubeclaw-e2e-istio
docker pull curlimages/curl:8.10.1
kind load docker-image curlimages/curl:8.10.1 --name kubeclaw-e2e-istio
```

### Plan-doc addendum

`docs/superpowers/plans/2026-05-10-credential-injection-istio.md` is amended
with a "Superseded — 2026-05-13" addendum at the end, calling out:

- The PASSTHROUGH listener decision at line 2497 was wrong (incompatible with
  HCM-based ext_authz).
- The corrected design (this spec) replaces the listener-protocol and
  acceptance-criterion specifics; the rest of the plan (Sidecar resource,
  SPIFFE-via-XFCC dispatch in the broker, NetworkPolicy shape, ambient-mode
  exclusion) stands unchanged.
- Cross-link to this spec.

The original text is left in place rather than rewritten, so the history of
the decision remains legible.

## Tests at three levels

| Level | Coverage |
|---|---|
| **Unit** | No new unit tests required for the chart change (no TypeScript logic added). `src/k8s/job-runner.test.ts:1488` (`mode=istio` block) gains two cases: API-key envs are substituted with `"injected-by-broker"` (not stripped); `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`/`OPENROUTER_BASE_URL` Secret entries are replaced with literal http:// values. |
| **Integration** | `e2e/helm-chart.test.ts:764` (the `helm template — mode=istio` suite) gains assertions: Gateway listener port is 80 and protocol HTTP; VirtualService renders `http:` routes not `tls:`; one `DestinationRule` per built-in destination renders with `tls.mode: SIMPLE` and correct SNI; ServiceEntry renders two ports per destination. Plus: with `testFixture.enabled=true`, the mock-upstream Deployment, Service, ServiceEntry, broker mapping, and Secret entry all render. The "mode=sidecar (no Istio regression)" suite at line 831 gains an assertion that the test fixture is NOT rendered. |
| **End-to-end** | The new test described above. Triggered by the existing `e2e-istio.yml` workflow (label `e2e:istio` or nightly). |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `additionalDestinations` operators with HTTPS-only backends | Medium | Document the http:// + upstreamPort pattern in `docs/CREDENTIAL_INJECTION.md` and the `values.yaml` comment. Population of affected operators is realistically zero — istio mode merged on main 2026-05-12 (commit 618c6d9). |
| Operators using Secret-derived base URLs in istio mode | Low | Same — document. Sidecar mode and mode=off retain full Secret-derived base-URL behaviour. |
| Test fixture rendered in a production install | Low | Flag defaults to false; objects are named `kubeclaw-mock-upstream` and `test-mock` (obvious in `kubectl get`). Implementation includes a `helm template`-time fail if `testFixture.enabled=true` and `mode != istio` (defence in depth). |
| Mesh-sidecar pinning in the one-shot probe pod | Medium | Probe issues `POST http://localhost:15020/quitquitquit` as its final step, so istio-proxy exits and the pod reaches `Succeeded`. Standard upstream pattern. |
| Plan-doc drift / historical rewriting | Low | Addendum block at the end of the merged plan, not a rewrite. Original PASSTHROUGH rationale preserved with a "superseded" marker. |
| Sidecar mode untouched but co-tested | Low | All chart changes are gated under `if eq .Values.credentialInjection.mode "istio"`. The existing `helm-chart.test.ts:831` "no Istio regression" suite catches accidental cross-contamination. |

## Future work (out of scope)

- **Negative-path e2e:** workload curls an unmapped destination, broker returns
  403, gateway denies the request with HTTP 403. Would round out coverage and
  prove `failure_mode_allow: false` end-to-end.
- **Helm-lint warning when `testFixture.enabled=true`:** today the only guard
  is the flag's default value. A NOTES.txt-rendered warning would make
  accidental enablement loud.
- **Audit-only mode coverage in the new e2e:** the broker's audit-only branch
  has unit coverage but no request-path coverage. A parameterised e2e that
  also runs with `auditOnly=true` and asserts the workload's placeholder
  header is *not* overwritten would close that gap.

## Acceptance criteria

- [ ] All chart template changes render cleanly under `helm template
      --set credentialInjection.mode=istio` for both `testFixture.enabled=true`
      and false, and the new integration test cases (`helm template — mode=istio`)
      pass.
- [ ] The "mode=sidecar (no Istio regression)" suite still passes unchanged.
- [ ] The job-runner unit tests for istio mode pass with the new placeholder
      substitution behaviour.
- [ ] The new e2e test passes on the `e2e-istio.yml` GitHub Actions workflow.
- [ ] `docs/superpowers/plans/2026-05-10-credential-injection-istio.md` has a
      "Superseded — 2026-05-13" addendum linking to this spec.
- [ ] `docs/CREDENTIAL_INJECTION.md` documents the http:// + `upstreamPort`
      pattern for `additionalDestinations`.
