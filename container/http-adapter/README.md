# KubeClaw HTTP Adapter

Sidecar container that enables KubeClaw to communicate with any agent container exposing an HTTP REST API. The agent container needs no knowledge of KubeClaw's internal protocol.

## Architecture

```
Kubernetes Pod
├── kubeclaw-http-adapter (this sidecar)
│   ├── Reads task from stdin (KubeClaw protocol)
│   ├── Polls GET /agent/health until ready
│   ├── Sends POST /agent/task with task payload
│   └── Writes result to stdout (KubeClaw markers)
│
└── your-agent-container
    └── Exposes REST API on port 8080
```

## HTTP API Spec for Agent Authors

Your agent container must expose two endpoints on port 8080 (configurable):

### GET /agent/health

Health check endpoint. Return HTTP 200 when ready to accept tasks.

**Response:** Any 2xx status code. Body is ignored.

### POST /agent/task

Execute a task.

**Request body:**

```json
{
  "prompt": "User's message text",
  "sessionId": "optional-session-id",
  "context": {
    "groupFolder": "group-folder-name",
    "chatJid": "chat-jid",
    "isMain": false,
    "assistantName": "Andy"
  },
  "secrets": {
    "API_KEY": "value"
  }
}
```

**Expected response (JSON):**

```json
{
  "status": "success",
  "result": "The agent's response text",
  "sessionId": "optional-new-session-id"
}
```

**Error response:**

```json
{
  "status": "error",
  "error": "Description of what went wrong"
}
```

## Retry Behavior

| HTTP Status   | Behavior                                                  |
| ------------- | --------------------------------------------------------- |
| 2xx           | Success, return result                                    |
| 4xx           | Fail immediately (no retry)                               |
| 5xx           | Retry up to 3 times with exponential backoff (1s, 2s, 4s) |
| Network error | Retry (same as 5xx)                                       |

## Environment Variables

| Variable                        | Default                 | Description                   |
| ------------------------------- | ----------------------- | ----------------------------- |
| `KUBECLAW_AGENT_URL`            | `http://localhost:8080` | Base URL of the agent         |
| `KUBECLAW_REQUEST_TIMEOUT`      | `300000`                | Request timeout in ms (5 min) |
| `KUBECLAW_HEALTH_POLL_INTERVAL` | `1000`                  | Health poll interval in ms    |
| `KUBECLAW_HEALTH_POLL_TIMEOUT`  | `30000`                 | Health check timeout in ms    |
| `KUBECLAW_MAX_RETRIES`          | `3`                     | Max retry attempts            |
| `KUBECLAW_RETRY_DELAY`          | `1000`                  | Initial retry delay in ms     |
| `KUBECLAW_HEALTH_ENDPOINT`      | `/agent/health`         | Health check path             |

## Examples

See `examples/http-agent/` for reference implementations:

- `python-flask/` - Python Flask agent
- `node-express/` - Node.js Express agent
