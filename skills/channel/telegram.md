---
name: telegram
description: Telegram Bot API channel via Grammy
dependencies:
  - grammy
env:
  - TELEGRAM_BOT_TOKEN
---

# Telegram Channel

Connects to Telegram via the Bot API using the Grammy library.

## Setup

1. Create a bot via @BotFather on Telegram
2. Copy the bot token
3. Optionally disable Group Privacy in BotFather settings for group monitoring

## Configuration

- `TELEGRAM_BOT_TOKEN`: bot token from BotFather

## JID Format

- `tg:{chatId}` for groups (e.g. `tg:-1001234567890`)
- `tg:{userId}` for direct messages

## Group Registration

Get the chat ID by sending a message to the bot in the target group, then check
the orchestrator logs or use the admin shell `list_channels` tool.

## Notes

- Supports typing indicators
- Message splitting at 4096 char Telegram limit
- Inline mentions translated to trigger format
