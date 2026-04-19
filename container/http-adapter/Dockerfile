# NanoClaw HTTP Adapter Container
# Sidecar adapter for HTTP-based communication with tool containers

FROM node:22-alpine

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

# Entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
