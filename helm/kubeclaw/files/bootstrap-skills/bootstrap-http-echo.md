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

## Step 1: Stage the manifest files on /runtime

The orchestrator independently rehashes `/runtime/package.json` and
`/runtime/package-lock.json` at commit time (Story 176 TOCTOU defense). The
manifest contents must match the registered manifest hash exactly.

The live ConfigMap `kubeclaw-channel-manifests` is mounted at
`/workspace/manifests/` as one file per channel type
(`/workspace/manifests/http-echo.json`), each file holding a single JSON
object with `packageJson`, `packageLockJson`, and `manifestHash` fields.

**Call the `local_bash` tool now** with this `command` to extract the two
embedded strings onto `/runtime/`:

```
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('/workspace/manifests/http-echo.json','utf8'));fs.writeFileSync('/runtime/package.json',m.packageJson);fs.writeFileSync('/runtime/package-lock.json',m.packageLockJson);"
```

This http-echo manifest declares **zero** dependencies, so no `npm ci` step is
required. **Call the `local_bash` tool again** with `command: ls -la /runtime/`
to confirm both files landed. You should see `package.json` and
`package-lock.json`. If either is missing, stop and report the error to the
admin.

## Step 2: Ask the admin for the port

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

## Step 3: Write the channel entrypoint

**Call the `local_write` tool now** to write the channel-entry.js file (do NOT
use a shell heredoc). The file must read its port from the `PORT` environment
variable — that variable will be populated from the K8s Secret you assemble in
step 4.

Pass `file_path: /runtime/channel-entry.js` and `content` set to exactly this:

```
import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const INSTANCE = process.env.KUBECLAW_CHANNEL || 'http-echo';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', channel: INSTANCE }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    channel: INSTANCE,
    method: req.method,
    url: req.url,
    headers: req.headers,
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.error('[http-echo] listening on port ' + PORT);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

Then **call the `local_read` tool** with `file_path: /runtime/channel-entry.js`
and `limit: 5` to confirm the file was written. You should see the first five
lines of the entry file.

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

- `channel_type`: `http-echo`
- `instance_name`: the instance name from the bootstrap context above
- `secret_data`: `{ "PORT": "<the validated port number as a string>" }`
- `runtime_pvc_lock_hash`: the hash printed by the previous step

If the orchestrator replies success, tell the admin: **"Channel
http-echo/<instance> is ready. Curl http://<instance>:<port>/ to verify."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
