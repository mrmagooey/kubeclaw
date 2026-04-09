# Redis IPC Protocol

KubeClaw uses Redis pub/sub channels and streams for inter-process communication (IPC) between the orchestrator, channel pods, and agent containers (Kubernetes Jobs). This document describes the naming conventions, message formats, and communication patterns.

## Overview

The Redis IPC system handles:
- **Pub/sub channels**: Broadcast messages from agents to group channels, task requests to the orchestrator
- **Streams**: Persistent, ordered message queues for agent input/output and tool pod communication
- **Atomic operations**: Coordinated job spawning and tool pod lifecycle management

All Redis names follow the `kubeclaw:` prefix convention to isolate KubeClaw data.

## Channel Naming Scheme

Pub/sub channels are used for:
1. Broadcasting messages to group chats
2. Routing task requests to the orchestrator
3. Publishing control commands to channel pods

### Message Output Channels

```
kubeclaw:messages:{groupFolder}
```

**Purpose**: Broadcast messages from agent jobs back to a specific group chat.

**Who writes**: Agent containers via `ContainerOutput` on the `output` topic.
**Who reads**: Orchestrator (in main mode) or channel pod (in channel mode).

**Wire format**: JSON object with fields `type`, `chatJid`, `text`:
```json
{
  "type": "message",
  "chatJid": "120123456789@g.us",
  "text": "Response to user"
}
```

**Authorization**: 
- Main group agents can publish to any group's output channel
- Non-main agents can only publish to their own group's output channel

### Task Request Channels

```
kubeclaw:tasks:{groupFolder}
```

**Purpose**: Route task requests (schedule, pause, cancel, etc.) from agents to the orchestrator.

**Who writes**: Agent containers via Redis pub/sub.
**Who reads**: Orchestrator.

**Wire format**: JSON object matching `TaskRequest` interface (see below).

**Authorization**:
- Main group agents can schedule tasks for any group
- Non-main agents can only modify their own group's tasks

### Control Channels

```
kubeclaw:control:{channelName}
```

**Purpose**: Send control commands (reload, mcp_update) from the orchestrator to a specific channel pod.

**Who writes**: Orchestrator.
**Who reads**: Channel pod identified by `{channelName}`.

**Wire format**: JSON object:
```json
{
  "command": "reload|mcp_update",
  "servers": "[{...}]"  // only for mcp_update
}
```

## Stream Naming Scheme

Streams are used for persistent, ordered message queues where delivery guarantees matter. Each stream uses the Redis XADD/XREAD API.

### Input Stream

```
kubeclaw:input:{jobId}
```

**Purpose**: Messages and control signals sent _to_ a running agent job.

**Who writes**: Orchestrator, channel pods, tool pods.
**Who reads**: Agent container.

**Message types**:
- `type: "message"` — Text message to the agent
- `type: "close"` — Graceful shutdown request
- `type: "task_update"` — Task status change (paused/resumed/cancelled)
- `type: "tool_pod_ack"` — Acknowledgement that a tool pod was spawned

**Wire format** (Redis stream field pairs):
```
type: message
text: "User message text"
---
type: close
---
type: task_update
taskId: "task-123"
status: paused|resumed|cancelled
---
type: tool_pod_ack
category: execution|browser
podJobId: "pod-123"
```

### Tool Calls Streams

```
kubeclaw:toolcalls:{jobId}:{category}
```

**Purpose**: Tool invocations from an agent to a specific tool pod category.

**Who writes**: Agent container.
**Who reads**: Tool pod (execution or browser service).

**Message types**:
- `browser` — Browser automation requests
- `execution` — Command execution requests

**Wire format** (example for execution tool):
```
toolName: bash
input: "ls -la /workspace"
```

### Tool Results Streams

```
kubeclaw:toolresults:{jobId}:{category}
```

**Purpose**: Responses from tool pods back to the agent.

**Who writes**: Tool pod.
**Who reads**: Agent container.

**Wire format** (example):
```
toolName: bash
result: "file.txt\ndir/"
exitCode: 0
```

### Job Status Key (String, not Stream)

```
kubeclaw:job:{jobId}:status
kubeclaw:job:{jobId}:output
```

**Purpose**: Persistent storage of final job status and output for fault recovery.

**Who writes**: Orchestrator (after job completes).
**Who reads**: Orchestrator (on startup for recovery).

## Stream-Based Operations

### Spawn Agent Job Stream

```
kubeclaw:spawn-agent-job
```

**Purpose**: Queue of agent job specifications for the orchestrator to spawn.

**Who writes**: Channel pods (when running directly without K8s RBAC).
**Who reads**: Orchestrator (`startAgentJobSpawnWatcher`).

**Wire format** (Redis stream fields):
```
prompt: "What is 2+2?"
groupFolder: my-group
isMain: "true"
chatJid: "120123456789@g.us"
timeout: "30000"
assistantName: "Assistant"
...and optional fields...
```

### Spawn Tool Pod Stream

```
kubeclaw:spawn-tool-pod
```

**Purpose**: Queue of tool pod specs for the orchestrator to create.

**Who writes**: Agent containers and channel pods.
**Who reads**: Orchestrator (`startToolPodSpawnWatcher`).

**Wire format** (Redis stream fields):
```
agentJobId: "agent-123"
groupFolder: my-group
category: execution|browser
timeout: "60000"
channel: "telegram"  // optional: for channel-specific PVC override
toolImage: "myrepo/mytool:latest"  // optional: for sidecar tool pods
toolPattern: http|file|acp  // optional: for sidecar tool pods
toolPort: "8080"  // optional: for sidecar tool pods
```

### Agent Job Result Stream

```
kubeclaw:agent-job-result:{jobId}
```

**Purpose**: Final result/output from an agent job, for the initiator to read.

**Who writes**: Orchestrator (after agent job completes).
**Who reads**: Channel pod that spawned the job (if applicable).

**Wire format**: Same as `ContainerOutput` structure.

### Task Request Stream

```
kubeclaw:task-requests
```

**Purpose**: Global queue of task requests (schedule, pause, cancel, etc.) from agents.

**Who writes**: Agent containers.
**Who reads**: Orchestrator (`startTaskRequestWatcher`).

**Wire format**: JSON matching `TaskRequest` interface.

## Message Types and Wire Formats

### AgentOutputMessage

Messages sent from agent containers to the orchestrator via pub/sub:

```typescript
interface AgentOutputMessage {
  type: 'output' | 'task_request' | 'status' | 'log';
  jobId: string;
  groupFolder: string;
  timestamp: string;
  payload: ContainerOutput | TaskRequest | StatusUpdate | LogMessage;
}
```

**Fields**:
- `type`: Message category
- `jobId`: Identifier of the sending agent job
- `groupFolder`: Group folder name for authorization/routing
- `timestamp`: ISO 8601 timestamp
- `payload`: Type-specific content

### HostInputMessage

Messages sent _to_ agent containers via streams:

```typescript
interface HostInputMessage {
  type: 'message' | 'close' | 'task_update' | 'tool_pod_ack';
  text?: string;          // for 'message' type
  taskId?: string;        // for 'task_update' type
  status?: 'paused' | 'resumed' | 'cancelled';  // for 'task_update' type
  category?: string;      // for 'tool_pod_ack' type (execution|browser)
  podJobId?: string;      // for 'tool_pod_ack' type
}
```

### TaskRequest

Task management requests from agents:

```typescript
interface TaskRequest {
  type:
    | 'schedule_task'
    | 'pause_task'
    | 'resume_task'
    | 'cancel_task'
    | 'update_task'
    | 'register_group'
    | 'refresh_groups'
    | 'tool_pod_request'
    | 'deploy_channel'
    | 'control_channel'
    | 'deploy_mcp_server'
    | 'remove_mcp_server'
    | 'list_mcp_servers';
  
  // Common fields
  taskId?: string;
  
  // For schedule_task, update_task
  prompt?: string;
  schedule_type?: 'cron' | 'interval' | 'once';
  schedule_value?: string;  // cron expression, ms, or ISO 8601 date
  context_mode?: 'group' | 'isolated';
  targetJid?: string;
  
  // For register_group
  jid?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  containerConfig?: Record<string, unknown>;
  
  // For tool_pod_request
  category?: 'execution' | 'browser';
  agentJobId?: string;
  groupFolder?: string;
  
  // For deploy_channel
  yaml?: string;  // Kubernetes YAML to apply
  
  // For control_channel
  channelName?: string;
  command?: 'reload' | 'mcp_update';
  
  // For deploy_mcp_server
  image?: string;
  port?: string;
  path?: string;
  env?: string;  // JSON-encoded
  channels?: string;  // JSON-encoded string[]
  allowedTools?: string;  // JSON-encoded string[]
  resources?: string;  // JSON-encoded
  
  // For list_mcp_servers
  resultStream?: string;  // stream to write results to
}
```

### StatusUpdate

Job status updates:

```typescript
interface StatusUpdate {
  status: 'running' | 'completed' | 'failed' | 'timeout';
  message?: string;
}
```

### LogMessage

Structured logging from containers:

```typescript
interface LogMessage {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}
```

## Message Lifecycle

### Agent Job Execution

1. **Spawn request**: Orchestrator or channel pod calls `jobRunner.createAgentJob(spec)` or publishes to `kubeclaw:spawn-agent-job` stream
2. **Job initialization**: Agent container reads initial prompt, group folder, chat JID from environment
3. **Input stream polling**: Agent subscribes to `kubeclaw:input:{jobId}` and polls for incoming messages
4. **Tool execution**: Agent publishes to `kubeclaw:toolcalls:{jobId}:execution` or `browser`, reads results from corresponding `toolresults` stream
5. **Task requests**: Agent publishes task requests to `kubeclaw:tasks:{groupFolder}` pub/sub channel
6. **Output**: Agent publishes to `kubeclaw:messages:{groupFolder}` for user-facing messages
7. **Job completion**: Orchestrator captures final output and writes to `kubeclaw:job:{jobId}:output`
8. **Cleanup**: Tool pods are terminated, input stream entry expires (if TTL configured)

### Tool Pod Lifecycle

1. **Request**: Agent publishes to `kubeclaw:toolcalls:{jobId}:{category}` stream
2. **Spawn**: 
   - For built-in tools (execution, browser): Agent publishes to `kubeclaw:spawn-tool-pod` stream, orchestrator spawns K8s Job
   - For sidecar tools: Include `toolImage`, `toolPattern`, `toolPort` in spawn request
3. **Acknowledgement**: Orchestrator sends `tool_pod_ack` to `kubeclaw:input:{jobId}` with spawned `podJobId`
4. **Communication**: Agent writes tool calls to stream, tool pod reads and responds via results stream
5. **Cleanup**: Tool pod exits, orchestrator removes associated K8s Job. Orchestrator cleans up via `cleanupToolPods(agentJobId)`

### Task Scheduling

1. **Request**: Agent publishes `schedule_task` to `kubeclaw:tasks:{groupFolder}`
2. **Validation**: Orchestrator verifies authorization (main group can schedule for any group, non-main only for self)
3. **Creation**: Task is stored in SQLite with `next_run` computed from cron/interval/once expression
4. **Execution**: Task scheduler runs at scheduled time, spawns agent job with task prompt
5. **Modification**: Agent can publish `pause_task`, `resume_task`, `cancel_task`, `update_task` requests

## Authorization

Tasks and messages are subject to group-based authorization:

| Operation | Main Group | Non-Main Group |
|-----------|-----------|---------|
| Send to any group's output channel | Yes | No (self only) |
| Schedule task for any group | Yes | No (self only) |
| Pause/resume/cancel/update any task | Yes | Only own group's tasks |
| Register new group | Yes | No |
| Refresh group list | Yes | No |
| Deploy channel | Yes | No |
| Control channel | Yes | No |
| Deploy/remove MCP server | Yes | No |

Channel pods bypass pub/sub authorization since they use direct function calls for inbound messages.

## Concurrency and Ordering

- **Streams guarantee order per stream**: Messages on a single stream are delivered in order (FIFO)
- **Pub/sub is best-effort**: Subscribers must be connected to receive messages; messages published to idle subscribers are lost
- **No cross-stream ordering**: Task updates and output messages may race if sent to different channels
- **Stream TTL**: Entries can expire; design agents to handle missing or truncated history

## Connection Management

The Redis client singleton (`redis-client.ts`) provides two connections:

1. **Regular client** (`getRedisClient()`): For publishing, XADD, XREAD, key operations
2. **Subscriber client** (`getRedisSubscriber()`): Dedicated to pub/sub subscriptions (required by ioredis)

Both are configured with:
- Automatic reconnection with exponential backoff
- Username/password authentication (if `REDIS_USERNAME`/`REDIS_ADMIN_PASSWORD` set)
- Retry strategy with max 3 retries per request

## Implementation Notes

### Polling Pattern

Agent containers poll input streams with XREAD in a blocking call (5s timeout). This avoids constant CPU spinning while remaining responsive to messages:

```typescript
await redis.xread('COUNT', 1, 'BLOCK', 5000, 'STREAMS', streamKey, lastId);
```

### Race Condition Prevention

To avoid race conditions when watching streams (e.g., in `startToolPodSpawnWatcher`), the protocol avoids using `$` as a stream ID. Instead:
1. Resolve the actual last-entry ID at startup via `xrevrange`
2. Resume from that ID to catch any messages added between watcher restarts

### Error Recovery

- **Lost pub/sub messages**: If the subscriber disconnects, messages published during the outage are lost. Critical operations use streams instead.
- **Incomplete agent jobs**: If an agent container crashes, the orchestrator cleans up tool pods via `cleanupToolPods(agentJobId)`.
- **Orphaned streams**: Input streams may persist if the agent crashes. Consider TTL or periodic cleanup.

## Debugging Tips

- **Monitor activity**: `MONITOR` command shows all Redis ops in real-time
- **Inspect channels**: `PUBSUB CHANNELS` lists active subscription channels
- **Inspect streams**: `XLEN kubeclaw:input:{jobId}` shows pending messages
- **Tail streams**: `XRANGE kubeclaw:input:{jobId} - +` shows all entries
- **Watch a channel**: `PSUBSCRIBE kubeclaw:*` monitors all KubeClaw pub/sub traffic
