# Channel Breadth: Five New Channel Types — Design Spec

**Date:** 2026-06-26
**Status:** Implemented (2026-06-27) on branch `feat/channel-breadth-five-channels` — all five channels built sequentially via subagent-driven-development, each with a two-stage review; final whole-branch review passed after fixing one blocker (WhatsApp `/readyz`). Awaiting user decision on merge/PR. Originally produced via `auto-develop`; design approved by an independent coherence reviewer (verdict: coherent, no blockers).

## Deferred to v2 (intentional v1 scope cuts)
- **Inbound/outbound media** on all channels (Telegram surfaces image/pdf/voice capability flags but v1 delivers text only; WhatsApp/iMessage mark inbound media `[Attachment: unsupported in v1]`; Matrix drops `m.image` and declares `inboundImages:false`).
- **Matrix E2E encryption** (unencrypted rooms only; `initRustCrypto()` deliberately never called).
- **Rich formatting**: only Discord sets `markdownOutput:true`; the others send plain text (avoids MarkdownV2/HTML escaping failures).
- **WhatsApp group send** (Meta Cloud API is 1:1 only — group JIDs early-return with a warning).
- **Live round-trips for WhatsApp & iMessage** are not CI-able (need a Meta Business account / a Mac running BlueBubbles); covered by fakes + documented.
- Reactions/tapbacks, Discord threads/embeds/slash-commands, interactive buttons.
**Goal (one sentence):** Add five new channel types — **Telegram, Discord, Matrix, WhatsApp, iMessage** — as runtime SDK adapters, each following the existing one-mechanism channel model, to close the channel-breadth gap versus comparable assistants (OpenClaw/NanoClaw support 13–30+ channels; KubeClaw today has only `irc`, `http`, `oauth-webchat`, `signal`).

## Why

KubeClaw's gap-analysis versus the field is **channel breadth**, not architecture. Each new channel is a self-contained `channel-entry.js` adapter that rides the existing `Channel` SDK contract, manifest packaging, bootstrap install path, and per-channel Secret model. No orchestrator/core changes are required beyond two small additions (the folder-prefix table and one sidecar-vs-external decision per platform). The work is broad but shallow and highly repetitive, which is why it is implemented **sequentially, one channel at a time**, each reusing the harness established by the previous.

## Scope & sequencing

One combined spec; **sequential implementation in ascending complexity** so the reusable pattern is established by the simplest first and the novel transport work (webhook ingress, external bridge) lands last:

1. **Telegram** — `telegraf`, long-poll, no ingress. *Establishes the adapter + manifest + bootstrap + 3-level test pattern.* (Bootstrap skill + folder-prefix already scaffolded in-repo.)
2. **Discord** — `discord.js`, Gateway WebSocket, no ingress.
3. **Matrix** — `matrix-js-sdk`, `/sync` long-poll, **unencrypted v1**.
4. **WhatsApp** — Meta WhatsApp Business **Cloud API**, inbound webhook via `httpPort` + Ingress (TLS required).
5. **iMessage** — external **BlueBubbles** bridge, **polling** receive model.

Each channel gets its own implementation pass and its own two-stage review (spec-compliance → code-quality) — that per-channel review IS the "sanity-check each one" the request asks for.

## Non-goals (YAGNI for v1)

- **Rich formatting / markdown translation.** Discord renders our markdown natively (`markdownOutput: true`). The other four send **plain text** in v1 — Telegram MarkdownV2 / Matrix HTML escaping is error-prone and causes hard send failures. Deferred, not designed out.
- **E2E encryption for Matrix** (olm/wasm + key management). Unencrypted rooms only in v1.
- Reactions, threads-as-channels, rich embeds, interactive buttons/slash-commands.
- Voice transcription pipeline — the SDK already emits `[Voice: ...]` / `[VoiceAttachment: ...]` markers; channels only surface inbound media as those markers.
- Unofficial WhatsApp libraries (Baileys / whatsapp-web.js) — ToS/ban risk, QR-session babysitting, and (whatsapp-web.js) a Chromium dependency that fails under `npm ci --ignore-scripts`.

## The shared pattern (applies to all five)

Established by the existing `irc` and `signal` adapters; each channel replicates it:

- **Adapter:** `helm/kubeclaw/files/channel-src/<type>/channel-entry.js`, default-exporting `register(sdk)` which calls `sdk.registerChannel('<type>', factory)`.
- **Factory:** `(opts) => Channel | null`. Reads creds via `process.env` / `sdk.readEnvFile([...])`; returns **`null` when creds are missing** (silent disable — never throws).
- **`Channel` implementation:** `name`, `connect()`, `sendMessage(jid, text)`, `isConnected()`, `ownsJid(jid)`, `disconnect()`, `readonly capabilities`, plus optional `setTyping` where cheap. Self-contained single file; a small text-chunking helper is duplicated per adapter (matches existing convention; avoids ConfigMap cross-coupling).
- **Inbound:** platform event → `opts.onChatMetadata(jid, ts, name?, '<type>', isGroup?)` then `opts.onMessage(jid, NewMessage)`. `NewMessage` = `{ id, chat_jid, sender, sender_name, content, timestamp, is_from_me? }`. Drop messages from unregistered chats (`opts.registeredGroups()[jid]` absent) and guard echo loops via `is_from_me`.
- **Outbound:** orchestrator calls `channel.sendMessage(jid, text)`; adapter chunks to the platform limit and handles platform formatting. Transport errors are **logged via `sdk.logger`, never thrown** into the runtime.
- **Manifest:** `bootstrap.channelManifests.<type>` in Helm values — `hostMode: channel-runner`, `packageJson`, `packageLockJson`, `manifestHash = sha256(canonical(packageJson) + '\n' + canonical(packageLockJson))`. Staged by the init container; `npm ci --omit=dev --ignore-scripts` on vanilla Node. **All five dependency trees verified script-free and native-free** (telegraf, discord.js, matrix-js-sdk all install clean under `--ignore-scripts`; matrix's `@matrix-org/matrix-sdk-crypto-wasm` ships a prebuilt `.wasm` with no build step; WhatsApp/iMessage use native `fetch`, zero npm deps).
- **Install:** a bootstrap skill `helm/kubeclaw/files/bootstrap-skills/bootstrap-<type>.md` (interactive, Path A) **and** a declarative Helm-values example (Path B), per `docs/INSTALLING_A_CHANNEL.md`. Credentials → per-channel Secret `kubeclaw-channel-<inst>` env vars.
- **JID scheme:** `ownsJid` uses a **prefix match** (`jid.startsWith('<type>:')`). Routing dispatches via `ownsJid()` polymorphism, not colon-splitting, and `jidToFolder` sanitizes non-alphanumerics — so JIDs containing extra colons (Matrix room ids) are safe.

### Shared cross-cutting task (do once, in the Telegram pass)

Add `matrix` and `imessage` to the `folderPrefixForChannel` table at `src/channel-runner.ts:456` (`matrix: 'mat'`, `imessage: 'imsg'`). `telegram`/`discord`/`whatsapp` already exist there. Add a unit test asserting all five prefixes.

---

## Per-channel sections

> Each section below is the unambiguous scope for one sequential implementation pass.

### 1. Telegram — `telegram`

- **Library:** `telegraf@4`. **Transport:** long-poll (`bot.launch()` → `getUpdates`). No `httpPort`, no ingress.
- **JID:** `telegram:<chatId>` (negative ids for groups/supergroups).
- **Inbound:** `bot.on('message', …)` → map `ctx.chat.id`, `ctx.from`, `ctx.message.text`; `isGroup = chat.type in {group, supergroup}`; chat name from `ctx.chat.title || username`. Surface photo/document/voice as attachment markers.
- **Outbound:** `telegram.sendMessage(chatId, text)` plain text (no `parse_mode` in v1); chunk at 4096 chars. `setTyping` via `sendChatAction(chatId, 'typing')`.
- **Capabilities:** `{ typing, inboundImages, inboundPdfs, inboundVoice, outboundMedia }` (no `markdownOutput`).
- **Creds:** `TELEGRAM_BOT_TOKEN`. **Bootstrap skill already exists** (`bootstrap-telegram.md`) — validates token via `getMe`. Reconcile the manifest/adapter to it.

### 2. Discord — `discord`

- **Library:** `discord.js@14`. **Transport:** Gateway WebSocket (outbound). No ingress.
- **Intents:** `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`. **`MessageContent` is a privileged intent.**
- **JID:** `discord:<channelId>` (works for guild channels and DMs).
- **Inbound:** `client.on('messageCreate', …)`; ignore `message.author.bot`; `isGroup = !!message.guild`; chat name from channel/guild name. Surface attachments as markers.
- **Outbound:** `channel.send(text)`; chunk at 2000 chars. `setTyping` via `channel.sendTyping()`.
- **Capabilities:** `{ typing, inboundImages, inboundPdfs, markdownOutput, outboundMedia }` (Discord renders our markdown natively).
- **Creds:** `DISCORD_BOT_TOKEN`. Bootstrap skill validates via `GET /users/@me`.
- **Operator step (docs + bootstrap skill):** enable **Message Content Intent** in the Discord Developer Portal → Bot. `connect()` logs a warning if a `messageCreate` arrives with empty `content` (the symptom of the intent being off at scale).

### 3. Matrix — `matrix`

- **Library:** `matrix-js-sdk@latest`. **Transport:** `client.startClient()` → `/sync` long-poll. No ingress.
- **Crypto:** **unencrypted v1 — do NOT call `initRustCrypto()`; use `MemoryStore`.** The `crypto-wasm` binary ships in the package but is never loaded because `initRustCrypto()` is never invoked. State this explicitly so an implementer doesn't add it thinking `/sync` needs it.
- **JID:** `matrix:<roomId>` (room ids contain a colon, e.g. `!abc:home.server` → `matrix:!abc:home.server`). Safe: prefix-match `ownsJid`, sanitized folder.
- **Inbound:** `client.on('Room.timeline', …)`; ignore own user id and non-`m.room.message` events; de-dupe on event id; `isGroup` = room member count > 2 (or always true — rooms are inherently multi-party); chat name from room name. Guard against replaying historical timeline on initial sync (only process events after sync `PREPARED`).
- **Outbound:** `client.sendTextMessage(roomId, text)` plain `m.text` body; chunk at ~32 KB (well under Matrix's event size cap). `setTyping` via `client.sendTyping(roomId, true, 20000)`.
- **Capabilities:** `{ typing, inboundImages, outboundMedia }` (no `markdownOutput` in v1).
- **Creds:** `MATRIX_HOMESERVER_URL`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`. Bootstrap skill validates via `GET /_matrix/client/v3/account/whoami`.

### 4. WhatsApp — `whatsapp`

- **Integration:** Meta **WhatsApp Business Cloud API** (official). Outbound = HTTPS POST to `graph.facebook.com`; inbound = Meta **webhook** POSTing to us. No sidecar, no npm deps (native `fetch`).
- **Inbound transport:** the adapter binds **`httpPort` (4080)** → Service + Ingress (existing mechanism). Exposes:
  - `GET /webhook` — verification handshake (echo `hub.challenge` when `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`).
  - `POST /webhook` — message receipt; **verify `X-Hub-Signature-256` HMAC** against `WHATSAPP_APP_SECRET` before processing.
- **TLS:** Meta requires HTTPS for the webhook — operator **must** configure `ingress.tls` in Helm values for this channel. Call out in install docs + bootstrap skill.
- **JID:** `whatsapp:<e164>` (1:1) and `whatsapp:group.<groupId>` (groups), mirroring Signal's convention.
- **Inbound:** parse `entry[].changes[].value.messages[]`; `sender` = `wa_id`, name from `contacts[].profile.name`; surface image/document/audio as markers (media requires a follow-up media-fetch call — fetch + store, or mark unsupported in v1 and log; **v1: text + mark media as `[Attachment: unsupported in v1]`** to keep scope bounded). Echo guard: ignore `statuses` payloads and own messages.
- **Outbound:** `POST /{PHONE_NUMBER_ID}/messages` with `{ type: 'text', text: { body } }`; plain text; chunk at 4096.
- **Capabilities:** `{ inboundImages: false (v1), outboundMedia: false (v1) }` — minimal; text-first.
- **Creds:** `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`. Bootstrap skill validates token via `GET /{PHONE_NUMBER_ID}` and explains webhook URL registration in Meta's dashboard.

### 5. iMessage — `imessage`

- **Integration:** external **BlueBubbles** server (operator runs it on a Mac — iMessage structurally requires Apple hardware; there is no in-cluster path). The adapter is a REST client of the operator-supplied BlueBubbles URL. **Not a sidecar** (the Mac is external infra).
- **Receive model:** **polling** (locked). Adapter polls BlueBubbles `GET /api/v1/chat` / message-query endpoints on an interval (`IMESSAGE_POLL_MS`, default ~3000), tracking a last-seen cursor — analogous to the Signal sidecar's poll loop. **No `httpPort`/ingress** (avoids requiring the external Mac to reach back into the cluster).
- **JID:** `imessage:<handle>` (phone/email, 1:1) and `imessage:group.<guid>` (group chats), mirroring Signal.
- **Inbound:** poll new messages; `sender` = handle address; ignore `isFromMe`; surface attachments as markers (v1: mark unsupported, log).
- **Outbound:** `POST /api/v1/message/text` with `{ chatGuid, message }`; plain text; chunk at ~10 000.
- **Capabilities:** minimal — text in/out only in v1.
- **Creds:** `IMESSAGE_BRIDGE_URL`, `IMESSAGE_BRIDGE_PASSWORD` (BlueBubbles uses a password query param / `guid`). Bootstrap skill validates via `GET /api/v1/ping` (or `/api/v1/server/info`) and documents the **external-Mac + BlueBubbles-server prerequisite** prominently.

---

## Testing (all three levels, per channel)

Per the global rule, **every** channel ships all three. Patterns follow the existing `src/channel-src/*-adapter.test.ts` and `e2e/irc-channel.test.ts`.

- **Unit** (`src/channel-src/<type>-adapter.test.ts`): factory registration; **creds-missing → `null`**; `ownsJid` accept/reject (incl. cross-channel rejection); inbound event → correct `NewMessage` mapping (mock the platform client); unregistered-chat drop; echo-loop guard; outbound chunking at the platform limit; JID parse/format. Plus the shared `folderPrefixForChannel` test (all five prefixes).
- **Integration**: adapter against an **in-process fake transport** with no platform SDK mock at the boundary — fake Telegram `getUpdates` HTTP server; fake Discord gateway/echo or a stubbed `client`; fake Matrix `/sync`; fake WhatsApp webhook POST + verify handshake (incl. a bad-signature rejection case); fake BlueBubbles REST (`/ping`, poll, send). Asserts the full inbound→`onMessage` and `sendMessage`→outbound wiring.
- **E2E** (`e2e/<type>-channel.test.ts`): mock-server lifecycle (connect → receive → route → disconnect) per the IRC e2e harness. Plus, for **Telegram only**, extend a `minikube-live` bootstrap e2e proving the declarative/bootstrap install path end to end. **Note:** live minikube e2e cannot run on the current dev host (8 GiB cluster needed — documented constraint); these tests are written and run in CI / on a larger box. State this explicitly in the test file, as the aux-backend spec did.

## Docs

- Update `docs/INSTALLING_A_CHANNEL.md` with an install section per channel (creds, bootstrap command, declarative values example; WhatsApp TLS prereq; Discord intent toggle; iMessage external-Mac prereq).
- Update `docs/DEVELOPING_A_CHANNEL.md` / `docs/ADDING_A_CHANNEL.md` only if a new category needs explaining (webhook-inbound for WhatsApp; external-bridge-polling for iMessage).

## File map (per channel; for the plan)

- `helm/kubeclaw/files/channel-src/<type>/channel-entry.js` — the adapter (NEW).
- `helm/kubeclaw/files/bootstrap-skills/bootstrap-<type>.md` — bootstrap skill (NEW; Telegram exists — reconcile).
- `helm/kubeclaw/values*.yaml` — `bootstrap.channelManifests.<type>` (packageJson/lock/hash; WhatsApp also webhook/ingress notes) + a declarative `channels.<inst>` example (NEW).
- `src/channel-runner.ts:456` — add `matrix`/`imessage` to `folderPrefixForChannel` (once, Telegram pass).
- `src/channel-src/<type>-adapter.test.ts` — unit (NEW).
- `e2e/<type>-channel.test.ts` — e2e (NEW); Telegram also a minikube-live bootstrap test.
- `docs/INSTALLING_A_CHANNEL.md`, `docs/DEVELOPING_A_CHANNEL.md` — install + dev docs.

## Risks / open points

- **WhatsApp/iMessage require external accounts/hardware** (Meta Business account; a Mac running BlueBubbles). The adapters are fully buildable and testable against fakes without them, but a *live* round-trip is not CI-able — same intrinsic limitation as Signal. Documented, not designed away.
- **Discord `MessageContent`** is privileged; large-scale bots need the portal toggle (operator step + connect-time warning).
- **WhatsApp media** is deferred in v1 (requires a media-fetch round-trip) to keep scope bounded; text-first.
- **Egress:** webhook/HTTPS channels need outbound 443 in their NetworkPolicy (existing per-channel egress mechanism; WhatsApp/iMessage/Matrix/Telegram/Discord all reach external APIs over 443).
