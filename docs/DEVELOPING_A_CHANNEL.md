# Developing a Channel

This guide is for **developers** who want to write a new KubeClaw channel type — the code that connects to a chat platform, delivers inbound messages to the harness, and sends outbound replies.

For **operators** installing an existing channel type into a running cluster, see [INSTALLING_A_CHANNEL.md](INSTALLING_A_CHANNEL.md).
For the full `Channel` interface reference (capabilities, JID conventions, attachment markers), see [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md).

---

## The Channel / ChannelFactory contract

Every channel must implement the `Channel` interface (`src/types.ts`):

```typescript
export interface Channel {
  name: string;                                           // unique type name, e.g. 'signal'
  connect(): Promise<void>;                               // establish platform connection
  sendMessage(jid: string, text: string): Promise<void>; // send outbound text
  isConnected(): boolean;
  ownsJid(jid: string): boolean;                         // true when this channel handles the JID
  disconnect(): Promise<void>;
  readonly capabilities?: ChannelCapabilities;           // optional feature flags
}
```

Channels self-register using a `ChannelFactory` from `src/channels/registry.ts`:

```typescript
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;
// opts.onMessage        — deliver an inbound message to storage
// opts.onChatMetadata   — register a chat / update its name
// opts.registeredGroups — read current group config
```

The factory returns `null` when credentials are missing; the harness silently disables the channel in that case. See [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md) for the full `ChannelCapabilities` reference and the JID prefix convention.

---

## Three delivery paths

| Path | When to use | How it ships |
|---|---|---|
| **A — Built-in TypeScript** | First-party channels shipped with the image | `src/channels/<type>.ts` compiled into the image; self-registers via `src/channels/index.ts` |
| **B — Bootstrap channel** | Operator-installed channel using a pure-JS client; source lives in the repo but is not compiled | `helm/kubeclaw/files/channel-src/<type>/*.js` shipped in the `kubeclaw-channel-src` ConfigMap; orchestrator exec-pushes to `/runtime` at commit time |
| **C — Plugin .js** | Pre-compiled channel distributed outside the normal build | `.js` file placed at `/workspace/plugins/` in the container; scanned at startup by `src/channels/plugin-loader.ts` |

Path A is the default for channels included in the Helm chart. Path B is for channels that need a third-party npm package and can be written in plain JS — the operator installs them via the admin shell bootstrap flow without rebuilding the image. Path C is for pre-compiled distribution cases and is described in [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md).

---

## Path B — bootstrap channel workflow (detailed)

### Overview

A bootstrap channel ships its JavaScript source and npm manifest in the Helm chart. At install time, the orchestrator exec-pushes the source files onto the bootstrap pod's `/runtime` directory and restarts the pod to import `/runtime/channel-entry.js`. npm dependencies are installed by the bootstrap skill (not transcribed by an LLM — the lockfile is committed to the repo and shipped verbatim).

The worked example below uses the `nanoid-echo` channel. The `signal` skeleton in `helm/kubeclaw/files/channel-src/signal/channel-entry.js` is a commented template following the same pattern.

### Step 1: Write the channel source

Create a directory under `helm/kubeclaw/files/channel-src/<type>/`. The only required file is `channel-entry.js`. The entry file must call `ctx.registerChannel` via a default export that the bootstrap loader calls:

```js
// helm/kubeclaw/files/channel-src/nanoid-echo/channel-entry.js
import http from 'node:http';
import { nanoid } from 'nanoid';   // third-party npm dep

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok' })); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: nanoid(), url: req.url }));
});
server.listen(PORT, '0.0.0.0', () => console.error('[nanoid-echo] listening on ' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

This file is a real, editable JavaScript file — not a template string, not LLM-generated at install time. The orchestrator pushes it byte-for-byte onto `/runtime`.

**Node ESM note:** `import` works in a typeless package via Node 22's auto-detection. Add `"type":"module"` to the channel's `package.json` (in the manifest, step 2) to silence the `--input-type=module` warning.

**Native bindings note:** Bootstrap channels run `npm ci --ignore-scripts`. Libraries that compile native extensions at install time will fail. Use pure-JS clients or REST bridges. The Signal skeleton's header comment covers this in detail.

### Step 2: Declare deps in a channel manifest

A channel manifest is a JSON object with `packageJson`, `packageLockJson`, and `manifestHash` fields. It lives in Helm values and is shipped to the cluster as the `kubeclaw-channel-manifests` ConfigMap.

Add the manifest for your channel to `values.yaml` (or your overlay):

```yaml
channelManifests:
  nanoid-echo:
    packageJson: |
      {
        "name": "kubeclaw-channel-nanoid-echo",
        "version": "1.0.0",
        "type": "module",
        "dependencies": {
          "nanoid": "^5.0.9"
        }
      }
    packageLockJson: |
      { ... full npm lockfile ... }
    manifestHash: "<sha256 of canonical(packageJson) + '\n' + canonical(packageLockJson)>"
```

Compute `manifestHash` with:

```bash
node -e "
const crypto = require('crypto');
function canon(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
  const keys = Object.keys(o).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}
const pj = JSON.parse(require('fs').readFileSync('package.json','utf8'));
const pl = JSON.parse(require('fs').readFileSync('package-lock.json','utf8'));
console.log(crypto.createHash('sha256').update(canon(pj) + '\n' + canon(pl)).digest('hex'));
"
```

The orchestrator independently recomputes this hash at commit time as a TOCTOU defense — if the hash diverges from what the bootstrap skill staged, the commit is rejected with `MANIFEST_DIVERGENCE`.

### Step 3: Write the bootstrap skill

Create `helm/kubeclaw/files/bootstrap-skills/bootstrap-<type>.md`. Copy the structure from `bootstrap-nanoid-echo.md`:

- YAML frontmatter: `channelType`, `manifestVersion`, `expectedQuestions`
- Step 1: extract `package.json` + `package-lock.json` from the manifests ConfigMap onto `/runtime/`
- Step 2 (if deps): `npm ci --prefix /runtime --omit=dev --ignore-scripts`
- Step N: `ask_admin` for each required credential
- Final step: compute `runtime_pvc_lock_hash` and call `commit_channel_config`

The `bootstrap-signal.md` template in `helm/kubeclaw/files/bootstrap-skills/` is a ready-to-adapt example.

### Step 4: Apply Helm + install via admin shell

```bash
helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw -f your-values.yaml
```

This ships the channel source files in the `kubeclaw-channel-src` ConfigMap and the manifest in `kubeclaw-channel-manifests`. Then install via the admin shell:

```bash
kubectl -n kubeclaw exec -it deploy/kubeclaw-orchestrator -- node dist/admin-shell.js
# In the shell: "install the nanoid-echo channel"
```

The LLM loads the bootstrap skill and walks through the steps, ending with `commit_channel_config`. The orchestrator:

1. Verifies the `runtime_pvc_lock_hash` matches the registered manifest
2. Reads source files for the channel type from the ConfigMap
3. Exec-pushes each file onto the bootstrap pod's `/runtime` via `kubectl exec cat`
4. Runs `npm ci` on the bootstrap pod (if the manifest has deps)
5. Restarts the channel pod to import `/runtime/channel-entry.js`

No LLM transcription of source code. No per-file content hash. The source arrives exactly as committed.

---

## What the orchestrator exec-push does

At `commit_channel_config`, the orchestrator reads every key in the `kubeclaw-channel-src` ConfigMap whose name starts with `<type>__`, derives the relative path (replacing `__` with `/`), and writes it to `/runtime/<relpath>` on the bootstrap pod using `kubectl exec -- sh -c 'cat > /runtime/<relpath>'`.

The ConfigMap is built by the Helm template from `helm/kubeclaw/files/channel-src/**`:

```
files/channel-src/nanoid-echo/channel-entry.js
→ ConfigMap key: nanoid-echo__channel-entry.js
→ pushed to:     /runtime/channel-entry.js
```

Multi-file channels (e.g. `utils/helpers.js`) work naturally — the double-underscore separator maps `nanoid-echo__utils__helpers.js` → `/runtime/utils/helpers.js`.

The channel pod's steady-state entry point is always `/runtime/channel-entry.js`. Node resolves relative imports (`import './utils/helpers.js'`) from there normally.

---

## v1 constraint and future follow-up

**In-repo source only (v1):** Channel source ships via `helm/kubeclaw/files/channel-src/` and is embedded in the Helm chart. Adding a new channel type or modifying existing source requires a `helm upgrade`. The total size of all channel source must stay under ~1 MB (the Kubernetes ConfigMap limit).

**Deferred — runtime upload without Helm:** A future follow-up will add an authenticated `POST /channel-src/<type>` route to the admin HTTP server (port 9090). It will accept a tarball, unpack it to per-file SQLite rows, and feed a reconciler that merges with the Helm baseline to produce the live ConfigMap — mirroring the channel-manifest reconciler. This will allow adding or updating a channel's source files in a running cluster without a Helm upgrade.

---

## Static verification

Before committing a new bootstrap channel, verify the JS syntax is clean:

```bash
export PATH="/home/peter/.nvm/versions/node/v22.22.2/bin:$PATH"
node --check helm/kubeclaw/files/channel-src/<type>/channel-entry.js && echo OK
```

Confirm the Helm template picks up the new files:

```bash
helm template kubeclaw ./helm/kubeclaw -f ./helm/kubeclaw/values-minikube.yaml \
  --show-only templates/channel-src-configmap.yaml | grep '<type>__channel-entry.js'
```

---

## See also

- [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md) — full `Channel` interface reference: JID conventions, `ChannelCapabilities`, attachment markers, plugin path
- [INSTALLING_A_CHANNEL.md](INSTALLING_A_CHANNEL.md) — operator guide for installing a finished channel type via the admin shell
- `helm/kubeclaw/files/channel-src/nanoid-echo/channel-entry.js` — worked example (third-party npm dep)
- `helm/kubeclaw/files/channel-src/signal/channel-entry.js` — Signal skeleton / template
- `helm/kubeclaw/files/bootstrap-skills/bootstrap-nanoid-echo.md` — canonical bootstrap skill pattern
- `helm/kubeclaw/files/bootstrap-skills/bootstrap-signal.md` — Signal bootstrap skill template
