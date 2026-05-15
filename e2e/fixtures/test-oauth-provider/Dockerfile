FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY src/ ./src/

# OIDC provider HTTP port
EXPOSE 8080

CMD ["node", "src/index.js"]
