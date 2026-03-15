FROM node:20-alpine

# Install jq for JSON processing in wrapper scripts
RUN apk add --no-cache jq bash

WORKDIR /app

# Copy package files
COPY package.json tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Remove dev dependencies for production
RUN npm prune --production

# Copy entrypoint and wrapper scripts
COPY entrypoint.sh runner-wrapper.sh ./
RUN chmod +x entrypoint.sh runner-wrapper.sh

# Create workspace directories
RUN mkdir -p /workspace/input /workspace/output && \
    chown -R node:node /workspace

# Switch to non-root user
USER node

# Expose workspace volume
VOLUME ["/workspace/input", "/workspace/output"]

ENTRYPOINT ["./entrypoint.sh"]
