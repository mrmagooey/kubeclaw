---
name: http
description: HTTP chat channel with Basic Auth and SSE
dependencies: []
env:
  - HTTP_CHANNEL_USERS
  - HTTP_CHANNEL_PORT
---

# HTTP Channel

Browser-based chat interface using Node.js built-in `node:http`. No npm dependencies.

## Endpoints

- `GET /` — browser chat UI (HTML/JS)
- `GET /stream` — Server-Sent Events for real-time agent responses
- `POST /message` — receive messages from the browser

All endpoints require HTTP Basic Authentication.

## Configuration

- `HTTP_CHANNEL_USERS`: comma-separated `user:password` pairs (e.g. `alice:secret,bob:pass`)
- `HTTP_CHANNEL_PORT`: listen port (default: 4080)

## JID Format

`http:{username}` — each user gets an isolated group.

## Source

Channel implementation is built-in at `src/channels/http.ts`.

## Security

- Always use HTTPS in production — Basic Auth sends credentials in clear over HTTP.
- The SSE stream authenticates on open and stays open; no per-message auth after that.
