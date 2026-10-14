FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev \
  && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/bot.sqlite
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/index.js"]
