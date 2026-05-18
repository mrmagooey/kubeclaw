FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY index.js ./
COPY filesystem ./filesystem
EXPOSE 3000
CMD ["node", "index.js"]
