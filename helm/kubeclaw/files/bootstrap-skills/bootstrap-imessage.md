---
name: bootstrap-imessage
description: Bootstrap an iMessage channel — relays iMessages into KubeClaw via an external BlueBubbles REST server that the operator runs on a Mac. The adapter polls BlueBubbles for new messages using a REST API (no webhook server, no httpPort). NO npm dependencies.
bootstrap:
  channelType: imessage
  manifestVersion: '1'
  expectedQuestions:
    - 'What is the URL of your BlueBubbles server (e.g. http://192.168.1.50:1234 or https://imessage.example.com)?'
    - 'What is your BlueBubbles server password?'
---

# Bootstrap: iMessage channel

You are setting up an iMessage channel for KubeClaw. iMessage is Apple-platform-only — there is no Linux/container iMessage client. KubeClaw bridges iMessage by connecting to an external **BlueBubbles** server that the operator runs on a Mac.

---

> **⚠️ HARD EXTERNAL PREREQUISITE — read this before proceeding:**
>
> This channel adapter is a REST client of a **BlueBubbles** server
> (https://bluebubbles.app) that YOU must run on a Mac that has iMessage
> configured. Without a running BlueBubbles server, this channel cannot
> function.
>
> **What you need before running this skill:**
>
> 1. **A Mac with iMessage signed in.** The Mac must be on a network
>    accessible to the KubeClaw cluster (or exposed via a tunnel/public
>    URL).
> 2. **BlueBubbles installed and running on the Mac.** Download from
>    https://bluebubbles.app. During setup, BlueBubbles will ask you to
>    set a **server password** — save it. It will also display its
>    **server URL** (usually `http://<mac-ip>:<port>`).
> 3. **BlueBubbles reachable from KubeClaw.** The URL must be accessible
>    from inside the cluster. If your Mac is on a home network, you may
>    need to:
>    - Use a local IP address with a port-forward/ingress from the cluster
>    - Or use a tunnel service (ngrok, Cloudflare Tunnel, etc.)
>    - Or run KubeClaw and the Mac on the same private network
> 4. **Verify connectivity** before proceeding by running:
>    ```
>    curl "<your-bluebubbles-url>/api/v1/ping?password=<your-password>"
>    ```
>    You should receive `{"status":200,"message":"pong"}`. If not, fix
>    the URL/network first — this skill cannot proceed without a reachable
>    BlueBubbles server.
>
> **This is NOT CI-able.** There is no cloud or containerized iMessage
> solution. The BlueBubbles Mac must stay running for the channel to work.

---

The adapter has **no npm dependencies** — native `fetch` only. `npm ci` is a no-op. The adapter polls BlueBubbles at a configurable interval (default 3 s) and tracks a `lastSeen` cursor to avoid re-delivering messages.

**IMPORTANT — how to read this skill:** Each step below is a TOOL CALL you must actually execute, in order. The fenced blocks are the arguments to pass to a tool — they are instructions, NOT examples of code that has already run. Execute one tool call, check its result, then proceed to the next step. Do not skip steps and do not guess values the admin is supposed to provide.

## Step 1: Ask the admin for the BlueBubbles server URL and password

Gather both credentials with a SINGLE `ask_admin` call.

**Call the `ask_admin` tool now** with:

```
question: "Please provide the following to connect KubeClaw to iMessage via BlueBubbles:\n\n1. BlueBubbles server URL — the URL shown in your BlueBubbles app (e.g. http://192.168.1.50:1234 or https://imessage.example.com). This must be reachable from inside the Kubernetes cluster.\n\n2. BlueBubbles server password — the password you set when you installed BlueBubbles on your Mac.\n\nIf you haven't installed BlueBubbles yet, visit https://bluebubbles.app and follow the setup guide. Verify connectivity first by running:\n  curl \"<url>/api/v1/ping?password=<password>\"\nYou should see {\"status\":200,\"message\":\"pong\"}."
```

Parse the admin's reply to extract:

- `IMESSAGE_BRIDGE_URL` — the full BlueBubbles server URL (e.g. `http://192.168.1.50:1234`).
  Remove any trailing slash. Must start with `http://` or `https://`.
- `IMESSAGE_BRIDGE_PASSWORD` — the BlueBubbles password. Required.

If either value is missing or the URL does not start with `http://` or `https://`, **call `ask_admin` again** with a corrective message. Do not proceed without both values.

## Step 2: Validate the BlueBubbles server is reachable

Before committing, verify the server responds to a ping.

**Call the `local_bash` tool now** with this `command` (substituting the actual URL and password):

```
curl -fsS "<IMESSAGE_BRIDGE_URL>/api/v1/ping?password=<IMESSAGE_BRIDGE_PASSWORD>"
```

- If the response contains `"status":200` or `"message":"pong"` → proceed.
- If the curl fails (connection refused, timeout, 4xx/5xx) → **call `ask_admin`** to report the error and ask the admin to fix the BlueBubbles URL/network before retrying.

## Step 3: Commit the configuration

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

The printed value is the `runtime_pvc_lock_hash`. (This is advisory — the orchestrator independently recomputes it.)

Now **call the `commit_channel_config` tool** with these arguments:

- `channel_type`: `imessage`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: `{ "IMESSAGE_BRIDGE_URL": "<validated URL>", "IMESSAGE_BRIDGE_PASSWORD": "<password>" }`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin:

> \*\*"Channel imessage/<instance> is ready. The channel pod will start polling
> your BlueBubbles server at <IMESSAGE_BRIDGE_URL> every 3 seconds. Register
> iMessage chats in the admin shell using JIDs of the form:
>
> - `imessage:+61412345678` (1:1 with a phone number)
> - `imessage:alice@example.com` (1:1 with an email handle)
> - `imessage:group.<chatGuid>` (group chat, where chatGuid comes from the BlueBubbles API)
>
> The Mac running BlueBubbles must remain on and connected for the channel to
> function. If BlueBubbles stops or the Mac sleeps, messages will be missed
> until it resumes."\*\*

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured error to the admin verbatim. Do not retry without admin direction.
