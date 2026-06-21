# Installing a Channel or Capability

This guide is for **operators** who want to install an existing channel (Telegram, Slack, etc.) or capability (RAG, image-vision, MCP server) into a running KubeClaw deployment.

For developers who want to *write a brand-new channel TYPE* (the TypeScript code), see [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md). For other dev-time customization (modifying behavior, triggers, router), use the `/customize` Claude Code skill.

---

## Installing a channel

Every channel is a **runtime adapter** — a plain JS file shipped in the `kubeclaw-channel-src` ConfigMap and loaded at runtime by the channel-runner host. There is one install mechanism (deliver the adapter + create the channel Deployment), with two front-ends:

- **(a) Interactive bootstrap** — LLM-driven credential gathering via the admin shell.
- **(b) Declarative Helm** — deterministic, LLM-free; suitable for automation and GitOps.

Both produce the same steady-state Deployment. Credentials reach the channel pod via environment variables sourced from its Secret.

Currently available adapters: `http`, `irc`, `oauth-webchat`. Additional channel types (telegram, slack, discord, etc.) follow the same pattern but their adapters are not yet built — the install steps below describe the intended model for when they are.

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
| `telegram` _(aspirational)_ | Bot token | Talk to [@BotFather](https://t.me/BotFather) |
| `discord` _(aspirational)_ | Bot token | https://discord.com/developers/applications → Bot → Token |
| `slack` _(aspirational)_ | Bot token + App token | https://api.slack.com/apps → OAuth & Permissions / Socket Mode |
| `whatsapp` _(aspirational)_ | Phone number | WhatsApp Business API setup |
| `signal` _(aspirational)_ | Phone number | signal-cli registration |
| `gmail` _(aspirational)_ | OAuth credentials | Google Cloud project with Gmail API enabled |

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
