---
name: bootstrap-http-echo
description: Bootstrap a minimal HTTP echo channel — Node stdlib only, no npm dependencies. Demonstrates the bootstrap subsystem end-to-end and serves as the bootstrap-subsystem e2e test fixture.
bootstrap:
  channelType: http-echo
  manifestVersion: "1"
  expectedQuestions:
    - "Which TCP port should the channel listen on? (1024-65535)"
---

# Bootstrap: HTTP-echo channel

You are setting up an HTTP-echo channel for KubeClaw. This is a minimal channel
implementation that uses ONLY the Node.js standard library — no npm dependencies
are required.

**IMPORTANT — how to read this skill:** Each step below is a TOOL CALL you must
actually execute, in order. The fenced blocks are the arguments to pass to a
tool — they are instructions, NOT examples of code that has already run. Execute
one tool call, check its result, then proceed to the next step. Do not skip
steps and do not guess values the admin is supposed to provide.

The package files are staged and dependencies installed automatically before this skill runs — you only gather credentials and commit.

The orchestrator delivers `/runtime/channel-entry.js` deterministically at commit time — this skill only asks for the port and commits.

## Step 1: Ask the admin for the port

**Call the `ask_admin` tool now** with:

```
question: "Which TCP port should the channel listen on? (1024-65535)"
```

The value the `ask_admin` tool returns IS the admin's answer. Validate it:

- Must parse as an integer
- Must be between 1024 and 65535 inclusive

If the answer is invalid, **call `ask_admin` again** with a corrective message
explaining the valid range. Do not proceed, and do not guess a port, until
`ask_admin` returns a valid value.

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

- `channel_type`: `http-echo`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: `{ "PORT": "<the validated port number as a string>" }`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin: **"Channel
http-echo/<instance> is ready. Curl http://<instance>:<port>/ to verify."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
