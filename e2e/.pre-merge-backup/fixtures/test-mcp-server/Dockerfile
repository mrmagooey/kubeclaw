FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/index.js"]
