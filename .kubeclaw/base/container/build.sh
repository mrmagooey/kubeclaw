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

while [[ $# -gt 0 ]]; do
  case $1 in
    --claude-only)
      BUILD_CLAUDE=true
      BUILD_OPENROUTER=false
      shift
      ;;
    --openrouter-only)
      BUILD_CLAUDE=false
      BUILD_OPENROUTER=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--claude-only|--openrouter-only]"
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

echo "================================"
echo "Build complete!"

if [ "$BUILD_CLAUDE" = true ]; then
  echo "  Claude image: nanoclaw-agent:claude"
fi
if [ "$BUILD_OPENROUTER" = true ] && [ -f "Dockerfile.openrouter" ]; then
  echo "  OpenRouter image: nanoclaw-agent:openrouter"
fi

echo ""
echo "Test Claude agent with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i nanoclaw-agent:claude"
