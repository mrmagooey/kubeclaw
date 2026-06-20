# Channel Migration — oauth-webchat Cutover (Sub-Project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Migrate `oauth-webchat` to the runtime-delivered SDK-adapter / channel-runner host path built in SP1, and extend the channel-runner Deployment builder to support **httpPort channels** (Service + ports + probes + ingress NetworkPolicy) — the first channel-runner channel that serves HTTP.

**Architecture:** Reuses SP1's foundation unchanged (Channel SDK, `loadRuntimeChannelAdapter`, host-selector, deterministic init container, orchestrator image for channel-runner). Adds: (1) an optional `httpPort` field on the channel manifest, carried like `hostMode`; (2) the commit handler, in channel-runner mode with an httpPort, also emits container ports + liveness/readiness probes and creates a ClusterIP Service + ingress NetworkPolicy. oauth-webchat is rewritten as an SDK adapter (mirrors the irc adapter; `openid-client` npm dep), installed via the bootstrap flow, with its compiled-in/`setup_channel`/Helm-`channels` paths removed.

**Tech Stack:** TypeScript (Node 22), `@kubernetes/client-node`, Vitest, Helm, the SP1 bootstrap system, `openid-client`.

## Global Constraints

- Node `>=20`. Run npm/npx/git with Node 22 on PATH: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- **Do NOT `git restore .` before committing** (it discards uncommitted work — an SP1 mishap). Commit with `--no-verify` to avoid prettier-hook noise; if the hook leaves drift on *other* files, leave it (don't restore).
- All new behaviour needs unit + integration + e2e coverage.
- **Standalone echo channels and irc must remain unaffected** — every httpPort/Service addition is gated on `channelRunnerMode && hasHttpPort`.
- Channel pods keep `automountServiceAccountToken: false` and use the restricted `channel` Redis ACL (SP1).
- oauth gotchas: `OAUTH_WEBCHAT_PUBLIC_URL` is the externally-reachable redirect base (NOT in-cluster DNS); `OAUTH_WEBCHAT_OIDC_ISSUER` is the in-cluster provider URL; `OAUTH_WEBCHAT_COOKIE_SECRET` must be ≥32 chars.
- Commit messages end with the repo `Co-Authored-By` trailer.

---

## Task 1: `httpPort` on the channel manifest

**Files:**
- Modify: `src/channel-manifests/reconciler.ts` (entry type + `BaselineFileContent` + `renderChannelManifestConfigMapData` to carry `httpPort`)
- Modify: `src/skills/orchestrator/channel-manifest-registry.ts` (accept optional `http_port`; SQLite column; validate 1024–65535)
- Modify: `src/admin-shell.ts` (`register_channel_manifest` tool schema + handler forward `http_port`)
- Modify: `helm/kubeclaw/templates/channel-manifests-configmap.yaml` (emit `httpPort`)
- Test: the corresponding `.test.ts` files

**Interfaces:**
- Produces: each manifest ConfigMap entry JSON gains optional `"httpPort": <number>`. Reader: `JSON.parse(cm.data['<type>.json']).httpPort` (undefined if absent).

Mirror exactly how `hostMode` was added in SP1 (commits `d539d7f`, `1d587a2`, `dd0c59b`). Steps: failing tests (reconciler carries httpPort; registry persists/validates; admin tool forwards it) → implement (entry type `httpPort?: number`; `renderChannelManifestConfigMapData` includes `httpPort` when present; registry `http_port` arg + `http_port INTEGER` column with schema-guard + range validation; admin tool `http_port` number property + forward) → pass → `helm template` renders. Commit.

---

## Task 2: Commit handler — httpPort Service, ports, probes, NetworkPolicy

**Files:**
- Modify: `src/k8s/ipc-redis-bootstrap.ts` (`CommitChannelConfigDeps` + the channel-runner Deployment branch)
- Modify: `src/index.ts` (wire `getChannelHttpPort`, `createService`, `createNetworkPolicy`)
- Test: `src/k8s/ipc-redis-bootstrap.test.ts`

**Interfaces:**
- Consumes: manifest `httpPort` (Task 1).
- Produces, on `CommitChannelConfigDeps`:
  - `getChannelHttpPort(channelType: string): Promise<number | null>` (reads the manifest ConfigMap entry's `httpPort`, null if absent/unreadable).
  - `createService(body: V1Service): Promise<void>` (idempotent create-or-replace).
  - `createNetworkPolicy(body: V1NetworkPolicy): Promise<void>` (idempotent create-or-replace).
- Behaviour: in `channelRunnerMode`, read `httpPort = await deps.getChannelHttpPort(channel_type)`. If non-null:
  - Container `ports: [{ name: 'http', containerPort: httpPort }, { name: 'health', containerPort: 9090 }]`.
  - `livenessProbe: { httpGet: { path: '/liveness', port: 'health' }, initialDelaySeconds: 15, periodSeconds: 30, failureThreshold: 3, timeoutSeconds: 5 }`.
  - `readinessProbe: { httpGet: { path: '/readyz', port: 'http' }, initialDelaySeconds: 5, periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 5 }`.
  - After `createDeployment`, `await deps.createService(...)` — ClusterIP, name `kubeclaw-channel-<instance>`, selector `app: kubeclaw-channel-<instance>`, `ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }]`.
  - `await deps.createNetworkPolicy(...)` — name `kubeclaw-channel-<instance>-ingress`, podSelector `app: kubeclaw-channel-<instance>`, `policyTypes: ['Ingress']`, `ingress: [{ from: [], ports: [{ protocol: 'TCP', port: httpPort }] }]`.
- For channel-runner channels WITHOUT httpPort (irc) and for standalone: no ports/probes/Service/NetworkPolicy (unchanged — gate on `httpPort != null`).

Mirror the exact field shapes from `helm/kubeclaw/templates/channel-pods.yaml` (ports lines 139–150, probes 151–177, Service 237–252, NetworkPolicy 215–236). Wire the three deps in `src/index.ts` using the existing `coreApi`/`networkingApi` (add `networkingApi = kc.makeApiClient(NetworkingV1Api)` if not present) with the same NotFound-create/409-replace idempotency pattern as `createPvc`/`createDeployment`.

- [ ] Failing unit tests (extend the channel-runner test): with `getChannelHttpPort → 4080`, the built Deployment has the `http`/`health` ports + readiness `/readyz:http` + liveness `/liveness:health`, and `createService`/`createNetworkPolicy` are called with the right names/ports; with `getChannelHttpPort → null` (irc case) none of these appear and the two deps are NOT called; standalone unchanged.
- [ ] Implement; wire deps in index.ts.
- [ ] `npx tsc --noEmit` + `npx vitest run src/k8s/ipc-redis-bootstrap.test.ts` pass. Commit.

---

## Task 3: oauth-webchat SDK adapter (+ SDK `groupsDir`)

**Files:**
- Modify: `src/channel-sdk/index.ts` (add `groupsDir: string` to `ChannelSdk` + `buildChannelSdk`, sourced from `GROUPS_DIR`)
- Modify: `src/channel-sdk/index.test.ts` (assert `groupsDir`)
- Create: `helm/kubeclaw/files/channel-src/oauth-webchat/channel-entry.js`
- Create: `src/channel-src/oauth-webchat-adapter.test.ts`

**Interfaces:** adapter default-exports `register(sdk)` calling `sdk.registerChannel('oauth-webchat', factory)`.

- [ ] Add `groupsDir` to the SDK (the irc adapter doesn't use it; oauth does — `GROUPS_DIR` for attachment storage). Test it's wired to the resident `GROUPS_DIR`.
- [ ] Create the adapter from `src/channels/oauth-webchat.ts` (read it), applying the irc-style transformation: only runtime import is `import { Issuer } from 'openid-client'`; `logger`→`sdk.logger`, `readEnvFile`→`sdk.readEnvFile`, `GROUPS_DIR`→`sdk.groupsDir`; thread `sdk` via the channel constructor; remove TS types; default-export `register(sdk)`. Channel HTTP-server/OIDC/cookie logic unchanged. `node --check` valid.
- [ ] Port the meaningful pure-logic unit assertions from `src/channels/oauth-webchat.test.ts` (allowed-emails matching, cookie sign/verify, parseConfig validation incl. the ≥32-char cookie secret) driving the adapter via a fake sdk. No real network/OIDC.
- [ ] `node --check`, the adapter test, `helm template … channel-src-configmap.yaml | grep oauth-webchat__channel-entry.js`, tsc. Commit.

---

## Task 4: oauth-webchat bootstrap manifest + skill

**Files:**
- Modify: `helm/kubeclaw/values-minikube.yaml` (`bootstrap.channelManifests.oauth-webchat`)
- Create: `helm/kubeclaw/files/bootstrap-skills/bootstrap-oauth-webchat.md`

- [ ] Generate a real lockfile: scratch dir `npm i --package-lock-only --omit=dev openid-client@<repo-pinned version>` (read the version from `node_modules/openid-client/package.json`). Manifest `package.json` = `{"name":"oauth-webchat-runtime","version":"1.0.0","dependencies":{"openid-client":"<ver>"}}`. Compute `manifestHash` with the canonical-sha256 routine (bootstrap skill Step from any existing skill). Add the entry with `hostMode: channel-runner` AND `httpPort: 4080`. Re-verify the hash from the embedded bytes equals `manifestHash`.
- [ ] Write `bootstrap-oauth-webchat.md` mirroring the slimmed `bootstrap-irc.md` (init container stages + npm ci; the skill only gathers creds + commits). Frontmatter `channelType: oauth-webchat`, `manifestVersion: "1"`, `expectedQuestions` for the OIDC settings. The skill gathers, validates, and commits `secret_data` = `{ OAUTH_WEBCHAT_PUBLIC_URL, OAUTH_WEBCHAT_OIDC_ISSUER, OAUTH_WEBCHAT_CLIENT_ID, OAUTH_WEBCHAT_CLIENT_SECRET, OAUTH_WEBCHAT_ALLOWED_EMAILS, OAUTH_WEBCHAT_COOKIE_SECRET }` (validate cookie secret ≥32; note PUBLIC_URL is external, OIDC_ISSUER is in-cluster). Use ONE combined ask_admin (the reliable single-question pattern from SP1) gathering all settings.
- [ ] Verify hash match + frontmatter parses + `helm template` renders. Commit.

---

## Task 5: Clean cutover — remove compiled-in oauth + setup_channel oauth

**Files:**
- Modify: `src/channels/index.ts` (remove `import './oauth-webchat.js';`)
- Delete: `src/channels/oauth-webchat.ts`, `src/channels/oauth-webchat.test.ts`, `src/channels/oauth-webchat.integration.test.ts` (port any unique coverage into the adapter test first)
- Modify: `src/skills/orchestrator/channel-setup.ts` (remove the oauth-webchat `buildSecretData` branch)
- Modify: `src/admin-shell.ts` (remove `oauth-webchat` from the `setup_channel` type enum if present)

- [ ] Remove the import + the source files + the setup_channel branch/enum entry. Hunt for and fix dangling references (grep `oauth-webchat` in src/, fix any compiled-in registration test expectation; do NOT touch http or irc).
- [ ] `npx tsc --noEmit` clean (no dangling import) + `npx vitest run` green (3 known container/agent-runner failures excepted). Confirm the ported oauth adapter test still covers the logic. Commit.

---

## Task 6: Repoint the live harness to bootstrap oauth-webchat

**Files:**
- Modify: `e2e/minikube-live-setup.ts`

- [ ] **Remove** the `kubeclaw-channel-oauth-webchat` Secret pre-create + the `--set channels.oauth-webchat.*` install args. **Keep** the `capabilities.test-oauth` install and `startTestOauthPortForward()` + `startOauthWebchatPortForward()` (the latter still targets `svc/kubeclaw-channel-oauth-webchat:80` — now bootstrap-created). **Add** oauth-webchat to the `--set-json bootstrap.channelManifests` (with `hostMode:channel-runner`, `httpPort:4080`, the Task-4 package strings + hash) and a `--set-file bootstrap.skills.bootstrap-oauth-webchat=...`.
- [ ] The harness no longer helm-installs oauth at deploy time, so the steady-state pod (and its Service) appear only after the e2e bootstraps it. Adjust any `waitForPod('app=kubeclaw-channel-oauth-webchat')` in global setup that assumed deploy-time install — move that readiness expectation into the bootstrap e2e (the pod won't exist until bootstrapped). Confirm via `tsc` + `helm template`. Commit.

---

## Task 7: oauth-webchat bootstrap e2e

**Files:**
- Create: `e2e/minikube-live-channel-oauth-bootstrap.test.ts` (model on `minikube-live-channel-irc-bootstrap.test.ts` + the existing `minikube-live-oauth-webchat.test.ts` for the OIDC flow assertions)
- Handle: the existing `e2e/minikube-live-oauth-webchat.test.ts` — if it assumed deploy-time install, either repoint it or supersede it with the new bootstrap test (port its OIDC-flow coverage).

- [ ] Drive bootstrap of `bootstrap-oauth-webchat` via the admin shell (single combined answer with the test-oauth values: PUBLIC_URL=`http://127.0.0.1:<oauth port-forward>`, OIDC_ISSUER=`http://kubeclaw-capability-test-oauth:8080`, client-id/secret=test values, allowed-emails=`alice@test.local`, a ≥32-char cookie secret). Assert (hard): AC1 bootstrap Job; AC3 channel-runner Deployment (`node dist/channel-runner.js`, orchestrator image, httpPort ports + readiness `/readyz`, the Service + ingress NetworkPolicy exist, pod Ready); AC4 the channel serves `/readyz` 200 via the port-forward AND the OIDC login redirect works (mirror the existing oauth-webchat test's flow). Include the AC3 channel-pod-log-dump-on-not-Ready diagnostic from SP1.
- [ ] Run: `npm run test:minikube-live -- minikube-live-channel-oauth-bootstrap`. Validate on a clean namespace (per SP1 ops notes: confirm `kubeclaw-live` is gone before a fresh run; KEEP=1 only when diagnosing, and clean up after). Commit.

---

## Final verification

- [ ] `npx vitest run` all pass; `npx tsc --noEmit` clean.
- [ ] `helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml >/dev/null` renders.
- [ ] E2E: `npm run test:minikube-live -- minikube-live-channel-oauth-bootstrap minikube-live-channel-irc-bootstrap minikube-live-bootstrap-channel-http-echo` — oauth (channel-runner+httpPort), irc (channel-runner no-httpPort), http-echo (standalone) all green — proves the host-selector across all three shapes.
- [ ] Final whole-branch review (Opus) → merge to main.

## SP1 ops lessons (apply here)
- Shared `kubeclaw-live` namespace: `KEEP=1` leaves it dirty → next run inherits stale state → spurious early failures. Validate from a confirmed-gone namespace; after a KEEP diagnostic run, run no-KEEP (or clean leftovers) before the next validation.
- The bootstrap dialogue is reliable with ONE combined ask_admin question (not multiple).
- The AC3 channel-pod log-dump on not-Ready is the fastest way to diagnose channel-runner pod crashes.
- Never `git restore .` before a commit.

## Self-review notes
- Spec coverage: httpPort foundation (T1/T2) — the new reusable work; oauth adapter (T3); manifest+skill (T4); cutover (T5/T6); e2e (T7). httpPort gated so irc/echoes unaffected.
- Type consistency: `getChannelHttpPort`/`createService`/`createNetworkPolicy` signatures identical in the `CommitChannelConfigDeps` extension (T2) and the `index.ts` wiring (T2); `httpPort` literal carried T1→T2; `groupsDir` on `ChannelSdk` defined T3, used by the oauth adapter.
- SP3 (http) will reuse T1/T2 (httpPort support) unchanged — http is also a channel-runner httpPort channel (the big one, needs the SDK data-facade for its db imports — a separate spec).
