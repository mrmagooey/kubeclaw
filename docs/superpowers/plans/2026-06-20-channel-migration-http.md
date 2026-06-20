# Channel Migration — http Cutover (Sub-Project 3, final) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Migrate `http` (the last compiled-in channel, ~4202 lines) to the runtime-delivered SDK-adapter / channel-runner host path, by adding a **typed SDK data-facade** (user-approved Option B) so the adapter keeps all its REST endpoints without importing host db/skill modules.

**Architecture:** Reuses the SP1/SP2 foundation unchanged (Channel SDK + `loadRuntimeChannelAdapter`, host-selector, deterministic init container, orchestrator image for channel-runner, httpPort Service/probes/NetworkPolicy + RBAC). The NEW work is a **data-facade on the Channel SDK**: ~22 typed db pass-throughs (grouped `sdk.history.*`, `sdk.tasks.*`, `sdk.jobs.*`, `sdk.audit.*`, `sdk.diag`), the 5 skill-store filesystem fns (`sdk.skills.*`), config constants (`sdk.config.*`), and one targeted helper replacing the raw `db` handle. `http.ts` is then a mechanical port to `channel-entry.js` (swap `db.X`→`sdk.<group>.X`, `config.X`→`sdk.config.X`), installed via the bootstrap flow, with compiled-in/`setup_channel`/Helm-`channels` http removed.

**Tech Stack:** TypeScript (Node 22), `@kubernetes/client-node`, Vitest, Helm, the SP1/SP2 bootstrap+httpPort system, `cron-parser` (http's only npm dep).

## Global Constraints
- Node `>=20`; run npm/npx/git with Node 22 on PATH: `export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- **Do NOT `git restore .` before committing** (it discards uncommitted work — a prior mishap). Commit with `--no-verify`; leave husky prettier drift on OTHER files.
- All new behaviour needs unit + integration + e2e coverage. **The existing http REST e2es (http-channel, jobs-http, memory-http, schedule-http, search-http, secrets-http, skills-http, capabilities-http, minikube-live-http-misc) MUST still pass** against the bootstrapped channel — they are the behavioural safety net for the 4202-line port.
- httpPort channel-runner channel (port 4080), like oauth. Restricted `channel` Redis ACL. `automountServiceAccountToken: false`.
- **irc, oauth, and standalone echoes must remain untouched** — the SDK facade is additive; the host-selector gates unchanged.
- Commit messages end with the repo `Co-Authored-By` trailer.

## SP2 ops lessons (apply here)
- Reused/KEEP namespace → stale orchestrator reconcile + accumulated state → spurious early failures. The harness now rolls the orchestrator after helm upgrade (SP2 `8027a05`); still validate from a confirmed-clean namespace when possible, and clean `kubeclaw/channel=e2e-http` leftovers between runs.
- httpPort channel-runner needs: Service/netpol bodies WITHOUT hardcoded metadata.namespace (SP2 `e2376d5`); orchestrator RBAC for networkpolicies (SP2 `2046913`, already on main); the e2e port-forward must target the bootstrap instance Service name `kubeclaw-channel-<instance>` (SP2 fix).
- Bootstrap dialogue: ONE combined ask_admin question; the poster must retry on 429 (admin /chat per-user inProgress) — copy the SP2 oauth test's `postChatAndCollectReply`.
- The AC3 channel-pod log-dump-on-not-Ready diagnostic is the fastest crash triage.

---

## Task 1: SDK data-facade (the contract everything else depends on)

**Files:**
- Modify: `src/channel-sdk/index.ts` (extend `ChannelSdk` + `buildChannelSdk`)
- Modify: `src/channel-sdk/index.test.ts`
- Create: `src/channel-sdk/data-facade.ts` (the typed facade impl, wiring db + skill-store + config) — keeps index.ts small
- Reference (do NOT modify): `src/db.ts`, `src/runtime/skill-store.ts`, `src/config.ts`

**Interfaces — add to `ChannelSdk`** (exact shapes; signatures from `src/db.ts` — read it for the precise param/return types and re-export the row types):
```ts
config: {
  timezone: string; rateLimitWindowMs: number; storeDir: string;
  toolJobsRetentionDays: number; defaultModel: string; debugEndpointsEnabled: boolean;
};
history: {
  getPage(groupFolder, opts?): ConversationHistoryPageRow[];
  getAll(groupFolder, username): ConversationExportRow[];
  getById(id, groupFolder): ConversationHistoryRow | null;
  search(args): SearchResult[];
  getOutboundSince(chatJid, sinceTimestamp, limit?): Pick<NewMessage,'id'|'content'|'timestamp'>[];
  append(groupFolder, role, content): void;
  update(id, content, groupFolder): boolean;
  deleteById(id, groupFolder): boolean;
  deleteBefore(groupFolder, before): number;
  clear(groupFolder): void;
  storeOutbound(msg): void;                              // wraps storeMessageDirect
  groupFolderForMessage(id): string | null;              // replaces the raw db.exec at http.ts:1886
};
tasks: { create; getForGroup; getById; deleteForGroup; pause; resume; getRunLogs; };
jobs: { active(); recentForGroup(groupFolder, limit); byIdForGroup(jobId, groupFolder); insertForDebug(args); };
audit: { write(args); entries(groupFolder, limit?); };
diag(groupFolder): DiagSnapshot;                         // wraps getDiagSnapshot(groupFolder, sdk.config.storeDir, sdk.groupsDir)
skills: { listAccepted(group); listCandidates(group); listArchived(group); accept(group,id); reject(group,id); };  // root = sdk.groupsDir bound internally
```
- `buildChannelSdk()` wires each to the real db/skill-store/config functions (the host has them in-process). `diag` and `skills.*` bind `storeDir`/`groupsDir` internally so the adapter never passes paths.
- `groupFolderForMessage` runs the single targeted query (`SELECT group_folder FROM conversation_history WHERE id = ?`) — exposed so the adapter never touches the raw `db` handle.

- [ ] Write failing tests in `index.test.ts`: `buildChannelSdk()` returns an sdk whose `history.getPage`/`tasks.create`/`jobs.active`/`audit.write`/`diag`/`skills.listAccepted` are functions; `sdk.config` has the 6 constants sourced from `src/config.ts` (assert identity for timezone/storeDir, types for the rest); `history.diag` and `skills.*` are pre-bound (callable with just group args). Use a temp/in-memory db or stub the db module per the existing test style.
- [ ] Implement `data-facade.ts` + wire into `buildChannelSdk`. Re-export the db row types from the SDK so the adapter's JSDoc/types resolve. `npx tsc --noEmit` clean. Tests pass. Commit: `feat(channel-sdk): typed data-facade (history/tasks/jobs/audit/diag/skills/config)`.

---

## Task 2: http SDK adapter (the large mechanical port)

**Files:**
- Create: `helm/kubeclaw/files/channel-src/http/channel-entry.js` (from `src/channels/http.ts`, 4202 lines)
- Create: `src/channel-src/http-adapter.test.ts`
- Reference: `helm/kubeclaw/files/channel-src/oauth-webchat/channel-entry.js` (the transform template)

**Transform (NO behaviour change):**
- Only runtime third-party import: `import { CronExpressionParser } from 'cron-parser';` (http's sole npm dep). Keep node builtins.
- Replace host-module VALUE imports with sdk:
  - `db.appendConversationMessage`→`sdk.history.append`, `getConversationHistoryPage`→`sdk.history.getPage`, `getAllConversationHistory`→`sdk.history.getAll`, `getMessageById`→`sdk.history.getById`, `updateConversationMessage`→`sdk.history.update`, `deleteMessageById`→`sdk.history.deleteById`, `deleteConversationHistoryBefore`→`sdk.history.deleteBefore`, `clearConversationHistory`→`sdk.history.clear`, `searchConversations`→`sdk.history.search`, `getOutboundMessagesSince`→`sdk.history.getOutboundSince`, `storeMessageDirect`→`sdk.history.storeOutbound`; the raw `db.exec(...)` at line 1886 → `sdk.history.groupFolderForMessage(msgId)`.
  - tasks: `createTask`→`sdk.tasks.create`, `getTasksForGroup`→`sdk.tasks.getForGroup`, `getTaskById`→`sdk.tasks.getById`, `deleteTaskForGroup`→`sdk.tasks.deleteForGroup`, `pauseTask`→`sdk.tasks.pause`, `resumeTask`→`sdk.tasks.resume`, `getTaskRunLogs`→`sdk.tasks.getRunLogs`.
  - jobs: `getActiveToolJobs`→`sdk.jobs.active`, `getRecentToolJobsForGroup`→`sdk.jobs.recentForGroup`, `getToolJobByIdForGroup`→`sdk.jobs.byIdForGroup`, `insertToolJobForDebug`→`sdk.jobs.insertForDebug`.
  - audit: `writeAuditEntry`→`sdk.audit.write`, `getAuditEntries`→`sdk.audit.entries`.
  - `getDiagSnapshot(group, STORE_DIR, GROUPS_DIR)`→`sdk.diag(group)`.
  - skill-store: `listAcceptedSkills/listCandidates/listArchived/acceptCandidate/rejectCandidate` → `sdk.skills.*` (drop the root arg — pre-bound).
  - config: `ASSISTANT_NAME`→`sdk.assistantName`, `GROUPS_DIR`→`sdk.groupsDir`, `TIMEZONE`→`sdk.config.timezone`, `RATE_LIMIT_WINDOW_MS`→`sdk.config.rateLimitWindowMs`, `STORE_DIR`→`sdk.config.storeDir`, `TOOL_JOBS_RETENTION_DAYS`→`sdk.config.toolJobsRetentionDays`, `DEBUG_ENDPOINTS_ENABLED`→`sdk.config.debugEndpointsEnabled`, `DEFAULT_DIRECT_MODEL`→`sdk.config.defaultModel`; `logger`→`sdk.logger`, `readEnvFile`→`sdk.readEnvFile`.
- Thread `sdk` via the channel constructor (store `this.sdk`); `parseConfig` takes `sdk`. Remove TS types/interfaces. Default-export `register(sdk)` calling `sdk.registerChannel('http', (opts)=> { const cfg = parseConfig(sdk); if(!cfg) return null; return new HttpChannel(cfg, opts, sdk); })`. Keep ALL endpoints/auth/rate-limit/SSE/attachment logic identical. `node --check` valid.
- The `HttpChannelOpts` test-injection overrides (checkDb, killJobFn, listSecretsFn, addSecretFn, getCapabilities, …) stay as opts (host provides them) — they are NOT part of the sdk facade.

- [ ] Port the file. `node --check` passes. Port the meaningful pure-logic unit assertions from `src/channels/http-channel.test.ts` into `http-adapter.test.ts` driving the adapter via a fake sdk (auth/rate-limit/routing/ownsJid; stub sdk.history/tasks/jobs/audit). `helm template … channel-src-configmap.yaml | grep http__channel-entry.js`. `npx tsc --noEmit`. Commit: `feat(channel-http): http as an SDK runtime adapter (data-facade consumer)`.

---

## Task 3: http bootstrap manifest + skill

**Files:** Modify `helm/kubeclaw/values-minikube.yaml`; create `helm/kubeclaw/files/bootstrap-skills/bootstrap-http.md`.
- [ ] Generate the lockfile: scratch `npm i --package-lock-only --omit=dev cron-parser@<repo-pinned version>` (read from `node_modules/cron-parser/package.json`). Manifest `package.json` = `{"name":"http-runtime","version":"1.0.0","dependencies":{"cron-parser":"<ver>"}}`. Compute `manifestHash` (canonical-sha256, copy from bootstrap-oauth-webchat.md). Add the `http:` entry to `bootstrap.channelManifests` with `hostMode: channel-runner` AND `httpPort: 4080`. **Re-verify** the recomputed hash from embedded bytes == manifestHash, and `helm template … channel-manifests-configmap.yaml` shows http with hostMode+httpPort.
- [ ] Create `bootstrap-http.md` mirroring `bootstrap-oauth-webchat.md` (init container stages; skill gathers creds + commits with ONE combined ask_admin). Frontmatter `channelType: http`, `manifestVersion: "1"`. secret_data gathers http's config (HTTP_CHANNEL_USERS `user:pass,...`, optional HTTP_CHANNEL_PORT, HTTP_CHANNEL_CORS_ORIGIN, the rate-limit/attachment envs as needed — read http's `parseConfig` for the exact env var names + which are required). Commit: `feat(channel-http): http bootstrap manifest (channel-runner, httpPort 4080, cron-parser) + skill`.

---

## Task 4: Clean cutover — remove compiled-in http + setup_channel http

**Files:** Modify `src/channels/index.ts` (remove `import './http.js'`); `git rm src/channels/http.ts` + the unit test `src/channels/http-channel.test.ts` (after porting its logic coverage to the adapter test in T2 — confirm coverage preserved first); `src/skills/orchestrator/channel-setup.ts` (remove http `buildSecretData` branch); `src/admin-shell.ts` (remove `http` from the `setup_channel` type enum).
- [ ] Remove + hunt stragglers (`grep -rn "channels/http" src/`; fix any import of the deleted module). Adjust ONLY http-specific compiled-in-registration assertions in `src/channels/index.test.ts` (http now registers at runtime). Do NOT touch irc/oauth or the http REST *integration* test files (jobs-http etc. — those exercise endpoints, not the import; they still run against the channel). `npx tsc --noEmit` clean; `npx vitest run` green (3 known container/agent-runner failures excepted). Commit: `refactor(channel-http): clean cutover — remove compiled-in http + setup_channel http`.

---

## Task 5: Repoint the live harness to bootstrap http

**Files:** Modify `e2e/minikube-live-setup.ts`.
- [ ] REMOVE the `--set channels.http.*` install args + any `kubeclaw-channel-http` Secret pre-create. ADD http to `--set-json bootstrap.channelManifests` (hostMode channel-runner, httpPort 4080, T3 package strings + hash — match the irc/oauth escaping) and `--set-file bootstrap.skills.bootstrap-http=...`. The steady-state http channel + its Service now appear only after the e2e bootstraps it.
- [ ] **Critical:** the http port-forward (`KUBECLAW_LIVE_HTTP_LOCAL_PORT`, currently `svc/kubeclaw-channel-http`) must target the bootstrap instance Service `kubeclaw-channel-<instance>` (mirror SP2's oauth port-forward fix). Pick the http bootstrap INSTANCE_NAME (e.g. `e2e-http`) and point the port-forward at `svc/kubeclaw-channel-e2e-http`. REMOVE the global-setup `waitForPod('app=kubeclaw-channel-http')` + its rollout-restart (the pod won't exist until bootstrapped); the many http REST e2e files rely on `KUBECLAW_LIVE_HTTP_*` reaching the channel — ensure they still resolve to the bootstrapped Service. (If those REST e2es assume http exists at global-setup time, they must run after a bootstrap; assess whether the http bootstrap e2e (T6) should run first / set up the channel for them, or whether global setup should bootstrap http itself. Document the chosen sequencing.) `tsc` + `helm template` render. Commit: `test(e2e): install http via bootstrap flow, not helm channels block`.

---

## Task 6: http bootstrap e2e + preserve the REST e2e suite

**Files:** Create `e2e/minikube-live-channel-http-bootstrap.test.ts` (model on `minikube-live-channel-oauth-bootstrap.test.ts`).
- [ ] AC1 bootstrap Job; AC1b dialogue (single combined answer, 429-retry poster); AC3 channel-runner Deployment (`node dist/channel-runner.js`, orchestrator image, groups/store/sessions mounts, httpPort ports/probes, Service `kubeclaw-channel-e2e-http`, ingress NetworkPolicy, pod Ready) + the AC3 log-dump diagnostic; AC4 the channel serves `/healthz`/`/version` 200 via the port-forward AND a representative authed REST call (e.g. `GET /history`) works through the bootstrap-created Service.
- [ ] Confirm the existing http REST e2es (jobs-http, memory-http, schedule-http, search-http, secrets-http, skills-http, capabilities-http, minikube-live-http-misc) still pass against the bootstrapped channel (this is the real proof the 4202-line port preserved behaviour). Run: `npm run test:minikube-live -- minikube-live-channel-http-bootstrap` then the REST suite (or the whole http group). Validate from a clean namespace; clean `kubeclaw/channel=e2e-http` leftovers between runs. Commit: `test(e2e): http bootstrapped end-to-end + REST suite green against bootstrap channel`.

---

## Final verification
- [ ] `npx vitest run` all pass; `npx tsc --noEmit` clean; `helm template … -f values-minikube.yaml >/dev/null` renders.
- [ ] E2E: http bootstrap e2e + the http REST suite green; a host-selector sanity (http + oauth + irc) optional.
- [ ] Final whole-branch review (Opus) → merge to main. **This completes the channel migration: all of irc/oauth/http are runtime-delivered; no compiled-in channels remain; single image.**

## Self-review notes
- Spec coverage: data-facade (T1, the approved Option-B core); http adapter port (T2); manifest+skill (T3); cutover (T4); harness (T5); e2e + REST-suite preservation (T6).
- Type consistency: the `sdk.history/tasks/jobs/audit/diag/skills/config` shapes defined in T1 are consumed verbatim in T2; the db row types are re-exported from the SDK so the adapter resolves them.
- Risk: T2 is a very large mechanical port (4202 lines) — the behavioural net is the existing http REST e2e suite (T6), which must stay green. If a subagent can't hold the whole file, split T2 by endpoint-group across sequential commits (history/tasks/jobs/audit/diag/skills/chat-core) but keep it ONE adapter file.
- After T6 green, the migration initiative is complete; consider deleting the now-unused helm `channels:` install path for http/oauth/irc if fully dead (separate cleanup).
