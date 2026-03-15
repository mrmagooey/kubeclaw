FROM node:22-slim

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY app.js .

EXPOSE 8080

CMD ["node", "app.js"]
