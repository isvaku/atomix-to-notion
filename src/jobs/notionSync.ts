import { CronJob } from "cron";
import { database } from "../database";
import { EntryModel } from "../models";
import { NotionClient, logger } from "../utils";
import { config } from "../config";

export class NotionSyncJob {
  private job: CronJob | null = null;
  private notionClient: NotionClient;
  private isRunning: boolean = false;

  constructor() {
    this.notionClient = new NotionClient();
  }

  public start(): void {
    if (this.job) {
      logger.warn("Notion sync job is already started");
      return;
    }

    this.job = new CronJob(
      config.notionSync.interval,
      () => this.runSync(),
      null,
      true,
      "America/New_York"
    );

    logger.info(
      `Notion sync job started with schedule: ${config.notionSync.interval}`
    );
  }

  public stop(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
      logger.info("Notion sync job stopped");
    }
  }

  public async runOnce(): Promise<void> {
    await this.runSync();
  }

  private async runSync(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Notion sync is already running, skipping this iteration");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info("Starting Notion sync run...");

      // Ensure database connection
      if (!database.isConnectedToDb()) {
        await database.connect();
      }

      // Test Notion connection
      const isNotionConnected = await this.notionClient.testConnection();
      if (!isNotionConnected) {
        logger.error("Notion connection failed, skipping sync");
        return;
      }

      // Get entries that haven't been created in Notion yet
      const entriesToSync = await EntryModel.find({
        created: false,
      })
        .sort({ entryDate: -1 })
        .limit(config.notionSync.batchSize);

      logger.info(`Found ${entriesToSync.length} entries to sync to Notion`);

      let totalSynced = 0;
      let totalErrors = 0;

      // Process each entry
      for (const entry of entriesToSync) {
        try {
          logger.debug(`Syncing entry to Notion: ${entry.title}`);

          const success = await this.notionClient.createPage(entry);

          if (success) {
            // Mark as created
            entry.created = true;
            entry.entryErrors = [];
            await entry.save();
            totalSynced++;

            logger.info(`Successfully synced to Notion: ${entry.title}`);
          } else {
            // Add error and increment retry count
            const errorMsg = `Failed to create Notion page at ${new Date().toISOString()}`;
            entry.entryErrors = entry.entryErrors || [];
            entry.entryErrors.push(errorMsg);

            // If too many errors, mark as created to avoid infinite retries
            if (entry.entryErrors.length >= 5) {
              entry.created = true;
              logger.error(
                `Entry has too many errors, marking as created: ${entry.entryId}`
              );
            }

            await entry.save();
            totalErrors++;
          }

          // Add a small delay to respect Notion rate limits
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          logger.error(
            `Error syncing entry ${entry.entryId} to Notion:`,
            error
          );

          // Add error to entry
          const errorMsg = `Sync error: ${
            error instanceof Error ? error.message : "Unknown error"
          }`;
          entry.entryErrors = entry.entryErrors || [];
          entry.entryErrors.push(errorMsg);

          // If too many errors, mark as created to avoid infinite retries
          if (entry.entryErrors.length >= 5) {
            entry.created = true;
            logger.error(
              `Entry has too many errors, marking as created: ${entry.entryId}`
            );
          }

          await entry.save();
          totalErrors++;
        }
      }

      const duration = Date.now() - startTime;
      logger.info(
        `Notion sync completed. Synced: ${totalSynced}, Errors: ${totalErrors}, Duration: ${duration}ms`
      );
    } catch (error) {
      logger.error("Notion sync run failed:", error);
    } finally {
      this.isRunning = false;
    }
  }

  public isJobRunning(): boolean {
    return this.isRunning;
  }

  public getNextRun(): Date | null {
    return this.job ? this.job.nextDate().toJSDate() : null;
  }
}

// Export singleton instance
export const notionSyncJob = new NotionSyncJob();
