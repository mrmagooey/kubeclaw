# NanoClaw Sidecar Adapter

A lightweight sidecar container for Kubernetes that enables NanoClaw to run arbitrary user containers using file-based IPC.

## Overview

The sidecar adapter bridges the gap between NanoClaw's stdin/stdout protocol and user containers that don't have HTTP interfaces. It runs as a sidecar in a Kubernetes Pod alongside the user's container.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes Pod                            │
│                                                              │
│  ┌──────────────────┐        ┌──────────────────────┐      │
│  │ nanoclaw-adapter │        │   user-container     │      │
│  │                  │        │                      │      │
│  │  Reads stdin     │        │  Reads /workspace/   │      │
│  │  → /workspace/   │◄──────►│  input/task.json    │      │
│  │  input/          │        │                      │      │
│  │                  │        │  Writes /workspace/ │      │
│  │  Polls /workspace│◄──────►│  output/result.json │      │
│  │  /output/        │        │                      │      │
│  │                  │        │                      │      │
│  │  Writes stdout   │        │                      │      │
│  │  (with markers)  │        │                      │      │
│  └──────────────────┘        └──────────────────────┘      │
│           │                              │                 │
│           └──────── shared emptyDir ─────┘                 │
└─────────────────────────────────────────────────────────────┘
```

## File Protocol

### Input Files

Tasks are written as JSON files to `/workspace/input/`:

**Initial task:** `task.json`

```json
{
  "prompt": "user message here",
  "sessionId": "optional-session-id",
  "groupFolder": "group-name",
  "chatJid": "chat@jid.com",
  "isMain": false,
  "isScheduledTask": false,
  "assistantName": "Andy",
  "secrets": { "key": "value" }
}
```

**Follow-up tasks:** `task_1.json`, `task_2.json`, etc.

### Output File

Results are written by the user container to `/workspace/output/result.json`:

```json
{
  "status": "success",
  "result": "response text",
  "newSessionId": "optional-session-id"
}
```

Or on error:

```json
{
  "status": "error",
  "error": "error message"
}
```

### Stdout Protocol

The sidecar adapter wraps all output in NanoClaw markers:

```
---NANOCLAW_OUTPUT_START---
{"status": "success", "result": "..."}
---NANOCLAW_OUTPUT_END---
```

## Configuration

Environment variables:

| Variable                 | Default             | Description                            |
| ------------------------ | ------------------- | -------------------------------------- |
| `NANOCLAW_INPUT_DIR`     | `/workspace/input`  | Input directory for task files         |
| `NANOCLAW_OUTPUT_DIR`    | `/workspace/output` | Output directory for result files      |
| `NANOCLAW_POLL_INTERVAL` | `1000`              | File polling interval in milliseconds  |
| `NANOCLAW_TIMEOUT`       | `1800000`           | Timeout for waiting for output (30min) |

## Usage

### With Docker

```bash
# Build the image
cd container/sidecar-adapter
docker build -t nanoclaw-sidecar-adapter:latest .

# Test with a simple task
echo '{"prompt":"Hello","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | docker run -i --rm \
  -v /tmp/workspace:/workspace \
  nanoclaw-sidecar-adapter:latest
```

### In Kubernetes

The sidecar is automatically deployed by the `SidecarJobRunner` in NanoClaw. See `src/k8s/sidecar-job-runner.ts` for details.

## User Container Integration

User containers can use the provided wrapper script or implement their own file watcher:

### Using the Wrapper Script

Mount the wrapper script via ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: runner-wrapper
data:
  runner.sh: |
    #!/bin/sh
    # Contents of runner-wrapper.sh
```

### Custom Implementation

User containers can watch the input directory and write to the output directory:

```bash
#!/bin/sh
# Poll for task files
while true; do
  if [ -f /workspace/input/task.json ]; then
    # Process task
    cat /workspace/input/task.json | jq -r '.prompt' | process
    # Write result
    echo '{"status":"success","result":"done"}' > /workspace/output/result.json
    # Clean up
    rm /workspace/input/task.json
  fi
  sleep 1
done
```

## Security Considerations

1. **Secrets are passed via environment variables**, never written to files
2. **Input/output files are cleaned up** after processing
3. **Shared volume is scoped per-Pod**, preventing cross-contamination
4. **User containers run without access to the sidecar's stdin/stdout**

## License

MIT - See parent project for details.
