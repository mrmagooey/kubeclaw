---
name: gmail
description: Gmail channel via Google APIs (OAuth)
dependencies:
  - googleapis
env:
  - GMAIL_CREDENTIALS_PATH
---

# Gmail Channel

Two modes: tool-only (agent can read/send email) or full channel (emails trigger the agent).

## Setup

1. Create a GCP project and enable the Gmail API
2. Create Desktop OAuth credentials, download the JSON
3. Run `npx -y @gongrzhe/server-gmail-autoauth-mcp auth` to authorize
4. Mount `~/.gmail-mcp` to the container at `/home/node/.gmail-mcp`

## Modes

### Tool-only

Agent gets Gmail tools (read, send, search, draft) as MCP tools. No channel code — emails don't trigger the agent.

### Channel mode

Polls the Primary inbox for new messages. Emails trigger the agent, which can reply by email. Excludes Promotions/Social/Updates/Forums tabs.

## Configuration

- `GMAIL_CREDENTIALS_PATH`: path to the OAuth credentials (default: `/home/node/.gmail-mcp`)

## JID Format

`gmail:{emailAddress}` — one group per email address.
