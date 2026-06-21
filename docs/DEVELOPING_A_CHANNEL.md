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

Channels register using a `ChannelFactory` from `src/channels/registry.ts`:

```typescript
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;
// opts.onMessage        — deliver an inbound message to storage
// opts.onChatMetadata   — register a chat / update its name
// opts.registeredGroups — read current group config
```

The factory returns `null` when credentials are missing; the harness silently disables the channel in that case. See [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md) for the full `ChannelCapabilities` reference and the JID prefix convention.

In a `channel-runner` adapter (see [The host-selector](#the-host-selector) below), the adapter calls `sdk.registerChannel(type, factory)` — it does not import `registry.ts` directly.

---

## Runtime adapters — the primary model

There are **no compiled-in channels**. Every channel is a **runtime adapter**: a plain-JS file at `helm/kubeclaw/files/channel-src/<type>/channel-entry.js`, shipped in the `kubeclaw-channel-src` ConfigMap and delivered to the channel pod's `/runtime/` volume at install time. A single generic image supports all channel types; which channel runs is selected at install time, not build time.

Existing adapters: `http`, `irc`, `oauth-webchat` (real channels), `http-echo`, `nanoid-echo` (echo demos), and `signal` (a skeleton/template, not a working channel).

The exact contract depends on the [host mode](#the-host-selector):

| Host mode | Image | Entrypoint | Adapter contract |
|---|---|---|---|
| `standalone` (default) | agent image | `channel-loader.js` does `await import('/runtime/channel-entry.js')` | Self-executing JS — no exported function required |
| `channel-runner` | orchestrator image | `channel-runner.js` calls `loadRuntimeChannelAdapter(sdk)` | Must default-export `register(sdk)` |

---

## The host-selector

Every channel manifest (`bootstrap.channelManifests.<type>` in Helm values) carries a `hostMode` field:

- **`standalone`** (default) — the channel pod runs `node /app/channel-loader.js` using the **agent image**. The loader simply does `await import('/runtime/channel-entry.js')`. The adapter is a self-contained, self-executing JS module — it manages its own process lifecycle (HTTP server, connection loop, SIGTERM handler). Use this for lightweight transports that don't need the agent loop, scheduled tasks, or the data facade.

- **`channel-runner`** — the channel pod runs `node dist/channel-runner.js` using the **orchestrator image** (the only image that contains `dist/channel-runner.js`). The host invokes the adapter's `register(sdk)` function, injects the full Channel SDK, and runs the agent loop + slash commands + IPC. Use this for channels that need the assistant conversation, Redis IPC, scheduled tasks, or REST data endpoints.

`httpPort` (optional, `channel-runner` only) — when set, additionally gives the pod container ports (http + health), liveness `/liveness` + readiness `/readyz` probes, a ClusterIP Service `kubeclaw-channel-<inst>` (+ `-metrics`), and an ingress NetworkPolicy `kubeclaw-channel-<inst>-ingress`.

```yaml
# values.yaml or overlay
bootstrap:
  channelManifests:
    irc:
      hostMode: channel-runner   # needs agent loop + SDK
      packageJson: |  ...
    signal:
      hostMode: standalone       # self-managing transport; omitting hostMode also gives standalone
      httpPort: 8080
      packageJson: |  ...
```

---

## The Channel SDK

When `hostMode: channel-runner`, the host builds a `ChannelSdk` (`src/channel-sdk/index.ts`, `buildChannelSdk()`) and passes it to the adapter's `register(sdk)`. The SDK is the **only** surface the adapter uses from the image — it never imports `db.ts`, `config.ts`, or any other host module directly.

**Core members:**

| Member | Type | Purpose |
|---|---|---|
| `registerChannel` | `(type, factory) => void` | Register the channel factory (call once in `register`) |
| `logger` | pino logger | Structured logging |
| `readEnvFile` | `(keys: string[]) => Record<string,string>` | Read credentials from the env file mounted by the host |
| `assistantName` | `string` | The configured assistant name (for trigger matching) |
| `groupsDir` | `string` | Filesystem path to the `groups/` directory |

**Data-facade members** (only needed by channels that expose REST/data endpoints; pure transports like irc use only the core members):

| Facade | Methods |
|---|---|
| `config` | `timezone`, `rateLimitWindowMs`, `storeDir`, `toolJobsRetentionDays`, `defaultModel`, `debugEndpointsEnabled` |
| `history` | `getPage`, `getAll`, `getById`, `search`, `getOutboundSince`, `append`, `update`, `deleteById`, `deleteBefore`, `clear`, `storeOutbound`, `groupFolderForMessage` (12) |
| `tasks` | `create`, `getForGroup`, `getById`, `deleteForGroup`, `pause`, `resume`, `getRunLogs` (7) |
| `jobs` | `active`, `recentForGroup`, `byIdForGroup`, `insertForDebug` (4) |
| `audit` | `write`, `entries` (2) |
| `diag` | `diag(groupFolder)` — returns a diagnostic snapshot |
| `skills` | `listAccepted`, `listCandidates`, `listArchived`, `accept`, `reject` (5) |

**Minimal `channel-runner` adapter skeleton:**

```js
// helm/kubeclaw/files/channel-src/my-channel/channel-entry.js
import MyClient from 'my-client-lib';

class MyChannel {
  name = 'my-channel';
  capabilities = {};

  constructor(cfg, opts, sdk) {
    this.cfg = cfg;
    this.opts = opts;
    this.sdk = sdk;
    this.client = null;
  }

  async connect() {
    this.client = new MyClient(this.cfg);
    this.client.on('message', (msg) => {
      const jid = `my-channel:${msg.room}`;
      this.opts.onChatMetadata(jid, new Date().toISOString(), msg.room, 'my-channel', true);
      this.opts.onMessage(jid, {
        id: `${Date.now()}`,
        chat_jid: jid,
        sender: msg.from,
        sender_name: msg.from,
        content: msg.text,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      });
    });
    await this.client.connect();
    this.sdk.logger.info({ server: this.cfg.server }, 'my-channel connected');
  }

  async sendMessage(jid, text) { await this.client.send(jid, text); }
  isConnected()    { return this.client?.connected ?? false; }
  ownsJid(jid)     { return jid.startsWith('my-channel:'); }
  async disconnect() { await this.client?.disconnect(); }
}

function parseConfig(sdk) {
  const env = sdk.readEnvFile(['MY_SERVER', 'MY_TOKEN']);
  const server = process.env.MY_SERVER || env.MY_SERVER;
  const token  = process.env.MY_TOKEN  || env.MY_TOKEN;
  if (!server || !token) {
    sdk.logger.warn('my-channel: MY_SERVER and MY_TOKEN must be set');
    return null;
  }
  return { server, token };
}

export default function register(sdk) {
  sdk.registerChannel('my-channel', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new MyChannel(cfg, opts, sdk);
  });
}
```

See `helm/kubeclaw/files/channel-src/irc/channel-entry.js` for a complete, production `channel-runner` adapter using `sdk.readEnvFile`, `sdk.logger`, `sdk.assistantName`, and `sdk.registerChannel`.

**Standalone adapter pattern (no SDK):**

For `standalone` channels, the adapter is just a self-executing Node module — no exported function, no SDK injection:

```js
// helm/kubeclaw/files/channel-src/my-transport/channel-entry.js
import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const server = http.createServer((req, res) => { /* ... */ });
server.listen(PORT, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

See `helm/kubeclaw/files/channel-src/nanoid-echo/channel-entry.js` (simple HTTP server) or `helm/kubeclaw/files/channel-src/signal/channel-entry.js` (Signal skeleton with health endpoint).

---

## Two delivery paths

Both paths produce the same steady-state pod. The choice is operational, not architectural.

### Path A — Interactive bootstrap (LLM-driven; use when credentials require gathering)

A short-lived bootstrap Job runs an agent that:
1. An init container stages the manifest + runs `npm ci` deterministically
2. The agent gathers credentials via a combined `ask_admin` call
3. The agent calls `commit_channel_config`

At commit time, the orchestrator:
1. Verifies the `runtime_pvc_lock_hash` matches the registered manifest (rejects `MANIFEST_DIVERGENCE`)
2. Reads every `<type>__*` key in the `kubeclaw-channel-src` ConfigMap
3. Exec-pushes each file to `/runtime/<relpath>` on the bootstrap pod via `kubectl exec -- sh -c "mkdir -p ... && cat > /runtime/<relpath>"`
4. Creates the credentials Secret
5. Creates the steady-state Deployment (+ Service/netpol when `httpPort` is set)

Admin tools (in the orchestrator admin shell): `register_channel_manifest`, `register_bootstrap_skill`, `bootstrap_channel_from_skill`, `list_channel_manifests`, `list_bootstrap_skills`, `remove_bootstrap_skill`.

### Path B — Declarative Helm (LLM-free; use for automation, CI, or operators)

`channels.<name>.enabled=true` (with `type`, `httpPort`, `envVars`) in Helm values causes `helm/kubeclaw/templates/channel-pods.yaml` to render a channel Deployment. A `stage-runtime` init container copies `<type>__channel-entry.js` from `kubeclaw-channel-src` + the package files from `kubeclaw-channel-manifests-baseline` into a `/runtime` emptyDir and runs `npm ci`. Then `channel-runner.js` loads `/runtime/channel-entry.js`.

**channel-runner channels only.** `channel-pods.yaml` hardcodes `node dist/channel-runner.js` on the orchestrator image — it does **not** branch on `hostMode`. So the declarative path works only for `channel-runner` adapters (those that `export default register(sdk)`). A **standalone** adapter (self-executing, e.g. an echo) would crash-loop here, because `channel-runner.js` requires the `register(sdk)` default export. Install standalone channels via the bootstrap path (Path A), which honours `hostMode` and runs `channel-loader.js` on the agent image.

**Note:** the init `npm ci` needs egress to the npm registry (port 443). This works in `credentialInjection.mode=off`; sidecar/istio modes need `networkPolicy.extraEgressPorts: [443]`.

---

## Bootstrap workflow (Path A — detailed)

### Step 1: Write the channel source

Create `helm/kubeclaw/files/channel-src/<type>/channel-entry.js`. The pattern depends on `hostMode`:

- `channel-runner`: default-export `register(sdk)` — see the skeleton above and the `irc` adapter
- `standalone`: self-executing module — see `nanoid-echo` or `signal`

The file is shipped byte-for-byte; the orchestrator pushes it verbatim. No LLM transcription.

**Node ESM note:** `import` works in a typeless package via Node 22's auto-detection. Add `"type":"module"` to the channel's `package.json` (in the manifest, step 2) to silence the `--input-type=module` warning.

**Native bindings note:** Bootstrap channels run `npm ci --ignore-scripts`. Libraries that compile native extensions at install time will fail. Use pure-JS clients or REST bridges. The Signal skeleton's header comment covers this in detail.

### Step 2: Declare deps in a channel manifest

A channel manifest lives in Helm values and is shipped to the cluster as the `kubeclaw-channel-manifests` ConfigMap.

```yaml
bootstrap:
  channelManifests:
    nanoid-echo:
      hostMode: standalone   # omit for standalone; shown for clarity
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

### Step 4: Apply Helm + install via admin shell or declarative config

**Via admin shell (Path A):**

```bash
helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw -f your-values.yaml
```

This ships the channel source in `kubeclaw-channel-src` and the manifest in `kubeclaw-channel-manifests`. Then:

```bash
kubectl -n kubeclaw exec -it deploy/kubeclaw-orchestrator -- node dist/admin-shell.js
# In the shell: "install the nanoid-echo channel"
```

**Via declarative Helm (Path B):**

`nanoid-echo` is a **standalone** channel, so it must use Path A above (the
declarative path runs every channel under `channel-runner.js` and would
crash-loop a self-executing adapter — see the Path B note earlier). For a
**channel-runner** channel (one that `export default register(sdk)`, e.g. an
http-serving channel), add to your values overlay:

```yaml
channels:
  my-channel:
    enabled: true
    type: <channel-runner-type>   # e.g. http — an adapter exporting register(sdk)
    httpPort: 4080
    envVars:
      - name: MY_CHANNEL_TOKEN
        key: token                # mapped from the kubeclaw-channel-my-channel Secret
```

Then `helm upgrade --install`. See [INSTALLING_A_CHANNEL.md](INSTALLING_A_CHANNEL.md) for both flows in detail.

---

## What the orchestrator exec-push does

At `commit_channel_config`, the orchestrator reads every key in the `kubeclaw-channel-src` ConfigMap whose name starts with `<type>__`, derives the relative path (replacing `__` with `/`), and writes it to `/runtime/<relpath>` on the bootstrap pod using `kubectl exec -- sh -c "mkdir -p \"$(dirname /runtime/<relpath>)\" && cat > /runtime/<relpath>"`.

The ConfigMap is built by the Helm template from `helm/kubeclaw/files/channel-src/**`:

```
files/channel-src/nanoid-echo/channel-entry.js
→ ConfigMap key: nanoid-echo__channel-entry.js
→ pushed to:     /runtime/channel-entry.js
```

Multi-file channels (e.g. `utils/helpers.js`) work naturally — the double-underscore separator maps `nanoid-echo__utils__helpers.js` → `/runtime/utils/helpers.js`.

The channel pod's steady-state entry point is always `/runtime/channel-entry.js`. Node resolves relative imports (`import './utils/helpers.js'`) from there normally.

---

## Path C — Plugin `.js` (pre-compiled distribution)

`src/channels/plugin-loader.ts` (imported by both `src/index.ts` and `src/channel-runner.ts`) scans `/workspace/plugins/` for `*.js` files at startup and dynamically imports each one. Each plugin file must default-export a function matching `(ctx: ChannelPluginContext) => void` where `ctx = { registerChannel }`. Files that do not export a default function are silently skipped; failures are logged and the remaining plugins continue to load.

This path is for distributing a pre-compiled channel as a drop-in `.js` file without touching the Helm chart — it calls `ctx.registerChannel` (the raw registry function) rather than `sdk.registerChannel`. It is documented fully in [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md).

---

## v1 constraint and future follow-up

**In-repo source only (v1):** Channel source ships via `helm/kubeclaw/files/channel-src/` and is embedded in the Helm chart. Adding a new channel type or modifying existing source requires a `helm upgrade`. The total size of all channel source must stay under ~1 MB (the Kubernetes ConfigMap limit).

**Deferred — runtime upload without Helm:** A future follow-up will add an authenticated `POST /channel-src/<type>` route to the admin HTTP server (port 9090). It will accept a tarball, unpack it to per-file SQLite rows, and feed a reconciler that merges with the Helm baseline to produce the live ConfigMap — mirroring the channel-manifest reconciler. This will allow adding or updating a channel's source files in a running cluster without a Helm upgrade.

---

## Static verification

Before committing a new channel, verify the JS syntax is clean:

```bash
nvm use 22  # ensure Node 22 is on PATH
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
- [INSTALLING_A_CHANNEL.md](INSTALLING_A_CHANNEL.md) — operator guide for installing a finished channel type
- `helm/kubeclaw/files/channel-src/irc/channel-entry.js` — complete `channel-runner` adapter (SDK-based)
- `helm/kubeclaw/files/channel-src/nanoid-echo/channel-entry.js` — minimal `standalone` adapter
- `helm/kubeclaw/files/channel-src/signal/channel-entry.js` — Signal skeleton / template (standalone)
- `helm/kubeclaw/files/bootstrap-skills/bootstrap-nanoid-echo.md` — canonical bootstrap skill pattern
- `helm/kubeclaw/files/bootstrap-skills/bootstrap-signal.md` — Signal bootstrap skill template
