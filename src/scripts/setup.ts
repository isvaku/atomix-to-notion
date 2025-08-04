#!/usr/bin/env tsx

import { database } from "../database";
import { logger } from "../utils";
import { config } from "../config";

async function setup() {
  try {
    logger.info("Starting Gaming News Crawler setup...");

    // Test database connection
    logger.info("Testing MongoDB connection...");
    await database.connect();
    logger.info("✅ MongoDB connection successful");

    // Check environment variables
    logger.info("Checking configuration...");

    if (
      !config.notion.token ||
      config.notion.token === "your_notion_integration_token_here"
    ) {
      logger.warn(
        "⚠️  NOTION_TOKEN not configured - Notion sync will be disabled"
      );
    } else {
      logger.info("✅ Notion token configured");
    }

    if (
      !config.notion.databaseId ||
      config.notion.databaseId === "your_notion_database_id_here"
    ) {
      logger.warn(
        "⚠️  NOTION_DATABASE_ID not configured - Notion sync will be disabled"
      );
    } else {
      logger.info("✅ Notion database ID configured");
    }

    logger.info("✅ Setup completed successfully!");
    logger.info("");
    logger.info("Next steps:");
    logger.info("1. Configure your .env file with Notion credentials");
    logger.info("2. Run: pnpm dev (to start with auto-reload)");
    logger.info("3. Or run: pnpm build && pnpm start (for production)");
    logger.info("4. Or run: pnpm crawler (to run crawler once)");

    await database.disconnect();
    process.exit(0);
  } catch (error) {
    logger.error("Setup failed:", error);
    logger.info("");
    logger.info("Troubleshooting:");
    logger.info("1. Make sure MongoDB is running");
    logger.info("2. Check your MONGODB_URI in .env file");
    logger.info("3. Ensure you copied .env.example to .env");

    process.exit(1);
  }
}

setup();
