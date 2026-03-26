---
name: add-http
description: Add an HTTP chat channel with Basic Auth and SSE. Serves a simple browser chat UI. No npm dependency — uses Node.js built-ins. Good for local development, admin access, or simple web interfaces.
---

# Add HTTP Channel

This skill adds an HTTP-based chat interface to KubeClaw. It serves:
- `GET /` — browser chat UI (HTML/JS, no framework)
- `GET /stream` — Server-Sent Events for real-time agent responses
- `POST /message` — receive messages from the browser

All endpoints require HTTP Basic Authentication. Users are configured via env vars — no OAuth, no sessions.

## Phase 1: Pre-flight

### Check if already applied

Read `.kubeclaw/state.yaml`. If `http` is in `applied_skills`, skip to Phase 3.

### Decide on users

Use `AskUserQuestion` to collect:

AskUserQuestion: What username(s) and password(s) do you want for the HTTP chat interface? Format: user1:pass1,user2:pass2. Each user gets their own isolated group.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-http
```

This deterministically:
- Adds `src/channels/http.ts` (HttpChannel class — no npm dependency, uses `node:http`)
- Adds `src/channels/http.test.ts` (unit tests)
- Appends `import './http.js'` to `src/channels/index.ts`
- Updates `.env.example` with `HTTP_CHANNEL_USERS` and `HTTP_CHANNEL_PORT`
- Records the application in `.kubeclaw/state.yaml`

### Validate

```bash
npm test
npm run build
```

## Phase 3: Configure

Add to `.env`:

```bash
# Comma-separated user:password pairs
HTTP_CHANNEL_USERS=alice:mysecretpassword,bob:anothersecret
# Port to listen on (default: 4080)
HTTP_CHANNEL_PORT=4080
```

Sync to container:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Kubernetes (Helm) — enable the channel pod

Add to Helm values:

```yaml
channels:
  http:
    enabled: true
    envVars:
      - name: HTTP_CHANNEL_USERS
        key: users
      - name: HTTP_CHANNEL_PORT
        key: port
```

Create the channel Secret:

```bash
kubectl create secret generic kubeclaw-channel-http -n kubeclaw \
  --from-literal=users="alice:mysecretpassword" \
  --from-literal=port="4080"
```

Expose the port (pick one option):

**Option A: NodePort** — access via `http://{node-ip}:30080`

```yaml
# In Helm values
channels:
  http:
    enabled: true
    service:
      type: NodePort
      nodePort: 30080
```

**Option B: kubectl port-forward** — development only

```bash
kubectl port-forward -n kubeclaw deployment/kubeclaw-channel-http 4080:4080
```

**Option C: Ingress** — production with TLS (highly recommended)

```yaml
# Add an Ingress resource pointing to kubeclaw-channel-http:4080
# and configure TLS via cert-manager or similar.
# IMPORTANT: Always use HTTPS in production — Basic auth over plain HTTP
# sends credentials in the clear.
```

## Phase 4: Register Users

Each `HTTP_CHANNEL_USERS` entry becomes a separate group. Register them:

```typescript
// For user "alice":
registerGroup("http:alice", {
  name: "Alice",
  folder: "http_alice",
  trigger: "@Andy",
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,  // responds to all messages, no trigger needed
});
```

## Phase 5: Verify

Tell the user:

> Open `http://localhost:4080` in your browser.
> Log in with your configured credentials.
> Type a message and hit Send — the agent should reply within seconds.

Check logs if needed:

```bash
kubectl logs -n kubeclaw deployment/kubeclaw-channel-http --tail=50
```

## JID Format Reference

| Format | Example |
|--------|---------|
| `http:{username}` | `http:alice` |

Each user gets a separate JID and isolated group folder.

## Security Notes

- **Basic Auth is insecure over plain HTTP** — always use HTTPS (TLS) in any externally accessible deployment.
- Passwords are stored in a Kubernetes Secret; never put them in `values.yaml` directly.
- The chat UI includes no session tokens — each request authenticates independently.
- The SSE stream authenticates on open and stays open; there's no per-message auth after that.

## Troubleshooting

### Browser shows 401 on every reload

The browser caches Basic Auth credentials per origin. If you changed the password, clear site data in browser settings or use an incognito window.

### Agent responses not appearing

Check that the SSE connection is open (browser DevTools → Network → `/stream` should be in `EventStream` state).

### Port already in use

Change `HTTP_CHANNEL_PORT` to an available port.

## Removal

1. Delete `src/channels/http.ts` and `src/channels/http.test.ts`
2. Remove `import './http.js'` from `src/channels/index.ts`
3. Remove `HTTP_CHANNEL_USERS` and `HTTP_CHANNEL_PORT` from `.env`
4. Remove HTTP registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'http:%'"`
5. Rebuild: `npm run build`
