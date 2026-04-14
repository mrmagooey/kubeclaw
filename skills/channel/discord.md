---
name: discord
description: Discord channel via discord.js
dependencies:
  - discord.js
env:
  - DISCORD_BOT_TOKEN
---

# Discord Channel

Connects to Discord using the discord.js library.

## Setup

1. Create an app at the Discord Developer Portal
2. Create a bot user and copy the token
3. Enable Privileged Gateway Intents: Message Content Intent
4. Invite the bot to your server with `bot` and `applications.commands` scopes

## Configuration

- `DISCORD_BOT_TOKEN`: bot token from Developer Portal

## JID Format

`dc:{channelId}` — get the channel ID from Discord Developer Mode (right-click channel, Copy Channel ID).

## Notes

- Message splitting at 2000 char Discord limit
- Typing indicators supported
- Reply context preserved
- `<@botId>` mentions translated to trigger format
