---
name: signal
description: Signal channel via signal-cli REST API (no npm dependency)
dependencies: []
env:
  - SIGNAL_PHONE_NUMBER
---

# Signal Channel

Connects to Signal via HTTP to a per-channel `signal-cli-rest-api` sidecar
container. No npm dependency — uses native fetch.

## Setup

The `bbernhard/signal-cli-rest-api` backend is automatically deployed as a
sidecar container alongside the channel pod (declared in the signal channel
manifest). The sidecar listens at `http://localhost:8080` inside the pod.

After the channel pod is Running, link or register the bot account:

1. Port-forward into the channel pod:
   ```
   kubectl port-forward pod/<channel-pod-name> 8080:8080 -n kubeclaw
   ```
2. Link as a secondary device (recommended): open
   `GET http://localhost:8080/v1/qrcodelink?device_name=kubeclaw` in a
   browser, then scan the QR code from Signal → Settings → Linked devices → +
3. Or register a dedicated number: `POST /v1/register/{number}` then
   `POST /v1/register/{number}/verify/{code}` with the received code.

The session persists on the `kubeclaw-channel-<instance>-auxsession` PVC.

## Configuration

- `SIGNAL_PHONE_NUMBER`: your number in E.164 format (e.g. `+14155552671`)
- `SIGNAL_API_URL`: injected automatically as `http://localhost:8080` by the manifest's `apiUrlEnv` — do not set manually
- `SIGNAL_POLL_MS`: polling interval (default: 2000)

## JID Format

- `signal:+{phone}` for direct messages
- `signal:group.{groupId}` for groups
