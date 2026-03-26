---
name: add-signal
description: Add Signal as a channel via signal-cli-rest-api. No extra npm dependency — connects over HTTP to a signal-cli REST API sidecar running in the same Kubernetes namespace.
---

# Add Signal Channel

This skill adds Signal support to KubeClaw using the skills engine for deterministic code changes, then guides through `signal-cli-rest-api` registration and setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.kubeclaw/state.yaml`. If `signal` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect:

AskUserQuestion: What Signal phone number do you want to use? This must be a real phone number you have access to for the one-time verification SMS. Enter in E.164 format (e.g. +14155552671).

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.kubeclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-signal
```

This deterministically:
- Adds `src/channels/signal.ts` (SignalChannel class — no npm dependency, uses native fetch)
- Adds `src/channels/signal.test.ts` (unit tests)
- Appends `import './signal.js'` to the channel barrel file `src/channels/index.ts`
- Updates `.env.example` with `SIGNAL_PHONE_NUMBER` and `SIGNAL_CLI_URL`
- Records the application in `.kubeclaw/state.yaml`

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Deploy signal-cli-rest-api

Signal uses `signal-cli-rest-api` (Docker image: `bbernhard/signal-cli-rest-api`) as a registration and messaging daemon. The channel pod communicates with it over HTTP.

### Kubernetes (Helm) deployment

Enable the signal-cli service in your Helm values:

```yaml
# values-local.yaml or helm upgrade arguments
signalCli:
  enabled: true
  phoneNumber: "+14155552671"  # your Signal number
```

Then upgrade:

```bash
helm upgrade kubeclaw helm/kubeclaw -n kubeclaw -f values-local.yaml
```

This deploys:
- `kubeclaw-signal-cli` Deployment (signal-cli-rest-api on port 8080)
- `kubeclaw-signal-cli` Service (ClusterIP)
- 5Gi PVC for signal-cli config and session data

### Non-Kubernetes (local dev) deployment

```bash
docker run -p 8080:8080 \
  -v "$PWD/signal-cli-data:/home/.local/share/signal-cli" \
  -e MODE=native \
  bbernhard/signal-cli-rest-api
```

## Phase 4: Register Signal Number

### Initiate registration

```bash
# Port-forward the signal-cli service (Kubernetes)
kubectl port-forward -n kubeclaw svc/kubeclaw-signal-cli 8080:8080

# Or use the local Docker URL
export SIGNAL_CLI_URL=http://localhost:8080
export SIGNAL_PHONE_NUMBER=+14155552671

# Request verification SMS
curl -X POST "${SIGNAL_CLI_URL}/v1/register/${SIGNAL_PHONE_NUMBER}"
```

Tell the user:

> Check your phone — you should receive a 6-digit verification SMS from Signal.
> Share the code when it arrives.

### Complete verification

When the user provides the code (e.g., `123456`):

```bash
curl -X POST "${SIGNAL_CLI_URL}/v1/register/${SIGNAL_PHONE_NUMBER}/verify/123456"
```

A 200 response means success. The number is now registered.

### Get your JID (for group registration)

To register an individual DM chat: `signal:+{their-phone-number}` (e.g., `signal:+19991112222`)

To register a Signal group, you need its group ID. After sending a message to the group:

```bash
curl "${SIGNAL_CLI_URL}/v1/receive/${SIGNAL_PHONE_NUMBER}"
```

Look for `groupInfo.groupId` in the envelope. The JID is `signal:g.{groupId}`.

## Phase 5: Configure Environment

Add to `.env`:

```bash
SIGNAL_PHONE_NUMBER=+14155552671
SIGNAL_CLI_URL=http://kubeclaw-signal-cli:8080
# Optional: polling interval in milliseconds (default: 3000)
# SIGNAL_POLL_INTERVAL_MS=3000
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The channel auto-enables when `SIGNAL_PHONE_NUMBER` is set.

### Enable the channel pod in Helm

Add to your Helm values:

```yaml
channels:
  signal:
    enabled: true
    envVars:
      - name: SIGNAL_PHONE_NUMBER
        key: phone-number
      - name: SIGNAL_CLI_URL
        key: cli-url
```

Create the channel Secret:

```bash
kubectl create secret generic kubeclaw-channel-signal -n kubeclaw \
  --from-literal=phone-number="+14155552671" \
  --from-literal=cli-url="http://kubeclaw-signal-cli:8080"
```

## Phase 6: Register Contacts

### Register a DM contact

```typescript
registerGroup("signal:+19991112222", {
  name: "Alice",
  folder: "signal_alice",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

### Register a group

```typescript
registerGroup("signal:g.{groupId}", {
  name: "Family",
  folder: "signal_family",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 7: Verify

Tell the user:

> Send a Signal message to the registered number or group.
> The bot should respond within a few seconds.

Check logs if needed:

```bash
kubectl logs -n kubeclaw deployment/kubeclaw-channel-signal --tail=50
```

## JID Format Reference

| Type | Format | Example |
|------|--------|---------|
| DM (phone) | `signal:{e164}` | `signal:+14155552671` |
| Group | `signal:g.{groupId}` | `signal:g.ABC123==` |

## Troubleshooting

### Polling returns empty or errors

```bash
curl http://localhost:8080/v1/receive/${SIGNAL_PHONE_NUMBER}
```

If this returns an error, the number may not be registered. Repeat Phase 4.

### "Unregistered number" errors when sending

The recipient's Signal account may not exist or the number format is wrong. Verify with:

```bash
curl -X GET http://localhost:8080/v1/identities/${SIGNAL_PHONE_NUMBER}
```

### Multiple devices / linked devices

signal-cli acts as a primary device. If the number is already registered on a phone, you can link it as a secondary device instead:

```bash
curl http://localhost:8080/v1/qrcodelink?device_name=kubeclaw
```

Open the returned QR code link in a browser and scan with Signal.

### signal-cli-rest-api version

Tested with `bbernhard/signal-cli-rest-api:latest`. For production, pin to a specific version tag.

## Removal

1. Delete `src/channels/signal.ts` and `src/channels/signal.test.ts`
2. Remove `import './signal.js'` from `src/channels/index.ts`
3. Remove `SIGNAL_PHONE_NUMBER` and `SIGNAL_CLI_URL` from `.env`
4. Remove Signal registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'signal:%'"`
5. Disable `signalCli.enabled` and `channels.signal.enabled` in Helm values
6. Rebuild: `npm run build`
