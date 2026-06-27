# Installing a Channel or Capability

This guide is for **operators** who want to install an existing channel (Telegram, Slack, etc.) or capability (RAG, image-vision, MCP server) into a running KubeClaw deployment.

For developers who want to *write a brand-new channel TYPE* (the TypeScript code), see [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md). For other dev-time customization (modifying behavior, triggers, router), use the `/customize` Claude Code skill.

---

## Installing a channel

Every channel is a **runtime adapter** — a plain JS file shipped in the `kubeclaw-channel-src` ConfigMap and loaded at runtime by the channel-runner host. There is one install mechanism (deliver the adapter + create the channel Deployment), with two front-ends:

- **(a) Interactive bootstrap** — LLM-driven credential gathering via the admin shell.
- **(b) Declarative Helm** — deterministic, LLM-free; suitable for automation and GitOps.

Both produce the same steady-state Deployment. Credentials reach the channel pod via environment variables sourced from its Secret.

Currently available adapters: `discord`, `http`, `irc`, `oauth-webchat`, `signal`, `telegram`. Additional channel types (slack, matrix, whatsapp, imessage, etc.) follow the same pattern but their adapters are not yet built.

For developers writing a new adapter, see [DEVELOPING_A_CHANNEL.md](DEVELOPING_A_CHANNEL.md).

### Two access modes for the admin shell

**TTY mode** (interactive shell inside the orchestrator pod):

```bash
kubectl -n kubeclaw exec -it deploy/kubeclaw-orchestrator -- node dist/admin-shell.js
```

**HTTP UI** (browser-based, requires `ADMIN_HTTP_PORT` and `ADMIN_HTTP_PASSWORD` set in your Helm values):

```bash
kubectl -n kubeclaw port-forward deploy/kubeclaw-orchestrator 8080:8080
# Open http://localhost:8080 in browser; auth with ADMIN_HTTP_USERNAME/PASSWORD
```

### (a) Interactive bootstrap

The bootstrap flow is LLM-driven and suited for gathering credentials interactively. You need a channel manifest and a bootstrap skill in place first — these ship in `bootstrap.channelManifests` Helm values and `helm/kubeclaw/files/bootstrap-skills/`, or you can register them at runtime:

```
register_channel_manifest(type="irc", ...)
register_bootstrap_skill(type="irc", ...)
```

Then trigger the install:

```
bootstrap_channel_from_skill(type="irc")
```

The orchestrator launches a short-lived bootstrap Job. An init container stages the adapter and runs `npm ci` deterministically. The agent then gathers credentials via one combined question and calls `commit_channel_config`. The orchestrator independently re-hashes the staged `/runtime` files and rejects the install with `MANIFEST_DIVERGENCE` if the files do not match the registered manifest hash (TOCTOU check). On success it creates the credentials Secret and the steady-state Deployment (plus Service and NetworkPolicy for channels with an `httpPort`).

**Multi-instance** — pass a distinct `instance_name` to `bootstrap_channel_from_skill`:

```
bootstrap_channel_from_skill(type="irc", instance_name="irc-work")
bootstrap_channel_from_skill(type="irc", instance_name="irc-personal")
```

Each instance gets its own Deployment (`kubeclaw-channel-irc-work`, `kubeclaw-channel-irc-personal`) and Secret.

Other useful admin shell tools: `list_channel_manifests`, `list_bootstrap_skills`, `remove_bootstrap_skill`.

### (b) Declarative Helm

For automation, GitOps, or CI, set `channels.<name>.enabled=true` with at minimum `type`, and optionally `httpPort` and `envVars`:

```yaml
channels:
  my-http:
    enabled: true
    type: http
    httpPort: 3000
    envVars:
      HTTP_BASIC_USERS: "alice:secret,bob:s3cr3t"
```

The channel pod includes a `stage-runtime` init container that copies `<type>__channel-entry.js` from the `kubeclaw-channel-src` ConfigMap and the package files from `kubeclaw-channel-manifests-baseline` into a `/runtime` emptyDir, then runs `npm ci`. The resident `channel-runner.js` then loads `/runtime/channel-entry.js`.

**Note:** the `npm ci` step needs outbound HTTPS (port 443) to the npm registry. This works out of the box with `credentialInjection.mode=off`. With `sidecar` or `istio` mode, add:

```yaml
networkPolicy:
  extraEgressPorts: [443]
```

**Multi-instance** — use distinct keys under `channels:`:

```yaml
channels:
  irc-work:
    enabled: true
    type: irc
    envVars:
      IRC_SERVER: irc.work.example.com
      IRC_NICK: kubeclaw-work
  irc-personal:
    enabled: true
    type: irc
    envVars:
      IRC_SERVER: irc.libera.chat
      IRC_NICK: kubeclaw-personal
```

Apply with `helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw -f your-values.yaml`.

### Per-channel credentials

Credentials are gathered by the bootstrap dialogue (interactive) or supplied via `envVars` / a channel Secret (declarative). The table below lists what each adapter needs — note that most of these channel types are aspirational; only `http`, `irc`, and `oauth-webchat` have adapters today.

| Channel | Credentials needed | Where to obtain |
|---|---|---|
| `http` | Username:password pairs | None (you choose them) |
| `irc` | Server, nick, optional channels list | None (just the IRC server you want to join) |
| `oauth-webchat` | OIDC issuer, client ID, client secret, allowed emails | Your OIDC provider (Google Workspace, Okta, etc.) |
| `telegram` | Bot token | Talk to [@BotFather](https://t.me/BotFather) |
| `discord` | Bot token | https://discord.com/developers/applications → Bot → Token |
| `slack` _(aspirational)_ | Bot token + App token | https://api.slack.com/apps → OAuth & Permissions / Socket Mode |
| `whatsapp` _(aspirational)_ | Phone number | WhatsApp Business API setup |
| `signal` | Phone number (E.164) | See [Signal](#signal) below — the signal-cli sidecar is created with the channel pod; link the device afterward via port-forward |
| `gmail` _(aspirational)_ | OAuth credentials | Google Cloud project with Gmail API enabled |

### Signal

Signal is a **channel-runner** adapter backed by a per-channel `bbernhard/signal-cli-rest-api` sidecar. There is no separately-deployed shared Signal daemon — the sidecar is created automatically alongside the channel pod when you install a Signal instance.

**What the sidecar field does:**
- Adds a second container (`signal-backend`) to the channel pod running `bbernhard/signal-cli-rest-api:0.93`.
- Creates a `kubeclaw-channel-<instance>-auxsession` PVC (5 GiB by default) mounted exclusively on the sidecar at `/home/.local/share/signal-cli`.
- Injects `SIGNAL_API_URL=http://localhost:8080` into the channel container automatically (via `apiUrlEnv`).
- Adds a per-channel `sidecar-egress` NetworkPolicy allowing outbound TCP 443 for Signal's infrastructure.

The adapter has **no npm dependencies** — it uses Node's built-in `fetch` to poll and send.

**Bootstrap (interactive, Path A):**

Ensure the Signal manifest ships in `bootstrap.channelManifests.signal` (it is included in `values-minikube.yaml` and any overlay that inherits from it). Then:

```
# In the admin shell:
bootstrap_channel_from_skill(type="signal")
# Or for a named instance:
bootstrap_channel_from_skill(type="signal", instance_name="signal-personal")
```

You will be asked for the bot's E.164 phone number (e.g. `+61412345678`). That is the only credential gathered; the `SIGNAL_API_URL` is injected by the manifest and does not need to be provided.

**Linking the device (post-install — required):**

After the channel pod reaches Running state, link the Signal account. The session persists on the `auxsession` PVC and survives pod restarts.

1. Find the channel pod name:
   ```bash
   kubectl get pods -n kubeclaw -l app=kubeclaw-channel-<instance>
   ```

2. Port-forward into the pod (the sidecar listens on 8080):
   ```bash
   kubectl port-forward pod/<pod-name> 8080:8080 -n kubeclaw
   ```

3. Two paths:
   - **Link as secondary device (recommended):** Open `http://localhost:8080/v1/qrcodelink?device_name=kubeclaw` in a browser. On your phone: *Signal → Settings → Linked devices → +* and scan the QR code. The bot sends/receives as your existing number.
   - **Register a dedicated number:** `POST http://localhost:8080/v1/register/<number>` (with captcha token), then `POST http://localhost:8080/v1/register/<number>/verify/<sms-code>`.

Once linked, the session is durable — the `auxsession` PVC keeps the linked-device credentials across pod restarts and upgrades.

**Multi-instance:** each instance gets its own sidecar, its own `auxsession` PVC, and therefore its own Signal device. You must link each instance separately.

```
bootstrap_channel_from_skill(type="signal", instance_name="signal-personal")
bootstrap_channel_from_skill(type="signal", instance_name="signal-work")
```

For developer notes on extending or modifying the Signal adapter, see [DEVELOPING_A_CHANNEL.md](DEVELOPING_A_CHANNEL.md#channels-with-an-external-backend-sidecar).

### Telegram

Telegram is a **channel-runner** adapter that uses [Telegraf](https://telegraf.js.org/) for long-poll updates. No sidecar or external backend is needed — the bot token is the only credential required.

**Prerequisites:** Create a bot via [@BotFather](https://t.me/BotFather) on Telegram:

```
/newbot
# Answer the name prompts; BotFather gives you a token like:
# 7412345678:AAExampleTokenXXX
```

Keep this token secret — it is equivalent to a password for your bot.

**Bootstrap (interactive, Path A):**

```
# In the admin shell:
bootstrap_channel_from_skill(type="telegram")
# Or for a named instance:
bootstrap_channel_from_skill(type="telegram", instance_name="telegram-personal")
```

You will be prompted for `TELEGRAM_BOT_TOKEN` (and optionally `TELEGRAM_BOT_USERNAME` — the `@botname` without the `@`). The bootstrap skill re-hashes the staged runtime files before creating the Deployment and rejects the install with `MANIFEST_DIVERGENCE` if there is a discrepancy.

**Declarative Helm (Path B):**

Create a Secret first, then reference it in `values.yaml`:

```bash
kubectl create secret generic kubeclaw-channel-telegram \
  --from-literal=TELEGRAM_BOT_TOKEN="7412345678:AAExampleTokenXXX" \
  -n kubeclaw
```

```yaml
# In your values overrides:
channels:
  telegram:
    enabled: true
    type: telegram
    envVars:
      TELEGRAM_BOT_USERNAME: "mybotname"   # optional but recommended
```

Apply with `helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw -f your-values.yaml`.

**Multi-instance** — one bot per instance; use distinct keys:

```yaml
channels:
  telegram-personal:
    enabled: true
    type: telegram
  telegram-work:
    enabled: true
    type: telegram
```

Each instance needs its own bot token (i.e. two separate bots created via @BotFather) stored in distinct Secrets:

```bash
kubectl create secret generic kubeclaw-channel-telegram-personal \
  --from-literal=TELEGRAM_BOT_TOKEN="<personal-bot-token>" -n kubeclaw
kubectl create secret generic kubeclaw-channel-telegram-work \
  --from-literal=TELEGRAM_BOT_TOKEN="<work-bot-token>" -n kubeclaw
```

**Registering chats:** After the pod starts, add the bot to the chats you want it to monitor using the normal `register_group` admin shell flow. The adapter listens for messages only in registered chats.

**Group trigger:** In group chats, a message must mention the assistant by name (e.g. `@Andy`) to trigger a response. Private chats respond to every message that passes the trigger pattern.

For developer notes on the Telegram adapter, see [DEVELOPING_A_CHANNEL.md](DEVELOPING_A_CHANNEL.md).

### Discord

Discord is a **channel-runner** adapter that uses [discord.js@14](https://discord.js.org/) and the Gateway WebSocket transport. No sidecar or external backend is needed — the bot token is the only credential required.

**Prerequisites:** Create a bot in the Discord Developer Portal:

1. Go to https://discord.com/developers/applications and click **New Application**.
2. Give your application a name (e.g. `KubeClaw`), then go to **Bot** in the left sidebar.
3. Click **Reset Token** to generate your bot token. Copy it — you will need it during bootstrap.
4. Under **Privileged Gateway Intents**, toggle **Message Content Intent** to **ON** and save.
   This step is mandatory. Without it the bot will receive empty messages in servers.
5. Under **OAuth2 → URL Generator**, select scopes `bot` and permissions `Send Messages` and
   `Read Message History`, then use the generated URL to invite the bot to your server.

**Bootstrap (interactive, Path A):**

```
# In the admin shell:
bootstrap_channel_from_skill(type="discord")
# Or for a named instance:
bootstrap_channel_from_skill(type="discord", instance_name="discord-personal")
```

You will be prompted for `DISCORD_BOT_TOKEN`. The bootstrap skill also validates the token
against the Discord API (`GET /users/@me`) and reminds you to enable the Message Content Intent.

**Declarative Helm (Path B):**

Create a Secret first, then reference it in `values.yaml`:

```bash
kubectl create secret generic kubeclaw-channel-discord \
  --from-literal=DISCORD_BOT_TOKEN="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.EXAMPLE.abc123" \
  -n kubeclaw
```

```yaml
# In your values overrides:
channels:
  discord:
    enabled: true
    type: discord
```

Apply with `helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw -f your-values.yaml`.

**Multi-instance** — one bot per instance; use distinct keys:

```yaml
channels:
  discord-personal:
    enabled: true
    type: discord
  discord-work:
    enabled: true
    type: discord
```

Each instance needs its own bot token stored in a distinct Secret.

**Registering channels:** After the pod starts, register the Discord channel IDs (not server IDs)
that the bot should monitor using `register_group` in the admin shell. The JID format is
`discord:<channelId>` — you can find the channel ID by right-clicking a channel in Discord with
Developer Mode enabled.

**Group trigger:** In server (guild) channels, a message must mention the assistant by name
(e.g. `@Andy`) to trigger a response. DM channels respond to every message.

**MessageContent intent note:** If you see `empty message content in guild` warnings in the pod
logs, the Message Content privileged intent is not enabled in the Developer Portal. Enable it
and the bot will start receiving message text immediately (no pod restart needed).

For developer notes on the Discord adapter, see [DEVELOPING_A_CHANNEL.md](DEVELOPING_A_CHANNEL.md).

### Removing a channel

Use the `remove_channel` admin shell tool. It deletes the full per-channel resource set — Deployment, ServiceAccount, Services (including `-metrics`), Ingress, NetworkPolicy, all Secret name variants, PVCs (`groups`, `store`, `sessions`, `runtime`, versioned runtime), and the bootstrap/upgrade Jobs. Failures are reported under a `FAILED` section; the operation never aborts early.

```
remove_channel(name="irc-work")
```

---

## Installing a capability

Capabilities are configured via Helm values and applied with `helm upgrade`. There are two shapes depending on whether the capability is a **separate model server / MCP server** (deploy as its own pod) or an **inline preprocessing pipeline** (modifies orchestrator/channel source code).

### Capability shape decision tree

| If the capability is... | Install via... |
|---|---|
| A separate model server you'd run anyway (Ollama LLM, image vision API) | Helm values `capabilities:` map |
| An MCP server exposing tools (calendar, weather, your own service) | Helm values `mcpServers:` map |
| Voice transcription (Whisper-class STT) | A `transcription` capability — install the spec via the admin shell (see "Installing voice transcription" below). The channel-side preprocessor reads the `[VoiceAttachment: …]` marker and calls it automatically. |
| An inline preprocessing pipeline (image resize, PDF text extraction) that runs inside channel/orchestrator pods | Source code change via `/customize` (see ADDING_A_CHANNEL.md for the markers contract) |

### `capabilities:` example — `use-local-whisper`

Run a local Whisper STT server as a capability pod that channel pods can call for voice transcription:

```yaml
# In your values overrides:
capabilities:
  whisper:
    image: onerahmet/openai-whisper-asr-webservice:v1.7.1
    port: 9000
    env:
      ASR_MODEL: base.en
    resources:
      requests:
        memory: 2Gi
        cpu: 500m
      limits:
        memory: 4Gi
        cpu: "2"
```

Apply with:

```bash
helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw -f your-values.yaml
```

Channel pods discover this via the orchestrator's discovery registry and call `http://kubeclaw-capability-whisper:9000/asr`.

### `mcpServers:` example — `ollama-tool`

Expose Ollama via MCP for channels that opt in:

```yaml
mcpServers:
  ollama:
    image: your-org/ollama-mcp-server:1.0.0
    port: 3000
    path: /mcp
    channels: [telegram]   # only telegram channel sees this; empty list = all
    env:
      OLLAMA_HOST: http://ollama-server:11434
    resources:
      memoryRequest: 256Mi
      memoryLimit: 512Mi
```

### Inline-preprocessing capabilities — `/customize`

These previously had `/add-*` Claude skills that modified source files directly. They cannot be installed via Helm because they need to run *inside* the channel or orchestrator pod's existing process:

| Capability | What it does | Where to add it |
|---|---|---|
| `image-vision` | Reads `[ImageAttachment: ...]` markers, resizes images, rewrites to `[Image: ...]` | New module `src/preprocessing/image-vision.ts` called from the orchestrator's preprocessing job |
| `pdf-reader` | Extracts text from PDF attachments before the agent sees them | New module `src/preprocessing/pdf-reader.ts` |
| `parallel` | Parallel skill execution support | Orchestrator router/runtime change |

Use the `/customize` Claude Code skill to add these; it'll ask the right questions and write the code following the existing patterns.

### Installing Qdrant as a RAG capability

RAG is no longer baked into the chart. Install Qdrant as a `rag` capability with
an embedded `provider` block. The `vector-store` adapter embeds + chunks in the
channel pod and upserts/searches Qdrant's REST API.

Spec (passed to the admin shell `install_capability` tool):

```json
{
  "kind": "rag",
  "name": "main-rag",
  "backend": "qdrant",
  "image": "qdrant/qdrant:latest",
  "port": 6333,
  "healthPath": "/healthz",
  "storage": { "sizeGi": 20, "mountPath": "/qdrant/storage" },
  "podSecurity": { "fsGroup": 1000, "runAsUser": 1000 },
  "provider": {
    "adapter": "vector-store",
    "embedding": { "provider": "openai", "apiKeyEnv": "OPENAI_API_KEY" },
    "topK": 5,
    "scoreThreshold": 0.5
  }
}
```

The `healthPath`, `storage`, and `port` values above match the RAG builder
defaults, so they can be omitted; they are shown here for clarity. The
`podSecurity` block (`fsGroup: 1000`) is required for Qdrant to own the mounted
PVC.

The embedding API key is read from the channel pod's `OPENAI_API_KEY`
(or `VOYAGE_API_KEY` for `provider: "voyage"`) — the raw key never appears in the
spec. To install a backend that embeds server-side (e.g. LightRAG), use the
`remote` adapter instead:

```json
{
  "kind": "rag",
  "name": "lightrag",
  "backend": "lightrag",
  "image": "ghcr.io/hkuds/lightrag:latest",
  "port": 9621,
  "healthPath": "/health",
  "provider": { "adapter": "remote", "queryMode": "hybrid" }
}
```

**Note:** the RAG builder probes `/healthz` by default. Backends that expose a
different health endpoint (e.g. LightRAG at `/health`) must set `healthPath`
explicitly, as shown above.

A backend speaking either protocol installs as pure config — no code change.

To invoke from the admin shell, describe what you want and the LLM will call
`install_capability` with the spec. You can also pass the spec directly in
a message: `install_capability(spec=<json above>)`.

After install, use `list_capabilities` to confirm the lifecycle reaches `ready`,
or `get_capability_logs(name="main-rag")` to diagnose startup issues.

### Installing voice transcription as a `transcription` capability

Voice notes arrive at channels as an audio file on the group PVC plus a
`[VoiceAttachment: attachments/raw/<file>]` marker in the message text. Install a
Whisper-class STT server as a `transcription` capability; the channel-side
inbound-preprocessor chain detects the marker, reads the audio from the group PVC,
POSTs it to the capability, and replaces the marker with `[Voice: <transcript>]`
BEFORE the LLM turn — so the model, stored history, and RAG all see the spoken
words, not the raw marker.

Spec (passed to the admin shell `install_capability` tool / Redis IPC). This uses
an OpenAI-compatible image, so it installs as pure config:

```json
{
  "kind": "transcription",
  "name": "whisper",
  "image": "onerahmet/openai-whisper-asr-webservice:latest",
  "port": 9000,
  "env": { "ASR_ENGINE": "faster_whisper", "ASR_MODEL": "base.en" },
  "resources": { "gpu": 1, "memoryRequest": "2Gi", "memoryLimit": "4Gi" },
  "scheduling": { "runtimeClassName": "nvidia" },
  "probe": {
    "type": "http",
    "path": "/health",
    "startup": { "failureThreshold": 60, "periodSeconds": 5 }
  },
  "endpointScheme": "http",
  "provider": {
    "transcribePath": "/v1/audio/transcriptions",
    "model": "base.en",
    "responseField": "text",
    "timeoutMs": 60000
  }
}
```

Notes:

- **`port` and `probe.path`** — the builder defaults both to `9000` and `/health`
  respectively, so they can be omitted; they are shown here for clarity.
- **`scheduling.runtimeClassName: "nvidia"`** — required for GPU scheduling on most
  clusters. Add `nodeSelector` and `tolerations` if your GPU nodes carry taints.
- **`probe.startup`** (SP1) — guards liveness/readiness while the model warms up.
  GPU images can take a minute to load weights; `failureThreshold * periodSeconds`
  = 300 s of grace time before Kubernetes marks the pod unhealthy.
- **`provider.transcribePath`** defaults to `/v1/audio/transcriptions` (OpenAI
  audio API shape). For images that expose `/asr` (e.g. the ASR webservice's native
  route), set `"transcribePath": "/asr"` and set `responseField` to match its JSON
  response key.
- **`provider.responseField`** defaults to `"text"`; `provider.timeoutMs` defaults
  to `60000`. Both can be omitted when using the OpenAI-compatible shape.
- **One transcription capability per channel** — the preprocessor picks the first
  matching entry for the channel. To run different STT servers for different
  channels, use disjoint `channels` ACL lists on each spec (empty/absent means all
  channels).
- **No raw secrets in the spec** — in-cluster STT needs no API key. If a hosted STT
  backend requires one, store it as a K8s Secret and reference it via
  `"envFromSecrets": ["my-stt-secret"]`; the key never appears in the spec or the
  discovery entry.

A backend speaking the OpenAI audio shape installs with no code change.

To invoke from the admin shell, describe what you want and the LLM will call
`install_capability` with the spec. You can also pass the spec directly:
`install_capability(spec=<json above>)`.

After install, use `list_capabilities` to confirm the lifecycle reaches `ready`,
or `get_capability_logs(name="whisper")` to diagnose startup issues.

---

## See also

- [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md) — for developers writing a brand-new channel TYPE in TypeScript
- `helm/kubeclaw/values.yaml` — full Helm value reference with inline comments
- `/customize` Claude Code skill — for source-code customization (channel types, behavior, triggers)
