FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json server.ts ./
RUN npx tsc --outDir /app/dist

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/server.js ./server.js
EXPOSE 3000
CMD ["node", "server.js"]
