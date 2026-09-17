import { Worker } from "bullmq";
import { FastifyInstance } from "fastify";
import { config } from "./config";
import { database } from "./database";
import { runMigrations } from "./database/migrations";
import { connectRedis, redis } from "./queue/connection";
import {
  closeQueues,
  crawlQueue,
  notionSyncQueue,
  registerSchedulers,
} from "./queue/queues";
import { buildServer } from "./server";
import { sendDailyReport } from "./services/report";
import { retryFailed } from "./services/retry";
import { logger, NotionClient, WebScraper } from "./utils";
import { isTelegramConfigured } from "./utils/telegram";
import { createCrawlWorker } from "./workers/crawlWorker";
import { createMaintenanceWorker, discover, sweepUnsynced } from "./workers/maintenanceWorker";
import { createNotionSyncWorker } from "./workers/notionSyncWorker";

const SHUTDOWN_TIMEOUT_MS = 60_000;

class Application {
  private scraper = new WebScraper();
  private notion = new NotionClient();
  private workers: Worker[] = [];
  private server: FastifyInstance | null = null;
  private isShuttingDown = false;

  public async start(): Promise<void> {
    try {
      logger.info("Starting Atomix to Notion...");
      this.validateConfig();

      await this.connect();
      await runMigrations();

      this.startWorkers({ crawl: true, notion: true, maintenance: true });
      await registerSchedulers();

      this.server = await buildServer({ workersRunning: () => this.workersRunning() });
      await this.server.listen({ host: config.server.host, port: config.server.port });
      logger.info(`Dashboard and API listening on port ${config.server.port}`);

      this.setupGracefulShutdown();
      logger.info("Atomix to Notion started successfully");
    } catch (error) {
      logger.error("Failed to start application:", error);
      await this.stop().catch(() => undefined);
      process.exit(1);
    }
  }

  private validateConfig(): void {
    const errors: string[] = [];

    if (!config.database.uri) {
      errors.push("MONGODB_URI is required");
    }
    if (config.env === "production" && !config.server.apiKey) {
      errors.push("API_KEY is required in production");
    }
    if (config.sources.length === 0) {
      errors.push("No news sources configured");
    }
    if (!this.notion.isConfigured()) {
      logger.warn("NOTION_TOKEN / NOTION_DATABASE_ID not set - Notion sync is disabled");
    }
    if (!isTelegramConfigured()) {
      logger.warn("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set - daily report won't be sent");
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(", ")}`);
    }
  }

  private async connect(): Promise<void> {
    await database.connect();
    await connectRedis();
  }

  private startWorkers(which: { crawl?: boolean; notion?: boolean; maintenance?: boolean }): void {
    if (which.crawl) {
      this.workers.push(createCrawlWorker(this.scraper));
    }
    if (which.notion && this.notion.isConfigured()) {
      this.workers.push(createNotionSyncWorker(this.notion));
    }
    if (which.maintenance) {
      this.workers.push(createMaintenanceWorker(this.scraper));
    }

    for (const worker of this.workers) {
      worker.on("error", (error) => logger.error(`Worker ${worker.name} error:`, error));
    }
  }

  private workersRunning(): boolean {
    return this.workers.length > 0 && this.workers.every((worker) => worker.isRunning());
  }

  /** Stops accepting work, lets active jobs finish, then closes all connections. */
  public async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
    }
    // close() waits for active jobs; an interrupted job is picked up again as stalled
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.scraper.close();
    await closeQueues();
    if (redis.status === "ready") {
      await redis.quit();
    }
    await database.disconnect();
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        logger.warn("Force shutdown requested");
        process.exit(1);
      }

      this.isShuttingDown = true;
      logger.info(`Received ${signal}, starting graceful shutdown...`);

      const timeout = setTimeout(() => {
        logger.error("Shutdown timeout reached, forcing exit");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      timeout.unref();

      try {
        await this.stop();
        logger.info("Graceful shutdown completed");
        process.exit(0);
      } catch (error) {
        logger.error("Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }

  /** Waits until a queue has no waiting, active or delayed jobs. */
  private async waitForQueue(queue: typeof crawlQueue | typeof notionSyncQueue): Promise<void> {
    for (;;) {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
      if (Object.values(counts).every((count) => count === 0)) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  /** CLI: discover new articles, crawl them and sync them to Notion, then exit. */
  public async runCrawlerOnce(): Promise<void> {
    await this.connect();
    this.startWorkers({ crawl: true, notion: true });
    try {
      await discover(this.scraper);
      await this.waitForQueue(crawlQueue);
      if (this.notion.isConfigured()) {
        await this.waitForQueue(notionSyncQueue);
      }
    } finally {
      await this.stop();
    }
  }

  /** CLI: queue every unsynced entry for Notion and wait until they're processed. */
  public async runNotionSyncOnce(): Promise<void> {
    await this.connect();
    this.startWorkers({ notion: true });
    try {
      if (!this.notion.isConfigured()) {
        throw new Error("NOTION_TOKEN / NOTION_DATABASE_ID are not set");
      }
      await sweepUnsynced();
      await this.waitForQueue(notionSyncQueue);
    } finally {
      await this.stop();
    }
  }

  /** CLI: send the daily report now, even if nothing failed. */
  public async sendReportOnce(): Promise<void> {
    await this.connect();
    try {
      const result = await sendDailyReport(true);
      if (!result.sent) {
        logger.warn(`Report not sent (${result.reason}). It would have been:\n${result.text}`);
      }
    } finally {
      await this.stop();
    }
  }

  /** CLI: queue failed crawls and Notion syncs again (a running app processes them). */
  public async retryFailedOnce(): Promise<void> {
    await this.connect();
    try {
      const result = await retryFailed();
      logger.info(`Queued again: ${result.crawls} crawls, ${result.syncs} Notion syncs`);
    } finally {
      await this.stop();
    }
  }
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
  process.exit(1);
});

const app = new Application();

const commands: Record<string, () => Promise<void>> = {
  "--crawler-once": () => app.runCrawlerOnce(),
  "--notion-sync-once": () => app.runNotionSyncOnce(),
  "--report-once": () => app.sendReportOnce(),
  "--retry-failed": () => app.retryFailedOnce(),
};

const command = process.argv.slice(2).find((arg) => arg in commands);

if (command) {
  commands[command]()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(`${command} failed:`, error);
      process.exit(1);
    });
} else {
  void app.start();
}

export default app;
