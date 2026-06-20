---
name: bootstrap-http
description: Bootstrap an http channel — provides a Basic-auth-protected web chat interface, running on port 4080, using the cron-parser npm package.
bootstrap:
  channelType: http
  manifestVersion: "1"
  expectedQuestions:
    - "Provide all HTTP channel settings on one line — users (required), and optionally port, cors_origin, rate_limit, max_attachment_count, max_attachment_bytes."
---

# Bootstrap: http channel

You are setting up an http channel for KubeClaw. This channel runs a
Basic-auth-protected web chat UI on port 4080, using the `cron-parser` npm package.

**IMPORTANT — how to read this skill:** Each step below is a TOOL CALL you must
actually execute, in order. The fenced blocks are the arguments to pass to a
tool — they are instructions, NOT examples of code that has already run. Execute
one tool call, check its result, then proceed to the next step. Do not skip
steps and do not guess values the admin is supposed to provide.

The package files are staged and dependencies installed automatically before this skill runs — you only gather credentials and commit.

The orchestrator delivers `/runtime/channel-entry.js` deterministically at commit time — this skill only asks for the HTTP settings and commits.

## Step 1: Ask the admin for all HTTP settings

Gather ALL the http channel settings with a SINGLE `ask_admin` call (do not
ask multiple separate questions — one combined question keeps the dialogue short and
reliable).

**Call the `ask_admin` tool now** with:

```
question: "Provide all HTTP channel settings on one line. Example: users=alice:secret,bob:pass cors_origin=* port=4080

Fields:
- users: comma-separated user:password pairs (REQUIRED, e.g. alice:secret,bob:pass)
- port: HTTP listen port (optional, default 4080)
- cors_origin: Access-Control-Allow-Origin header value (optional, default *)
- rate_limit: max messages per user per minute (optional, default 60; 0 = unlimited)
- max_attachment_count: max stored attachments per user (optional, default 0 = unlimited)
- max_attachment_bytes: max cumulative attachment bytes per user (optional, default 0 = unlimited)"
```

The value the `ask_admin` tool returns IS the admin's answer. Parse these fields
from it (the admin may use `key=value` form as in the example, or plain prose —
extract sensibly):

- `HTTP_CHANNEL_USERS` — comma-separated `user:password` pairs. **Required**, non-empty.
  Format: `alice:secret,bob:pass`. If missing or empty, call `ask_admin` again.
- `HTTP_CHANNEL_PORT` — listen port number (optional, default `4080`).
- `HTTP_CHANNEL_CORS_ORIGIN` — CORS origin header (optional, default `*`).
- `HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE` — integer rate limit (optional, default `60`; `0` = unlimited).
- `HTTP_CHANNEL_MAX_ATTACHMENT_COUNT_PER_USER` — integer max attachment count (optional, default `0` = unlimited).
- `HTTP_CHANNEL_MAX_ATTACHMENT_BYTES_PER_USER` — integer max attachment bytes (optional, default `0` = unlimited).

If `HTTP_CHANNEL_USERS` is missing or empty, **call `ask_admin` again** with a
corrective message naming the missing field and restating the required format.
Do not proceed until you have at least one valid `user:password` pair.

Only include optional fields in `secret_data` if the admin explicitly provided
a value for them (do not emit defaults as secret values).

## Step 2: Commit the configuration

Compute the runtime PVC lock hash. The hash algorithm is:

```
sha256(canonical(package.json) + "\n" + canonical(package-lock.json))
```

where `canonical(x)` is `JSON.stringify` with keys sorted recursively.

**Call the `local_bash` tool now** with this `command` to compute it:

```
node -e "
const fs = require('fs');
const crypto = require('crypto');
function canon(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
  const keys = Object.keys(o).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}
const pj = JSON.parse(fs.readFileSync('/runtime/package.json','utf8'));
const pl = JSON.parse(fs.readFileSync('/runtime/package-lock.json','utf8'));
const h = crypto.createHash('sha256').update(canon(pj) + '\n' + canon(pl)).digest('hex');
console.log(h);
"
```

The printed value is the `runtime_pvc_lock_hash`. (This is advisory — the
orchestrator independently recomputes it.)

Now **call the `commit_channel_config` tool** to hand off to the orchestrator,
with these arguments:

- `channel_type`: `http`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: an object containing at minimum `{ "HTTP_CHANNEL_USERS": "<user:pass,...>" }`,
  plus any optional fields the admin provided:
  `HTTP_CHANNEL_PORT`, `HTTP_CHANNEL_CORS_ORIGIN`,
  `HTTP_CHANNEL_RATE_LIMIT_PER_USER_MESSAGES_PER_MINUTE`,
  `HTTP_CHANNEL_MAX_ATTACHMENT_COUNT_PER_USER`,
  `HTTP_CHANNEL_MAX_ATTACHMENT_BYTES_PER_USER`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin: **"Channel
http/<instance> is ready. Users can access the chat UI at
http://<host>:4080/ using their configured credentials."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
