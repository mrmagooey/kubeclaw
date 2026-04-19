# Execution Modes

KubeClaw supports two runtime modes controlled by the `KUBECLAW_MODE` environment variable. Understanding which mode is active is essential when adding a channel or reasoning about registration and agent-execution behaviour.

## Environment variables

| Variable | Purpose |
|---|---|
| `KUBECLAW_MODE` | `orchestrator` (default) or `channel` |
| `KUBECLAW_CHANNEL` | Required in channel-pod mode. The instance name for this pod (e.g. `telegram`, `http-dev`). |
| `KUBECLAW_CHANNEL_TYPE` | Optional in channel-pod mode. The factory type to look up in the registry. Defaults to `KUBECLAW_CHANNEL`. Set this when the instance name differs from the type (e.g. instance `http-staging`, type `http`). |

---

## Orchestrator mode (`KUBECLAW_MODE=orchestrator` or unset)

Entry point: `src/index.ts`

This is the default mode. A single long-running process manages the full lifecycle:

- Loads all channel factories that were self-registered via `registerChannel()` (unless `KUBECLAW_MODE=orchestrator`, in which case channels run in their own pods and are not loaded inline).
- Maintains a registry of explicitly registered groups (`groups/{name}/` folders).
- Spawns **Kubernetes Jobs** for tool execution via `src/k8s/job-runner.ts`. Each job runs an isolated container with IPC sidecars.
- Groups must be registered manually, typically through a command sent in the main group (e.g. via `register_group` IPC). Non-main groups require a trigger word (`@AssistantName`) before the agent responds.
- The `onChatMetadata` callback only stores chat metadata — it does **not** auto-register groups.
- Redis is required for IPC between the orchestrator, channel pods, and tool jobs.

### Group registration in orchestrator mode

1. A user in the main group sends a `register_group` command (or equivalent tool call from the agent).
2. The IPC watcher in `src/k8s/ipc-redis.ts` calls `registerGroup(jid, group)`.
3. The group is persisted to SQLite and its folder is created under `groups/`.
4. Future messages from that JID are picked up by the message loop.

---

## Channel-pod mode (`KUBECLAW_MODE=channel`)

Entry point: `src/channel-runner.ts`

One pod per channel. This mode is used when channels run as isolated Kubernetes Deployments (the common production topology). Characteristics:

- Only the single channel identified by `KUBECLAW_CHANNEL` / `KUBECLAW_CHANNEL_TYPE` is loaded.
- Agent execution uses `DirectLLMRunner` (in-process, no Kubernetes Jobs). This means the agent runs inside the channel pod itself.
- The pod has **no Kubernetes RBAC** — tool pod spawning is delegated to the orchestrator via Redis.
- A health server runs on port `9090` (configurable via `HEALTH_PORT`).

### Auto-registration via `onChatMetadata`

The most important behavioural difference from orchestrator mode: **every new chat is automatically registered** when first seen.

When a channel calls `opts.onChatMetadata(chatJid, timestamp, name, channelType, isGroup)`, the channel runner checks whether `chatJid` is already registered. If not, it:

1. Derives a folder name using `jidToFolder(channelType, chatJid)` (see below).
2. Calls `registerGroup(chatJid, { ..., requiresTrigger: false, containerConfig: { direct: true } })`.
3. Creates `groups/{folder}/logs/` on disk.
4. Logs `Auto-registered new chat`.

Key properties of auto-registered groups:

| Property | Value | Meaning |
|---|---|---|
| `requiresTrigger` | `false` | The agent responds to every message, no `@AssistantName` prefix needed. |
| `containerConfig.direct` | `true` | Uses `DirectLLMRunner` (in-process); never spawns a K8s Job. |

This means channel-pod mode is a "respond to everything" setup out of the box. If you want trigger-gating in channel-pod mode, you must set `requiresTrigger: true` on the registered group after it is created (e.g. via an IPC update from the orchestrator).

### Folder naming in channel-pod mode

The folder name for an auto-registered group is derived by `jidToFolder` in `src/channel-runner.ts`:

```
folder = folderPrefixForChannel(channelType) + '-' + sanitize(jidIdentifier)
```

`folderPrefixForChannel` is exported from `src/channel-runner.ts` and maps known channel types to short prefixes:

| Channel type | Prefix |
|---|---|
| `telegram` | `tg` |
| `discord` | `dc` |
| `slack` | `sl` |
| `whatsapp` | `wa` |
| `irc` | `irc` |
| `http` | `http` |
| _(unknown)_ | first 3 chars of channel name |

The identifier portion of the JID (the part after the colon) is sanitised before use:

1. All non-alphanumeric characters replaced with `-`
2. Consecutive `-` collapsed
3. Leading/trailing `-` stripped
4. Truncated to 55 characters

Example: channel type `telegram`, JID `telegram:-1001234567890` → folder `tg-1001234567890`.

### Redis IPC in channel-pod mode

Although there are no K8s Jobs, the channel pod still subscribes to Redis:

- `kubeclaw:messages:{groupFolder}` — receives scheduled messages from the orchestrator's task scheduler and delivers them via the channel.
- `kubeclaw:control:{channelName}` — receives reload and MCP-update commands from the orchestrator.

---

## Comparison summary

| Aspect | Orchestrator mode | Channel-pod mode |
|---|---|---|
| Entry point | `src/index.ts` | `src/channel-runner.ts` |
| Agent runner | `K8sJobRunner` (Kubernetes Jobs) | `DirectLLMRunner` (in-process) |
| Channel loading | All registered channels (unless `orchestrator`) | Single channel (`KUBECLAW_CHANNEL`) |
| Group registration | Manual (IPC command) | Automatic on first `onChatMetadata` |
| `requiresTrigger` default | `true` for non-main groups | `false` (responds to all messages) |
| Redis required | Yes | For IPC only (scheduled messages + reload) |
| K8s RBAC needed | Yes | No |
| Health port | `8080` (`HEALTH_PORT`) | `9090` (`HEALTH_PORT`) |

---

## See also

- [docs/ADDING_A_CHANNEL.md](ADDING_A_CHANNEL.md) — how to implement a channel, including JID conventions and attachment handling.
- [docs/REDIS_IPC_PROTOCOL.md](REDIS_IPC_PROTOCOL.md) — the Redis streams and pub/sub channels used for inter-pod communication.
