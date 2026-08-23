FROM node:24.19.0-alpine3.24

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY email.mjs relay.mjs server.mjs ./

USER node
CMD ["node", "server.mjs"]
