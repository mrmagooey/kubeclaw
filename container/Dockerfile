# KubeClaw Base Container (Claude variant)
# Shared image for orchestrator and channel pods in the four-tier architecture
# (Orchestrator / Channel / Capability / Tool Job). The orchestrator runs
# dist/index.js; channel pods run dist/channel-runner.js via KUBECLAW_MODE=channel.

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY container/agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY container/agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Docker mode: task JSON is piped to stdin (cat > /tmp/input.json)
# K8s mode:   task is passed as env vars (NANOCLAW_PROMPT etc.) — build JSON from them
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN cat > /app/entrypoint.sh <<'ENTRYPOINT'
#!/bin/bash
set -e
if [ -n "$NANOCLAW_PROMPT" ]; then
  # Kubernetes mode: build ContainerInput JSON from env vars
  node -e "
process.stdout.write(JSON.stringify({
  prompt: process.env.NANOCLAW_PROMPT,
  groupFolder: process.env.NANOCLAW_GROUP_FOLDER || '',
  chatJid: process.env.NANOCLAW_CHAT_JID || '',
  sessionId: process.env.NANOCLAW_SESSION_ID || undefined,
  isMain: process.env.NANOCLAW_IS_MAIN === 'true',
  assistantName: process.env.NANOCLAW_ASSISTANT_NAME || 'Andy',
  isScheduledTask: process.env.NANOCLAW_IS_SCHEDULED === 'true',
}));
" > /tmp/input.json
else
  # Docker mode: read JSON from stdin
  cat > /tmp/input.json
fi
node /app/dist/index.js < /tmp/input.json
ENTRYPOINT
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
