#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_NAME="kubeclaw-irc-mock"
IMAGE_TAG="${1:-latest}"

echo "=== Building IRC Mock Server Image ==="
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"

# Create a temporary build directory
BUILD_DIR=$(mktemp -d)
trap "rm -rf ${BUILD_DIR}" EXIT

echo "Creating build context in ${BUILD_DIR}..."

# Copy necessary files to build context
cp -r "${PROJECT_ROOT}/e2e" "${BUILD_DIR}/"
cp -r "${PROJECT_ROOT}/scripts" "${BUILD_DIR}/"
cp "${PROJECT_ROOT}/package.json" "${BUILD_DIR}/"
cp "${PROJECT_ROOT}/package-lock.json" "${BUILD_DIR}/" 2>/dev/null || true
cp "${PROJECT_ROOT}/tsconfig.json" "${BUILD_DIR}/"

# Remove "type": "module" from package.json for CommonJS build
sed -i 's/"type": "module",//' "${BUILD_DIR}/package.json"

# Create the Dockerfile
cat > "${BUILD_DIR}/Dockerfile" << 'DOCKERFILE'
FROM node:20-alpine

WORKDIR /app

# Install TypeScript globally for compilation
RUN npm install -g typescript

# Install dependencies (skip prepare script to avoid husky issue)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy source files
COPY tsconfig.json ./
COPY e2e/ ./e2e/
COPY scripts/irc-mock-server.ts ./scripts/

# Build the standalone server (output as .cjs to avoid ES module issues)
RUN tsc scripts/irc-mock-server.ts --outDir dist --esModuleInterop --target ES2020 --module commonjs --moduleResolution node --skipLibCheck && \
    mv dist/scripts/irc-mock-server.js dist/scripts/irc-mock-server.cjs

# Expose the IRC port
EXPOSE 16667

# Run the mock server
CMD ["node", "dist/scripts/irc-mock-server.cjs"]
DOCKERFILE

echo "Building Docker image..."
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" "${BUILD_DIR}"

echo "=== Build Complete ==="
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
