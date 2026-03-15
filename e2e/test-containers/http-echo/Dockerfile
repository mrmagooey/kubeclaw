# NanoClaw HTTP Echo Test Container
# Simple Express server that echoes back HTTP requests

FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source
COPY src ./src

# Expose default port
EXPOSE 8080

# Run the HTTP echo service
CMD ["node", "src/index.js"]