# E2E Test Containers

This directory contains minimal test containers for end-to-end testing of the KubeClaw sidecar system.

## Containers

### file-echo

A file-based IPC echo container that:

- Reads tasks from `/workspace/input/task.json`
- Writes results to `/workspace/output/result.json`
- Echoes back the user message content
- Supports special commands: `CRASH`, `TIMEOUT`

### http-echo

An HTTP-based echo container that:

- Exposes `GET /agent/health` for health checks
- Exposes `POST /agent/task` for task processing
- Echoes back the user message content via HTTP
- Supports special commands: `CRASH`, `TIMEOUT`

## Task Format

```json
{
  "taskId": "uuid",
  "input": {
    "messages": [{ "role": "user", "content": "Hello" }],
    "tools": [],
    "sessionId": "optional-session-id"
  }
}
```

## Result Format

```json
{
  "status": "success",
  "result": {
    "text": "Echo: Hello"
  },
  "newSessionId": "session-id"
}
```

## Special Commands

- **CRASH**: Simulates a container crash (exits with error code for file-echo, returns 500 for http-echo)
- **TIMEOUT**: Simulates a timeout scenario (sleeps indefinitely)

## Building

From the project root:

```bash
# Build test containers
cd e2e && make build-test-containers

# Load into minikube
cd e2e && make load-test-containers
```

Or manually:

```bash
# Build file-echo
docker build -t kubeclaw-test-file-echo:latest e2e/test-containers/file-echo/

# Build http-echo
docker build -t kubeclaw-test-http-echo:latest e2e/test-containers/http-echo/
```
