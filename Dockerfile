# Use an ARM-compatible Node.js image for Raspberry Pi
FROM --platform=linux/arm64 node:24-bullseye

# Set the working directory
WORKDIR /app

# Install necessary dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* || cat /var/log/apt/*

# Copy package.json and pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# Install pnpm globally with a specific version to match the lockfile
RUN npm install -g pnpm@9.11.0 && pnpm install --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Install Puppeteer browser with ARM-compatible Chromium
RUN npx puppeteer install --platform=linux/arm64 chromium

# Set the default command to run the application
CMD ["pnpm", "start"]
