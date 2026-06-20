---
name: bootstrap-signal
description: Bootstrap a Signal channel — requires a pure-JS Signal client npm package and a registered Signal phone number. Template only; Signal cannot run in CI. Operator must register a 'signal' channel manifest in Helm values before using this skill.
bootstrap:
  channelType: signal
  manifestVersion: "1"
  expectedQuestions:
    - "What is the Signal phone number for this channel? (e.g. +61412345678)"
---

# Bootstrap: Signal channel

You are setting up a Signal channel for KubeClaw. This channel requires:

1. A **channel manifest** registered in Helm values for channel type `signal`
   (operator must do this before running this skill — see below).
2. A **registered Signal phone number** that the chosen pure-JS Signal client
   can use to send and receive messages.

> **IMPORTANT — native bindings:** Most Signal SDKs require native compilation
> (libsignal, Java-based signal-cli). These do NOT work with
> `npm ci --ignore-scripts` inside the bootstrap pod. Choose a pure-JS client
> or a REST bridge (run signal-cli as a sidecar and call its JSON-RPC HTTP API
> from channel-entry.js using Node's built-in `fetch`). Update the `import`
> line in `helm/kubeclaw/files/channel-src/signal/channel-entry.js` accordingly
> before registering the manifest.

> **IMPORTANT — operator prerequisites:** The `signal` channel manifest must be
> present in `kubeclaw-channel-manifests` before this skill runs. Add it to
> your Helm values (see "Declare deps in a channel manifest" in
> `docs/DEVELOPING_A_CHANNEL.md`) and run `helm upgrade`. Without the manifest,
> step 1 below will fail with a missing file error.

**IMPORTANT — how to read this skill:** Each step below is a TOOL CALL you must
actually execute, in order. The fenced blocks are the arguments to pass to a
tool — they are instructions, NOT examples of code that has already run. Execute
one tool call, check its result, then proceed to the next step. Do not skip
steps and do not guess values the admin is supposed to provide.

The orchestrator delivers `/runtime/channel-entry.js` deterministically at commit time — this skill only stages the npm package files, installs dependencies, asks for the phone number, and commits.

## Step 1: Stage the manifest files on /runtime

The orchestrator independently rehashes `/runtime/package.json` and
`/runtime/package-lock.json` at commit time (TOCTOU defense). The manifest
contents must match the registered manifest hash exactly.

The live ConfigMap `kubeclaw-channel-manifests` is mounted at
`/workspace/manifests/` as one file per channel type
(`/workspace/manifests/signal.json`), each file holding a single JSON object
with `packageJson`, `packageLockJson`, and `manifestHash` fields.

**Call the `local_bash` tool now** with this `command` to extract the two
embedded strings onto `/runtime/`:

```
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('/workspace/manifests/signal.json','utf8'));fs.writeFileSync('/runtime/package.json',m.packageJson);fs.writeFileSync('/runtime/package-lock.json',m.packageLockJson);"
```

**Call the `local_bash` tool again** with `command: ls -la /runtime/` to
confirm both files landed. You should see `package.json` and
`package-lock.json`. If either is missing, stop and report the error to the
admin.

## Step 2: Install npm dependencies

This channel requires a pure-JS Signal client package (defined in the manifest).
**Call the `local_bash` tool now** with this `command`:

```
npm ci --prefix /runtime --omit=dev --ignore-scripts 2>&1
```

This installs the Signal client from the lockfile and may take 10-60 seconds
(pure-JS clients can be large). After it completes, **call the `local_bash`
tool again** to confirm `ls /runtime/node_modules/` lists at least one entry.
If `npm ci` fails with a native binding error, the wrong Signal library is in
the manifest — stop and report to the admin.

## Step 3: Ask the admin for the phone number

**Call the `ask_admin` tool now** with:

```
question: "What is the Signal phone number for this channel? (e.g. +61412345678)"
```

The value the `ask_admin` tool returns IS the admin's answer. Validate it:

- Must be a non-empty string
- Must start with `+` followed by digits only
- Must be between 8 and 16 characters total

If the answer is invalid, **call `ask_admin` again** with a corrective message.
Do not proceed until `ask_admin` returns a valid value.

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

- `channel_type`: `signal`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: `{ "SIGNAL_PHONE_NUMBER": "<the validated phone number>" }`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin: **"Channel
signal/<instance> is ready. It will start receiving messages sent to
<phone number>."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
