# Channel-Install Unification Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Collapse channel installation to ONE mechanism (deliver runtime adapter + create channel-runner Deployment) with two front-ends — interactive bootstrap (LLM dialogue) and declarative Helm (`channels:`) — by (a) deleting the dead `setup_channel` tool and (b) FIXING the Helm static path to stage the runtime adapter so its pods actually work. No more broken/dead install paths.

**Architecture:** After the channel migration, channels are runtime adapters loaded by `channel-runner.js` from `/runtime/channel-entry.js`. The bootstrap flow delivers that adapter (exec-push) + stages npm deps (init container) + creates the Deployment via `commit_channel_config`. The Helm static path (`channel-pods.yaml`, gated on `.Values.channels`) still runs `node dist/channel-runner.js` but delivers NO adapter, so its pods fail ("Channel factory returned null") — and 25 e2e tests + `setupTestCluster` depend on it. This plan makes the Helm pod stage its own `/runtime` (init container reads the `kubeclaw-channel-src` + `kubeclaw-channel-manifests` ConfigMaps → writes `channel-entry.js` + `package.json`/`-lock.json`, runs `npm ci`), making it a deterministic, LLM-free face of the same mechanism. `setup_channel` (enum lists only never-built channels, delivers no adapter) is deleted.

**Tech Stack:** TypeScript (Node 22), Helm, Vitest, the channel-runner runtime-adapter system.

## Global Constraints
- Node `>=20`; `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"` before npm/npx/git/helm.
- **Do NOT `git restore .` before committing.** Commit `--no-verify`; leave husky prettier drift on OTHER files.
- New/changed behaviour needs tests at the right level. The 25 e2e tests that `--set channels.http.enabled=true` MUST keep working (they're the behavioural proof the fixed Helm path delivers a working channel) — do NOT change them.
- **KEEP** `remove_channel`/`removeChannel` (still valid for any channel instance), and **KEEP** `patchRuntimePvc` + `waitForDeploymentRollout` in `channel-setup.ts` (used by the bootstrap upgrade path via `index.ts`). Only the `setup_channel`-specific code is removed.
- Channel pods keep `automountServiceAccountToken: false` and the restricted `channel` Redis ACL.
- Commit messages end with the repo `Co-Authored-By` trailer.

## Key facts (verified)
- `kubeclaw-channel-src` ConfigMap keys: `<type>__channel-entry.js` (e.g. `http__channel-entry.js`). Template: `helm/kubeclaw/templates/channel-src-configmap.yaml`.
- `kubeclaw-channel-manifests-baseline` ConfigMap keys: `<type>.json` = `{packageJson, packageLockJson, manifestHash, hostMode, httpPort}` (helm-created, always present — prefer over the runtime-reconciled `kubeclaw-channel-manifests` to avoid an ordering dependency).
- Bootstrap init-container template to mirror: `buildStageRuntimeInitContainer` in `src/k8s/bootstrap-runner.ts` (reads `/workspace/manifests/<type>.json`, writes package files to `/runtime`, `npm ci --prefix /runtime --omit=dev --ignore-scripts`). It does NOT copy `channel-entry.js` (bootstrap exec-pushes that) — the Helm init container MUST additionally copy the adapter from `kubeclaw-channel-src`.
- `loadRuntimeChannelAdapter` loads `/runtime/channel-entry.js` (DEFAULT_ENTRY); returns false if absent.
- Channel type for a Helm channel = `$cfg.type | default $name`.
- `.Values.channels` is iterated by 5 templates: `channel-pods.yaml`, `serviceaccounts.yaml`, `secrets.yaml`, `storage.yaml`, `metrics-servicemonitor.yaml` (those STAY — only channel-pods.yaml gains the staging).

---

## Task 1: Delete the dead `setup_channel` tool + its `channel-setup.ts` functions

**Files:**
- Modify: `src/admin-shell.ts` (remove the `setup_channel` tool schema, the dispatch `case 'setup_channel'`, `handleSetupChannel`, the `setupChannel` import, and the "Call setup_channel" guidance in the admin system-prompt ~line 2502)
- Modify: `src/skills/orchestrator/channel-setup.ts` (remove `setupChannel`, `buildSecretData`, `validateChannelCredentials`, `createOrPatchSecret`, `createPvcIfNotExists`, `createOrReplaceDeployment` — verified none used by the bootstrap path; KEEP `patchRuntimePvc`, `waitForDeploymentRollout`)
- Modify: `src/skills/orchestrator/channel-setup.test.ts` (remove tests for the removed functions; keep `patchRuntimePvc`/`waitForDeploymentRollout` tests)
- Check: `src/index.ts` imports only `patchRuntimePvc`/`waitForDeploymentRollout` from channel-setup (must stay green)

**Interfaces:** removes the `setup_channel` admin tool entirely; `remove_channel` stays.

- [ ] Grep first: `grep -rn "setup_channel\|setupChannel\|buildSecretData\|validateChannelCredentials\|createOrPatchSecret\|createPvcIfNotExists\|createOrReplaceDeployment" src/` — enumerate every reference. Confirm (re-verify) none of the removed functions are imported by `index.ts`/`ipc-redis-bootstrap.ts`/any non-setup code. If any IS shared, KEEP it and note in the report.
- [ ] Remove the `setup_channel` tool object from the tools array, the dispatch case, `handleSetupChannel`, and the `setupChannel` import in `admin-shell.ts`. Remove the channel-setup functions listed above. Trim the admin system-prompt so it no longer instructs "Call setup_channel" (point channel install at the bootstrap flow / declarative helm instead — keep it brief, match surrounding prose).
- [ ] Remove the now-dead tests in `channel-setup.test.ts` (and any `admin-shell` test asserting `setup_channel`). Do NOT weaken unrelated assertions.
- [ ] `npx tsc --noEmit` clean; `npm test` green (3 known container/agent-runner failures excepted). Commit: `refactor(channels): remove dead setup_channel tool (delivered no adapter; enum was never-built channels)`.

---

## Task 2: Fix `channel-pods.yaml` to stage the runtime adapter (the declarative face)

**Files:**
- Modify: `helm/kubeclaw/templates/channel-pods.yaml`
- Reference: `src/k8s/bootstrap-runner.ts` (`buildStageRuntimeInitContainer`), `helm/kubeclaw/templates/channel-src-configmap.yaml`, `channel-manifests-configmap.yaml`

**Behaviour:** when a Helm channel pod starts, an init container must populate `/runtime` with the adapter + its npm deps so `node dist/channel-runner.js` → `loadRuntimeChannelAdapter('/runtime/channel-entry.js')` succeeds.

Add to the channel pod spec (inside the `range $name, $cfg` block):
1. A `runtime` `emptyDir` volume.
2. Volume mounts of the two ConfigMaps for the init container:
   - `channel-src` → `kubeclaw-channel-src` (keys `<type>__channel-entry.js`)
   - `channel-manifests` → `kubeclaw-channel-manifests-baseline` (keys `<type>.json`)
3. A `stage-runtime` init container (BEFORE `fix-permissions`, or after — order vs fix-permissions doesn't matter since they touch different paths), image = the orchestrator image (same as the main container), that:
   - Writes the adapter: copy the `kubeclaw-channel-src` key `<type>__channel-entry.js` → `/runtime/channel-entry.js`.
   - Writes the manifest package files: read `<type>.json` from the manifests mount, write `m.packageJson`→`/runtime/package.json`, `m.packageLockJson`→`/runtime/package-lock.json` (mirror `buildStageRuntimeInitContainer`'s node -e).
   - `npm ci --prefix /runtime --omit=dev --ignore-scripts`.
   - The channel TYPE comes from a Helm-templated env var `KUBECLAW_CHANNEL_TYPE: {{ $cfg.type | default $name }}` (no shell interpolation of the type into the node script — read it from env, exactly like the bootstrap init container).
   - Note: ConfigMap keys use `__` not `/`; the channel-src mount exposes files named `http__channel-entry.js`, so the copy reads `/workspace/channel-src/<type>__channel-entry.js`. (A ConfigMap volume mounts each key as a file of that literal name.)
4. Mount `runtime` at `/runtime` on the MAIN `channel` container (so the loaded adapter + its node_modules are visible at runtime).

- [ ] Implement the init container + volumes + main-container `/runtime` mount in `channel-pods.yaml`. Keep everything else (command, env, probes, Service, NetworkPolicy, httpPort handling) unchanged.
- [ ] `helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml --set channels.http.enabled=true --set channels.http.type=http --set channels.http.httpPort=4080 --show-only templates/channel-pods.yaml` renders: a `stage-runtime` init container, the `channel-src`/`channel-manifests` volumes, and the main container's `/runtime` mount. Paste the rendered init container in the report.
- [ ] Verify the existing render-only `helm template` still succeeds for the whole chart (no YAML errors): `helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml --set channels.http.enabled=true >/dev/null && echo OK`.
- [ ] Commit: `fix(helm): stage the runtime adapter in channel-pods so the declarative install delivers a working channel`.

**Risk flag (for the validation task):** the init container runs `npm ci`, which needs npm-registry egress from the channel pod — the same requirement the bootstrap path already relies on. If the e2e clusters restrict egress, the pod's init may fail; if validation surfaces that, add a channel-pod egress allowance (mirror how bootstrap pods get egress) — but do NOT pre-emptively add it; confirm the need first.

---

## Task 3: Update the render-only template tests

**Files:**
- Modify: `e2e/helm-chart-template.test.ts`

- [ ] The tests at lines ~439/536/1072 `--set channels.http.enabled=true` and assert on the rendered channel pod. Update any assertion that the new init container / `/runtime` volume would break, and ADD an assertion that the rendered http channel pod now includes the `stage-runtime` init container + the `channel-src` volume (locks in the fix). Do NOT change unrelated render assertions.
- [ ] Run these template tests: `npm run test:e2e -- helm-chart-template` (render-only, no cluster). Green. Commit: `test(e2e): assert channel-pods renders the runtime-adapter staging init container`.

---

## Task 4: Validate the fixed declarative install on a live cluster

**Files:** (validation only — may add a throwaway script under `/tmp`, not committed)

- [ ] On minikube (available): build/load the orchestrator + agent images if needed (`eval $(minikube docker-env)` per the ops notes), `helm install`/`upgrade` the chart into a scratch namespace with `--set channels.http.enabled=true --set channels.http.type=http --set channels.http.httpPort=4080 --set channels.http.envVars[0].name=HTTP_CHANNEL_USERS --set channels.http.envVars[0].key=users` (+ a pre-created `kubeclaw-channel-http` secret with `users=alice:livepass`, mirroring how `e2e/lib/per-test-cluster.ts` does it).
- [ ] Assert: the `kubeclaw-channel-http` pod reaches Ready (the init container staged `/runtime/channel-entry.js` + npm ci succeeded; channel-runner loaded the adapter). If the pod CrashLoops, get the init + main container logs (`kubectl logs ... -c stage-runtime`, `kubectl logs deploy/kubeclaw-channel-http`) and root-cause (npm egress? wrong configmap key? missing /runtime mount?) per systematic-debugging.
- [ ] Assert the channel serves: port-forward `svc/kubeclaw-channel-http` and `curl /healthz` (200) + an authed `GET /version` (200). This proves the declarative install now yields a working channel.
- [ ] If a representative `setupTestCluster`-based test can be pointed at minikube cheaply, run one (e.g. a small one) as extra proof; otherwise the install-and-curl above + the existing 25 tests (run in CI against this path) are the coverage. Document what was validated where. Clean up the scratch namespace.
- [ ] Final: `npm test` green, `npx tsc --noEmit` clean, full chart `helm template` renders.

---

## Final verification
- [ ] `npm test` (unit) green; `npx tsc --noEmit` clean; `npm run test:e2e -- helm-chart-template` green; full `helm template` renders with and without `channels.http.enabled`.
- [ ] Live: the declarative `channels.http.enabled` install yields a Ready, serving http channel pod on minikube (Task 4).
- [ ] No remaining references to `setup_channel`/`setupChannel`/`buildSecretData` in `src/`.
- [ ] Final whole-branch review (Opus) → merge to main. End state: ONE install mechanism; the dead `setup_channel` gone; the Helm declarative path repaired (deterministic, LLM-free); the bootstrap flow unchanged (interactive). The 25 e2e tests + `setupTestCluster` work against the repaired path.

## Self-review notes
- Spec coverage: dead-tool removal (T1); the load-bearing fix — Helm pod stages the adapter (T2); render-test lock-in (T3); live proof (T4).
- Type/name consistency: ConfigMap names `kubeclaw-channel-src` / `kubeclaw-channel-manifests-baseline`; keys `<type>__channel-entry.js` / `<type>.json`; adapter path `/runtime/channel-entry.js`; type source `$cfg.type | default $name`. The init container reads type from `KUBECLAW_CHANNEL_TYPE` env (no shell interpolation).
- KEEP list honored: `remove_channel`, `patchRuntimePvc`, `waitForDeploymentRollout`, the 5 `.Values.channels` templates, the 25 e2e tests.
- This is the user-approved "one mechanism, two front-ends" option (interactive bootstrap + repaired declarative Helm); it deliberately does NOT remove the Helm `channels:` path.
