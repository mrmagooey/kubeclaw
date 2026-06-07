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

# Install agent-browser globally
RUN npm install -g agent-browser

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

# Create workspace directories (agent-runner mode + bootstrap/channel mode)
# /workspace/group     — agent-runner group workspace
# /workspace/skills    — bootstrap skill markdown (from ConfigMap, set by bootstrap Job)
# /workspace/manifests — channel manifests (from ConfigMap, set by bootstrap Job)
# /runtime             — per-channel runtime PVC mount point (bootstrap writes, steady-state reads)
RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
    /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input \
    /workspace/skills /workspace/manifests /runtime

# Create entrypoint script
# Three modes (selected at startup, no separate image needed):
#
# 1. Bootstrap mode    — KUBECLAW_BOOTSTRAP_SKILL set
#                        Runs channel-loader.js bootstrap branch: skill-driven agent loop
#                        with local_bash + commit_channel_config tools. Installs npm deps
#                        onto /runtime PVC and writes channel-entry.js.
#
# 2. Steady-state mode — /runtime/channel-entry.js exists (post-bootstrap)
#                        Runs channel-loader.js steady-state branch: imports the
#                        channel-entry from the read-only PVC mount and hands off.
#
# 3. Agent-runner mode — neither of the above
#                        Existing pi-agent-core agent loop for execute_agent tool jobs
#                        and per-group agent runs. Reads ContainerInput JSON from
#                        stdin (Docker) or env vars (K8s).
RUN cat > /app/entrypoint.sh <<'ENTRYPOINT'
#!/bin/bash
set -e

# Mode 1: bootstrap (skill set via env) → agent-runner short-circuits on the
# same env var and runs the skill-loaded agent loop with superuser tools.
# No stdin input is needed; main() detects bootstrap mode before reading.
if [ -n "$KUBECLAW_BOOTSTRAP_SKILL" ]; then
  exec node /app/dist/index.js
fi

# Mode 2: steady-state channel (PVC contains channel-entry.js) → channel-loader
# imports the entry file as a normal ES module and hands control to it.
if [ -f "/runtime/channel-entry.js" ]; then
  exec node /app/channel-loader.js
fi

# Mode 3: default agent-runner
if [ -n "$KUBECLAW_PROMPT" ]; then
  # Kubernetes mode: build ContainerInput JSON from env vars
  node -e "
process.stdout.write(JSON.stringify({
  prompt: process.env.KUBECLAW_PROMPT,
  groupFolder: process.env.KUBECLAW_GROUP_FOLDER || '',
  chatJid: process.env.KUBECLAW_CHAT_JID || '',
  sessionId: process.env.KUBECLAW_SESSION_ID || undefined,
  isMain: process.env.KUBECLAW_IS_MAIN === 'true',
  assistantName: process.env.KUBECLAW_ASSISTANT_NAME || 'Andy',
  isScheduledTask: process.env.KUBECLAW_IS_SCHEDULED === 'true',
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
RUN chown -R node:node /workspace /runtime && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
