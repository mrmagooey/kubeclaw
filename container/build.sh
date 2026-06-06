#!/bin/bash
# Build KubeClaw container images (four-tier architecture)
# Supports both Claude and OpenRouter LLM providers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Parse command line arguments
BUILD_CLAUDE=true
BUILD_OPENROUTER=true
BUILD_FILE_ADAPTER=false
BUILD_HTTP_ADAPTER=false
BUILD_BROWSER=false
BUILD_ORCHESTRATOR=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --claude-only)
      BUILD_CLAUDE=true
      BUILD_OPENROUTER=false
      BUILD_FILE_ADAPTER=false
      shift
      ;;
    --openrouter-only)
      BUILD_CLAUDE=false
      BUILD_OPENROUTER=true
      BUILD_FILE_ADAPTER=false
      shift
      ;;
    --file-adapter)
      BUILD_FILE_ADAPTER=true
      shift
      ;;
    --http-adapter)
      BUILD_HTTP_ADAPTER=true
      shift
      ;;
    --browser)
      BUILD_BROWSER=true
      shift
      ;;
    --orchestrator)
      BUILD_ORCHESTRATOR=true
      shift
      ;;
    --all)
      BUILD_CLAUDE=true
      BUILD_OPENROUTER=true
      BUILD_FILE_ADAPTER=true
      BUILD_HTTP_ADAPTER=true
      BUILD_BROWSER=true
      BUILD_ORCHESTRATOR=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--claude-only|--openrouter-only|--file-adapter|--http-adapter|--browser|--orchestrator|--all]"
      exit 1
      ;;
  esac
done

echo "Building KubeClaw container images..."
echo "Container runtime: ${CONTAINER_RUNTIME}"
echo ""

# Build Claude agent
if [ "$BUILD_CLAUDE" = true ]; then
  echo "Building Claude agent..."
  echo "Image: kubeclaw-agent:claude"
  ${CONTAINER_RUNTIME} build --network=host -f container/Dockerfile -t kubeclaw-agent:claude .
  echo "Claude agent build complete!"
  echo ""
fi

# Build OpenRouter agent
if [ "$BUILD_OPENROUTER" = true ]; then
  echo "Building OpenRouter agent..."
  echo "Image: kubeclaw-agent:openrouter"
  if [ -f "container/Dockerfile.openrouter" ]; then
    ${CONTAINER_RUNTIME} build --network=host -f container/Dockerfile.openrouter -t kubeclaw-agent:openrouter .
    echo "OpenRouter agent build complete!"
  else
    echo "WARNING: Dockerfile.openrouter not found, skipping OpenRouter build"
    echo "Make sure Phase 1 (OpenRouter agent runner) has been set up"
  fi
  echo ""
fi

# Build File Adapter
if [ "$BUILD_FILE_ADAPTER" = true ]; then
  echo "Building File Adapter..."
  echo "Image: kubeclaw-file-adapter:latest"
  if [ -d "container/file-adapter" ]; then
    ${CONTAINER_RUNTIME} build --network=host -f container/file-adapter/Dockerfile -t kubeclaw-file-adapter:latest container/file-adapter
    echo "File adapter build complete!"
  else
    echo "WARNING: file-adapter directory not found, skipping file adapter build"
  fi
  echo ""
fi

# Build HTTP Adapter
if [ "$BUILD_HTTP_ADAPTER" = true ]; then
  echo "Building HTTP Adapter..."
  echo "Image: kubeclaw-http-adapter:latest"
  if [ -d "container/http-adapter" ]; then
    ${CONTAINER_RUNTIME} build --network=host -f container/http-adapter/Dockerfile -t kubeclaw-http-adapter:latest container/http-adapter
    echo "HTTP adapter build complete!"
  else
    echo "WARNING: http-adapter directory not found, skipping HTTP adapter build"
  fi
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

if [ "$BUILD_CLAUDE" = true ]; then
  echo "  Claude image: kubeclaw-agent:claude"
fi
if [ "$BUILD_OPENROUTER" = true ] && [ -f "container/Dockerfile.openrouter" ]; then
  echo "  OpenRouter image: kubeclaw-agent:openrouter"
fi
if [ "$BUILD_FILE_ADAPTER" = true ] && [ -d "container/file-adapter" ]; then
  echo "  File adapter image: kubeclaw-file-adapter:latest"
fi
if [ "$BUILD_HTTP_ADAPTER" = true ] && [ -d "container/http-adapter" ]; then
  echo "  HTTP adapter image: kubeclaw-http-adapter:latest"
fi
if [ "$BUILD_BROWSER" = true ] && [ -d "container/browser" ]; then
  echo "  Browser sidecar image: kubeclaw-browser-sidecar:latest"
fi
if [ "$BUILD_ORCHESTRATOR" = true ]; then
  echo "  Orchestrator image: kubeclaw-orchestrator:latest"
fi

echo ""
echo "Test Claude agent with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i kubeclaw-agent:claude"
