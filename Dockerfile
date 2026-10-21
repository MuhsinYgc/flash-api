FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Standalone yt-dlp binary is installed in ensure-yt-dlp.mjs; skip Python preinstall check.
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1
# postinstall needs scripts/ — run ensure-yt-dlp after COPY below instead.
RUN npm ci --omit=dev --ignore-scripts

COPY scripts ./scripts
COPY show-server ./show-server

RUN node scripts/ensure-yt-dlp.mjs

ENV SHOW_WS_PORT=8080
EXPOSE 8080

CMD ["node", "show-server/server.mjs"]
