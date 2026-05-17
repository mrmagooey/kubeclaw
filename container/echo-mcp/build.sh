#!/usr/bin/env bash
set -euo pipefail
TAG="${1:-kubeclaw-echo-mcp:latest}"
cd "$(dirname "$0")"
docker build -t "$TAG" .
