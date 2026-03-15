#!/bin/bash
# Entrypoint for nanoclaw-sidecar-adapter
# Handles initialization and runs the main adapter

set -e

echo "[sidecar] Initializing sidecar adapter..."

# Create workspace directories
mkdir -p /workspace/input
mkdir -p /workspace/output

# Set proper permissions
chown -R node:node /workspace 2>/dev/null || true

echo "[sidecar] Workspace directories created:"
echo "  Input:  /workspace/input"
echo "  Output: /workspace/output"

# Run the adapter
exec node dist/index.js
