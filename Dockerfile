FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY show-server ./show-server

RUN node scripts/ensure-yt-dlp.mjs

ENV SHOW_WS_PORT=8080
EXPOSE 8080

CMD ["node", "show-server/server.mjs"]
