#!/bin/bash
# Build the NanoClaw agent container images
# Supports both Claude and OpenRouter LLM providers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Parse command line arguments
BUILD_CLAUDE=true
BUILD_OPENROUTER=true
BUILD_FILE_ADAPTER=false
BUILD_HTTP_ADAPTER=false

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
    --all)
      BUILD_CLAUDE=true
      BUILD_OPENROUTER=true
      BUILD_FILE_ADAPTER=true
      BUILD_HTTP_ADAPTER=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--claude-only|--openrouter-only|--file-adapter|--http-adapter|--all]"
      exit 1
      ;;
  esac
done

echo "Building NanoClaw agent container images..."
echo "Container runtime: ${CONTAINER_RUNTIME}"
echo ""

# Build Claude agent
if [ "$BUILD_CLAUDE" = true ]; then
  echo "Building Claude agent..."
  echo "Image: nanoclaw-agent:claude"
  ${CONTAINER_RUNTIME} build -f Dockerfile -t nanoclaw-agent:claude .
  echo "Claude agent build complete!"
  echo ""
fi

# Build OpenRouter agent
if [ "$BUILD_OPENROUTER" = true ]; then
  echo "Building OpenRouter agent..."
  echo "Image: nanoclaw-agent:openrouter"
  if [ -f "Dockerfile.openrouter" ]; then
    ${CONTAINER_RUNTIME} build -f Dockerfile.openrouter -t nanoclaw-agent:openrouter .
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
  echo "Image: nanoclaw-file-adapter:latest"
  if [ -d "file-adapter" ]; then
    ${CONTAINER_RUNTIME} build -f file-adapter/Dockerfile -t nanoclaw-file-adapter:latest file-adapter
    echo "File adapter build complete!"
  else
    echo "WARNING: file-adapter directory not found, skipping file adapter build"
  fi
  echo ""
fi

# Build HTTP Adapter
if [ "$BUILD_HTTP_ADAPTER" = true ]; then
  echo "Building HTTP Adapter..."
  echo "Image: nanoclaw-http-adapter:latest"
  if [ -d "http-adapter" ]; then
    ${CONTAINER_RUNTIME} build -f http-adapter/Dockerfile -t nanoclaw-http-adapter:latest http-adapter
    echo "HTTP adapter build complete!"
  else
    echo "WARNING: http-adapter directory not found, skipping HTTP adapter build"
  fi
  echo ""
fi

echo "================================"
echo "Build complete!"

if [ "$BUILD_CLAUDE" = true ]; then
  echo "  Claude image: nanoclaw-agent:claude"
fi
if [ "$BUILD_OPENROUTER" = true ] && [ -f "Dockerfile.openrouter" ]; then
  echo "  OpenRouter image: nanoclaw-agent:openrouter"
fi
if [ "$BUILD_FILE_ADAPTER" = true ] && [ -d "file-adapter" ]; then
  echo "  File adapter image: nanoclaw-file-adapter:latest"
fi
if [ "$BUILD_HTTP_ADAPTER" = true ] && [ -d "http-adapter" ]; then
  echo "  HTTP adapter image: nanoclaw-http-adapter:latest"
fi

echo ""
echo "Test Claude agent with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i nanoclaw-agent:claude"
