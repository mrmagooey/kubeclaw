# KubeClaw File Adapter

A file-based sidecar adapter that enables KubeClaw to run arbitrary containers without HTTP interfaces. This adapter uses shared volumes and file watching for IPC between KubeClaw and user containers.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Kubernetes Pod                          │
│  ┌──────────────────────┐    ┌──────────────────────────┐  │
│  │ kubeclaw-file-adapter│    │      user-agent          │  │
│  │  (this container)    │    │  (arbitrary user image)  │  │
│  │                      │    │                          │  │
│  │  Reads stdin from    │    │  Runs wrapper script     │  │
│  │  orchestrator        │    │  that watches files      │  │
│  │                      │◄──►│                          │  │
│  │  Writes output with  │    │  Processes tasks         │  │
│  │  KubeClaw markers    │    │  Writes results          │  │
│  │                      │    │                          │  │
│  └──────────┬───────────┘    └────────────┬─────────────┘  │
│             │                              │               │
│             └──────────┬───────────────────┘               │
│                        │                                    │
│              ┌─────────▼──────────┐                        │
│              │   emptyDir volume  │                        │
│              │  /workspace/input  │                        │
│              │  /workspace/output │                        │
│              └────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

## How It Works

1. **Sidecar Container** (`kubeclaw-file-adapter`): Handles the KubeClaw protocol (stdin/stdout with markers)
2. **Main Container** (user's arbitrary image): Reads/writes files, no HTTP needed
3. **Shared Volume** (`emptyDir`): File-based IPC at `/workspace/input/` and `/workspace/output/`

## Protocol

### Input from Orchestrator (stdin)

```json
{
  "prompt": "user message here",
  "sessionId": "optional-session-id",
  "groupFolder": "group-name",
  "chatJid": "chat@jid.com",
  "isMain": false,
  "isScheduledTask": false,
  "assistantName": "Andy",
  "secrets": { "API_KEY": "secret-value" }
}
```

### Output to Orchestrator (stdout with markers)

```
---KUBECLAW_OUTPUT_START---
{"status":"success","result":"response text","newSessionId":"session-id"}
---KUBECLAW_OUTPUT_END---
```

### File Protocol

**Input file** (`/workspace/input/task.json`):
Same format as stdin input from orchestrator.

**Output file** (`/workspace/output/result.json`):

```json
{
  "status": "success",
  "result": "response text",
  "newSessionId": "session-id"
}
```

Or for errors:

```json
{
  "status": "error",
  "result": null,
  "error": "error message"
}
```

## Usage

### Environment Variables

- `KUBECLAW_INPUT_DIR`: Input directory (default: `/workspace/input`)
- `KUBECLAW_OUTPUT_DIR`: Output directory (default: `/workspace/output`)
- `KUBECLAW_POLL_INTERVAL`: Poll interval in ms (default: `1000`)
- `KUBECLAW_TIMEOUT`: Timeout for waiting on output in ms (default: `300000`)
- `IDLE_TIMEOUT`: Idle timeout for follow-up messages (default: `1800000`)

### Running Locally

```bash
# Build the container
docker build -t kubeclaw-file-adapter:latest .

# Run with test input
echo '{"prompt":"Hello","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i kubeclaw-file-adapter:latest
```

### In Kubernetes

See `src/k8s/file-sidecar-runner.ts` for the Kubernetes Job runner that creates pods with both containers.

## Wrapper Script

The `runner-wrapper.sh` script runs inside the user container and:

1. Polls `/workspace/input/` for `task*.json` files
2. Reads the task and runs the user's command (or echoes by default)
3. Writes the result to `/workspace/output/result.json`

Mount this script via ConfigMap into user containers at `/workspace/runner-wrapper.sh`.

## Development

```bash
# Install dependencies
npm install

# Run in dev mode
echo '{"prompt":"test","groupFolder":"g","chatJid":"c","isMain":false}' | npm run dev

# Build
npm run build

# Start
npm start
```
