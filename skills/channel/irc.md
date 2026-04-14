---
name: irc
description: IRC channel via irc-upd library
dependencies:
  - irc-upd
env:
  - IRC_SERVER
  - IRC_PORT
  - IRC_NICK
  - IRC_CHANNELS
---

# IRC Channel

Connects to an IRC server and joins configured channels.

## Configuration

- `IRC_SERVER`: IRC server hostname
- `IRC_PORT`: port (default: 6667, use 6697 for SSL)
- `IRC_NICK`: bot nickname
- `IRC_CHANNELS`: comma-separated channels to join (e.g. `#general,#dev`)

## JID Format

`irc:#channel@server` — one group per IRC channel.

## Source

Channel implementation is built-in at `src/channels/irc.ts`.

## Notes

- Supports SSL/TLS on port 6697
- Auto-reconnect on disconnect
- Messages over 480 chars are split automatically
