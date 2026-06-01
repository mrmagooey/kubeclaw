# Story 97: IRC channel connects, joins configured channels, and disconnects cleanly

## Goal

Verify that `IRCChannel` connects to an IRC server, reaches `Registered` state, auto-joins configured channels, and disconnects cleanly via `QUIT` — all exercised against a real in-process mock IRC server.

## Architecture

`IRCChannel.start()` (alias `connect()`) in `src/channels/irc.ts` uses the `irc` npm client to open a TCP connection, send `NICK`/`USER`, and wait for the server `001` welcome message before resolving — signalling `Registered` state. Once connected, the client automatically sends a `JOIN` for every channel listed in the `channels` config array; the mock server records these joins and exposes them via `getChannels()`. `IRCChannel.stop()` (alias `disconnect()`) sends `QUIT` and tears down the socket; the mock server tracks connected clients so the test can assert the nick is no longer present after stop.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e`)
- **Mock IRC server:** in-process `startIRCServer`/`stopIRCServer` from `e2e/lib/irc-server.ts` — no real IRC network required
- **Channel under test:** `IRCChannel` from `src/channels/irc.ts`
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/irc-channel.test.ts` | Connection Lifecycle describe block (3 it() tests) |
| `e2e/lib/irc-server.ts` | In-process mock IRC server (NICK/USER/JOIN/QUIT handling) |
| `src/channels/irc.ts` | `IRCChannel` implementation (`connect`, `disconnect`, `isConnected`) |

## Tasks (retrospective)

### AC 1 — `IRCChannel.start()` connects and reaches Registered state

`IRCChannel.connect()` resolves only after the mock server sends the `001` welcome, confirming the `Registered` state. The test asserts `channel.isConnected() === true` and that `ircServer.getConnectedClients()` contains the configured nick.

### AC 2 — Auto-join of configured channels after connection

After `connect()` resolves, the `irc` client sends `JOIN #kubeclaw-test` automatically. The test polls `ircServer.getChannels()` (via `waitFor`) until the channel appears, then asserts it is present (case-insensitive).

### AC 3 — `IRCChannel.stop()` disconnects cleanly

`channel.disconnect()` sends `QUIT`, the socket closes, and the mock server removes the client. The test asserts `channel.isConnected() === false` after a 200 ms drain window.

### AC 4 — Verified against real mock IRC server

All three assertions are made against `ircServer` state (connected clients list, channels list) rather than stubs — confirming `IRCChannel` produces correct on-wire protocol behaviour.

### AC 5 — Suite isolation via beforeEach/afterEach

The outer describe (`IRC Channel End-to-End`) has a `beforeEach` that calls `ircServer.clearMessages()` and resets received-message arrays, and an `afterEach` that calls `channel?.disconnect()`, ensuring the Connection Lifecycle tests cannot bleed state into each other or into adjacent suites.

### Verification

Run: `npm run test:e2e -- irc-channel -t "Connection Lifecycle"`

Expected: **3 / 3 tests pass** (connect → join → disconnect).

Runtime: under 10 seconds (no cluster, no network I/O beyond loopback).
