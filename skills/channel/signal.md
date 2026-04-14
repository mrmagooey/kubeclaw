---
name: signal
description: Signal channel via signal-cli REST API (no npm dependency)
dependencies: []
env:
  - SIGNAL_PHONE_NUMBER
  - SIGNAL_CLI_URL
---

# Signal Channel

Connects to Signal via HTTP to a signal-cli-rest-api sidecar. No npm dependency — uses native fetch.

## Setup

1. Deploy `bbernhard/signal-cli-rest-api` as a sidecar or separate pod
2. Register your phone number:
   - `POST /v1/register/{number}` to request SMS verification
   - `POST /v1/register/{number}/verify/{code}` with the received code
3. Send a message to a Signal group to discover the group ID

## Configuration

- `SIGNAL_PHONE_NUMBER`: your number in E.164 format (e.g. `+14155552671`)
- `SIGNAL_CLI_URL`: URL of the signal-cli REST API (e.g. `http://kubeclaw-signal-cli:8080`)
- `SIGNAL_POLL_INTERVAL_MS`: polling interval (default: 2000)

## JID Format

- `signal:+{phone}` for direct messages
- `signal:g.{groupId}` for groups

## Kubernetes

Requires `signalCli.enabled: true` in Helm values to deploy the signal-cli StatefulSet.
