#!/usr/bin/env bash
set -euo pipefail
TAG="${1:-kubeclaw-mcp-bundle:latest}"
cd "$(dirname "$0")"
docker build -t "$TAG" .
