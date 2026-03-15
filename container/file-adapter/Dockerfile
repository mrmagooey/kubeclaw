# NanoClaw File Adapter Container
# Sidecar adapter for file-based IPC with arbitrary containers

FROM node:20-alpine

WORKDIR /app

# Install TypeScript and build tools
RUN npm install -g typescript tsx

# Copy package files
COPY package.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/input /workspace/output

# Entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
