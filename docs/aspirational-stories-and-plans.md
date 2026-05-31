# Aspirational user stories, gap analysis, and remediation plans

Three forward-looking user stories that the current KubeClaw system **cannot yet deliver**, along with the gaps that block them and a tight implementation plan per gap.

Unlike `user_stories.md` (which assumes the system already supports each story), this document deliberately targets capability gaps.

- **Story A:** Researcher subagent for low airfares
- **Story B:** Reminder delivered to the channel in 3 days
- **Story C:** Personalized restaurant recommendation with multi-turn refinement

## Index of plans

Gaps are consolidated across stories — current-time injection and per-group user profile are shared between Stories B and C.

| #  | Plan                                                                                | Closes gaps in |
|----|-------------------------------------------------------------------------------------|----------------|
| 1  | [Inject current wall-clock time into LLM context](#plan-1-inject-current-wall-clock-time-into-llm-context) | B, C           |
| 2  | [Per-group structured user profile](#plan-2-per-group-structured-user-profile)      | B, C           |
| 3  | [Structured-results web-search backend](#plan-3-structured-results-web-search-backend) | A              |
| 4  | [Baseline Researcher specialist](#plan-4-baseline-researcher-specialist)            | A              |
| 5  | [Per-specialist tool budgets](#plan-5-per-specialist-tool-budgets)                  | A              |
| 6  | [Immediate ConfigMap apply for specialist overrides](#plan-6-immediate-configmap-apply-for-specialist-overrides) | A              |
| 7  | [Reminder LLM UX](#plan-7-reminder-llm-ux)                                          | B              |
| 8  | [Missed-fire regression tests for once-tasks](#plan-8-missed-fire-regression-tests-for-once-tasks) | B              |
| 9  | [Places-search tool](#plan-9-places-search-tool)                                    | C              |
| 10 | [Recommendation execution pattern](#plan-10-recommendation-execution-pattern)       | C              |

---

# Story A: Researcher subagent searches for cheap flights and returns a summary to the channel

**As a** user mid-conversation in a KubeClaw channel
**I want** to @mention a "researcher" specialist, give it a flight-search task (e.g. "@researcher find me cheap flights SFO→NRT in mid-August, summarise options"), and receive a formatted summary of flight options posted back to my conversation
**So that** I can get aggregated travel intelligence from an autonomous research agent without leaving the channel or writing a single line of code

### Acceptance criteria

1. Typing `@researcher find me cheap flights SFO→NRT in mid-August, summarise options` in any KubeClaw channel causes the channel pod to detect the `@researcher` mention, match it against a registered `Researcher` specialist (name or trigger), and dispatch a `DirectLLMRunner` invocation with the specialist's system prompt and `tools: ["web_search", "web_fetch"]` as the tool allowlist.
2. The specialist LLM invokes `web_search` and/or `web_fetch` one or more times; each tool call is executed by a browser-category tool pod spawned in the `kubeclaw` namespace, with the pod receiving internet egress via the credential-injection subsystem (sidecar or istio mode) or directly where `credentialInjection.mode=off`.
3. After completing its research (within the specialist's active deadline), the specialist returns a natural-language summary listing at least price, airline, and travel time for ≥2 distinct flight options, and that summary is sent to the originating chat as a single message prefixed `[@Researcher]`.
4. The specialist's reply is appended to the group's `conversation_history` table (via `storeMessage`) so it is visible in subsequent `/search` queries and skill-curator scans.
5. If the web search or fetch tool pod fails (network timeout, DNS error, or non-2xx response), the specialist surfaces a graceful error message to the user rather than silently dropping the request; the `specialist_usage` table row records `status='error'` and a non-empty `error_message`.
6. The specialist invocation completes or times out within `CONTAINER_TIMEOUT` (default 30 min); on timeout the user sees a "timed out" notice identical in format to the existing `formatTimeoutNotice` for tool jobs.
7. After the conversation turn completes, `SELECT * FROM specialist_usage WHERE specialist_name='Researcher'` in the channel pod's SQLite database contains a row for the invocation with correct `group_folder`, non-zero `duration_ms`, and `status='success'`.

### Notes for the test author

- Specialist dispatch path: `src/channel-runner.ts` → `detectMentionedSpecialists` (`src/specialists.ts`) → parallel `runOne()` → `DirectLLMRunner.runAgent()` in `src/runtime/direct-llm-runner.ts`. Specialist overrides including `toolFilter` are built at `src/channel-runner.ts` lines 2672–2678.
- The `Researcher` specialist must be registered in `values.yaml` under `specialists:` with `tools: ["web_search", "web_fetch"]`; or added at runtime via `register_specialist` in the admin shell (`src/skills/orchestrator/specialist-registry.ts`). The merged catalog reaches channel pods via the `kubeclaw-specialists` ConfigMap and is hot-reloaded by `src/specialists/catalog-loader.ts`.
- `web_search` and `web_fetch` are both defined in `src/runtime/direct-llm-runner.ts` (TOOLS list) and implemented in `container/agent-runner/src/tool-server.ts` (`toolWebSearch`, `toolWebFetch`). Both map to the `browser` tool-pod category via `TOOL_CATEGORY` (line 380–382 in `direct-llm-runner.ts`).
- `web_search` is currently implemented as a DuckDuckGo HTML scrape — assert on the *structure* of the specialist reply (contains prices, routes, airlines), not on specific DuckDuckGo HTML output.
- Typing indicator is set with `channel.setTyping?.(chatJid, true)` before specialist dispatch and cleared after (lines 2699, 2790 of `channel-runner.ts`).
- Telemetry: `recordSpecialistUsage` is called in the `finally` block of `runOne()` (lines 2758–2764).
- E2E pattern to follow: `e2e/minikube-live.test.ts` for POST + SSE reply; `e2e/alpine-tool-execution.test.ts` for tool-pod spawn verification.

status: drafted

---

# Story B: User-requested reminder delivered to the originating channel

**As a** user chatting with KubeClaw mid-conversation
**I want** to say "remind me to renew my passport in 3 days" and have the assistant confirm a scheduled reminder, then receive that reminder as an unprompted message in the same channel 3 days later
**So that** I don't have to leave the conversation or use a separate reminder app — the assistant acts as a trusted time-delayed messenger inside my existing channel

### Acceptance criteria

1. When the user says anything semantically equivalent to "remind me to X in N days/hours/minutes" (or "remind me at \<wall-clock time\>"), the LLM calls `schedule_task` with `schedule_type: "once"` and a valid ISO-8601 UTC `schedule_value` that matches the user's expressed intent. The fire time must be computed relative to the wall-clock time visible in the conversation context, accounting for the system timezone (`TIMEZONE` from `src/config.ts`).
2. Within the same conversation turn, the assistant replies with a human-readable confirmation that echoes back the reminder text and the computed fire time in the user's local timezone — e.g. "I'll remind you to renew your passport on Friday, May 31 at 10:23 AM (America/New_York)."
3. The reminder row is persisted in the `scheduled_tasks` table in the orchestrator's SQLite database before the confirmation reply is sent to the user. If the orchestrator pod is killed and restarted at any point before the fire time, the task survives because it was loaded from the SQLite file on startup.
4. At the computed fire time (within one scheduler poll interval, default 60 s), the orchestrator's scheduler loop picks up the task and calls `runAgent` with the task's prompt. The agent's response — the reminder text — is forwarded by `deps.sendMessage` through the appropriate delivery path: in orchestrator mode, via the `kubeclaw:messages:<group_folder>` Redis pub/sub channel to the relevant channel pod, which then delivers it to the user without any inbound trigger from the user.
5. The reminder message appears in the channel (e.g. Telegram, HTTP SSE, IRC) as an unprompted outbound message. It is persisted in the channel pod's `messages` table with `is_from_me=1, is_bot_message=1`. The message body is a plain-language reminder — e.g. "Reminder: renew your passport." — not a raw JSON dump or a tool-call log.
6. After the reminder fires, the task's `status` in `scheduled_tasks` is updated to `completed` and `next_run` is set to `null`. The task must not fire a second time.
7. The user can cancel the pending reminder before it fires by saying "cancel my reminder" (or equivalent), causing the LLM to call `cancel_task` with the correct task ID, and the orchestrator to delete the row. After cancellation the user receives a confirmation.
8. If the orchestrator pod is down at the exact moment the `next_run` timestamp passes but restarts within a reasonable window (up to 24 h later), the task fires on the first scheduler poll after restart because `getDueTasks()` returns any row where `next_run <= now` regardless of how long ago that was.

### Notes for the test author

- **Unit tests**: test `scheduleTaskDirect` in `src/runtime/direct-llm-runner.ts` with a mocked Redis client; test `computeNextRun` in `src/task-scheduler.ts` returns `null` for `schedule_type: "once"`.
- **Integration tests**: use `_initTestDatabase` + `createTask` + `getDueTasks` to exercise the scheduler loop end-to-end with a real in-memory SQLite database.
- **End-to-end tests**: extend the minikube-live or kind-cluster suite. Post "remind me to X in 10 seconds" via the HTTP channel; poll `scheduled_tasks` via `GET /schedule`; wait 60s and verify the SSE stream shows a bot-authored reminder message.
- Natural language → ISO date resolution happens inside the LLM turn — requires the current time being present in context (see Plan 1).
- Task delivery path (orchestrator mode): `startSchedulerLoop deps.sendMessage` → `getRedisClient().publish(getOutputChannel(group.folder), ...)` → `startIpcWatcher sendMessage` in `channel-runner.ts` → `ch.sendMessage(jid, text)`.
- Per-group task limit (`MAX_TASKS_PER_GROUP`, default 3) applies.
- Deduplication check in `startTaskRequestWatcher` (`src/k8s/ipc-redis.ts:1296-1314`) will block an exact duplicate.

status: drafted

---

# Story C: Personalized restaurant recommendation with multi-turn refinement

**As a** user mid-conversation in a channel
**I want** to ask "where should I eat tonight?" and receive a restaurant suggestion that takes into account my known food preferences (cuisine, dietary restrictions, price range), my location, and the current time of day, and to be able to narrow that suggestion in follow-up turns ("something cheaper", "no Thai")
**So that** I get useful, personalized local dining advice without having to repeat context I have already shared with the assistant

### Acceptance criteria

1. When the user sends a message containing a restaurant/dining request, the assistant reads a structured preference record (per-group profile in SQLite — see Plan 2) that includes cuisine likes, dietary restrictions, and budget tier, and the recommendation excludes any cuisine or ingredient flagged as disliked or restricted — e.g. if preferences record "no shellfish", the recommended place is not a shellfish-centric restaurant.
2. The assistant resolves the user's location (from the stored profile record, or from a location mentioned in the current turn) and supplies it as a geographic constraint to the places search — the recommendation is for a restaurant near that location, not a generic suggestion.
3. The current local time (derived from the explicitly-injected `current_time` context — see Plan 1) is used to filter results: if the user asks at 10 AM, only places open for breakfast or brunch are surfaced; if at 7 PM, dinner-service venues are preferred.
4. The response cites at least one concrete place: name, address, a brief why-it-fits note, and an approximate price tier — not just a generic description of the cuisine.
5. When the user follows up with a refinement ("something cheaper" / "no Thai"), the next recommendation respects both the original constraints and the new constraint — the second recommendation has a lower price tier than the first (for "cheaper"), or excludes the named cuisine (for "no X"), and the conversation history driving this refinement is the same `conversation_history` SQLite session already used for the group.
6. If no location is known and the user has not mentioned one in the current turn, the assistant asks for a location before searching rather than guessing or returning a generic city-agnostic suggestion.
7. The entire exchange — user request, assistant recommendation, user refinement, assistant follow-up — is stored in `conversation_history` under the group's `group_folder`, so a later session can recall "the Thai place you recommended last Tuesday".

### Notes for the test author

- The system prompt is loaded from `groups/{group}/CLAUDE.md` in `src/runtime/direct-llm-runner.ts` (`loadSystemPrompt`, line 862). Per-group structured preferences live in SQLite via Plan 2.
- Timezone is already wired: `TIMEZONE` is exported from `src/config.ts` and injected as the `<context timezone="..."/>` XML header by `formatMessages` in `src/router.ts`. Current wall-clock time is added by Plan 1.
- Multi-turn refinement relies on `conversation_history` in SQLite, which the `DirectLLMRunner` persists on every turn via `appendConversationMessage` and reads at the start of each turn via `getConversationHistory`. No new plumbing for refinement once a valid first turn exists.
- The places search capability is built in Plan 9.
- Regression test for "no shellfish": seed the profile, run the recommendation turn, assert the assistant response does not mention oysters/clams/mussels/shrimp. Cheaper-refinement test: capture the price tier from turn 1, send "something cheaper", assert turn 2 price tier is strictly lower.

status: drafted

---

# Gap synthesis

Ten distinct gaps emerged across the three stories. Two were duplicated (current-time injection in Stories B & C; per-group profile fields in Stories B & C) and have been consolidated.

| Gap                                                                         | Story A | Story B | Story C |
|-----------------------------------------------------------------------------|:-------:|:-------:|:-------:|
| 1. Current wall-clock time not explicitly injected into the LLM context     |         |   ✓     |   ✓     |
| 2. No structured per-group user profile (timezone, location, preferences)   |         |   ✓     |   ✓     |
| 3. `web_search` is a DuckDuckGo HTML scrape — no structured results         |   ✓     |         |         |
| 4. No baseline `Researcher` specialist registered in the Helm chart         |   ✓     |         |         |
| 5. No per-specialist tool-round / output-bytes budget                       |   ✓     |         |         |
| 6. `register_specialist` does not apply the `kubeclaw-specialists` ConfigMap immediately |   ✓     |         |         |
| 7. `schedule_task` description + system prompt lack reminder UX guidance    |         |   ✓     |         |
| 8. Missed-fire semantics for once-tasks are correct but untested            |         |   ✓     |         |
| 9. No places-search tool or external dining-API credential                  |         |         |   ✓     |
| 10. No recommendation execution pattern (preferences + places + refinement) |         |         |   ✓     |

---

# Plan 1: Inject current wall-clock time into LLM context

**Goal:** Add a `current_time` attribute to the `<context>` header emitted by `formatMessages` so the LLM always has an explicit, fresh ISO-8601 timestamp with timezone offset — never persisted in history.

**Affected files:**
- `src/router.ts`
- `src/timezone.ts`
- `src/routing.test.ts`
- `src/channel-runner.ts` (two call sites: lines 2604, 2612–2615)
- `src/direct-llm-runner.test.ts` (integration)

## Steps

1. **Add `formatCurrentTime(timezone)` to `src/timezone.ts`.** Use `Intl.DateTimeFormat` with `timeZoneName: 'longOffset'` to produce a UTC ISO-8601 string with the local offset (e.g. `2026-05-28T19:34:00+10:00`). Accept an optional `now: Date` parameter (default `new Date()`) for deterministic tests.
2. **Update `formatMessages` signature in `src/router.ts` (line 13).** Add an optional third parameter `now: Date = new Date()`. On line 22, change the header to: `` `<context timezone="${escapeXml(timezone)}" current_time="${escapeXml(formatCurrentTime(timezone, now))}" />` ``. Import `formatCurrentTime` from `./timezone.js`.
3. **No call-site changes in `src/channel-runner.ts`** — the `now` parameter defaults to `new Date()`. Both calls at lines 2604 and 2612 pick up the injected time automatically.
4. **Confirm `input.prompt` in `direct-llm-runner.ts` (line 1096)** is already the formatted string from `formatMessages` — no change there either.

## Tests

- **Unit:** In `src/routing.test.ts`, update the existing `'formats single message correctly'` test to pass a pinned `now` and assert `current_time="2024-01-01T12:00:00+00:00"` is present. Add a new test asserting the attribute changes between calls. Assert it appears on `<context>`, not inside `<messages>`.
- **Integration:** In `src/direct-llm-runner.test.ts`, capture the user-turn content via a mocked LLM client and assert it contains `current_time=` within ±5s of `Date.now()`. Assert `conversation_history` rows do NOT contain `current_time=` (non-persistence).
- **E2E:** Send "what time is it right now?" through the channel HTTP endpoint; assert the reply contains a time within a 1-minute window of the server clock.

## Risks / open questions

- `Intl` does not natively emit `+HH:MM` offset strings — implement carefully in `formatCurrentTime` using `formatToParts` with `timeZoneName: 'longOffset'`. Unit tests will catch mis-formatting.
- `direct-llm-runner.ts` does not call `formatMessages` directly — it receives the already-formatted `input.prompt` from `channel-runner.ts` (line 2604). No redundant injection in `loadSystemPrompt` is needed.

---

# Plan 2: Per-group structured user profile

**Goal:** Add a `group_profiles` SQLite table that stores per-group timezone, location, cuisine preferences, dietary restrictions, and budget tier, then inject it into the system prompt and expose an `update_profile` LLM tool so both the LLM and tool code can read and mutate it reliably across sessions.

**Affected files:**
- `src/db.ts` — new `group_profiles` table + `getGroupProfile` / `upsertGroupProfile` accessors
- `src/types.ts` — `GroupProfile` interface
- `src/runtime/direct-llm-runner.ts` — inject profile into `loadSystemPrompt` (line 862); register `update_profile` local tool
- `src/timezone.ts` — no changes needed; `formatLocalTime` already accepts a TZ string (line 5)
- `src/config.ts` — `TIMEZONE` becomes a fallback; call sites prefer `profile.timezone ?? TIMEZONE`

## Steps

1. **`src/types.ts`** — add `GroupProfile` interface: `{ groupFolder: string; timezone?: string; location?: string; cuisineLikes?: string; cuisineDislikes?: string; dietaryRestrictions?: string; budgetTier?: string; updatedAt: string }`.
2. **`src/db.ts` schema** — inside `createSchema`, after the `audit_log` block (line 453), add `CREATE TABLE IF NOT EXISTS group_profiles` keyed on `group_folder`, with nullable columns for each profile field.
3. **`src/db.ts` accessors** — add `getGroupProfile(groupFolder): GroupProfile | null` and `upsertGroupProfile(p)` using `UPDATE ... SET col = COALESCE(?, col)` semantics (not `INSERT OR REPLACE`) to avoid destructive overwrites on partial updates.
4. **`src/runtime/direct-llm-runner.ts` system prompt** — in `loadSystemPrompt` (line 862), call `getGroupProfile(groupFolder)` and append a `## Your profile` section after the skills suffix when a profile exists.
5. **`update_profile` tool** — add a `LocalTool` (registered via `registerLocalTool` near line 932) whose handler calls `upsertGroupProfile`.
6. **Call-site fix** — wherever `TIMEZONE` is passed to `formatLocalTime` or cron evaluation, prefer `profile?.timezone ?? TIMEZONE`.

## Tests

- **Unit:** `getGroupProfile` returns `null` on missing row; `upsertGroupProfile` round-trips all fields; partial upsert preserves existing fields; `loadSystemPrompt` includes profile section when profile exists and omits it otherwise.
- **Integration:** Create a group, call `upsertGroupProfile`, re-init DB from disk, assert profile survives. Call `update_profile` via `DirectLLMRunner` and verify the SQLite row is written.
- **E2E:** `POST /message` asking the assistant to set timezone to `America/New_York`; assert subsequent reminder fire-time display uses Eastern time.

## Risks / open questions

- The orchestrator does not own the channel SQLite. `update_profile` executes only in the channel pod — correct, but a follow-up may need orchestrator-side access for scheduler timezone resolution.
- `INSERT OR REPLACE` would zero out unset columns. Use `UPSERT` with `COALESCE` for safe partial updates.

---

# Plan 3: Structured-results web-search backend

**Goal:** Replace the fragile DuckDuckGo HTML scrape in `toolWebSearch` with the Brave Search API, routing the API key through the credential broker so results include snippets and metadata that downstream LLMs can use without re-fetching every URL.

**Affected files:**
- `container/agent-runner/src/tool-server.ts` — replace `toolWebSearch` implementation
- `container/agent-runner/src/tool-server.test.ts` — new file
- `src/runtime/direct-llm-runner.ts` — extend `web_search` tool description
- `helm/kubeclaw/values.yaml` — add `brave-search` catalog entry
- `e2e/minikube-live-browser.test.ts` — update existing `web_search` e2e test

## Steps

1. **Brave Search catalog entry in `helm/kubeclaw/values.yaml`** — add under `credentialInjection.catalog` (NOT `credentialBroker.catalog`; confirmed at `values.yaml:415`): `id: brave-search`, `host: api.search.brave.com`, `upstreamPort: 443`, `credentialFields: [{name: api_key, envVar: BRAVE_API_KEY}]`, `allowOperatorFallback: true`, `allowedPositions: [header]`, `apiKeyShape: {prefix: "BSA", minLength: 30}`. The broker stamps the credential as the `X-Subscription-Token` header on egress.
2. **Replace `toolWebSearch` in `container/agent-runner/src/tool-server.ts` (lines 125–136).** Call `https://api.search.brave.com/res/v1/web/search?q=<query>&count=10` and **do NOT manually set any credential header** in default `sidecar`/`istio` modes — the workload's `HTTPS_PROXY` env (added by `workloadEnvForSidecar` in `src/credential-injection/workload-env.ts:11-25`) routes the request through the local Envoy listener and the broker stamps `X-Subscription-Token` at ext_authz. In `mode: off` the handler must read `process.env.BRAVE_API_KEY` and set the header itself; the simplest pattern is `if (key && !key.startsWith('KC_PH_') && key !== 'injected-by-broker') headers['X-Subscription-Token'] = key;`. Map `web.results[]` to `{title, url, snippet, published, source}` objects, serialize to JSON string. Keep `(input: {query: string}): Promise<string>` signature stable.
3. **Update the `web_search` tool description in `src/runtime/direct-llm-runner.ts` (around line 108–118)** to document the richer return fields, prompting the LLM to read snippets before falling back to `web_fetch`.
4. **Dispatch table in `tool-server.ts` (line 293)** — no change.

## Tests

- **Unit** (new `tool-server.test.ts`): stub `globalThis.fetch`; assert (a) happy-path returns JSON containing `snippet`, (b) non-200 surfaces a descriptive error, (c) when `BRAVE_API_KEY` is a placeholder (`KC_PH_*`) the handler omits the `X-Subscription-Token` header (sidecar/istio path), (d) when `BRAVE_API_KEY` is a real key the handler sets the header (off path).
- **Integration** (`brave-search-catalog.test.ts` or extend `resolver.test.ts`): load the YAML snippet through the credential-injection config loader and assert the entry parses with `allowedPositions: [header]` and the correct `envVar` mapping.
- **E2E** (`e2e/minikube-live-browser.test.ts`): extend the `web_search via channel → tool pod` test to JSON-parse the tool-result payload and assert at least one `snippet` field is present. Run against an install with `credentialInjection.mode: sidecar` (default) to verify the no-manual-header path.

## Risks / open questions

- **Brave's non-standard header name:** the broker today is well-attested for stamping `Authorization: Bearer <key>` via ext_authz. Brave uses `X-Subscription-Token`. Verify `src/credential-broker/ext-authz.ts` and the Envoy Lua filter support arbitrary header names; if not, the catalog needs an `allowedPositions: [header]` + custom `headerName` extension before this plan is shippable.
- **Free tier limit** (2 000 req/month) — document in `values.yaml` comments.
- **Backward compatibility of return format**: existing callers that split on `\n` for `title: url` pairs will break. Audit researcher and specialist prompts before shipping.

---

# Plan 4: Baseline Researcher specialist

**Goal:** Add a `Researcher` specialist entry to the Helm chart's `values.yaml` so that `@researcher` dispatches to a configured web-research sub-agent without manual operator registration.

**Affected files:**
- `helm/kubeclaw/values.yaml` — add the `Researcher` entry under `specialists:`
- `helm/kubeclaw/templates/specialists-baseline-configmap.yaml` — verify rendering
- `src/specialists/types.ts` — no change required

## Steps

1. **Add the `Researcher` entry to `values.yaml`** (stanza below).
2. **Verify Helm rendering** via `helm template helm/kubeclaw | grep -A40 specialists-baseline`.
3. **Validate** by writing a small test fixture that calls `validateSpecialist` with the decoded YAML and asserts `ok: true`.

Proposed stanza:

```yaml
specialists:
  - name: Researcher
    prompt: |
      You are a web-research specialist. When given a topic or question:
      1. Search for relevant, current information using available search tools.
      2. Fetch and read promising sources to gather details.
      3. Synthesise findings into a concise, structured summary with:
         - A one-paragraph executive summary.
         - Key facts as a bulleted list.
         - Source URLs cited inline.
      Stay factual; note when information is uncertain or conflicting.
    triggers:
      - researcher
    llmProvider: openrouter
    memory:
      isolated: false
    tools:
      - web_search
      - web_fetch
```

`memory.isolated: false` is deliberate. With `false`, the specialist's `session_key` is the group folder (`src/channel-runner.ts:2673`), so a follow-up `@researcher` turn ("filter to non-stops") sees the prior research in its history (`src/runtime/direct-llm-runner.ts:995-998`). Specialist replies are stored via `storeMessage` (raw `messages` table) — they do NOT flow into the main group's `conversation_history`, so the main LLM is not polluted by Researcher's turns regardless of mode. Token bloat is bounded by `MAX_CONVERSATION_HISTORY` (default 20). The doc's canonical "Research" example in `docs/SPECIALISTS.md:17-28` also uses `isolated: false`.

## Tests

- **Unit:** `validateSpecialist` returns `ok: true` for the decoded YAML.
- **Integration:** Reconciler test installs with the Researcher stanza and asserts `parseSpecialists` of the resulting ConfigMap JSON contains the entry.
- **E2E:** Extend `e2e/specialist-catalog.test.ts` with a test that does `helmUpgrade` with Researcher, sends `@researcher what is the boiling point of water?`, and asserts the SSE reply contains `[@Researcher]`.

## Risks / open questions

- `web_search`/`web_fetch` are LLM-facing names — document this in the `values.yaml` comment.
- `llmProvider: openrouter` requires the right secret to be set; consider omitting to inherit the group default.
- Privacy: in a multi-user group, the non-isolated Researcher sees prior user turns from everyone in the group (bounded by `MAX_CONVERSATION_HISTORY`). Acceptable for single-user deployments; revisit for shared groups.

---

# Plan 5: Per-specialist tool budgets

**Goal:** Add `maxToolRounds` and `maxToolOutputBytes` fields to `GlobalSpecialist`, thread them through `RunAgentOverrides` to `DirectLLMRunner.runAgent`'s loop, and honor them in the tool-server so specialist pods can exceed or tighten the global defaults without affecting other specialists.

**Affected files:**
- `src/specialists/types.ts` — `GlobalSpecialist`, `ALLOWED_KEYS`, `validateSpecialist`
- `src/runtime/types.ts` — `RunAgentOverrides`
- `src/runtime/direct-llm-runner.ts` — lines 60, 1136 (`MAX_TOOL_ROUNDS` guard)
- `src/channel-runner.ts` — lines 2672–2678 (overrides construction)
- `src/k8s/job-runner.ts` — tool pod env-var injection
- `container/agent-runner/src/tool-server.ts` — lines 122, 132 (truncation constants)

## Steps

1. **`src/specialists/types.ts`** — add `maxToolRounds?: number` and `maxToolOutputBytes?: number` after line 8; add both to `ALLOWED_KEYS` (lines 20–28); validate positive-integer in `validateSpecialist` after line 76.
2. **`src/runtime/types.ts`** — add both fields to `RunAgentOverrides` (after line 76) with JSDoc noting fallbacks (`MAX_TOOL_ROUNDS=10`, `50000` bytes).
3. **`src/runtime/direct-llm-runner.ts`** — read `overrides.maxToolRounds ?? MAX_TOOL_ROUNDS` into `effectiveMaxRounds` before line 1136 loop; replace `MAX_TOOL_ROUNDS` in the `while` condition. Thread `maxToolOutputBytes` into `executeToolViaK8s` so the tool pod can read it.
4. **`src/channel-runner.ts`** — in the overrides object at lines 2672–2678, pass `maxToolRounds: s.maxToolRounds` and `maxToolOutputBytes: s.maxToolOutputBytes` (omitted when undefined).
5. **`src/k8s/job-runner.ts`** — when creating a browser tool pod, inject `KUBECLAW_MAX_TOOL_OUTPUT_BYTES` as an env var if set. Forward via the existing Redis spawn fields.
6. **`container/agent-runner/src/tool-server.ts`** — read `parseInt(process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES || '50000', 10)` at startup; replace hard-coded `50000` (line 122) and `10` (line 132).

## Tests

- **Unit:** `validateSpecialist` accepts/rejects the new fields correctly; `runAgent` loop exits at the overridden round count both below and above default; channel-runner overrides builder maps fields correctly.
- **Integration:** `DirectLLMRunner` with a mock LLM that always returns tool calls halts at the override; `KUBECLAW_MAX_TOOL_OUTPUT_BYTES` appears in the pod spec when set.
- **E2E:** Register a specialist with `maxToolRounds: 2`; send a prompt that normally drives many rounds; assert ≤2 rounds.

## Risks / open questions

- Passing `maxToolOutputBytes` via Redis spawn fields requires the pod-creation path to forward it cleanly — verify the env-injection hook in `job-runner.ts`.
- `web_search` result count is item count, not bytes; decide whether `maxToolOutputBytes` also caps item count.
- No `maxWallClockMs` in this plan — follow-on via `Promise.race` if the researcher story needs it.

---

# Plan 6: Immediate ConfigMap apply for specialist overrides

**Goal:** Wire the existing `configMapApply` dependency into the admin-shell's `register_specialist`, `edit_specialist`, and `remove_specialist` handlers so that mutations immediately patch the `kubeclaw-specialists` ConfigMap, making new specialists visible to channel pods without an orchestrator restart.

**Affected files:**
- `src/admin-shell.ts` (lines 732, 747, 755 — mutation handlers; lines 50–55 — `coreV1` client init)
- `src/specialists/reconciler.ts` (lines 39–68 — `SpecialistReconciler`)
- `src/skills/orchestrator/specialist-registry.ts` (lines 11–86)
- `docs/SPECIALISTS.md` (line 60 — caveat removed)

## Steps

1. **Add a Promise-chain mutex to `SpecialistReconciler.apply()` in `src/specialists/reconciler.ts`.** Rename the current `apply()` body to a private `_applyOnce()`, then make `apply()` chain through a per-instance `applyChain: Promise<void>`:

   ```typescript
   private applyChain: Promise<void> = Promise.resolve();
   async apply(): Promise<void> {
     this.applyChain = this.applyChain.then(() => this._applyOnce());
     return this.applyChain;
   }
   ```

   This eliminates a silent-data-loss race where two back-to-back `register_specialist` calls could each take a stale snapshot from SQLite and have the older snapshot clobber the newer ConfigMap patch (K8s itself serializes the writes, but doesn't preserve "merged" intent). Place the mutex in the reconciler — not in admin-shell handlers — so any future caller (admin shell, startup, future timer-based reconcile) is automatically serialized.

2. **Instantiate `SpecialistReconciler` in `admin-shell.ts`.** After `coreV1` at line 52, build a `configMapApply` closure identical to `src/index.ts` lines 364–393 (patch-then-create-on-404, merge-patch content-type). Construct a `SpecialistReconciler` with `baselineLoader: loadBaselineFromDisk`.
3. **Pass `reconciler.apply.bind(reconciler)` to each mutation call** at lines 732, 747, 755.
4. **Update success strings** (lines 734, 749, 757) to say "Changes are live; channel pods will see the updated catalog within ~30s."
5. **Remove the caveat** from `docs/SPECIALISTS.md` line 60.

## Tests

- **Unit (`src/specialists/reconciler.test.ts`):** With the new mutex — call `apply()` twice back-to-back without awaiting the first. With a slow `configMapApply` stub (50ms delay), assert the second call's SQLite snapshot is taken AFTER the first call's `configMapApply` resolves (verifiable via increasing `generation` values and ordered call timestamps on a `vi.fn()` `configMapApply`). Without the mutex this test is flaky; with it, it passes deterministically.
- **Unit (`src/admin-shell.test.ts`):** Mock `coreV1.patchNamespacedConfigMap`. Assert it's called once with `name: 'kubeclaw-specialists'` containing the new specialist; 404 path falls back to `createNamespacedConfigMap`; non-404 errors still return `ok: true` (reconcile failure is non-fatal per `specialist-registry.ts:31-34`).
- **Integration (concurrent-registration regression):** Call `registerSpecialist("A", reconcile)` and `registerSpecialist("B", reconcile)` back-to-back without awaiting; drain both. Assert `configMapApply` was called exactly twice and the second payload includes both A and B with `generation: 2`. Then call `editSpecialist` → `removeSpecialist` and assert apply payload contents and `generation` increment monotonically.
- **E2E (`e2e/specialist-catalog.test.ts`):** Add Test 6: install with empty specialists, issue `register_specialist` via admin-shell IPC, wait ≤65s for kubelet propagation WITHOUT restarting the orchestrator, send `@<new-specialist>`, assert reply.

## Risks / open questions

- **`loadBaselineFromDisk` path:** the baseline file may not be mounted in the admin-shell container. Existing `[]` fallback at lines 26–27 is acceptable; document the implication.
- **Patch MIME type:** confirm strategic-merge-patch matches the existing `index.ts` call (lines 377–381) to avoid 415.
- **Mutex starvation under sustained mutation load:** the Promise chain is unbounded — if a slow `configMapApply` blocks while many admin calls queue, callers wait. Acceptable for the admin shell (low call rate); revisit if a future code path drives mutations programmatically.

---

# Plan 7: Reminder LLM UX

**Goal:** Reliably handle natural-language reminder requests ("remind me to X in N days") by sharpening the `schedule_task` tool description and adding a `set_reminder` convenience tool that encapsulates the correct prompt template and enforces ISO datetime.

**Affected files:**
- `src/runtime/direct-llm-runner.ts` (lines 57–58, 180–208, 1234–1240, and tool dispatch block)
- `src/runtime/tools/set-reminder.ts` (new)
- `tests/unit/set-reminder.test.ts` (new)
- `tests/integration/set-reminder.test.ts` (new)

## Steps

1. **Sharpen `schedule_task` description (lines 184–203):** "When scheduling a `once` task, `schedule_value` MUST be an absolute ISO 8601 datetime string. Resolve any relative expression like 'in 3 days' to a concrete datetime before calling this tool." Update `schedule_value` description (line 200–202) accordingly.
2. **Extend the default system prompt (line 57–58):** "When a user asks to be reminded about something, use `set_reminder` (preferred) or `schedule_task` with `schedule_type: 'once'` and a resolved absolute ISO datetime; never pass relative phrases like 'in 3 days' as the schedule value."
3. **Create `src/runtime/tools/set-reminder.ts`** with a `LocalTool` whose schema is `{ reminder_text: string, when_iso: string }`. Handler validates ISO, builds `prompt: "Deliver this reminder message to the user verbatim: ${reminder_text}"`, delegates to `scheduleTaskDirect(..., { schedule_type: 'once', schedule_value: when_iso })`, returns a confirmation including human-readable `toLocaleString()` time.
4. **Register `set_reminder`** in the constructor near line 932 via `registerLocalTool`. The dispatch at line 1314 already routes to `localTools`.

## Tests

- **Unit:** Stub `scheduleTaskDirect`; assert invalid ISO returns an error without calling the stub; valid ISO produces the verbatim-delivery prompt template and human-readable confirmation.
- **Integration:** In-process `DirectLLMRunner` with a test SQLite DB; send "remind me to take my vitamins in 2 minutes"; assert a row appears in `scheduled_tasks` with the verbatim-template prompt and a parseable ISO.
- **E2E:** Send "remind me to call the dentist in 1 hour"; assert confirmation with human-readable time; assert `SELECT COUNT(*) FROM scheduled_tasks WHERE prompt LIKE '%dentist%' = 1`.

## Risks / open questions

- **Coordination with Plan 1:** without current-time injection, the LLM may not resolve "in 3 days" correctly. Coordinate merge order.
- **Backward compatibility:** existing `schedule_task` callers unaffected — only description text changes.
- **Prompt-injection via `reminder_text`:** add a max-length guard (~500 chars).

---

# Plan 8: Missed-fire regression tests for once-tasks

**Goal:** Pin the existing correct missed-fire semantics for `once` tasks with deterministic regression tests so that any future refactor of `getDueTasks` or `updateTaskAfterRun` that breaks the guarantee fails immediately.

**Affected files:**
- `/home/peter/projects/kubeclaw/src/task-scheduler.test.ts` (new unit cases)
- `/home/peter/projects/kubeclaw/e2e/task-scheduler.test.ts` (strengthen existing case)

## Steps

1. **Expose `getDueTasks` and `updateTaskAfterRun` in the test imports** of `src/task-scheduler.test.ts`.
2. **Unit test: overdue once-task appears in `getDueTasks`** — insert a `once` task with `next_run` 48 h in the past, assert it's returned. Pins the SQL predicate.
3. **Unit test: `updateTaskAfterRun(id, null, …)` sets `status='completed'`** — pin the `CASE WHEN ? IS NULL THEN 'completed'` branch.
4. **Unit test: after `updateTaskAfterRun`, the task no longer appears in `getDueTasks`** — pin "does not re-fire".
5. **Integration test: scheduler loop fires overdue once-task exactly once** — use existing `vi.useFakeTimers()` pattern; insert task with `next_run` 24 h ago; wire a mock runner via `getRunnerForGroup`; advance timers; assert `enqueueTask` called exactly once; advance again, assert still once; assert `getTaskById(id).status === 'completed'`.
6. **Strengthen existing e2e test** (`e2e/task-scheduler.test.ts`, "marks a once-type task as processed"): add `task.status === 'completed'` assertion + post-`waitForTaskUpdate` `getDueTasks()` empty-check.

## Tests

- **Unit:** Steps 2–4 in `src/task-scheduler.test.ts`.
- **Integration:** Step 5, wiring `startSchedulerLoop` with real DB functions and a mocked runner.
- **E2E:** Step 6 — strengthening existing test; no new file needed.

## Risks / open questions

- **`getRunnerForGroup` mock depth:** the loop test needs `getRunnerForGroup` to return an object with `writeTasksSnapshot`, `runAgent`, and possibly `getAllTasks`. Audit the existing module-level mock.
- **`null` `schedule_value`:** verify `createTask` accepts an empty string without a constraint error.
- **No production code change anticipated** — pure test coverage. If step 5 reveals that the "group not found" early-return path skips `updateTaskAfterRun`, the test surfaces a real bug (status never becomes `'completed'`); fix by using a properly-registered group with a mock runner.

---

# Plan 9: Places-search tool

**Goal:** Add a `places_search` local tool to the channel pod that calls the Google Places API "Nearby Search (New)" endpoint and returns structured venue results, backed by a new credential-broker catalog entry for the API key.

**Affected files:**
- `src/runtime/direct-llm-runner.ts` — new tool definition in TOOLS (after line 300); register at channel startup
- `src/runtime/places-search.ts` — new file: handler, result schema, HTTP call
- `helm/kubeclaw/values.yaml` — new catalog entry under `credentialInjection.catalog` (line 415)
- `tests/unit/places-search.test.ts`, `tests/integration/places-search.test.ts`, `e2e/places-search.test.ts` — new

## Steps

1. **Tool definition in TOOLS (lines 89–300):** parameters `query` (string, required), `location` (string `"lat,lng"`, required), `open_now` (boolean, optional), `price_range` (array of integers 1–4, optional).
2. **`src/runtime/places-search.ts`:** Zod result schema `{ name, address, lat, lng, rating, price_tier, cuisines, open_now }`. `placesSearchHandler(args)` calls `${process.env.GOOGLE_PLACES_BASE_URL}/v1/places:searchNearby` with a JSON body and an explicit `X-Goog-FieldMask` header (controls billing). Do NOT manually set an API-key header in default `sidecar`/`istio` modes — the channel pod's `HTTPS_PROXY` routes the request through Envoy and the broker stamps the credential. In `mode: off`, fall back to setting `X-Goog-Api-Key: process.env.GOOGLE_PLACES_API_KEY` directly (same placeholder-guard pattern as Plan 3). Map `priceLevel` enum to `price_tier` (1–4); derive `cuisines` from `types[]` via a curated food-type allow-list.
3. **Register at channel startup** near `registerLocalTool` (line 932): `runner.registerLocalTool('places_search', { definition: PLACES_TOOL_DEF, handler: placesSearchHandler })`. Dispatch path at line 1314 already routes registered local tools.
4. **Catalog entry in `helm/kubeclaw/values.yaml`** under `credentialInjection.catalog`:
   ```yaml
   - id: google-places
     host: places.googleapis.com
     upstreamPort: 443
     credentialFields:
       - { name: api_key, envVar: GOOGLE_PLACES_API_KEY }
     baseUrlEnvs:
       # NOTE: http:// scheme is intentional — istio egress requires it so the
       # sidecar can intercept the request and call ext_authz. The broker
       # upgrades the upstream connection to HTTPS internally.
       GOOGLE_PLACES_BASE_URL: "http://places.googleapis.com"
     allowOperatorFallback: false
     allowedPositions: [header]
     apiKeyShape: { prefix: "AIza", minLength: 39 }
   ```

**Why local tool, not tool-job:** single HTTPS call returning <2 KB JSON — spawning a pod adds 10–30 s latency for no benefit. Local tools run in-process; credential broker stamps the outbound header via the channel-pod sidecar when `mode: sidecar`.

## Tests

- **Unit:** Mock `fetch`; verify request body construction for all parameter combinations, `priceLevel` mapping (all five enum values + missing/unknown), `types[]` → `cuisines` extraction, error path.
- **Integration:** In-process HTTP mock (e.g. `msw`) with realistic Google Places JSON. Assert field shapes, `open_now` forwarding, 4xx error handling.
- **E2E:** With `credentialInjection.mode: off` and `GOOGLE_PLACES_API_KEY` set to a sandbox key (or e2e mock-upstream), send "find Italian restaurants near 37.7749,-122.4194"; assert response contains a result with non-empty `address` and numeric `rating`.

## Risks / open questions

- **Field-mask billing:** the handler MUST send `X-Goog-FieldMask` to avoid expensive responses.
- **Header-name support in broker:** Google Places uses `X-Goog-Api-Key`, not `Authorization: Bearer`. Same caveat as Plan 3 — verify the broker's ext_authz config can stamp arbitrary header names; extend the catalog schema if needed.
- **Location source:** this plan does not store user location — see Plan 2. Caller must pass `"lat,lng"`; the LLM asks the user if unknown.
- **`cuisines` heuristic:** curated allow-list for food-specific `types[]` strings is needed; bad list → empty/misleading cuisines.

---

# Plan 10: Recommendation execution pattern

**Goal:** Surface a `places_search` tool and a recommendation-contract section in the main-channel system prompt so the main agent handles recommendation flows (restaurants, movies, etc.) natively, with multi-turn refinement implicit in the shared `group_folder` session history.

**Affected files:**
- `src/runtime/direct-llm-runner.ts` — add `places_search` to `TOOLS` (after line 356), register `TOOL_CATEGORY` / `TOOL_SERVER_NAME` (lines 371–384), extend `loadSystemPrompt` (lines 862–881)
- `src/specialists/types.ts` — no change (no new specialist)
- `src/channel-runner.ts` — no change (main-agent path at lines 2681–2688 already wires the LLM)
- `helm/kubeclaw/values.yaml` — no change (no new specialist entry)

## Steps

1. **Add `places_search` to TOOLS** (after line 356) — see Plan 9 for the schema. Register in `TOOL_CATEGORY` as `'browser'` and in `TOOL_SERVER_NAME` as `'placesSearch'` (lines 371–384).
2. **Add recommendation contract to `loadSystemPrompt`** — after the skill suffix is appended (line 876), inject a fixed `RECOMMENDATION_CONTRACT` constant (defined at module top near line 57) unless the loaded prompt contains `<!-- no-recommendation-contract -->` (opt-out escape hatch). The contract instructs the agent: when the user asks for a recommendation, (a) call `read_user_profile`, (b) call `places_search` (or another structured tool), (c) respect refinement constraints from conversation history, (d) present a short ranked list with name, one-line reason, source citation.
3. **`read_user_profile` local tool** — register via `registerLocalTool` (line 932). Handler reads `group_profiles` via Plan 2's accessor (or `groups/{groupFolder}/profile.json` if a file-based approach is chosen). Returns parsed JSON; degrades to `{}` if absent.
4. **No Helm changes** — preferences and tool routing live entirely in channel-pod code.

## Tests

- **Unit:** `loadSystemPrompt` injects the contract when CLAUDE.md is absent or present; does NOT inject when opt-out flag present. `TOOLS` array contains `places_search` with correct schema. `read_user_profile` returns parsed JSON / `{}` fallback.
- **Integration:** Stub LLM returns a `places_search` tool call; confirm routing to the browser pod category. Second `runAgent` on the same `session_key` sees prior recommendation in history and the contract in the system prompt.
- **E2E:** Full channel turn — "good Italian restaurants near me" → agent calls `read_user_profile` and `places_search` → cited results. Follow-up "cheaper options" → respects prior context.

## Risks / open questions

- **Depends on Plans 2 + 9:** `read_user_profile` degrades to `{}` so the contract works immediately even without a profile; `places_search` requires Plan 9.
- **Context-window cost:** the contract section adds ~150 tokens to every main-channel system prompt. Verify compression tests still pass after addition.
- **Opt-out documentation:** document `<!-- no-recommendation-contract -->` in `groups/*/CLAUDE.md` template comments.
