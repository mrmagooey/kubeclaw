# Echo Bot Example for File-Based Sidecar

This is a simple example demonstrating the KubeClaw file-based sidecar adapter. The echo-bot reads task files from `/workspace/input/` and echoes the prompt back as the result.

## How It Works

1. The file adapter sidecar writes task JSON to `/workspace/input/task.json`
2. The echo-bot (running via runner-wrapper.sh) reads the task
3. The echo-bot writes the result to `/workspace/output/result.json`
4. The file adapter sidecar reads the result and outputs it with KubeClaw markers

## Running Locally

Build the echo-bot:

```bash
docker build -t kubeclaw-echo-bot:latest .
```

Test with the file adapter:

```bash
# Terminal 1: Run the echo-bot
docker run -v /tmp/workspace:/workspace kubeclaw-echo-bot:latest

# Terminal 2: Write a task and check the result
echo '{"prompt":"Hello World","groupFolder":"test","chatJid":"test@g.us","isMain":false}' > /tmp/workspace/input/task.json
# Wait a moment...
cat /tmp/workspace/output/result.json
```

## Running in Kubernetes

The echo-bot is designed to run alongside the `kubeclaw-file-adapter` sidecar in a Kubernetes Job. See the main README for how to configure file-based sidecar mode.

## Configuration

The echo-bot uses the following environment variables:

- `KUBECLAW_INPUT_DIR`: Input directory (default: `/workspace/input`)
- `KUBECLAW_OUTPUT_DIR`: Output directory (default: `/workspace/output`)
- `KUBECLAW_POLL_INTERVAL`: Poll interval in seconds (default: `1`)
