#!/usr/bin/env tsx

// Checks that everything the app needs is reachable and configured.
import { database } from "../database";
import { connectRedis, isRedisHealthy, redis } from "../queue/connection";
import { logger, NotionClient } from "../utils";
import { isTelegramConfigured } from "../utils/telegram";
import { config } from "../config";

async function setup() {
  try {
    logger.info("Checking Atomix to Notion setup...");

    logger.info("Testing MongoDB connection...");
    await database.connect();
    logger.info("✅ MongoDB connection successful");

    logger.info("Testing Redis connection...");
    await connectRedis();
    if (!(await isRedisHealthy())) {
      throw new Error("Redis did not respond to PING");
    }
    logger.info("✅ Redis connection successful");

    const notion = new NotionClient();
    if (!notion.isConfigured()) {
      logger.warn("⚠️  NOTION_TOKEN / NOTION_DATABASE_ID not set - Notion sync is disabled");
    } else if (await notion.testConnection()) {
      logger.info("✅ Notion database reachable");
    } else {
      logger.warn("⚠️  Notion is configured but the database could not be read");
    }

    if (!config.server.apiKey) {
      logger.warn("⚠️  API_KEY not set - required in production (openssl rand -hex 32)");
    } else {
      logger.info("✅ API key configured");
    }

    if (!isTelegramConfigured()) {
      logger.warn("⚠️  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set - no daily report");
    } else {
      logger.info("✅ Telegram configured (test it with: pnpm report)");
    }

    logger.info("");
    logger.info("Next steps:");
    logger.info("1. pnpm dev              (start the app, dashboard on http://localhost:3000)");
    logger.info("2. pnpm crawler          (crawl once and exit)");
    logger.info("3. docker compose up -d  (run it for real)");
  } catch (error) {
    logger.error("Setup check failed:", error);
    logger.info("");
    logger.info("Troubleshooting:");
    logger.info("1. Are MongoDB and Redis running? (docker compose up -d redis)");
    logger.info("2. Check MONGODB_URI and REDIS_URL in .env");
    logger.info("3. Copy .env.example to .env if you haven't");
    process.exitCode = 1;
  } finally {
    await redis.quit().catch(() => undefined);
    await database.disconnect().catch(() => undefined);
  }
}

void setup();
