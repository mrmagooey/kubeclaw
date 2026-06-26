# Five New Channel Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram, Discord, Matrix, WhatsApp, and iMessage channel types to KubeClaw as runtime SDK adapters, implemented sequentially in that order, each with unit + integration + e2e tests.

**Architecture:** Each channel is a self-contained `helm/kubeclaw/files/channel-src/<type>/channel-entry.js` that default-exports `register(sdk)` → `sdk.registerChannel('<type>', factory)`. The factory returns a `Channel` instance or `null` when credentials are absent. Inbound events call `opts.onChatMetadata(...)` + `opts.onMessage(jid, NewMessage)`; outbound is `channel.sendMessage(jid, text)`. Packaging is a Helm manifest (`bootstrap.channelManifests.<type>`) installed via `npm ci --omit=dev --ignore-scripts`. The existing **`signal` adapter and its test file are the canonical template** — copy their structure.

**Tech Stack:** Node.js (ESM, built-in `fetch`), `telegraf@4`, `discord.js@14`, `matrix-js-sdk`, Meta WhatsApp Cloud API (no SDK), BlueBubbles REST (no SDK); Vitest; Helm.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-26-channel-breadth-five-channels-design.md` — authoritative; every task inherits it.
- **Canonical template (copy structure/conventions verbatim):** `helm/kubeclaw/files/channel-src/signal/channel-entry.js` and `src/channel-src/signal-adapter.test.ts`.
- **Adapter file header:** start with `/* eslint-disable */` (matches all existing adapters).
- **Factory contract:** `(opts) => Channel | null`. Return `null` (never throw) when required creds are missing; `parseConfig(sdk)` returns `null` and logs a `sdk.logger.warn`.
- **Channel interface:** `name`, `connect()`, `sendMessage(jid, text)`, `isConnected()`, `ownsJid(jid)`, `disconnect()`, `readonly capabilities`, optional `setTyping(jid, isTyping)`.
- **`ownsJid` MUST be a prefix match** (`typeof jid === 'string' && jid.startsWith('<type>:')`) and reject `undefined`.
- **Inbound mapping:** drop messages whose JID is not in `opts.registeredGroups()`; guard echo loops (ignore the bot's own messages); group-mention trigger-rewrite exactly as signal does (`@${sdk.assistantName}` → prefix) for group chats.
- **`NewMessage` shape:** `{ id, chat_jid, sender, sender_name, content, timestamp, is_from_me: false }`. `id = `${ts}-${++this.messageId}``. `timestamp` ISO 8601.
- **`onChatMetadata(jid, timestamp, name, '<type>', isGroup)`** called before `onMessage`.
- **Transport errors:** log via `sdk.logger.{warn,error}`, never throw into the runtime.
- **Named exports for tests:** `export { <Type>Channel, parseConfig }` at file end (after the `default` export).
- **No native deps / no install scripts:** all manifests install under `npm ci --ignore-scripts` on vanilla Node. Verified clean for telegraf, discord.js, matrix-js-sdk.
- **manifestHash** = `sha256(canonical(packageJson) + '\n' + canonical(packageLockJson))` (compute with the existing helper used in `bootstrap-telegram.md` Step 4).
- **Tests at all three levels per channel:** unit (`src/channel-src/<type>-adapter.test.ts`), integration (in-process fake transport), e2e (`e2e/<type>-channel.test.ts`). Live minikube e2e cannot run on the dev host (documented 8 GiB constraint) — write it, note it runs in CI.
- **git hooks need Node on PATH:** prepend `/home/peter/.nvm/versions/node/v24.15.0/bin` to `PATH` before any `git commit`.
- **Branch:** `feat/channel-breadth-five-channels` (worktrees branch off it per channel).
- **Commit cadence:** commit after each green test cycle; conventional-commit messages.

---

## Phase 0 — Shared groundwork (do once, folded into the Telegram pass)

### Task 0: Folder-prefix table for the new types

**Files:**
- Modify: `src/channel-runner.ts:456-467` (the `folderPrefixForChannel` map)
- Test: `src/channel-runner.test.ts` (add a `describe('folderPrefixForChannel')` block)

**Interfaces:**
- Produces: stable folder prefixes `matrix → mat`, `imessage → imsg` (the others — `telegram → tg`, `discord → dc`, `whatsapp → wa` — already exist).

- [ ] **Step 1: Write the failing test** in `src/channel-runner.test.ts`:

```ts
import { folderPrefixForChannel } from './channel-runner.js';

describe('folderPrefixForChannel: new channel types', () => {
  it('maps all five new channel types to stable prefixes', () => {
    expect(folderPrefixForChannel('telegram')).toBe('tg');
    expect(folderPrefixForChannel('discord')).toBe('dc');
    expect(folderPrefixForChannel('whatsapp')).toBe('wa');
    expect(folderPrefixForChannel('matrix')).toBe('mat');
    expect(folderPrefixForChannel('imessage')).toBe('imsg');
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `matrix`/`imessage` fall through to `slice(0,3)` (`'mat'` passes by luck, `'imessage'.slice(0,3)` = `'ime'` ≠ `'imsg'` → FAIL).

Run: `npx vitest run src/channel-runner.test.ts -t folderPrefixForChannel`
Expected: FAIL on the `imessage` assertion.

- [ ] **Step 3: Add the two entries** to the `prefix` map in `src/channel-runner.ts`:

```ts
    matrix: 'mat',
    imessage: 'imsg',
```

- [ ] **Step 4: Run the test, verify PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(channels): folder prefixes for matrix and imessage"`

---

## Phase 1 — Telegram (`telegram`)

> Establishes the reusable pattern. A `bootstrap-telegram.md` and the `tg` prefix already exist — reconcile to them.

**Library:** `telegraf@4.16.3`. **Transport:** long-poll (`bot.launch()`), no `httpPort`. **JID:** `telegram:<chatId>` (negative for groups). **Outbound chunk:** 4096. **Capabilities:** `{ typing: true, inboundImages: true, inboundPdfs: true, inboundVoice: true, outboundMedia: false }`, no `markdownOutput`. **Creds:** `TELEGRAM_BOT_TOKEN`.

### Task 1.1: Telegram adapter + unit tests (TDD)

**Files:**
- Create: `helm/kubeclaw/files/channel-src/telegram/channel-entry.js`
- Test: `src/channel-src/telegram-adapter.test.ts`

**Interfaces:**
- Consumes: the SDK (`registerChannel`, `logger`, `readEnvFile`, `assistantName`, `groupsDir`) and `ChannelOpts` (`onMessage`, `onChatMetadata`, `registeredGroups`).
- Produces: `class TelegramChannel`, `parseConfig(sdk)`, default `register(sdk)`. Pure helpers for tests: `ownsJid(jid)`, `buildInbound(ctx)` (maps a Telegraf `ctx` to `{ jid, message, isGroup, senderName }` or `null`).

- [ ] **Step 1: Write the failing unit test** `src/channel-src/telegram-adapter.test.ts`. Copy the harness from `signal-adapter.test.ts` (the `fakeSdk`/`fakeOpts`/`buildChannel` helpers) and adapt. Cover these cases (mirror the signal test's coverage):
  - factory builds a channel when `TELEGRAM_BOT_TOKEN` present; returns `null` when absent.
  - `name === 'telegram'`.
  - `ownsJid('telegram:123')` true; `ownsJid('irc:#x')` false; `ownsJid(undefined)` false.
  - `buildInbound` maps a private-chat update → `{ jid: 'telegram:123', isGroup: false, ... }` and a group update (negative id, `chat.type='group'`) → `isGroup: true`.
  - a registered private message routes to `onMessage` with the right JID + `onChatMetadata(..., 'telegram', false)`.
  - bare `@Andy` mention in a group is rewritten to a `@Andy ` prefix.
  - unregistered chat → `onMessage` NOT called.
  - the bot's own message (`ctx.from.is_bot` / from-self) → ignored.
  - `sendMessage` calls the Telegram client with the parsed chat id and chunks at 4096 (mock the client; assert call count for a 9000-char string = 3).
  - `parseConfig` honours an optional `TELEGRAM_BOT_USERNAME`.

  Mock telegraf by injecting a fake bot: structure the adapter so the client is created in `connect()` via an injectable factory (`this._makeBot = (token) => new Telegraf(token)`), and in tests replace `ch._makeBot` with a fake exposing `.telegram.sendMessage`, `.telegram.sendChatAction`, `.launch`, `.stop`, `.on`. This keeps `import { Telegraf } from 'telegraf'` out of the unit test's resolution path. (Telegraf isn't installed in the repo's dev deps — the import lives only in the channel-src file, which Vitest loads; guard by lazy `await import('telegraf')` inside `connect()` so module-load doesn't require the dep. Unit tests never call the real `connect()`.)

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/channel-src/telegram-adapter.test.ts` → FAIL (module/file absent).

- [ ] **Step 3: Implement `channel-entry.js`.** Structure (mirrors signal):

```js
/* eslint-disable */
const MAX_MESSAGE_LENGTH = 4096;

class TelegramChannel {
  name = 'telegram';
  capabilities = { typing: true, inboundImages: true, inboundPdfs: true, inboundVoice: true, outboundMedia: false };

  constructor(config, opts, sdk) {
    this.config = config; this.opts = opts; this.sdk = sdk;
    this.bot = null; this.connected = false; this.messageId = 0;
    this._makeBot = null; // set in connect(); overridable in tests
  }

  ownsJid(jid) { return typeof jid === 'string' && jid.startsWith('telegram:'); }

  /** Map a Telegraf message ctx → normalized inbound, or null to skip. */
  buildInbound(ctx) {
    const chat = ctx.chat; const from = ctx.from;
    if (!chat || !from) return null;
    if (from.is_bot) return null;                 // echo / other bots
    const jid = `telegram:${chat.id}`;
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    const senderName = from.username || [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id);
    const chatName = chat.title || senderName;
    const text = ctx.message?.text ?? ctx.message?.caption ?? '';
    return { jid, isGroup, senderName, chatName, sender: String(from.id), text };
  }

  handleCtx(ctx) {
    const inb = this.buildInbound(ctx);
    if (!inb) return;
    const registered = this.opts.registeredGroups()[inb.jid];
    if (!registered) { this.sdk.logger.debug({ jid: inb.jid }, 'telegram: unregistered chat'); return; }
    let content = inb.text;
    if (inb.isGroup && this.sdk.assistantName && content) {
      const trig = new RegExp(`^@${this.sdk.assistantName}\\b`, 'i');
      const ment = new RegExp(`@${this.sdk.assistantName}\\b`, 'i');
      if (ment.test(content) && !trig.test(content)) content = `@${this.sdk.assistantName} ${content}`;
    }
    if (!content) return; // media-only: v1 surfaces nothing (mark unsupported)
    const ts = Date.now(); const timestamp = new Date(ts).toISOString();
    this.opts.onChatMetadata(inb.jid, timestamp, inb.chatName, 'telegram', inb.isGroup);
    this.opts.onMessage(inb.jid, { id: `${ts}-${++this.messageId}`, chat_jid: inb.jid, sender: inb.sender, sender_name: inb.senderName, content, timestamp, is_from_me: false });
  }

  async connect() {
    const make = this._makeBot ?? (async (t) => { const { Telegraf } = await import('telegraf'); return new Telegraf(t); });
    this.bot = await make(this.config.token);
    this.bot.on('message', (ctx) => { try { this.handleCtx(ctx); } catch (err) { this.sdk.logger.warn({ err: String(err) }, 'telegram: handleCtx failed'); } });
    await this.bot.launch();           // long-poll; resolves once polling starts
    this.connected = true;
    this.sdk.logger.info('telegram: connected (long-poll)');
  }

  chunk(text, max) { if (text.length <= max) return [text]; const o=[]; for (let i=0;i<text.length;i+=max) o.push(text.slice(i,i+max)); return o; }

  async sendMessage(jid, text) {
    if (!this.ownsJid(jid) || !this.bot) return;
    const chatId = jid.slice('telegram:'.length);
    for (const c of this.chunk(text, MAX_MESSAGE_LENGTH)) {
      try { await this.bot.telegram.sendMessage(chatId, c); }
      catch (err) { this.sdk.logger.error({ jid, err: String(err) }, 'telegram: send failed'); }
    }
  }

  async setTyping(jid, isTyping) {
    if (!this.ownsJid(jid) || !this.bot || !isTyping) return;
    try { await this.bot.telegram.sendChatAction(jid.slice('telegram:'.length), 'typing'); } catch (err) { this.sdk.logger.debug({ err: String(err) }, 'telegram: typing failed'); }
  }

  isConnected() { return this.connected; }
  async disconnect() { this.connected = false; if (this.bot) { try { this.bot.stop(); } catch {} this.bot = null; } }
}

function parseConfig(sdk) {
  const env = sdk.readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME']);
  const token = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
  if (!token) { sdk.logger.warn('telegram: TELEGRAM_BOT_TOKEN is required'); return null; }
  return { token, botUsername: process.env.TELEGRAM_BOT_USERNAME || env.TELEGRAM_BOT_USERNAME || '' };
}

export default function register(sdk) {
  sdk.registerChannel('telegram', (opts) => { const cfg = parseConfig(sdk); if (!cfg) return null; return new TelegramChannel(cfg, opts, sdk); });
}
export { TelegramChannel, parseConfig };
```

- [ ] **Step 4: Run the unit test, verify PASS.** Fix until green.

- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): channel adapter + unit tests"`

### Task 1.2: Telegram manifest + reconcile bootstrap skill

**Files:**
- Modify: `helm/kubeclaw/values.yaml` (add `bootstrap.channelManifests.telegram`) — follow the `signal`/`irc` entries' shape (`hostMode: channel-runner`, `packageJson`, `packageLockJson`, `manifestHash`).
- Verify/Modify: `helm/kubeclaw/files/bootstrap-skills/bootstrap-telegram.md` (already exists — ensure `secret_data` key is `TELEGRAM_BOT_TOKEN` and the manifest path matches).

- [ ] **Step 1:** Generate a real lockfile: in a scratch dir, `npm install telegraf@4.16.3 --package-lock-only --ignore-scripts`, capture `package.json` + `package-lock.json`.
- [ ] **Step 2:** Compute `manifestHash` with the node one-liner from `bootstrap-telegram.md` Step 4.
- [ ] **Step 3:** Add the `telegram` manifest block to `values.yaml`.
- [ ] **Step 4: Integration test** `src/channel-manifests/reconciler.test.ts` (or the manifest-registry test) — assert the `telegram` manifest validates and its hash matches. Run, verify PASS.
- [ ] **Step 5:** `helm template` the chart with `channels.telegram-test.enabled=true type=telegram` and assert the channel Deployment + ConfigMap key `telegram__channel-entry.js` render. (Add to an existing helm-render integration test or a new `*.integration.test.ts`.)
- [ ] **Step 6: Commit** — `git commit -m "feat(telegram): manifest + bootstrap reconcile"`

### Task 1.3: Telegram integration test (fake transport)

**Files:**
- Test: `src/channel-src/telegram-adapter.integration.test.ts`

- [ ] **Step 1:** Write a test that drives the adapter end-to-end with a **fake bot** (no network): inject `ch._makeBot` returning an object that records the `message` handler and exposes a `.telegram.sendMessage` spy backed by an in-memory array; call `connect()`, push a fake `ctx` through the captured handler, assert `onMessage` fired; call `sendMessage` and assert the fake recorded the chunked sends. This exercises the full `connect → on('message') → handleCtx → onMessage` and `sendMessage → client` wiring against a real (fake) collaborator rather than mocking individual methods.
- [ ] **Step 2:** Run, verify FAIL→implement→PASS (implementation already exists; this validates wiring).
- [ ] **Step 3: Commit** — `git commit -m "test(telegram): integration test against fake bot"`

### Task 1.4: Telegram e2e + live-bootstrap e2e

**Files:**
- Test: `e2e/telegram-channel.test.ts`
- Test: extend/sibling a `minikube-live` bootstrap test (e.g. `e2e/minikube-live-channel-telegram-bootstrap.test.ts`).

- [ ] **Step 1:** `e2e/telegram-channel.test.ts` — stand up a tiny fake Telegram Bot API HTTP server (responds to `getMe`, `sendMessage`; `getUpdates` returns a queued update) and point a real `TelegramChannel` at it by overriding the telegraf API root (`new Telegraf(token, { telegram: { apiRoot: 'http://127.0.0.1:<port>' } })`). Drive: connect → server delivers an update → assert `onMessage` → `sendMessage` → assert the fake server received the POST. Follow the `e2e/irc-channel.test.ts` lifecycle shape.
- [ ] **Step 2:** The minikube-live bootstrap test: register the manifest + bootstrap skill, run the bootstrap flow with a mock LLM, assert the steady-state Deployment + Secret. Add a top-of-file comment: *"Requires an 8 GiB minikube; not runnable on the constrained dev host — runs in CI."*
- [ ] **Step 3:** Run `e2e/telegram-channel.test.ts` locally, verify PASS. (Skip the live one locally.)
- [ ] **Step 4: Commit** — `git commit -m "test(telegram): e2e (fake API) + live bootstrap e2e"`

### Task 1.5: Telegram docs + Phase-1 review gate

- [ ] **Step 1:** Add a Telegram section to `docs/INSTALLING_A_CHANNEL.md` (creds from @BotFather, `bootstrap_channel_from_skill(type="telegram")`, declarative values example).
- [ ] **Step 2:** Run the full unit suite: `PATH=/home/peter/.nvm/versions/node/v24.15.0/bin:$PATH npx vitest run src/channel-src/telegram-adapter` + `src/channel-runner.test.ts`. All green.
- [ ] **Step 3: Commit** — `git commit -m "docs(telegram): install guide"`
- [ ] **REVIEW GATE (two-stage, per channel):** spec-compliance review, then code-quality review (separate reviewer subagents). Fix findings before Phase 2.

---

## Phase 2 — Discord (`discord`)

**Library:** `discord.js@14`. **Transport:** Gateway WebSocket, no `httpPort`. **Intents:** `Guilds, GuildMessages, MessageContent, DirectMessages` (MessageContent is privileged). **JID:** `discord:<channelId>`. **Chunk:** 2000. **Capabilities:** `{ typing: true, inboundImages: true, inboundPdfs: true, markdownOutput: true, outboundMedia: false }`. **Creds:** `DISCORD_BOT_TOKEN`.

### Task 2.1: Discord adapter + unit tests

**Files:** Create `helm/kubeclaw/files/channel-src/discord/channel-entry.js`; Test `src/channel-src/discord-adapter.test.ts`.

**Interfaces:** `class DiscordChannel`, `parseConfig(sdk)`, `register(sdk)`. Pure helpers: `ownsJid`, `buildInbound(message)` (maps a discord.js `Message` → normalized inbound or `null`).

- [ ] **Step 1: Failing unit tests** (copy harness). Cases:
  - factory builds with `DISCORD_BOT_TOKEN`, `null` without.
  - `name === 'discord'`; `capabilities.markdownOutput === true`.
  - `ownsJid('discord:123')` true; foreign + `undefined` false.
  - `buildInbound`: a guild message → `{ jid: 'discord:<channelId>', isGroup: true, chatName: <guild#channel> }`; a DM (`!message.guild`) → `isGroup: false`; `message.author.bot === true` → `null` (echo guard).
  - registered guild message routes; group `@Andy` rewrite; unregistered drop.
  - **empty-content warning:** when `buildInbound` receives a message with `content === ''` and a guild present, the adapter logs a `sdk.logger.warn` mentioning the MessageContent intent (assert the warn fired).
  - `sendMessage` chunks at 2000 (9000-char → 5 sends) via an injected fake channel resolver.
  Inject the client like Telegram: `this._makeClient = (token) => new Client({intents}); ...` overridable in tests; lazy `await import('discord.js')` in `connect()` only.

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** the adapter (mirror Telegram structure). Key bits:
  - `connect()`: `const { Client, GatewayIntentBits, Partials } = await import('discord.js')`; create client with the four intents + `Partials.Channel` (for DMs); `client.on('messageCreate', m => this.handleMessage(m))`; `await client.login(token)`; set `connected` on the `ready` event.
  - `sendMessage(jid, text)`: `const channel = await this.client.channels.fetch(jid.slice('discord:'.length))`; for each chunk `await channel.send(chunk)`.
  - `setTyping`: `channel.sendTyping()`.
  - empty-content warn inside `handleMessage` when `message.guild && !message.content`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(discord): channel adapter + unit tests`.

### Task 2.2: Discord manifest

**Files:** `helm/kubeclaw/values.yaml` (`bootstrap.channelManifests.discord`); create `helm/kubeclaw/files/bootstrap-skills/bootstrap-discord.md`.

- [ ] **Step 1:** Lockfile for `discord.js@14` (`--package-lock-only --ignore-scripts`); compute hash.
- [ ] **Step 2:** Add manifest block. Bootstrap skill mirrors `bootstrap-telegram.md`: install packages, ask for `DISCORD_BOT_TOKEN`, validate via `curl -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me`, **instruct the operator to enable the Message Content Intent in the Developer Portal**, then `commit_channel_config` with `secret_data: {"DISCORD_BOT_TOKEN": ...}`.
- [ ] **Step 3:** Manifest validation + helm-render integration test (as Task 1.2 Steps 4–5). PASS.
- [ ] **Step 4: Commit** — `feat(discord): manifest + bootstrap skill`.

### Task 2.3: Discord integration test
- [ ] Fake discord.js `Client` (records `messageCreate` handler + `channels.fetch` returning a fake channel with a `send` spy); drive connect→inbound→`onMessage` and `sendMessage`→chunked sends. Commit `test(discord): integration test`.

### Task 2.4: Discord e2e
- [ ] `e2e/discord-channel.test.ts`: a fake gateway is heavy; instead instantiate `DiscordChannel` with an injected fake client and assert the full lifecycle (connect sets connected on `ready`, inbound routing, disconnect). Document that a real gateway round-trip is not CI-able (needs a live bot token), mirroring the signal e2e note. Commit `test(discord): e2e`.

### Task 2.5: Discord docs + REVIEW GATE
- [ ] `docs/INSTALLING_A_CHANNEL.md` Discord section (bot creation, **Message Content Intent toggle**, declarative example). Commit. Then two-stage review; fix findings.

---

## Phase 3 — Matrix (`matrix`)

**Library:** `matrix-js-sdk`. **Transport:** `/sync` long-poll. **Crypto:** OFF — **do NOT call `initRustCrypto()`; use `MemoryStore`.** **JID:** `matrix:<roomId>` (room ids contain a colon — safe via prefix `ownsJid` + sanitized folder). **Chunk:** 32000. **Capabilities:** `{ typing: true, inboundImages: true, outboundMedia: false }`, no `markdownOutput`. **Creds:** `MATRIX_HOMESERVER_URL`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`.

### Task 3.1: Matrix adapter + unit tests

**Files:** Create `helm/kubeclaw/files/channel-src/matrix/channel-entry.js`; Test `src/channel-src/matrix-adapter.test.ts`.

**Interfaces:** `class MatrixChannel`, `parseConfig(sdk)`, `register(sdk)`. Pure helpers: `ownsJid`, `buildInbound(event, room, syncReady)` (maps a timeline event → normalized inbound or `null`).

- [ ] **Step 1: Failing unit tests.** Cases:
  - factory builds when all three env vars present; `null` if any missing.
  - `ownsJid('matrix:!abc:hs.example')` true; foreign + `undefined` false.
  - `buildInbound`: an `m.room.message`/`m.text` event from another user with `syncReady=true` → `{ jid: 'matrix:<roomId>', isGroup: true }`; an event from **`this.config.userId`** → `null` (echo); an event when `syncReady=false` → `null` (don't replay history); a non-`m.room.message` type → `null`; duplicate event id → `null` (de-dupe set).
  - registered room routes; `@Andy` group rewrite; unregistered drop.
  - `sendMessage` chunks at 32000 and calls `client.sendTextMessage(roomId, chunk)`.
  Inject client: `this._makeClient = (cfg) => sdk-createClient(...)`; lazy `await import('matrix-js-sdk')` in `connect()`. Unit tests use a fake client (`{ on, startClient, sendTextMessage, sendTyping, stopClient, getUserId }`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Key bits:
  - `connect()`: `const sdkMx = await import('matrix-js-sdk'); this.client = sdkMx.createClient({ baseUrl, accessToken, userId, store: new sdkMx.MemoryStore() });` — **no `initRustCrypto()`**. Register `client.on('sync', state => { if (state === 'PREPARED') this.syncReady = true; })` and `client.on('Room.timeline', (event, room) => this.handleEvent(event, room))`; `await client.startClient({ initialSyncLimit: 1 })`; set `connected`.
  - `handleEvent`: pull `event.getType()`, `event.getContent()`, `event.getSender()`, `event.getId()`, `room.roomId`, `room.name`; apply `buildInbound`; de-dupe via a `Set` of event ids (cap size).
  - `sendMessage`: `await this.client.sendTextMessage(roomId, chunk)`.
  - `setTyping`: `await this.client.sendTyping(roomId, isTyping, 20000)`.
  - `disconnect`: `this.client?.stopClient()`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(matrix): channel adapter + unit tests (unencrypted)`.

### Task 3.2: Matrix manifest + bootstrap
- [ ] Lockfile for `matrix-js-sdk` (`--package-lock-only --ignore-scripts`; confirm `@matrix-org/matrix-sdk-crypto-wasm` resolves with no install script). Manifest block + `bootstrap-matrix.md` (ask for homeserver URL, user id, access token; validate via `GET {homeserver}/_matrix/client/v3/account/whoami`). Manifest-validation + helm-render integration tests. Commit `feat(matrix): manifest + bootstrap skill`.

### Task 3.3: Matrix integration test
- [ ] Fake matrix client emitting a `sync→PREPARED` then a `Room.timeline` event; assert `onMessage` only fires after PREPARED and never for self-sent events; assert `sendMessage` calls `sendTextMessage`. Commit `test(matrix): integration test`.

### Task 3.4: Matrix e2e
- [ ] `e2e/matrix-channel.test.ts`: drive `MatrixChannel` with an injected fake client through the full lifecycle (connect → PREPARED → inbound → disconnect). Note a real homeserver round-trip is not CI-able. Commit `test(matrix): e2e`.

### Task 3.5: Matrix docs + REVIEW GATE
- [ ] `docs/INSTALLING_A_CHANNEL.md` Matrix section (how to get an access token; unencrypted-rooms caveat). Commit. Two-stage review; fix.

---

## Phase 4 — WhatsApp (`whatsapp`)

**Integration:** Meta WhatsApp Business **Cloud API** (no npm deps; native `fetch`). **Inbound:** binds `httpPort` (4080) → Service + Ingress, exposes `GET/POST /webhook`. **TLS required** (operator sets `ingress.tls`). **JID:** `whatsapp:<e164>` + `whatsapp:group.<id>`. **Chunk:** 4096. **Capabilities:** `{ inboundImages: false, outboundMedia: false }` (text-first v1; media marked unsupported). **Creds:** `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`.

### Task 4.1: WhatsApp adapter + unit tests

**Files:** Create `helm/kubeclaw/files/channel-src/whatsapp/channel-entry.js`; Test `src/channel-src/whatsapp-adapter.test.ts`.

**Interfaces:** `class WhatsAppChannel`, `parseConfig(sdk)`, `register(sdk)`. Pure helpers: `ownsJid`, `verifySignature(rawBody, headerSig)` (HMAC-SHA256 over the raw body using `WHATSAPP_APP_SECRET`, constant-time compare), `parseWebhook(body)` (→ array of normalized inbound), `handleVerify(query)` (→ challenge string or null).

- [ ] **Step 1: Failing unit tests.** Cases:
  - factory builds when all four creds present; `null` if any missing.
  - `ownsJid('whatsapp:+15551230000')` + `whatsapp:group.X` true; foreign/`undefined` false.
  - `handleVerify({ 'hub.mode':'subscribe', 'hub.verify_token': <good>, 'hub.challenge':'123' })` → `'123'`; wrong token → `null`.
  - `verifySignature`: a body signed with the secret → true; tampered body or wrong sig → false.
  - `parseWebhook`: a `messages` payload → `[{ jid:'whatsapp:<wa_id>', sender, senderName, text }]`; a `statuses` payload → `[]` (ignored); an own-message echo → ignored.
  - registered chat routes to `onMessage`; unregistered drop.
  - `sendMessage` POSTs to `https://graph.facebook.com/v20.0/<PHONE_NUMBER_ID>/messages` with `{ messaging_product:'whatsapp', to:<e164>, type:'text', text:{ body } }` and chunks at 4096 (mock `fetch`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Uses `node:http` for the webhook server (like the http adapter), `node:crypto` for HMAC. `connect()` starts the server on `config.httpPort` (default 4080); routes `GET /webhook`→`handleVerify`, `POST /webhook`→ read raw body, `verifySignature` (reject 403 on mismatch), `parseWebhook`, route each via the registered-groups + echo guards. `sendMessage` via `fetch` with `Authorization: Bearer <accessToken>`. Media inbound → append `[Attachment: unsupported in v1]` marker and still deliver any text.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(whatsapp): cloud-API adapter + unit tests`.

### Task 4.2: WhatsApp manifest (httpPort + ingress) + bootstrap
- [ ] Manifest block with **`httpPort: 4080`** so the chart renders a Service + Ingress (follow the `http`/`oauth-webchat` manifest entries). `packageJson` has no deps (native fetch) — still pin an empty-deps lockfile + hash. `bootstrap-whatsapp.md`: ask for the four creds, validate token via `GET /<PHONE_NUMBER_ID>`, explain registering the webhook callback URL + verify token in Meta's dashboard, and **state the `ingress.tls` HTTPS requirement**. Manifest-validation + helm-render integration tests (assert Service + Ingress render; assert TLS note). Commit `feat(whatsapp): manifest + ingress + bootstrap`.

### Task 4.3: WhatsApp integration test
- [ ] Boot the adapter's real `node:http` server on an ephemeral port; (1) `GET /webhook?hub...` returns the challenge; (2) `POST /webhook` with a correctly-signed messages body → `onMessage` fires; (3) `POST /webhook` with a bad signature → 403 and no `onMessage`. Use the real HMAC to sign. Commit `test(whatsapp): integration (real http server)`.

### Task 4.4: WhatsApp e2e
- [ ] `e2e/whatsapp-channel.test.ts`: full loop against a fake Graph API server — inbound webhook POST → `onMessage` → `sendMessage` → assert the fake Graph server received the outbound POST with the right body/auth header. Note a live Meta round-trip needs a Business account (not CI-able). Commit `test(whatsapp): e2e`.

### Task 4.5: WhatsApp docs + REVIEW GATE
- [ ] `docs/INSTALLING_A_CHANNEL.md` WhatsApp section (Meta app setup, webhook URL + verify token, **TLS/HTTPS requirement**, declarative example incl. `ingress.tls`). Commit. Two-stage review; fix.

---

## Phase 5 — iMessage (`imessage`)

**Integration:** external **BlueBubbles** server on a Mac (operator infra). Adapter is a REST client; **polling** receive model (no `httpPort`/ingress). Closely mirrors the **signal** adapter. **JID:** `imessage:<handle>` + `imessage:group.<guid>`. **Chunk:** 10000. **Capabilities:** text-only v1. **Creds:** `IMESSAGE_BRIDGE_URL`, `IMESSAGE_BRIDGE_PASSWORD`, optional `IMESSAGE_POLL_MS` (default 3000).

### Task 5.1: iMessage adapter + unit tests

**Files:** Create `helm/kubeclaw/files/channel-src/imessage/channel-entry.js`; Test `src/channel-src/imessage-adapter.test.ts`.

**Interfaces:** `class IMessageChannel`, `parseConfig(sdk)`, `register(sdk)`. Helpers: `ownsJid`, `jidForMessage(msg)`, `recipientForJid(jid)`, `pollOnce()` (mirror signal's `receiveOnce`), `handleMessage(msg)`.

- [ ] **Step 1: Failing unit tests** (copy the signal test harness closely — this is the nearest analog). Cases:
  - factory builds when `IMESSAGE_BRIDGE_URL` + `IMESSAGE_BRIDGE_PASSWORD` present; `null` otherwise.
  - `apiUrl` trailing slash trimmed; `pollMs` default 3000, honours `IMESSAGE_POLL_MS`.
  - `ownsJid('imessage:+15551230000')` + `imessage:group.<guid>` true; foreign/`undefined` false.
  - `jidForMessage`: a group chat (`chats[0].guid` group) → `imessage:group.<guid>`; a 1:1 → `imessage:<handle>`.
  - `pollOnce` parses a BlueBubbles message-query response and routes each new message; tracks a cursor so the same message isn't re-delivered; ignores `isFromMe`; unregistered drop; `@Andy` group rewrite.
  - `sendMessage` POSTs to `<url>/api/v1/message/text?password=<pw>` (or BlueBubbles' documented auth) with `{ chatGuid, message }`, chunked at 10000; ignores non-imessage JID.
  - non-200 poll → no routing; fetch throw → propagates (caught by the schedule loop) without crashing.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** by adapting `signal/channel-entry.js`: same `scheduleReceive`/`unref` poll loop, same registered-groups/echo/trigger logic, same chunking. Differences: BlueBubbles endpoints + a `lastSeen` cursor (timestamp or rowId) instead of signal's drain-queue semantics; auth via password param/header per BlueBubbles. `connect()` probes `GET /api/v1/ping`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(imessage): BlueBubbles polling adapter + unit tests`.

### Task 5.2: iMessage manifest + bootstrap
- [ ] Manifest block (no deps; native fetch; empty-deps lockfile + hash; no `httpPort`). `bootstrap-imessage.md`: ask for bridge URL + password; validate via `GET /api/v1/ping`; **prominently document the external-Mac + BlueBubbles-server prerequisite**. Manifest-validation + helm-render integration tests. Commit `feat(imessage): manifest + bootstrap`.

### Task 5.3: iMessage integration test
- [ ] In-process fake BlueBubbles REST server (`/api/v1/ping`, message-query returning queued messages, `/api/v1/message/text` recording sends); drive connect→pollOnce→`onMessage` and `sendMessage`→recorded POST; assert cursor advances (second poll returns nothing new → no duplicate delivery). Commit `test(imessage): integration (fake BlueBubbles)`.

### Task 5.4: iMessage e2e
- [ ] `e2e/imessage-channel.test.ts`: full lifecycle against the fake BlueBubbles server (connect → poll delivers → route → send → disconnect). Note a live round-trip needs a Mac running BlueBubbles (not CI-able), mirroring signal. Commit `test(imessage): e2e`.

### Task 5.5: iMessage docs + REVIEW GATE
- [ ] `docs/INSTALLING_A_CHANNEL.md` iMessage section (BlueBubbles server setup on a Mac, URL/password, the hard external-hardware prerequisite). Commit. Two-stage review; fix.

---

## Final integration pass

### Task 6: Full-suite green + spec cross-check

- [ ] **Step 1:** Run the entire unit/integration suite with Node on PATH: `PATH=/home/peter/.nvm/versions/node/v24.15.0/bin:$PATH npm test`. All green (no regressions in the ~3193 existing tests).
- [ ] **Step 2:** `helm template helm/kubeclaw` renders cleanly with each new channel enabled in turn.
- [ ] **Step 3:** Cross-check every spec section has a landed task; update the spec's Status to "Implemented" and note any deferred items (v1 media, Matrix E2EE) in a short "Deferred" subsection.
- [ ] **Step 4: Commit** — `chore(channels): five-channel breadth pass complete`.
- [ ] **Step 5:** STOP at the merge/PR decision — hand to the user (do not merge to main).

---

## Self-review (against the spec)

- **Coverage:** every per-channel spec section (1–5) → a Phase (1–5) with adapter+manifest+bootstrap+3-level tests+docs+review; shared folder-prefix fix → Task 0; reviewer should-fix items → Matrix no-`initRustCrypto` (Task 3.1/3.3), Discord intent toggle+warning (Task 2.1/2.2/2.5), iMessage polling (Phase 5), WhatsApp TLS (Task 4.2/4.5), prefixes (Task 0). ✔
- **Placeholders:** none — each adapter has concrete code or an exact concrete template (`signal`) plus per-channel deltas; each test task enumerates named cases. ✔
- **Type/name consistency:** every adapter exposes the same `Channel` surface + `parseConfig`/`register`/named exports; JID prefixes match `ownsJid` and the Task 0 folder table; `NewMessage` shape identical across channels. ✔
- **Three-level tests:** every channel has unit + integration + e2e tasks; live-cluster limits documented, not skipped silently. ✔
