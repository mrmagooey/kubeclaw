---
name: bootstrap-irc
description: Bootstrap an IRC channel — connects to an IRC server using the irc-upd npm package, joins the configured channels, and relays messages into KubeClaw.
bootstrap:
  channelType: irc
  manifestVersion: "1"
  expectedQuestions:
    - "Provide the IRC connection details on one line — server hostname, port (default 6697), bot nickname, and comma-separated channels to join."
---

# Bootstrap: irc channel

You are setting up an IRC channel for KubeClaw. This channel uses the
`irc-upd` npm package to connect to an IRC server and relay messages.

**IMPORTANT — how to read this skill:** Each step below is a TOOL CALL you must
actually execute, in order. The fenced blocks are the arguments to pass to a
tool — they are instructions, NOT examples of code that has already run. Execute
one tool call, check its result, then proceed to the next step. Do not skip
steps and do not guess values the admin is supposed to provide.

The package files are staged and dependencies installed automatically before this skill runs — you only gather credentials and commit.

The orchestrator delivers `/runtime/channel-entry.js` deterministically at commit time — this skill only asks for the IRC settings and commits.

## Step 1: Ask the admin for the IRC connection details

Gather ALL the IRC connection settings with a SINGLE `ask_admin` call (do not
ask four separate questions — one combined question keeps the dialogue short and
reliable).

**Call the `ask_admin` tool now** with:

```
question: "Provide the IRC connection details on one line — server hostname, port (default 6697), bot nickname, and comma-separated channels to join. Example: server=irc.example.net port=6697 nick=mybot channels=#ops,#general"
```

The value the `ask_admin` tool returns IS the admin's answer. Parse these four
fields from it (the admin may use `key=value` form as in the example, or plain
prose — extract sensibly):

- `IRC_SERVER` — the server hostname. Required, non-empty, no spaces.
- `IRC_PORT` — the port as a string. If not provided, default to `6697`. Must be
  an integer between 1 and 65535 inclusive.
- `IRC_NICK` — the bot nickname. Required, non-empty, no spaces or commas.
- `IRC_CHANNELS` — the comma-separated channels. Required; each comma-separated
  token should start with `#`.

If any required field is missing or invalid, **call `ask_admin` again** with a
corrective message naming the missing/invalid field and restating the expected
format. Do not proceed until you have all four valid values.

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

- `channel_type`: `irc`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: `{ "IRC_SERVER": "<server hostname>", "IRC_PORT": "<port as string>", "IRC_NICK": "<bot nickname>", "IRC_CHANNELS": "<comma-separated channels>" }`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin: **"Channel
irc/<instance> is ready."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
