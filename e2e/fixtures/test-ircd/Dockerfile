FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY src/ ./src/

# IRC port
EXPOSE 6667
# HTTP side-channel (inject / log)
EXPOSE 8080

CMD ["node", "src/index.js"]
