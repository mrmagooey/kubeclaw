# NanoClaw File Echo Test Container
# Simple container that reads from /workspace/input/task.json and writes to /workspace/output/result.json

FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Copy source
COPY src ./src

# Create workspace directories
RUN mkdir -p /workspace/input /workspace/output

# Run the echo service
CMD ["node", "src/index.js"]