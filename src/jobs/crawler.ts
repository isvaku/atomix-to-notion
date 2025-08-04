import { CronJob } from "cron";
import { database } from "../database";
import { EntryModel } from "../models";
import { WebScraper, logger } from "../utils";
import { config } from "../config";

export class CrawlerJob {
  private job: CronJob | null = null;
  private scraper: WebScraper;
  private isRunning: boolean = false;

  constructor() {
    this.scraper = new WebScraper();
  }

  public start(): void {
    if (this.job) {
      logger.warn("Crawler job is already started");
      return;
    }

    this.job = new CronJob(
      config.crawler.interval,
      () => this.runCrawler(),
      null,
      true,
      "America/New_York"
    );

    logger.info(
      `Crawler job started with schedule: ${config.crawler.interval}`
    );
  }

  public stop(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
      logger.info("Crawler job stopped");
    }
  }

  public async runOnce(): Promise<void> {
    await this.runCrawler();
  }

  private async runCrawler(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Crawler is already running, skipping this iteration");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info("Starting crawler run...");

      // Ensure database connection
      if (!database.isConnectedToDb()) {
        await database.connect();
      }

      let totalProcessed = 0;
      let totalSaved = 0;

      // Process each source
      for (const source of config.sources) {
        try {
          logger.info(`Processing source: ${source.name}`);

          // Get article links
          const articleLinks = await this.scraper.getArticleLinks(
            source.url,
            source.listingPath,
            source.selectors.articleLinks,
            source.nextPageSelector,
            source.nextPageLoadsInSamePage
          );

          logger.info(`Found ${articleLinks.length} links for ${source.name}`);

          // Process each article
          for (const link of articleLinks) {
            try {
              totalProcessed++;

              // Scrape article content
              const articleData = await this.scraper.scrapeArticle(
                link,
                source
              );
              if (!articleData) {
                logger.warn(`Failed to scrape article: ${link}`);
                continue;
              }

              // Check if article already exists
              const { entryId } = articleData;
              const existingEntry = await EntryModel.findOne({ entryId });

              if (existingEntry) {
                logger.debug(`Article already exists: ${link}`);
                continue;
              }

              // Create and save entry
              const newEntry = new EntryModel({
                entryId,
                title: articleData.title,
                author: articleData.author,
                summary: articleData.summary,
                content: articleData.content,
                link: articleData.link,
                created: false,
                entryErrors: [],
                entryDate: articleData.date,
              });

              await newEntry.save();
              totalSaved++;

              logger.info(`Saved new article: ${articleData.title}`);

              // Add a small delay to avoid overwhelming the servers
              await new Promise((resolve) => setTimeout(resolve, 1000));
            } catch (error) {
              logger.error(`Error processing article ${link}:`, error);
            }
          }
        } catch (error) {
          logger.error(`Error processing source ${source.name}:`, error);
        }
      }

      const duration = Date.now() - startTime;
      logger.info(
        `Crawler run completed. Processed: ${totalProcessed}, Saved: ${totalSaved}, Duration: ${duration}ms`
      );

      // Close the browser
      await this.scraper.close();
    } catch (error) {
      logger.error("Crawler run failed:", error);
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
export const crawlerJob = new CrawlerJob();
