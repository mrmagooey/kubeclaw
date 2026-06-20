# Channel Migration — Foundation + IRC Cutover (Design)

**Date:** 2026-06-20
**Status:** Design — pending plan
**Scope:** Sub-project 1 of the "migrate built-in channels to the runtime-delivery system" initiative.

## Goal

Make the generic KubeClaw image host **runtime-delivered channel adapters** under its existing `channel-runner.js` runtime, and cut the **irc** channel over to that path as the proving pilot — installed via the bootstrap flow, with its compiled-in code and `setup_channel`/Helm install path removed (clean cutover).

This sub-project delivers the **foundation** (a Channel SDK + the host's ability to load a runtime adapter + the Deployment host-selector) and proves it end-to-end on the smallest real channel. oauth-webchat and http are **separate, follow-on specs** that reuse this foundation unchanged.

## Background: why this exists

Today there are two divergent ways a channel pod runs (established by investigation, this session):

- **`setup_channel` path** (`src/skills/orchestrator/channel-setup.ts:408`): the channel's code is **compiled into the image** (`src/channels/{http,irc,oauth-webchat}.ts`, self-registering via `registerChannel` through `src/channels/index.ts`). The orchestrator creates a Secret + PVCs + a Deployment whose command is `node dist/channel-runner.js`. `channel-runner.ts` (~3,684 lines) is the **runtime host**: it boots SQLite, the GroupQueue + LLM message loop, Redis IPC watchers, health/metrics servers, schedulers, slash commands, then looks up the channel factory by `KUBECLAW_CHANNEL_TYPE` and connects it.
- **Bootstrap path** (`src/k8s/bootstrap-runner.ts`, `src/k8s/ipc-redis-bootstrap.ts`): the channel's code is **delivered at runtime** onto a `/runtime` PVC. The steady-state Deployment command is `node /app/channel-loader.js` — a 34-line stub (`container/agent-runner/channel-loader.js`) that only does `await import('/runtime/channel-entry.js')` and **provides none of the runtime host** (no DB, no message loop, no IPC, no health/metrics).

The recently shipped exec-push feature (on `main`) lets the orchestrator deterministically deliver real source files onto `/runtime` at `commit_channel_config` time. That solves *delivery*. What remains, to move a real channel (which needs the runtime host) onto the bootstrap path, is to **close the host gap** — without introducing a second "channel-base" image (the founding "single customisable image" intent forbids that).

The key insight: the generic image **already ships** `channel-runner.js` — the full host. So "channel-base" is not a new image; it is a new **role** for code already in the image. We keep the steady-state pod on `channel-runner.js` and teach it to also load a runtime-delivered adapter.

## Architecture decisions (settled during brainstorming)

1. **Single image, unified host.** Steady-state channel pods for SDK channels run `node dist/channel-runner.js` (the resident host). The host loads a runtime-delivered adapter from `/runtime/channel-entry.js` in addition to any compiled-in built-ins. The 34-line `channel-loader.js` stub remains only for "standalone" bootstrap channels (the echo demos) that bring their own server and want no host.
2. **Channel SDK via dependency injection.** The image exposes a curated, stable SDK surface. Because `/runtime` is mounted **read-only** at steady-state (and ESM ignores `NODE_PATH`), the host does **not** make the SDK resolvable as a bare specifier on `/runtime`. Instead the host **injects** the resident SDK object into the adapter: the adapter's module default-exports `register(sdk)`, and the host calls it with the in-process SDK singletons. The adapter's only runtime imports are its own npm deps; SDK **types** are a dev-time-only import (erased at runtime).
3. **Installation = the bootstrap flow.** A migrated channel is installed via `register_channel_manifest` + `register_bootstrap_skill` + `bootstrap_channel_from_skill`, with its adapter source delivered by exec-push (`helm/kubeclaw/files/channel-src/<type>/`). SDK adapters are thin source and fit the ~1 MB ConfigMap; no PVC-upload follow-up is needed.
4. **Clean cutover.** As each channel migrates, its compiled-in registration (`src/channels/index.ts` import), its `setup_channel` applicability, and its Helm `channels:` deploy-time install are **removed**. No dual in-image/runtime path is kept.
5. **Order:** irc → oauth-webchat → http, each its own spec. This spec = foundation + irc.

### Rejected alternatives

- **Separate `channel-base` image** — violates the single-image intent.
- **SDK as a bare-specifier import resolved via a `/runtime/node_modules/@kubeclaw/channel-sdk` symlink** — `/runtime` is read-only at steady-state, and the symlink would have to be created during bootstrap and point into the image filesystem; ESM resolution friction and fragility. Dependency injection avoids it entirely.
- **SDK shipped as a versioned npm package installed via the manifest** — would be a *separate copy*, not the resident in-process singletons (breaking the data-facade requirement that the adapter share the host's live DB handle and logger).
- **Self-contained esbuild bundle per channel** — native `better-sqlite3` can't be single-file bundled and http would blow the ConfigMap limit; unnecessary once the host stays resident.

## Components

### 1. Channel SDK — `src/channel-sdk/` (new), exposed to adapters as an injected object

A single curated module that re-exports the stable surface a channel adapter is allowed to use. For the irc pilot the surface is minimal; oauth/http will extend it (notably a data-access facade for http).

**Runtime object injected into adapters (`ChannelSdk`):**
- `registerChannel(name, factory)` — re-export of `src/channels/registry.ts`.
- `logger` — the resident pino instance (`src/logger.ts`).
- `readEnvFile(keys)` — `src/env.ts`.
- `assistantName: string` — the resident `ASSISTANT_NAME` constant (`src/config.ts`), passed as data (adapter does not import config.ts).

**Dev-time type surface (`@kubeclaw/channel-sdk` types):** `Channel`, `ChannelOpts`, `ChannelCapabilities`, `OnInboundMessage`, `OnChatMetadata`, `RegisteredGroup` (re-exported from `src/types.ts`), plus the `ChannelSdk` interface and the adapter entry signature. These are type-only; they vanish at runtime. The adapter source under `helm/kubeclaw/files/channel-src/irc/` is type-checked against these in the repo build.

**Adapter entry contract:** a runtime adapter module default-exports:
```ts
export default function register(sdk: ChannelSdk): void
```
which calls `sdk.registerChannel('<type>', (opts) => Channel | null)` exactly as a compiled-in channel does today.

**Responsibility boundary:** the SDK is the *only* thing an adapter may depend on from the image; everything else it needs is its own npm dependency (declared in its manifest). This makes the adapter's coupling explicit and the SDK independently reviewable.

### 2. `channel-runner.ts` — load a runtime adapter

In `main()`, after the existing compiled-in registration (`import './channels/index.js'`) and before the factory lookup (`getChannelFactory(KUBECLAW_CHANNEL_TYPE)`, ~`src/channel-runner.ts:3569`):

- If `/runtime/channel-entry.js` exists, `await import()` it, take its `default` export, and call `default(sdk)` with the constructed `ChannelSdk` object. The adapter self-registers into the same registry the factory lookup reads. Everything downstream (connect, IPC watchers, message loop) is unchanged.
- If the import fails or the module lacks a `register` default export, fail fast with a clear log (the pod crash-loops with an actionable message rather than silently running no channel).

A `loadRuntimeChannelAdapter(sdk, entryPath = '/runtime/channel-entry.js'): Promise<boolean>` helper (new, unit-testable) encapsulates the existence check, import, shape validation, and invocation. `main()` calls it; it returns whether an adapter was loaded.

### 3. Deployment host-selector

The bootstrap steady-state Deployment builder (`src/k8s/ipc-redis-bootstrap.ts`, currently command `['node','/app/channel-loader.js']`) gains a per-channel **host mode**:
- `channel-runner` (SDK channels: irc, later oauth/http) → command `['node','dist/channel-runner.js']`, with `/runtime` mounted read-only **and** the groups/store/sessions volumes the host needs (matching what `setup_channel` mounts today), and `KUBECLAW_CHANNEL_TYPE` set so the host's factory lookup resolves the registered adapter.
- `standalone` (echo demos) → unchanged command `['node','/app/channel-loader.js']`.

Host mode is declared per channel type. It is sourced from the channel's bootstrap skill frontmatter (a new `bootstrap.hostMode` field, default `standalone` for backward compatibility with the existing echo demos) and threaded through the bootstrap metadata to the commit handler that builds the Deployment.

### 4. IRC SDK adapter — `helm/kubeclaw/files/channel-src/irc/channel-entry.js`

A rewrite of `src/channels/irc.ts` (299 lines) as a self-registering adapter under the injected SDK. The transformation is mechanical because irc already receives all shared services as injected `ChannelOpts` callbacks and touches no DB/Redis directly:

- Today's cross-tree value imports map to the SDK: `logger`→`sdk.logger`, `readEnvFile`→`sdk.readEnvFile`, `ASSISTANT_NAME`→`sdk.assistantName`, `registerChannel`→`sdk.registerChannel`. Type imports become dev-time `@kubeclaw/channel-sdk` type imports.
- `irc-upd` becomes the adapter's sole npm dependency, declared in its manifest and installed by `npm ci` at bootstrap.
- The `IRCChannel` class body (connect/sendMessage/ownsJid/disconnect/handleMessage) is unchanged.
- Module default export is `register(sdk)`, which performs the `parseConfig()` gate and `sdk.registerChannel('irc', …)` call.

### 5. IRC bootstrap manifest + skill

- **Manifest** (`bootstrap.channelManifests.irc` / registered via `register_channel_manifest`): `package.json` declaring `irc-upd` at its current pinned version + a real `package-lock.json` + the sha256 `manifestHash` (computed by the canonical-hash routine the existing skills use).
- **Skill** (`helm/kubeclaw/files/bootstrap-skills/bootstrap-irc.md`): mirrors the slimmed `nanoid-echo` skill — stage package files, `npm ci --omit=dev --ignore-scripts`, gather IRC credentials interactively (`IRC_SERVER`, `IRC_PORT`, `IRC_NICK`, `IRC_CHANNELS`), `commit_channel_config`. Frontmatter: `channelType: irc`, `manifestVersion`, `hostMode: channel-runner`, `expectedQuestions` for the four IRC settings.

### 6. Clean-cutover removals (irc only, this spec)

- Remove the `irc` import from `src/channels/index.ts` so irc is no longer compiled-in/self-registered. (The `IRCChannel` source itself becomes the basis of the adapter under `files/channel-src/irc/` and is removed from `src/channels/` once the adapter is the source of truth — or retained only as the authoring source if the build copies it; the plan picks one, see Open question O1.)
- Remove/guard irc in `setup_channel`'s accepted types and credential builder so irc routes through the bootstrap flow.
- Update the Helm `channels:` handling and the live-test harness (`e2e/minikube-live-setup.ts`, which sets `channels.irc.*` + pre-creates the `kubeclaw-channel-irc` Secret) to install irc via the bootstrap flow instead of the deploy-time `channels:` block.

### 7. e2e harness update

The live suite already deploys a test IRC daemon (`kubeclaw-capability-test-ircd`) and an irc channel. This spec repoints irc installation to the bootstrap flow and adds an e2e that bootstraps irc end-to-end and asserts the channel connects to the test ircd and round-trips a message through the (real, resident) agent loop.

## Lifecycle / data flow (irc, post-migration)

```
admin: register_channel_manifest(irc, pkg, lock)         → SQLite + kubeclaw-channel-manifests ConfigMap
admin: register_bootstrap_skill(bootstrap-irc.md)        → SQLite + kubeclaw-bootstrap-skills ConfigMap
admin: bootstrap_channel_from_skill(bootstrap-irc)       → bootstrap Job (KUBECLAW_BOOTSTRAP_SKILL set)
  bootstrap Job (agent, /runtime RW):
    stage package.json/lock from manifest → npm ci → /runtime/node_modules/irc-upd
    ask_admin for IRC_SERVER/PORT/NICK/CHANNELS
    commit_channel_config(channel_type=irc, instance, secret_data, hostMode=channel-runner)
  orchestrator (commit handler):
    verify manifest hash (TOCTOU)
    exec-push helm/kubeclaw/files/channel-src/irc/* → /runtime   (exec-push, already built)
    create credentials Secret
    create steady-state Deployment: command `node dist/channel-runner.js`,
       /runtime read-only + groups/store/sessions volumes, KUBECLAW_CHANNEL_TYPE=irc
  steady-state pod (single image):
    channel-runner.main(): boot host (DB, IPC, health, metrics, message loop)
    loadRuntimeChannelAdapter(sdk): import /runtime/channel-entry.js; default(sdk)
       → adapter calls sdk.registerChannel('irc', factory)
    getChannelFactory('irc') → connect → IRC socket up; inbound → onMessage → agent loop
```

## Error handling

- **Missing/!-importable `/runtime/channel-entry.js` when host mode requires it:** `loadRuntimeChannelAdapter` throws a labelled error; the pod crash-loops with a clear message. (Contrast: today's `getChannelFactory` returning undefined warns and continues — for a runtime-adapter pod that is a hard failure.)
- **Adapter default export missing / not a function:** hard fail with the offending path and the expected `register(sdk)` contract in the message.
- **`parseConfig()` returns null (missing creds):** the factory returns `null` as today → host logs the channel disabled. Unchanged behavior.
- **Push failure at commit:** already handled by the exec-push feature (`CHANNEL_SOURCE_PUSH_FAILED`, no Deployment created).
- **SDK surface drift:** because the adapter type-checks against `@kubeclaw/channel-sdk` types in the repo build, a breaking SDK change fails the build, not a deployed pod.

## Testing

- **Unit:**
  - `channel-sdk` builds the injected object correctly (registerChannel/logger/readEnvFile/assistantName wired to the resident singletons).
  - `loadRuntimeChannelAdapter`: loads a fake adapter module and invokes its `register(sdk)`; missing file → false (when optional) / throws (when required); missing default export → throws; bad export shape → throws.
  - Deployment host-selector: `channel-runner` mode yields the right command + volume mounts + `KUBECLAW_CHANNEL_TYPE`; `standalone` mode unchanged.
- **Integration:** `channel-runner` host with the message loop wired, loading a real-but-trivial SDK adapter from a temp `/runtime`, routes an inbound message through `processGroupMessages` to a stubbed LLM runner and asserts the reply path — proving the injected-SDK adapter participates in the real host loop (not mocks).
- **e2e (minikube-live):** bootstrap irc via the bootstrap flow against the resident test ircd; assert the steady-state pod uses `channel-runner` command, the irc adapter connected, and a message sent to the test channel reaches the agent loop and a reply is delivered back to irc. The pre-existing in-image irc e2e is replaced by this bootstrap-path e2e (clean cutover).

## Scope boundaries

**In scope:** the Channel SDK (minimal surface for irc), `channel-runner` loading a runtime adapter, the Deployment host-selector, the irc adapter + manifest + skill, irc clean-cutover removals, irc e2e + harness repoint.

**Explicitly NOT in scope (follow-on specs):**
- oauth-webchat migration (reuses the foundation; adds `openid-client` manifest; no SDK extension expected).
- http migration (reuses the foundation; **requires extending the SDK with a data-access facade** for http's ~26 direct `db.ts` operations + the skills/diag REST surface; likely its own sub-decomposition).
- Retiring `channel-loader.js` entirely (it stays for standalone echo demos).
- The deferred runtime-upload (admin HTTP endpoint + per-file SQLite) from the exec-push spec — not needed here.

## Open questions for the plan

- **O1 — irc source-of-truth location.** After cutover, does the irc adapter source live only under `helm/kubeclaw/files/channel-src/irc/` (removed from `src/channels/`), or does `src/channels/irc.ts` remain the authoring source with a build step emitting the adapter? Recommendation: single source under `files/channel-src/irc/`, type-checked against the SDK types, `src/channels/irc.ts` deleted — simplest and matches "code is delivered, not compiled in." The plan confirms and handles the test file (`src/channels/irc.test.ts`) accordingly (port its unit assertions to the adapter location).
- **O2 — groups/store/sessions volumes for SDK steady-state pods.** Confirm the exact PVC set the `channel-runner` host requires (the investigation shows `setup_channel` mounts groups/store/sessions); the host-selector must provision/mount the same so the resident host's DB and attachment storage work. The plan enumerates them from `channel-setup.ts`.
- **O3 — `hostMode` plumbing.** Confirm the field flows skill frontmatter → bootstrap metadata → `commit_channel_config` payload → Deployment builder. The plan traces the exact structs.

## Success criteria

- irc is installed and runs exclusively via the bootstrap flow on the single generic image; no compiled-in irc registration remains; `setup_channel`/Helm-`channels` no longer install irc.
- The runtime irc adapter participates in the full resident host loop (real agent loop, real IPC), proven by the e2e message round-trip.
- The foundation (SDK + `loadRuntimeChannelAdapter` + host-selector) is reusable unchanged by the oauth and http specs.
- All three test levels pass.
