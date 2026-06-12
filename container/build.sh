#!/bin/bash
# Build KubeClaw container images (four-tier architecture)
# All LLM providers share the single canonical kubeclaw-agent:latest image.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Parse command line arguments
BUILD_AGENT=true
BUILD_BROWSER=false
BUILD_ORCHESTRATOR=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --browser)
      BUILD_BROWSER=true
      shift
      ;;
    --orchestrator)
      BUILD_ORCHESTRATOR=true
      shift
      ;;
    --all)
      BUILD_AGENT=true
      BUILD_BROWSER=true
      BUILD_ORCHESTRATOR=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--browser|--orchestrator|--all]"
      exit 1
      ;;
  esac
done

echo "Building KubeClaw container images..."
echo "Container runtime: ${CONTAINER_RUNTIME}"
echo ""

# Build agent image (multi-provider: claude, openrouter, openai, ollama, ...)
if [ "$BUILD_AGENT" = true ]; then
  echo "Building agent image..."
  echo "Image: kubeclaw-agent:latest"
  ${CONTAINER_RUNTIME} build --network=host -f container/Dockerfile -t kubeclaw-agent:latest .
  echo "Agent build complete!"
  echo ""
fi

# Build Browser Sidecar
if [ "$BUILD_BROWSER" = true ]; then
  echo "Building Browser Sidecar..."
  echo "Image: kubeclaw-browser-sidecar:latest"
  if [ -d "container/browser" ]; then
    ${CONTAINER_RUNTIME} build --network=host -f container/browser/Dockerfile -t kubeclaw-browser-sidecar:latest container/browser
    echo "Browser sidecar build complete!"
  else
    echo "WARNING: browser directory not found, skipping browser sidecar build"
  fi
  echo ""
fi

# Build Orchestrator
if [ "$BUILD_ORCHESTRATOR" = true ]; then
  echo "Building Orchestrator..."
  echo "Image: kubeclaw-orchestrator:latest"
  ${CONTAINER_RUNTIME} build --network=host -f Dockerfile -t kubeclaw-orchestrator:latest .
  echo "Orchestrator build complete!"
  echo ""
fi

# Channel-base image removed: bootstrap + steady-state channel modes are now
# served by the kubeclaw-agent image (built above) via channel-loader.js, which
# branches on KUBECLAW_BOOTSTRAP_SKILL / presence of /runtime/channel-entry.js.
# The skill customises the generic agent container in the cluster — no
# per-channel image is needed.

echo "================================"
echo "Build complete!"

if [ "$BUILD_AGENT" = true ]; then
  echo "  Agent image: kubeclaw-agent:latest"
fi
if [ "$BUILD_BROWSER" = true ] && [ -d "container/browser" ]; then
  echo "  Browser sidecar image: kubeclaw-browser-sidecar:latest"
fi
if [ "$BUILD_ORCHESTRATOR" = true ]; then
  echo "  Orchestrator image: kubeclaw-orchestrator:latest"
fi

echo ""
echo "Test agent with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i kubeclaw-agent:latest"
