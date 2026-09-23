# Works on amd64 and arm64 (Raspberry Pi 4).
#
# atomix.vg is behind a Cloudflare challenge that blocks headless browsers, so
# Chromium runs headful inside a virtual display (Xvfb, see docker-entrypoint.sh).
# Puppeteer doesn't ship Chrome for Linux ARM, so Debian's chromium package is used.
FROM node:24-bookworm-slim AS build

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Production image
FROM node:24-bookworm-slim AS production

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    fonts-liberation \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=true \
    CHROME_DISABLE_GPU=true \
    DISPLAY=:99 \
    PORT=3000 \
    # Everything scratch lives in /tmp, which is a tmpfs: no writes to the SD card
    LOG_TO_FILE=false \
    HOME=/tmp \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod && pnpm store prune

COPY --from=build /app/dist ./dist
COPY public ./public
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000

# Checked rarely: Docker writes the container state on every health check
HEALTHCHECK --interval=5m --timeout=15s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
