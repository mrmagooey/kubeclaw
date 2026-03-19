# NanoClaw Orchestrator Container
# Main application that manages channels and schedules agent jobs

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies (sql.js is pure JS, no native build needed)
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Create runtime directories (groups and store are overridden by PVCs in K8s;
# these exist so the orchestrator works when run locally without volume mounts)
RUN mkdir -p /app/groups /app/store && \
    chown -R 1000:1000 /app/groups /app/store

# Set environment variables
ENV NANOCLAW_RUNTIME=kubernetes
ENV REDIS_URL=redis://nanoclaw-redis:6379
ENV NANOCLAW_NAMESPACE=nanoclaw

# Expose port (if needed for health checks)
EXPOSE 8080

# Run the orchestrator
CMD ["node", "dist/index.js"]
