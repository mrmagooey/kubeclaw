# Adding a Channel

This guide explains how to implement a new channel and package it as a skill.

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
| _(unknown)_ | first 3 chars of channel name |

The identifier part of the JID is then sanitised:

1. All non-alphanumeric characters are replaced with `-`
2. Consecutive `-` are collapsed to one
3. Leading and trailing `-` are stripped
4. The result is truncated to 55 characters

The final folder name is `{prefix}-{sanitized-identifier}`, e.g. `tg-1001234567890` or `dc-987654321098765432`.

If you need to discover your channel's folder prefix at runtime you can import `folderPrefixForChannel` directly:

```typescript
import { folderPrefixForChannel } from '../channel-runner.js';

const prefix = folderPrefixForChannel('mychannel'); // → 'myc' (3-char fallback)
```

## Capabilities declaration

Add a `readonly capabilities` property to your class to declare what optional features your channel supports:

```typescript
import { Channel, ChannelCapabilities } from '../types.js';

export class MyChannel implements Channel {
  name = 'mychannel';
  readonly capabilities: ChannelCapabilities = {
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

When a user sends an image, download the binary and write it to the group's attachment directory, then embed a marker in the message content using the `imageAttachmentMarker` builder:

```typescript
import path from 'path';
import fs from 'fs';
import { GROUPS_DIR } from '../config.js';
import { imageAttachmentMarker } from '../attachment-markers.js';

// Download image bytes from platform...
const folder = getGroupFolder(chatJid); // your channel's folder lookup
const rawDir = path.join(GROUPS_DIR, folder, 'attachments', 'raw');
fs.mkdirSync(rawDir, { recursive: true });

const filename = `img-${Date.now()}.jpg`;
const rawPath = path.join('attachments', 'raw', filename);
fs.writeFileSync(path.join(GROUPS_DIR, folder, rawPath), imageBuffer);

// Embed marker in message content (caption is optional):
content = imageAttachmentMarker(rawPath, caption) + '\n' + content;
```

The preprocessing pipeline (added by the `add-image-vision` skill) reads these markers, resizes the image, and rewrites them to `[Image: attachments/processed/...]` before the agent sees them.

### `inboundPdfs: true` — PDF attachments

Same pattern as images, using `pdfAttachmentMarker`:

```typescript
import { pdfAttachmentMarker } from '../attachment-markers.js';

const filename = `doc-${Date.now()}.pdf`;
const rawPath = path.join('attachments', 'raw', filename);
fs.writeFileSync(path.join(GROUPS_DIR, folder, rawPath), pdfBuffer);
content = pdfAttachmentMarker(rawPath) + '\n' + content;
```

The `add-pdf-reader` skill must also be applied for the agent to receive extracted PDF text.

### `inboundVoice: true` — voice messages

Two implementation patterns:

**Option A — Inline transcription (recommended for simplicity):**

```typescript
import { transcribeBuffer } from '../transcription.js'; // added by add-voice-transcription skill

// Download audio bytes from platform...
const transcript = await transcribeBuffer(audioBuffer);
if (transcript) {
  content = `[Voice: ${transcript}]\n${content}`;
}
```

Requires the `add-voice-transcription` skill to be applied (which adds `src/transcription.ts` and the `openai` npm dependency).

**Option B — Attachment marker (uses preprocessing pipeline):**

```typescript
import { voiceAttachmentMarker } from '../attachment-markers.js';

const filename = `voice-${Date.now()}.ogg`;
const rawPath = path.join('attachments', 'raw', filename);
fs.writeFileSync(path.join(GROUPS_DIR, folder, rawPath), audioBuffer);
content = voiceAttachmentMarker(rawPath) + '\n' + content;
```

### `markdownOutput: true` — markdown rendering

No code needed in the channel. This flag signals that the platform renders markdown (bold, italic, code blocks). The agent runtime may use this in future to format responses appropriately.

When your platform requires specific escaping (e.g. Telegram's `MarkdownV2`), handle that in `sendMessage` before dispatching to the API.

## Self-registration

Channels register themselves at module load time. The factory returns `null` if credentials are missing (auto-disable):

```typescript
import { registerChannel, ChannelOpts } from './registry.js';

registerChannel('mychannel', (opts: ChannelOpts) => {
  const token = process.env.MYCHANNEL_TOKEN || '';
  if (!token) {
    console.warn('MyChannel: MYCHANNEL_TOKEN not set');
    return null;
  }
  return new MyChannel(token, opts);
});
```

`ChannelOpts` provides:
- `opts.onMessage(chatJid, message)` — deliver an inbound message to storage
- `opts.onChatMetadata(chatJid, timestamp, name?, channelName?, isGroup?)` — register a chat
- `opts.registeredGroups()` — read the current group configuration

## Skill manifest

A minimal `manifest.yaml` for a new channel skill:

```yaml
skill: mychannel
version: 1.0.0
core_version: ">=1.0.0"

adds:
  - src/channels/mychannel.ts
  - src/channels/mychannel.test.ts

modifies:
  - src/channels/index.ts

structured:
  npm_dependencies:
    some-platform-sdk: "^4.0.0"
  env_additions:
    - MYCHANNEL_TOKEN

conflicts: []
depends: []

test: "npx vitest run src/channels/mychannel.test.ts"
```

The `modifies` entry for `src/channels/index.ts` appends `import './mychannel.js'` so the channel self-registers at startup.

## Plugin channels (runtime-loaded)

### When to use a plugin vs. TypeScript source

The normal approach is to add a TypeScript source file (`src/channels/mychannel.ts`) that is compiled when the skill is applied and self-registers at startup via `src/channels/index.ts`. This is suitable for all first-party and skill-distributed channels.

A plugin (a pre-compiled `.js` file placed in `/workspace/plugins/`) is loaded dynamically at runtime via `src/channels/plugin-loader.ts`. Use this approach when the channel code cannot or should not go through the TypeScript compile step — for example, when shipping pre-compiled code for distribution outside the normal skill apply pipeline.

### The plugin contract

A plugin file must export a single default function that receives a `ChannelPluginContext` and calls `ctx.registerChannel` to register its channel:

```js
// mychannel.plugin.js — must have a default export
export default function(ctx) {
  ctx.registerChannel('mychannel', (opts) => {
    const token = process.env.MYCHANNEL_TOKEN;
    if (!token) {
      console.warn('MyChannel: MYCHANNEL_TOKEN not set');
      return null;  // returning null disables the channel silently
    }
    return new MyChannel(token, opts);
  });
}
```

The factory function follows the same contract as a TypeScript source channel:
- It receives `ChannelOpts` (`onMessage`, `onChatMetadata`, `registeredGroups`)
- It must return a `Channel` instance, or `null` if credentials are missing

### Where to place the file

Place the compiled `.js` file at `/workspace/plugins/<filename>.js` inside the container. The loader scans every `*.js` file in that directory at startup. If the directory does not exist, startup proceeds normally with no error.

In a skill, add the file under `container/plugins/` and list it in the `adds` section of `manifest.yaml`:

```yaml
adds:
  - container/plugins/mychannel.plugin.js
```

The skill apply tooling copies files under `container/` into the image at `/workspace/`.

### Manifest entry

A minimal `manifest.yaml` for a plugin-based channel skill:

```yaml
skill: mychannel-plugin
version: 1.0.0
core_version: ">=1.0.0"

adds:
  - container/plugins/mychannel.plugin.js

structured:
  npm_dependencies: {}
  env_additions:
    - MYCHANNEL_TOKEN

conflicts: []
depends: []
```

No `modifies` entry for `src/channels/index.ts` is needed — plugin channels are discovered automatically from the plugins directory without any import added to source.

## Checklist for a new channel skill

- [ ] Implements all 6 required `Channel` methods
- [ ] JIDs are prefixed with `channelname:`
- [ ] `readonly capabilities` declared (even if `{}`)
- [ ] `registerChannel()` call at module bottom with credential check
- [ ] Adds `import './mychannel.js'` to `src/channels/index.ts`
- [ ] `manifest.yaml` lists all env vars in `env_additions`
- [ ] Tests cover: message receipt, `ownsJid`, `sendMessage`, credential-missing returns null

## See also

- [docs/EXECUTION_MODES.md](EXECUTION_MODES.md) — explains the difference between orchestrator mode and channel-pod mode, including how chats are auto-registered in channel-pod mode and how `KUBECLAW_MODE`/`KUBECLAW_CHANNEL` control which path runs.
