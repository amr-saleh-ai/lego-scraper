FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/lego.db

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/index.js"]
