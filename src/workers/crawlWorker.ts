import { Job, UnrecoverableError, Worker } from "bullmq";
import { config } from "../config";
import { EntryModel } from "../models";
import { workerConnection } from "../queue/connection";
import { CrawlJobData, QUEUE_NAMES, enqueueNotionSync } from "../queue/queues";
import { WebScraper } from "../utils/scraper";
import { logger } from "../utils/logger";

export interface CrawlJobResult {
  entryId?: string;
  skipped?: "exists";
}

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

/** Scrapes one article, saves it and queues it for Notion. */
export async function processCrawlJob(
  job: Job<CrawlJobData>,
  scraper: Pick<WebScraper, "scrapeArticle">
): Promise<CrawlJobResult> {
  const { link, sourceName } = job.data;
  const source = config.sources.find((candidate) => candidate.name === sourceName);
  if (!source) {
    throw new UnrecoverableError(`Unknown source "${sourceName}"`);
  }

  const existing = await EntryModel.findOne({ link }).select({ _id: 1 }).lean();
  if (existing) {
    return { skipped: "exists", entryId: String(existing._id) };
  }

  const article = await scraper.scrapeArticle(link, source);
  if (!article || !article.content) {
    throw new Error("Could not scrape article content");
  }

  try {
    const entry = await EntryModel.create({
      entryId: article.entryId,
      title: article.title,
      author: article.author,
      summary: article.summary,
      content: article.content,
      link,
      created: false,
      entryErrors: [],
      entryDate: article.date,
    });

    await enqueueNotionSync(String(entry._id), link);
    logger.info(`Saved article: ${article.title}`);
    return { entryId: String(entry._id) };
  } catch (error) {
    // Same article under another URL, or saved concurrently
    if (isDuplicateKeyError(error)) {
      const duplicate = await EntryModel.findOne({
        $or: [{ link }, { entryId: article.entryId }],
      }).select({ _id: 1 }).lean();
      return { skipped: "exists", entryId: duplicate ? String(duplicate._id) : undefined };
    }
    throw error;
  }
}

export function createCrawlWorker(scraper: WebScraper): Worker<CrawlJobData, CrawlJobResult> {
  const worker = new Worker<CrawlJobData, CrawlJobResult>(
    QUEUE_NAMES.crawl,
    (job) => processCrawlJob(job, scraper),
    {
      connection: workerConnection,
      prefix: config.redis.prefix,
      // One Chromium: articles are scraped one at a time
      concurrency: 1,
      // Scraping on a Pi can be slow; don't treat it as stalled
      lockDuration: 5 * 60_000,
    }
  );

  worker.on("failed", (job, error) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const final = job.attemptsMade >= attempts;
    const message = `Crawl ${final ? "failed" : "attempt failed"} (${job.attemptsMade}/${attempts}) for ${job.data.link}: ${error.message}`;
    if (final) {
      logger.error(message);
    } else {
      logger.warn(message);
    }
  });

  return worker;
}
