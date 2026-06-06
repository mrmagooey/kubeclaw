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
are required. The bootstrap-http-echo skill is the canonical end-to-end test
fixture for the bootstrap subsystem (Stories 174-184); follow these steps
exactly.

## Step 1: Stage the manifest files on /runtime

The orchestrator independently rehashes `/runtime/package.json` and
`/runtime/package-lock.json` at commit time (Story 176 TOCTOU defense). The
manifest contents must match the registered manifest hash, so copy the files
from `/workspace/manifests/http-echo/` rather than constructing them yourself.

```
local_bash("cp /workspace/manifests/http-echo/package.json /workspace/manifests/http-echo/package-lock.json /runtime/")
```

This http-echo manifest declares **zero** dependencies, so no `npm ci` step is
required. Confirm both files copied:

```
local_bash("ls -la /runtime/")
```

You should see `package.json` and `package-lock.json`. If either is missing,
stop and report the error to the admin.

## Step 2: Ask the admin for the port

Ask the admin: **"Which TCP port should the channel listen on? (1024-65535)"**

Wait for the admin to reply with a number.

Validate the response:
- Must parse as an integer
- Must be between 1024 and 65535 inclusive

If invalid, ask again with a clear error message. Do not proceed until you have
a valid port.

## Step 3: Write the channel entrypoint

Use `local_write` (NOT shell heredoc) to write the channel-entry.js file. The
file must read its port from the `PORT` environment variable — that variable
will be populated from the K8s Secret you assemble in step 4.

```
local_write({
  file_path: "/runtime/channel-entry.js",
  content: `import http from 'node:http';

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
`
})
```

Confirm the file was written:

```
local_read({ file_path: "/runtime/channel-entry.js", limit: 5 })
```

You should see the first five lines of the entry file.

## Step 4: Commit the configuration

Compute the runtime PVC lock hash. The hash algorithm is:

```
sha256(canonical(package.json) + "\n" + canonical(package-lock.json))
```

where `canonical(x)` is `JSON.stringify` with keys sorted recursively. Compute
it inline:

```
local_bash(`node -e "
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
"`)
```

The output is the `runtime_pvc_lock_hash`. (This is advisory — the orchestrator
independently recomputes it.)

Now hand off to the orchestrator:

```
commit_channel_config({
  channel_type: "http-echo",
  instance_name: "<the instance name from the bootstrap context above>",
  secret_data: {
    "PORT": "<the validated port number as a string>"
  },
  runtime_pvc_lock_hash: "<the hash from above>"
})
```

If the orchestrator replies success, tell the admin: **"Channel http-echo/<instance> is ready. Curl http://<instance>:<port>/ to verify."**

If the orchestrator rejects (e.g. MANIFEST_DIVERGENCE), surface the structured
error to the admin verbatim. Do not retry without admin direction.
