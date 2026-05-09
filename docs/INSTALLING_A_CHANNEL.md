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
| An inline preprocessing pipeline (image resize, PDF text extraction, voice transcription) that runs inside channel/orchestrator pods | Source code change via `/customize` (see ADDING_A_CHANNEL.md for the markers contract) |

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

### RAG (special case)

RAG isn't a capability under `capabilities:` — it's a top-level Helm values block:

```yaml
rag:
  enabled: true
  provider: openai          # or "voyage"
  storage: 20Gi
  topK: 5
  scoreThreshold: "0.5"
```

This deploys a Qdrant StatefulSet and wires the orchestrator to embed + retrieve before each agent invocation. See `helm/kubeclaw/values.yaml` for the full schema.

---

## See also

- [ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md) — for developers writing a brand-new channel TYPE in TypeScript
- `helm/kubeclaw/values.yaml` — full Helm value reference with inline comments
- `/customize` Claude Code skill — for source-code customization (channel types, behavior, triggers)
