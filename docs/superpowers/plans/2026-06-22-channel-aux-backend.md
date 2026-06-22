# Channel Auxiliary Backend (per-channel sidecar) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development to implement task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Add an optional `sidecar` field to the channel manifest, rendered as a per-channel backend container (+ session PVC) in the channel pod; migrate Signal off the bespoke shared `kubeclaw-signal-cli` StatefulSet onto it.

**Architecture:** The manifest gains `sidecar`. The orchestrator Deployment builder and the declarative Helm path render a 2nd container + a `-auxsession` PVC and point the adapter at `http://localhost:<port>`. `remove_channel` reaps the PVC. Signal becomes the first consumer.

**Tech Stack:** TypeScript (orchestrator + manifest registry), plain-JS channel adapter, Helm templates, vitest.

## Global Constraints
- `sidecar` is valid ONLY when `host_mode === 'channel-runner'`.
- Session PVC name: exactly `kubeclaw-channel-<instance>-auxsession`.
- The channel's own `/runtime` mount stays **read-only**; only the sidecar's session PVC is RW.
- Adapter stays dependency-less; the manifest hash for `signal` MUST be recomputed and re-verified after any manifest change.
- Do NOT `git restore`. Commit each task with `--no-verify`. nvm: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- Reuse existing patterns: mirror how `http_port` flows through the same files.

---

### Task 1: Manifest schema + validation for `sidecar`
**Files:**
- Modify: `src/skills/orchestrator/channel-manifest-registry.ts` (`RegisterArgs` ~L34, `OverrideRow` ~L42, validator ~L116)
- Modify: `src/channel-manifests/reconciler.ts` (the manifest type carrying `hostMode`/`httpPort`)
- Test: `src/skills/orchestrator/channel-manifest-registry.test.ts` (or the existing registry test file)

**Interfaces — Produces:**
```ts
interface SidecarSpec {
  image: string;
  port: number;
  sessionMountPath: string;
  sessionStorageGi: number;
  env?: { name: string; value: string }[];
  healthPath?: string;
  egressPorts?: number[];
}
// added optional `sidecar?: SidecarSpec` to RegisterArgs, OverrideRow, and the reconciler manifest type
```

**Steps:**
- [ ] Write failing tests: (a) a valid `sidecar` with `host_mode:'channel-runner'` passes; (b) `sidecar` with `host_mode:'standalone'` (or default) → validation error mentioning channel-runner; (c) missing required subfield (`image`/`port`/`sessionMountPath`/`sessionStorageGi`) → error; (d) `port` out of 1–65535 → error; (e) `egressPorts` containing a non-1..65535 value → error.
- [ ] Run tests → fail.
- [ ] Add `SidecarSpec` + `sidecar?` to `RegisterArgs`/`OverrideRow` + the reconciler manifest type; add validation (after the existing `host_mode` validation): require channel-runner, require subfields, range-check `port`/`egressPorts`, non-empty `image`.
- [ ] Run tests → pass. tsc clean.
- [ ] Commit: `feat(channels): add sidecar field to channel manifest schema + validation`.

---

### Task 2: Deployment builder renders the sidecar + session PVC
**Files:**
- Modify: `src/k8s/ipc-redis-bootstrap.ts` (`processCommitChannelConfig`: the `channelRunnerMode` `extraVolumes` ~L423, the `containers` array ~L540, env ~L548, and the `createPvc` calls)
- Test: the existing bootstrap test (`src/k8s/ipc-redis-bootstrap.test.ts` or equivalent — find it)

**Interfaces — Consumes:** `SidecarSpec` (Task 1). The commit flow already resolves the manifest; thread `sidecar` to the builder.

**Steps:**
- [ ] Write failing tests against the built `V1Deployment` when the manifest has a `sidecar`: (a) `spec.template.spec.containers` has 2 entries; the 2nd has the sidecar `image`, `ports:[{containerPort: port}]`, the `env`, and (if `healthPath`) readiness+liveness `httpGet{path,port}`; (b) a volume + volumeMount for `kubeclaw-channel-<inst>-auxsession` at `sessionMountPath` (RW) on the sidecar; (c) the channel container env includes the adapter API-URL var pointed at `http://localhost:<port>` (for signal: `SIGNAL_API_URL`); (d) when manifest has NO sidecar, exactly 1 container + no auxsession PVC. Also assert `createPvc('kubeclaw-channel-<inst>-auxsession', sessionStorageGi)` is invoked when sidecar present.
- [ ] Run → fail.
- [ ] Implement: when `sidecar` present, push the 2nd container, add the auxsession entry to `extraVolumes` (claimName `kubeclaw-channel-<inst>-auxsession`, mount on the SIDECAR not the channel container), call `createPvc` for it, and add the `localhost` API-URL env to the channel container. Keep the API-URL var name configurable/derived (for signal: `SIGNAL_API_URL` — acceptable to special-case the env var name keyed off channel type, OR add an optional `apiUrlEnv` to SidecarSpec; pick the simpler — document the choice).
- [ ] Run → pass. tsc clean.
- [ ] Commit: `feat(channels): render manifest sidecar as a per-channel backend container + session PVC`.

**Decision to make + record in the task report:** whether the adapter's API-URL env var name is special-cased by type (`signal → SIGNAL_API_URL`) or declared in the manifest (`sidecar.apiUrlEnv`). Prefer the manifest field (general) unless it complicates Task 5 — flag the choice.

---

### Task 3: `remove_channel` deletes the aux session PVC
**Files:**
- Modify: `src/skills/orchestrator/channel-remove.ts` (the anchored PVC regex in `listInstancePvcNames`)
- Test: `src/skills/orchestrator/channel-remove.test.ts`

**Steps:**
- [ ] Write a failing test: an instance with a `kubeclaw-channel-<i>-auxsession` PVC → `remove_channel` records `persistentvolumeclaim/kubeclaw-channel-<i>-auxsession` deleted; cross-instance safety still holds (`http` ≠ `http-staging`).
- [ ] Run → fail.
- [ ] Extend the regex to `^kubeclaw-channel-<i>-(groups|store|sessions|runtime|auxsession)(-v\d+)?$`.
- [ ] Run → pass.
- [ ] Commit: `fix(channels): remove_channel reaps the per-channel auxsession PVC`.

---

### Task 4: Declarative Helm path renders the sidecar
**Files:**
- Modify: `helm/kubeclaw/templates/channel-pods.yaml` (2nd container when the type's manifest has `sidecar`), `helm/kubeclaw/templates/storage.yaml` (the auxsession PVC), `helm/kubeclaw/templates/networkpolicies.yaml` (egress on `sidecar.egressPorts`)
- Test: a `helm template` integration check (extend an existing helm-render test or add a focused one)

**Steps:**
- [ ] Write a failing render assertion: with a channel whose `bootstrap.channelManifests.<type>.sidecar` is set, `helm template` for `channel-pods.yaml` emits the 2nd container (image/port/env/probe), `storage.yaml` emits the auxsession PVC, `networkpolicies.yaml` emits egress on the sidecar ports. (Use the signal manifest from Task 5, or a fixture sidecar.)
- [ ] Run → fail.
- [ ] Implement the templating (read `sidecar` from the type's manifest in values; guard each block on its presence).
- [ ] Run → pass. `helm template ... -f values-minikube.yaml` renders cleanly.
- [ ] Commit: `feat(helm): declarative channel pods render a manifest sidecar + session PVC + egress`.

---

### Task 5: Migrate Signal onto the sidecar abstraction
**Files:**
- Modify: `helm/kubeclaw/values.yaml` + `values-minikube.yaml` (`bootstrap.channelManifests.signal.sidecar`; DELETE the `signalCli` block)
- Delete: `helm/kubeclaw/templates/signal-cli.yaml`
- Modify: `helm/kubeclaw/templates/networkpolicies.yaml` (remove the bespoke `channel → kubeclaw-signal-cli` egress rule)
- Modify: `helm/kubeclaw/files/channel-src/signal/channel-entry.js` (`SIGNAL_API_URL` default → `http://localhost:8080`)
- Modify: `helm/kubeclaw/files/bootstrap-skills/bootstrap-signal.md` (per-instance linking)
- Test: `src/channel-src/signal-adapter.test.ts` (the localhost default), the registry/render tests pick up the signal sidecar

**Steps:**
- [ ] Write/adjust failing tests: signal adapter's `parseConfig` defaults `apiUrl` to `http://localhost:8080` when unset; a render test shows the signal channel pod has the signal-cli sidecar + auxsession PVC + 443 egress and NO `kubeclaw-signal-cli` StatefulSet output.
- [ ] Run → fail.
- [ ] Add `sidecar` to the signal manifest (image `bbernhard/signal-cli-rest-api:<PIN A REAL TAG>`, port 8080, sessionMountPath `/home/.local/share/signal-cli`, sessionStorageGi 5, env `[{MODE: native}]`, healthPath `/v1/health`, egressPorts `[443]`); change the adapter default; delete `signal-cli.yaml` + the `signalCli` values + the bespoke egress rule; rewrite `bootstrap-signal.md` to per-instance linking (port-forward into the channel pod, `/v1/qrcodelink` or register, session on the per-channel PVC).
- [ ] **Recompute + re-verify the signal manifest hash** (the `sidecar` field is part of the canonical manifest). Confirm HASH MATCH.
- [ ] Run → pass. `node --check` the adapter; tsc clean; `helm template -f values-minikube.yaml` renders, no `signal-cli` StatefulSet remains.
- [ ] Commit: `feat(channel-signal): migrate to per-channel signal-cli sidecar; drop shared StatefulSet`.

---

### Task 6: Documentation — the channel-with-external-backend category
**Files:**
- Modify: `docs/DEVELOPING_A_CHANNEL.md` (new section: the category + the `sidecar` manifest field, Signal as the worked example), `docs/INSTALLING_A_CHANNEL.md` (Signal per-instance linking)

**Steps:**
- [ ] Add the "Channels with an external backend (sidecar)" section: when to use it, the `sidecar` manifest field reference (each subfield), the per-channel-sidecar topology, the localhost wiring, the per-instance linking + the stateful-pod/egress caveats. Cross-link from the Signal mentions.
- [ ] Verify every claim against the code shipped in Tasks 1–5 (field names, the localhost URL, the PVC name).
- [ ] Commit: `docs: channel-with-external-backend category + sidecar manifest field`.

---

### Task 7: E2e regression — sidecar rendering + lifecycle
**Files:**
- Create: `e2e/minikube-live-channel-sidecar.test.ts` (or extend the declarative install/remove test)

**Steps:**
- [ ] Write the test: declaratively install a `channel-runner` channel whose manifest declares a `sidecar` using a LIGHTWEIGHT stand-in image (e.g. a tiny HTTP server like `hashicorp/http-echo` or a busybox httpd — NOT real signal-cli, so no account needed). Assert: the channel pod reaches Ready with **2 containers**, the `kubeclaw-channel-<inst>-auxsession` PVC exists, and `remove_channel` deletes the full set INCLUDING `-auxsession` (no orphans). Explicitly comment that this validates rendering+lifecycle, NOT a live Signal round-trip.
- [ ] Run it on the live minikube (`KUBECLAW_LIVE_KEEP=1 npm run test:minikube-live -- minikube-live-channel-sidecar`) until green (rebuild/redeploy as the setup does). Fix any real bugs it surfaces.
- [ ] Commit: `test(e2e): sidecar-bearing channel install + remove regression`.

---

## Self-review notes
- Task ordering respects deps: 1 (schema) → 2,3,4 (consumers) → 5 (signal, needs 1/2/4) → 6 (docs, needs 1–5) → 7 (e2e, validates 2/3/4). 5 and 4 are coupled (the render test in 4 can use signal's manifest from 5, or a fixture — 4 uses a fixture to stay independent).
- Open implementation decision flagged in Task 2: the API-URL env var name (manifest `apiUrlEnv` vs type special-case) — implementer picks + reports.
- Manifest-hash recompute is called out explicitly in Task 5 (the one easy-to-miss gotcha).
