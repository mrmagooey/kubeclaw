---
name: slack
description: Slack channel via Socket Mode (@slack/bolt)
dependencies:
  - "@slack/bolt"
env:
  - SLACK_BOT_TOKEN
  - SLACK_APP_TOKEN
---

# Slack Channel

Connects to Slack using Socket Mode (no public URL needed).

## Setup

1. Create an app at api.slack.com/apps
2. Enable Socket Mode under Settings
3. Subscribe to events: `message.channels`, `message.groups`, `message.im`
4. Add OAuth scopes: `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`
5. Install the app to your workspace

## Configuration

- `SLACK_BOT_TOKEN`: Bot User OAuth Token (`xoxb-...`)
- `SLACK_APP_TOKEN`: App-Level Token (`xapp-...`)

## JID Format

`slack:{channelId}` — get channel ID from the channel URL or right-click Copy Link.

## Known Limitations

- Threads are flattened to main channel (no thread-aware routing)
- No typing indicator support
- Naive message splitting at 4000 chars
