# KubeClaw channel-base — slim image for bootstrap Jobs and steady-state channel pods.
#
# INTENTIONALLY does NOT contain channel-specific npm packages:
#   no telegraf, no irc-upd, no openid-client, no discord.js, no @slack/*
#
# Channel-specific packages are installed at bootstrap time by npm ci into the
# per-channel runtime PVC. The steady-state pod mounts the PVC read-only.
#
# AC1 verification: docker run --rm kubeclaw-channel-base:<tag> npm ls --depth=0 --json
# should NOT list telegraf, irc-upd, openid-client, discord.js, @slack/* in deps.

FROM node:22-slim

# curl is needed during bootstrap for credential validation (e.g. Telegram getMe)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only IPC/agent-runner core deps. No channel-specific packages.
COPY container/channel-base/package.json container/channel-base/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Channel-loader entrypoint (plain JS — no TypeScript compilation needed)
COPY container/channel-base/channel-loader.js ./channel-loader.js

# Runtime directory (bootstrap writes here; steady-state reads it)
# /workspace/skills   — bootstrap skill markdown (from ConfigMap)
# /workspace/manifests — channel manifests (from ConfigMap)
# /runtime             — per-channel runtime PVC mount point
RUN mkdir -p /runtime /workspace/skills /workspace/manifests /workspace/group

RUN chown -R node:node /runtime /workspace /app && chmod 777 /home/node

USER node

WORKDIR /workspace

# KUBECLAW_BOOTSTRAP_SKILL set → bootstrap mode (agent loop)
# KUBECLAW_BOOTSTRAP_SKILL unset → steady-state mode (load /runtime/channel-entry.js)
ENTRYPOINT ["node", "/app/channel-loader.js"]
