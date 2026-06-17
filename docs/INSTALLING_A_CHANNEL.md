# Installing a Channel or Capability

This guide is for **operators** who want to install an existing channel (Telegram, Slack, etc.) or capability (RAG, image-vision, MCP server) into a running KubeClaw deployment.

For developers who want to *write a brand-new channel TYPE* (the TypeScript code), see [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md). For other dev-time customization (modifying behavior, triggers, router), use the `/customize` Claude Code skill.

---

## Installing a channel

Channels are installed via the orchestrator's **admin shell**. The admin shell is an LLM-powered tool runner that walks you through credential collection and provisions the K8s resources (Secret, PVCs, Deployment, NetworkPolicy) for the new channel pod.

### Two access modes

**TTY mode** (interactive shell inside the orchestrator pod):

```bash
kubectl -n kubeclaw exec -it deploy/kubeclaw-orchestrator -- node dist/admin-shell.js
```

**HTTP UI** (browser-based, requires `ADMIN_HTTP_PORT` and `ADMIN_HTTP_PASSWORD` set in your Helm values):

```bash
kubectl -n kubeclaw port-forward deploy/kubeclaw-orchestrator 8080:8080
# Open http://localhost:8080 in browser; auth with ADMIN_HTTP_USERNAME/PASSWORD
```

### What the admin shell does

The admin shell exposes a `setup_channel` tool to its underlying LLM. You describe what you want ("install Telegram"), the LLM asks for credentials, calls `setup_channel`, and the orchestrator:

1. Validates credentials online (e.g. fetches `api.telegram.org` for Telegram)
2. Creates a K8s Secret with the credentials
3. Creates 3 PVCs for the channel pod (groups, store, sessions)
4. Creates a Deployment running the orchestrator image in `KUBECLAW_MODE=channel`
5. Optionally registers a default group with `direct: true`

### Per-channel credentials

| Channel | Credentials needed | Where to obtain |
|---|---|---|
| `telegram` | Bot token | Talk to [@BotFather](https://t.me/BotFather) |
| `discord` | Bot token | https://discord.com/developers/applications → Bot → Token |
| `slack` | Bot token + App token | https://api.slack.com/apps → OAuth & Permissions / Socket Mode |
| `whatsapp` | Phone number | WhatsApp Business API setup |
| `signal` | Phone number | signal-cli registration |
| `irc` | Server, nick, optional channels list | None (just the IRC server you want to join) |
| `gmail` | OAuth flow handled by setup_channel | Google Cloud project with Gmail API enabled |
| `http` | Username:password pairs | None (you choose them) |
| `oauth-webchat` | OIDC issuer, client ID, client secret, allowed emails | Your OIDC provider (Google Workspace, Okta, etc.) |

### Multi-instance setups (e.g., Telegram swarm)

`setup_channel` accepts an `instanceName` field. To run multiple Telegram bots side by side, call it once per bot with distinct names:

```
setup_channel(type="telegram", instanceName="telegram-personal", token="...")
setup_channel(type="telegram", instanceName="telegram-work", token="...")
```

Each gets its own Deployment (`kubeclaw-channel-telegram-personal`, `kubeclaw-channel-telegram-work`) and Secret. The default `instanceName` equals the channel `type` for the single-bot common case.

### Removing a channel

The admin shell does not currently expose a removal tool. To remove a channel, manually:

```bash
kubectl -n kubeclaw delete deploy kubeclaw-channel-<instanceName>
kubectl -n kubeclaw delete secret kubeclaw-channel-<instanceName>-secret
kubectl -n kubeclaw delete pvc -l kubeclaw/channel=<instanceName>  # ⚠ deletes message history
```

---

## Installing a capability

Capabilities are configured via Helm values and applied with `helm upgrade`. There are two shapes depending on whether the capability is a **separate model server / MCP server** (deploy as its own pod) or an **inline preprocessing pipeline** (modifies orchestrator/channel source code).

### Capability shape decision tree

| If the capability is... | Install via... |
|---|---|
| A separate model server you'd run anyway (Whisper STT, Ollama LLM, image vision API) | Helm values `capabilities:` map |
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
| `voice-transcription` | Transcribes audio attachments to text inline | `src/transcription.ts` exporting `transcribeBuffer()`; called from channel implementations that set `inboundVoice: true` (see ADDING_A_CHANNEL.md) |
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
