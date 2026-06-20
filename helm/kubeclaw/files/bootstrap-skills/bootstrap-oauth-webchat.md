---
name: bootstrap-oauth-webchat
description: Bootstrap an oauth-webchat channel — provides an OIDC-protected web chat interface, running on port 4080, using the openid-client npm package.
bootstrap:
  channelType: oauth-webchat
  manifestVersion: "1"
  expectedQuestions:
    - "Provide all OIDC settings on one line — public_url, issuer, client_id, client_secret, allowed_emails, and cookie_secret."
---

# Bootstrap: oauth-webchat channel

You are setting up an oauth-webchat channel for KubeClaw. This channel runs an
OIDC-protected web chat UI on port 4080, using the `openid-client` npm package.

**IMPORTANT — how to read this skill:** Each step below is a TOOL CALL you must
actually execute, in order. The fenced blocks are the arguments to pass to a
tool — they are instructions, NOT examples of code that has already run. Execute
one tool call, check its result, then proceed to the next step. Do not skip
steps and do not guess values the admin is supposed to provide.

The package files are staged and dependencies installed automatically before this skill runs — you only gather credentials and commit.

The orchestrator delivers `/runtime/channel-entry.js` deterministically at commit time — this skill only asks for the OIDC settings and commits.

## Step 1: Ask the admin for all OIDC settings

Gather ALL the oauth-webchat settings with a SINGLE `ask_admin` call (do not
ask six separate questions — one combined question keeps the dialogue short and
reliable).

**Call the `ask_admin` tool now** with:

```
question: "Provide all OIDC settings on one line. Example: public_url=https://chat.example.com issuer=http://kubeclaw-capability-test-oauth:8080 client_id=kubeclaw client_secret=s3cr3t allowed_emails=alice@example.com,@example.org cookie_secret=<32+ random chars>

Fields:
- public_url: externally-reachable base URL the OIDC provider redirects back to (browser-reachable; NOT in-cluster DNS)
- issuer: in-cluster OIDC provider URL (the channel pod does OIDC discovery against this)
- client_id: OIDC client ID
- client_secret: OIDC client secret
- allowed_emails: comma-separated allowed emails or @domain suffixes
- cookie_secret: session cookie secret, MUST be 32 or more characters"
```

The value the `ask_admin` tool returns IS the admin's answer. Parse these six
fields from it (the admin may use `key=value` form as in the example, or plain
prose — extract sensibly):

- `OAUTH_WEBCHAT_PUBLIC_URL` — the externally-reachable base URL. Required, non-empty, must start with `http://` or `https://`, no trailing slash.
- `OAUTH_WEBCHAT_OIDC_ISSUER` — the in-cluster OIDC provider URL. Required, non-empty, must start with `http://` or `https://`.
- `OAUTH_WEBCHAT_CLIENT_ID` — the OIDC client ID. Required, non-empty.
- `OAUTH_WEBCHAT_CLIENT_SECRET` — the OIDC client secret. Required, non-empty.
- `OAUTH_WEBCHAT_ALLOWED_EMAILS` — comma-separated allowed emails or `@domain` suffixes. Required, non-empty.
- `OAUTH_WEBCHAT_COOKIE_SECRET` — the session cookie secret. Required; **MUST be at least 32 characters long**. If shorter than 32 characters, reject it.

If any required field is missing or invalid (including a cookie_secret shorter
than 32 characters), **call `ask_admin` again** with a corrective message
naming the missing/invalid field and restating the expected format. Do not
proceed until you have all six valid values.

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

- `channel_type`: `oauth-webchat`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: `{ "OAUTH_WEBCHAT_PUBLIC_URL": "<public url>", "OAUTH_WEBCHAT_OIDC_ISSUER": "<issuer url>", "OAUTH_WEBCHAT_CLIENT_ID": "<client id>", "OAUTH_WEBCHAT_CLIENT_SECRET": "<client secret>", "OAUTH_WEBCHAT_ALLOWED_EMAILS": "<comma-separated emails/domains>", "OAUTH_WEBCHAT_COOKIE_SECRET": "<cookie secret>" }`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin: **"Channel
oauth-webchat/<instance> is ready."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
