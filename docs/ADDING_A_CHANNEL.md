# Adding a Channel

This guide explains how to implement a new channel as a runtime adapter. For packaging, install, and the bootstrap/Helm workflow, see [docs/DEVELOPING_A_CHANNEL.md](DEVELOPING_A_CHANNEL.md).

## Required interface

Every channel must implement the `Channel` interface from `src/types.ts`:

```typescript
export interface Channel {
  name: string;                                                  // unique identifier, e.g. 'telegram'
  connect(): Promise<void>;                                      // establish connection to platform
  sendMessage(jid: string, text: string): Promise<void>;        // send outbound text
  isConnected(): boolean;                                        // connection status check
  ownsJid(jid: string): boolean;                                // true if this channel handles the JID
  disconnect(): Promise<void>;                                   // clean shutdown
}
```

### JID conventions

Channels must prefix every JID with their channel name and a colon:

- `telegram:12345678`
- `signal:+61412345678`
- `irc:#channel@irc.server`

`ownsJid` typically looks like:

```typescript
ownsJid(jid: string): boolean {
  return jid.startsWith('telegram:');
}
```

This prefix is how the router determines which channel handles outbound delivery.

## JID format and folder naming

### JID format

Every JID passed to `onMessage` and `onChatMetadata` must follow the format:

```
channelname:identifier
```

The part before the colon is the channel type name (the string passed to `registerChannel`). The part after the colon is the platform-specific identifier — a chat ID, phone number, channel name, etc. Examples:

- `telegram:-1001234567890`
- `discord:987654321098765432`
- `slack:C01ABCDEF12`
- `irc:#general@irc.libera.chat`

### How `jidToFolder` derives the group folder name

In channel-pod mode (`KUBECLAW_MODE=channel`), every new chat seen via `onChatMetadata` is automatically registered. The folder name is derived from the channel type and the JID identifier by `jidToFolder` in `src/channel-runner.ts`, which calls the exported `folderPrefixForChannel` utility.

The full prefix table (from `folderPrefixForChannel`):

| Channel type | Folder prefix |
|---|---|
| `telegram` | `tg` |
| `discord` | `dc` |
| `slack` | `sl` |
| `whatsapp` | `wa` |
| `irc` | `irc` |
| `http` | `http` |
| `oauth-webchat` | `oauth` |
| _(unknown)_ | first 3 chars of channel name |

The identifier part of the JID is then sanitised:

1. All non-alphanumeric characters are replaced with `-`
2. Consecutive `-` are collapsed to one
3. Leading and trailing `-` are stripped
4. The result is truncated to 55 characters

The final folder name is `{prefix}-{sanitized-identifier}`, e.g. `tg-1001234567890` or `dc-987654321098765432`.

The folder prefix logic is baked into the host — adapters do not need to compute it. The table above is provided as a reference so you can predict the folder name your channel will use (e.g. when constructing attachment paths).

## Capabilities declaration

Add a `capabilities` property to your class to declare what optional features your channel supports:

```js
class MyChannel {
  name = 'mychannel';
  capabilities = {
    typing: true,
    groupSync: true,
    inboundImages: true,
    inboundPdfs: false,   // can omit false fields entirely
    inboundVoice: false,
    markdownOutput: true,
  };
  // ...
}
```

`capabilities` is optional on the `Channel` interface — omitting it is valid for a minimal channel. But declaring it explicitly (even as `{}`) signals to skill authors that the capability question was considered.

### Capability reference

| Field | What it means | What to implement |
|-------|--------------|-------------------|
| `typing` | Show a typing indicator while agent is working | `setTyping(jid, isTyping)` |
| `groupSync` | Discover group/chat names from the platform | `syncGroups(force)` |
| `inboundImages` | Receive image attachments from users | Write `[ImageAttachment: ...]` markers (see below) |
| `inboundPdfs` | Receive PDF attachments from users | Write `[PdfAttachment: ...]` markers (see below) |
| `inboundVoice` | Receive voice/audio messages | Transcribe inline or write `[VoiceAttachment: ...]` markers |
| `markdownOutput` | Platform renders markdown natively | No code needed; signals to future agent runtime |

## Implementing each capability

### `typing: true` — typing indicator

```typescript
async setTyping(jid: string, isTyping: boolean): Promise<void> {
  // Send platform-specific typing action
  // e.g. await this.bot.api.sendChatAction(chatId, 'typing');
}
```

The orchestrator calls `channel.setTyping?.(jid, true)` before the agent starts and `setTyping(jid, false)` after it finishes.

### `groupSync: true` — group name discovery

```typescript
async syncGroups(force: boolean): Promise<void> {
  // Fetch group/chat list from platform
  // Call this.opts.onChatMetadata(...) for each one
  // Use force flag to bypass rate limits if needed
}
```

The orchestrator calls this periodically via IPC to keep group names up to date.

### `inboundImages: true` — image attachments

When a user sends an image, download the binary and write it to the group's attachment directory, then embed a marker in the message content:

```js
import path from 'path';
import fs from 'fs';

// sdk.groupsDir is the resolved groups directory path
const rawDir = path.join(sdk.groupsDir, folder, 'attachments', 'raw');
fs.mkdirSync(rawDir, { recursive: true });

const filename = `img-${Date.now()}.jpg`;
const rawPath = path.join('attachments', 'raw', filename);
fs.writeFileSync(path.join(sdk.groupsDir, folder, rawPath), imageBuffer);

// Embed marker in message content (caption is optional):
const marker = caption
  ? `[ImageAttachment: ${rawPath} caption="${caption}"]`
  : `[ImageAttachment: ${rawPath}]`;
content = marker + '\n' + content;
```

A preprocessing pipeline (image-vision) is expected to read these markers, resize the image, and rewrite them to `[Image: attachments/processed/...]` before the agent sees them. See `docs/INSTALLING_A_CHANNEL.md` (capability section) for how to add the pipeline via `/customize`.

### `inboundPdfs: true` — PDF attachments

Same pattern as images, using the `[PdfAttachment: ...]` marker format:

```js
const filename = `doc-${Date.now()}.pdf`;
const rawPath = path.join('attachments', 'raw', filename);
fs.writeFileSync(path.join(sdk.groupsDir, folder, rawPath), pdfBuffer);
content = `[PdfAttachment: ${rawPath}]\n` + content;
```

A pdf-reader preprocessing module must also be present for the agent to receive extracted PDF text. See `docs/INSTALLING_A_CHANNEL.md` for how to add it via `/customize`.

### `inboundVoice: true` — voice messages

Two implementation patterns:

**Option A — Inline transcription (recommended for simplicity):**

```js
// Requires a transcription helper available in your adapter's npm deps (e.g. openai)
// See docs/INSTALLING_A_CHANNEL.md for how to add voice transcription via /customize.

// Download audio bytes from platform...
const transcript = await transcribeAudio(audioBuffer); // your platform helper
if (transcript) {
  content = `[Voice: ${transcript}]\n${content}`;
}
```

**Option B — Attachment marker (uses preprocessing pipeline):**

```js
const filename = `voice-${Date.now()}.ogg`;
const rawPath = path.join('attachments', 'raw', filename);
fs.writeFileSync(path.join(sdk.groupsDir, folder, rawPath), audioBuffer);
content = `[VoiceAttachment: ${rawPath}]\n` + content;
```

### `markdownOutput: true` — markdown rendering

No code needed in the channel. This flag signals that the platform renders markdown (bold, italic, code blocks). The agent runtime may use this in future to format responses appropriately.

When your platform requires specific escaping (e.g. Telegram's `MarkdownV2`), handle that in `sendMessage` before dispatching to the API.

## Adapter registration

Channels are **runtime adapters** — plain JS files shipped in the `kubeclaw-channel-src` ConfigMap and loaded at runtime. There are no compiled-in channel modules; `src/channels/index.ts` imports no channel code.

An adapter must **default-export a `register(sdk)` function** that calls `sdk.registerChannel`:

```js
// helm/kubeclaw/files/channel-src/mychannel/channel-entry.js

class MyChannel {
  name = 'mychannel';
  // ...
}

export default function register(sdk) {
  sdk.registerChannel('mychannel', (opts) => {
    // readEnvFile(keys: string[]) → Record<string, string> (reads the mounted
    // credential file); fall back to the process env.
    const env = sdk.readEnvFile(['MYCHANNEL_TOKEN']);
    const token = process.env.MYCHANNEL_TOKEN || env.MYCHANNEL_TOKEN;
    if (!token) {
      sdk.logger.warn('MyChannel: MYCHANNEL_TOKEN not set');
      return null; // returning null disables the channel silently
    }
    return new MyChannel(token, opts, sdk);
  });
}
```

The factory returns `null` when credentials are missing — the channel is skipped without crashing the host.

### `ChannelOpts`

The `opts` argument passed by the host to your factory provides:
- `opts.onMessage(chatJid, message)` — deliver an inbound message to storage
- `opts.onChatMetadata(chatJid, timestamp, name?, channelName?, isGroup?)` — register a chat
- `opts.registeredGroups()` — read the current group configuration

### The `sdk` object

The injected `sdk` (`ChannelSdk`) gives the adapter access to host services without importing internal modules:

- **Core:** `registerChannel`, `logger`, `readEnvFile`, `assistantName`, `groupsDir`
- **Data-facade** (typed pass-throughs to host db/skill-store/config): `config`, `history`, `tasks`, `jobs`, `audit`, `diag`, `skills`

Pure transports (IRC, Signal) typically use only `sdk.logger` and `sdk.readEnvFile`. Channels that expose REST endpoints (HTTP) use the full data-facade.

## Packaging, install, and the full authoring workflow

The adapter contract described above (the `register(sdk)` export and the `Channel` interface) is all you need to understand when writing a channel implementation. For everything else — the Helm manifest, bootstrap skill, host-selector (`hostMode`), declarative vs. interactive install, and the `remove_channel` tool — see:

**[docs/DEVELOPING_A_CHANNEL.md](DEVELOPING_A_CHANNEL.md)**

That guide owns the full runtime-adapter packaging and install lifecycle. This guide intentionally does not duplicate it.

## Checklist for a new channel adapter

- [ ] Implements all 6 required `Channel` methods
- [ ] JIDs are prefixed with `channelname:`
- [ ] `readonly capabilities` declared (even if `{}`)
- [ ] Default-exports `register(sdk)` which calls `sdk.registerChannel('<type>', factory)`
- [ ] Factory returns `null` when credentials are missing
- [ ] File placed at `helm/kubeclaw/files/channel-src/<type>/channel-entry.js`
- [ ] Manifest and install steps covered in `docs/DEVELOPING_A_CHANNEL.md`
- [ ] Tests cover: message receipt, `ownsJid`, `sendMessage`, credential-missing returns null

## See also

- [docs/EXECUTION_MODES.md](EXECUTION_MODES.md) — explains the difference between orchestrator mode and channel-pod mode, including how chats are auto-registered in channel-pod mode and how `KUBECLAW_MODE`/`KUBECLAW_CHANNEL` control which path runs.
