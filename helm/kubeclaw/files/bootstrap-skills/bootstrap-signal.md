---
name: bootstrap-signal
description: Bootstrap a Signal channel — relays Signal messages into KubeClaw via a per-channel signal-cli-rest-api sidecar container. The adapter has no npm dependencies. The sidecar is created automatically with the channel pod; you only need to provide the bot phone number and then link/register the account via a port-forward into the running channel pod.
bootstrap:
  channelType: signal
  manifestVersion: "1"
  expectedQuestions:
    - "What is the bot's phone number in E.164 form (e.g. +61412345678)?"
---

# Bootstrap: Signal channel

You are setting up a Signal channel for KubeClaw. This channel relays messages
to/from Signal via the **signal-cli-rest-api** backend
(`bbernhard/signal-cli-rest-api`). The backend runs as a **per-channel sidecar
container**, automatically injected alongside the channel pod by the manifest's
`sidecar` field. The channel adapter talks to it over `http://localhost:8080`
using Node's built-in `fetch`, so it has **no npm dependencies** (no native
libsignal compile, nothing that fights `npm ci`).

> **OPERATOR PREREQUISITES — do these AFTER the channel pod is running:**
>
> The `SIGNAL_API_URL` is always `http://localhost:8080` (injected by the
> manifest) — **you do NOT need to set it**. The signal-cli sidecar is
> started automatically with the channel pod and holds the linked account
> session on the per-channel `kubeclaw-channel-<instance>-auxsession` PVC.
>
> **Link or register the bot account.** signal-cli must hold a real Signal
> session. This CANNOT be automated in CI — it needs a real phone/account.
> Do this AFTER the channel pod is running:
>
> 1. Port-forward into the channel pod:
>    ```
>    kubectl port-forward pod/<channel-pod-name> 8080:8080 -n kubeclaw
>    ```
>    (Find the pod name with `kubectl get pods -n kubeclaw -l app=kubeclaw-channel-<instance>`)
>
> 2. Two linking paths:
>    - **Link as a secondary device (recommended).** Open
>      `GET http://localhost:8080/v1/qrcodelink?device_name=kubeclaw` in a
>      browser while the port-forward is active. On your phone go to
>      *Signal → Settings → Linked devices → +* and scan the QR code. The
>      bot now sends/receives as YOUR existing number.
>    - **Register a dedicated number.** `POST /v1/register/<number>` (solve
>      the captcha), then `POST /v1/register/<number>/verify/<code>` with
>      the SMS or voice code. The bot uses this fresh number.
>
> 3. The session persists on the `kubeclaw-channel-<instance>-auxsession` PVC
>    so the account survives pod restarts.
>
> **Register the `signal` channel manifest** in `kubeclaw-channel-manifests`
> (it ships in `bootstrap.channelManifests.signal` in the Helm values). Run
> `helm upgrade` if you added it. Without it, step 1 below fails.

**IMPORTANT — how to read this skill:** Each step below is a TOOL CALL you must
actually execute, in order. The fenced blocks are the arguments to pass to a
tool — they are instructions, NOT examples of code that has already run. Execute
one tool call, check its result, then proceed to the next step. Do not skip
steps and do not guess values the admin is supposed to provide.

The package files are staged and dependencies installed automatically before
this skill runs (the signal manifest has no dependencies, so `npm ci` is a
no-op) — you only gather the phone number and commit. The orchestrator delivers
`/runtime/channel-entry.js` deterministically at commit time.

## Step 1: Ask the admin for the Signal phone number

Gather the setting with a SINGLE `ask_admin` call.

**Call the `ask_admin` tool now** with:

```
question: "What is the bot's phone number in E.164 form (e.g. +61412345678)?"
```

The value the `ask_admin` tool returns IS the admin's answer. Parse this field:

- `SIGNAL_PHONE_NUMBER` — the bot's own number. Required. Must start with `+`
  followed by 7–15 digits (E.164). This must be the SAME number you will link
  or register after the channel pod starts.

If the phone number is missing or not valid E.164, **call `ask_admin` again**
with a corrective message. Do not proceed until you have a valid number.

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

- `channel_type`: `signal`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: `{ "SIGNAL_PHONE_NUMBER": "<the validated phone number>" }`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin:

> **"Channel signal/<instance> is ready. The signal-cli sidecar will start
> alongside the channel pod. Once the pod is Running, port-forward into it
> (`kubectl port-forward pod/<pod-name> 8080:8080 -n kubeclaw`) and link your
> Signal account via `GET http://localhost:8080/v1/qrcodelink?device_name=kubeclaw`
> (scan from Signal → Settings → Linked devices → +) or register a dedicated
> number. The session persists on the kubeclaw-channel-<instance>-auxsession PVC."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
