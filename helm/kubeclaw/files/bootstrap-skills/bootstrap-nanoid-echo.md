---
name: bootstrap-nanoid-echo
description: Bootstrap a nanoid-echo channel — uses the nanoid npm package to generate unique IDs. Demonstrates the bootstrap subsystem with a third-party npm dependency and serves as the channel-src-push e2e test fixture.
bootstrap:
  channelType: nanoid-echo
  manifestVersion: "1"
  expectedQuestions:
    - "Which TCP port should the channel listen on? (1024-65535)"
---

# Bootstrap: nanoid-echo channel

You are setting up a nanoid-echo channel for KubeClaw. This channel uses the
`nanoid` npm package to generate unique IDs for every HTTP request. It
demonstrates the bootstrap subsystem with a third-party npm dependency.

**IMPORTANT — how to read this skill:** Each step below is a TOOL CALL you must
actually execute, in order. The fenced blocks are the arguments to pass to a
tool — they are instructions, NOT examples of code that has already run. Execute
one tool call, check its result, then proceed to the next step. Do not skip
steps and do not guess values the admin is supposed to provide.

The orchestrator delivers `/runtime/channel-entry.js` deterministically at commit time — this skill only stages the npm package files, installs dependencies, asks for the port, and commits.

## Step 1: Stage the manifest files on /runtime

The orchestrator independently rehashes `/runtime/package.json` and
`/runtime/package-lock.json` at commit time (Story 176 TOCTOU defense). The
manifest contents must match the registered manifest hash exactly.

The live ConfigMap `kubeclaw-channel-manifests` is mounted at
`/workspace/manifests/` as one file per channel type
(`/workspace/manifests/nanoid-echo.json`), each file holding a single JSON
object with `packageJson`, `packageLockJson`, and `manifestHash` fields.

**Call the `local_bash` tool now** with this `command` to extract the two
embedded strings onto `/runtime/`:

```
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('/workspace/manifests/nanoid-echo.json','utf8'));fs.writeFileSync('/runtime/package.json',m.packageJson);fs.writeFileSync('/runtime/package-lock.json',m.packageLockJson);"
```

**Call the `local_bash` tool again** with `command: ls -la /runtime/` to
confirm both files landed. You should see `package.json` and
`package-lock.json`. If either is missing, stop and report the error to the
admin.

## Step 2: Install npm dependencies

This channel requires the `nanoid` package. **Call the `local_bash` tool now**
with this `command`:

```
npm ci --prefix /runtime --omit=dev --ignore-scripts 2>&1
```

This installs nanoid from the lockfile and may take 10-30 seconds. After it
completes, **call the `local_bash` tool again** with `command: ls /runtime/node_modules/nanoid/index.js`
to confirm the package installed. If the file is missing, stop and report the
error to the admin.

## Step 3: Ask the admin for the port

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

## Step 4: Commit the configuration

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

- `channel_type`: `nanoid-echo`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: `{ "PORT": "<the validated port number as a string>" }`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin: **"Channel
nanoid-echo/<instance> is ready."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
