import { database } from "./database";
import { crawlerJob, notionSyncJob } from "./jobs";
import { logger } from "./utils";
import { config } from "./config";

class Application {
  private isShuttingDown: boolean = false;

  public async start(): Promise<void> {
    try {
      logger.info("Starting Gaming News Crawler application...");

      // Connect to database
      await database.connect();

      // Validate configuration
      this.validateConfig();

      // Start the cron jobs
      crawlerJob.start();
      notionSyncJob.start();

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      logger.info("Gaming News Crawler application started successfully");
      logger.info(`Crawler schedule: ${config.crawler.interval}`);
      logger.info(`Notion sync schedule: ${config.notionSync.interval}`);

      // Keep the process alive
      process.stdin.resume();
    } catch (error) {
      logger.error("Failed to start application:", error);
      process.exit(1);
    }
  }

  private validateConfig(): void {
    const errors: string[] = [];

    if (!config.database.uri) {
      errors.push("MONGODB_URI is required");
    }

    if (!config.notion.token) {
      logger.warn(
        "NOTION_TOKEN is not configured - Notion sync will be disabled"
      );
    }

    if (!config.notion.databaseId) {
      logger.warn(
        "NOTION_DATABASE_ID is not configured - Notion sync will be disabled"
      );
    }

    if (config.sources.length === 0) {
      errors.push("No news sources configured");
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(", ")}`);
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        logger.warn("Force shutdown requested");
        process.exit(1);
      }

      this.isShuttingDown = true;
      logger.info(`Received ${signal}, starting graceful shutdown...`);

      try {
        // Stop cron jobs
        crawlerJob.stop();
        notionSyncJob.stop();

        // Wait for running jobs to complete (with timeout)
        const shutdownTimeout = setTimeout(() => {
          logger.error("Shutdown timeout reached, forcing exit");
          process.exit(1);
        }, 30000);

        // Wait for jobs to finish
        while (crawlerJob.isJobRunning() || notionSyncJob.isJobRunning()) {
          logger.info("Waiting for jobs to complete...");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        clearTimeout(shutdownTimeout);

        // Disconnect from database
        await database.disconnect();

        logger.info("Graceful shutdown completed");
        process.exit(0);
      } catch (error) {
        logger.error("Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGHUP", () => shutdown("SIGHUP"));
  }

  public async runCrawlerOnce(): Promise<void> {
    try {
      logger.info("Running crawler once...");
      await database.connect();
      await crawlerJob.runOnce();
    } catch (error) {
      logger.error("Failed to run crawler once:", error);
      throw error;
    }
  }

  public async runNotionSyncOnce(): Promise<void> {
    try {
      logger.info("Running Notion sync once...");
      await database.connect();
      await notionSyncJob.runOnce();
    } catch (error) {
      logger.error("Failed to run Notion sync once:", error);
      throw error;
    }
  }
}

const app = new Application();

// Handle command line arguments
const args = process.argv.slice(2);

if (args.includes("--crawler-once")) {
  app
    .runCrawlerOnce()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else if (args.includes("--notion-sync-once")) {
  app
    .runNotionSyncOnce()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else {
  // Start the full application
  app.start();
}

export default app;
