# Add IRC Channel

This skill adds IRC (Internet Relay Chat) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `irc` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: What IRC server do you want to connect to?

If they have a server, collect it now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-irc
```

This deterministically:

- Adds `src/channels/irc.ts` (IRCChannel class with self-registration via `registerChannel`)
- Adds `src/channels/irc.test.ts` (unit tests with irc-upd mock)
- Appends `import './irc.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `irc-upd` npm dependency
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:

- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new IRC tests) and build must be clean before proceeding.

## Phase 3: Setup

### Configure environment

Add to `.env`:

```bash
IRC_SERVER=irc.libera.chat
IRC_PORT=6697
IRC_NICK=YourBot
IRC_CHANNELS=#channel1,#channel2
```

Wait for the user to provide their server, port, nick, and channels.

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Channel Info

The JID format is `irc:#channelname@server`. For example: `irc:#general@libera.chat`

Tell the user:

> To register an IRC channel:
>
> 1. Make sure the bot has joined the channel (it will auto-join based on IRC_CHANNELS)
> 2. The channel JID will be: `irc:#yourchannel@<server>`
>
> The channel ID will be: `irc:#channelname@server`

Wait for the user to provide the channel ID.

### Register the channel

Use the IPC register flow or register directly. The channel ID, name, and folder name are needed.

For a main channel (responds to all messages):

```typescript
registerGroup('irc:#channel@server', {
  name: 'server #channel',
  folder: 'irc_main',
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional channels (trigger-only):

```typescript
registerGroup('irc:#channel@server', {
  name: 'server #channel',
  folder: 'irc_channel',
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered IRC channel:
>
> - For main channel: Any message works
> - For non-main: @mention the bot (e.g., @YourBot) in IRC
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `IRC_SERVER`, `IRC_PORT`, `IRC_NICK`, `IRC_CHANNELS` are set in `.env` AND synced to `data/env/env`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'irc:%'"`
3. For non-main channels: message must include @mention of the bot's nick
4. Service is running: `launchctl list | grep nanoclaw`
5. Verify the bot connected to the server (check logs)

### Connection refused

- Verify the server and port are correct
- Check if the server requires SSL/TLS (try port 6697 for SSL)
- Some servers may require SASL authentication

### Nick already in use

The bot will automatically retry with different nicks. Update `IRC_NICK` to a unique nickname.

### Bot only responds to @mentions

This is the default behavior for non-main channels (`requiresTrigger: true`). To change:

- Update the registered group's `requiresTrigger` to `false`
- Or register the channel as the main channel

## After Setup

The IRC bot supports:

- Text messages in registered channels
- @mention translation (IRC @nickname → NanoClaw trigger format)
- Message splitting for responses over 480 characters
- Auto-reconnect on disconnect
- SSL/TLS connections (port 6697)
