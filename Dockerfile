# Works on amd64 and arm64 (Raspberry Pi 4).
#
# atomix.vg is behind a Cloudflare challenge that blocks headless browsers, so
# Chromium runs headful inside a virtual display (Xvfb, see docker-entrypoint.sh).
# Puppeteer doesn't ship Chrome for Linux ARM, so Debian's chromium package is used.
FROM node:24-bookworm-slim AS build

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@9.11.0 && pnpm install --frozen-lockfile

COPY . .
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

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=true \
    CHROME_DISABLE_GPU=true \
    DISPLAY=:99

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@9.11.0 && pnpm install --frozen-lockfile --prod && pnpm store prune

COPY --from=build /app/dist ./dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
