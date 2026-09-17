import { Job, Worker } from "bullmq";
import { config } from "../config";
import { EntryModel } from "../models";
import { workerConnection } from "../queue/connection";
import { QUEUE_NAMES, SCHEDULERS, enqueueLinks, enqueueNotionSync } from "../queue/queues";
import { alertDiscoverFailed, pingWatchdog } from "../services/alerts";
import { sendDailyReport } from "../services/report";
import { WebScraper } from "../utils/scraper";
import { logger } from "../utils/logger";

// Unsynced entries queued per sweep
const SWEEP_LIMIT = 500;

export type MaintenanceResult = Record<string, unknown>;

/** Finds new article links on every source and queues the ones we don't have. */
export async function discover(
  scraper: Pick<WebScraper, "getArticleLinks">
): Promise<MaintenanceResult> {
  let found = 0;
  let queued = 0;

  for (const source of config.sources) {
    const links = await scraper.getArticleLinks(source);
    if (links.length === 0) {
      // Usually means the site is blocking us or its markup/API changed
      throw new Error(`No links found for ${source.name}`);
    }
    const result = await enqueueLinks(links, "cron", [source]);
    found += links.length;
    queued += result.queued.length;
  }

  logger.info(`Discover: ${found} links found, ${queued} new queued`);
  // Tells the external watchdog the crawler is alive and reaching the site
  await pingWatchdog();
  return { found, queued };
}

/** Queues entries that never made it to Notion (e.g. jobs lost with Redis data). */
export async function sweepUnsynced(): Promise<MaintenanceResult> {
  const entries = await EntryModel.find({ created: false, failed: { $ne: true } })
    .select({ _id: 1, link: 1 })
    .sort({ entryDate: -1 })
    .limit(SWEEP_LIMIT)
    .lean();

  let queued = 0;
  for (const entry of entries) {
    if ((await enqueueNotionSync(String(entry._id), entry.link)) === "queued") {
      queued++;
    }
  }

  if (queued > 0) {
    logger.info(`Sweep: queued ${queued} unsynced entries for Notion`);
  }
  return { unsynced: entries.length, queued };
}

export function createMaintenanceWorker(scraper: WebScraper): Worker {
  const worker = new Worker(
    QUEUE_NAMES.maintenance,
    async (job: Job): Promise<MaintenanceResult> => {
      switch (job.name) {
        case SCHEDULERS.discover:
          return discover(scraper);
        case SCHEDULERS.sweepUnsynced:
          return sweepUnsynced();
        case SCHEDULERS.dailyReport: {
          const { sent, reason } = await sendDailyReport();
          return { sent, reason };
        }
        default:
          throw new Error(`Unknown maintenance job "${job.name}"`);
      }
    },
    {
      connection: workerConnection,
      prefix: config.redis.prefix,
      concurrency: 1,
      // Discover starts Chromium and passes Cloudflare, which is slow on a Pi
      lockDuration: 10 * 60_000,
    }
  );

  worker.on("failed", (job, error) => {
    logger.error(`Maintenance job ${job?.name ?? "unknown"} failed: ${error.message}`);
    if (job?.name === SCHEDULERS.discover) {
      void alertDiscoverFailed(error);
    }
  });

  return worker;
}
