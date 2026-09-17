import { EntryModel } from "../models";
import { crawlQueue, enqueueNotionSync } from "../queue/queues";
import { logger } from "../utils/logger";

export interface RetryResult {
  crawls: number;
  syncs: number;
}

/** Retries failed crawl jobs and failed Notion syncs. */
export async function retryFailed(): Promise<RetryResult> {
  const failedCrawls = (await crawlQueue.getJobCounts("failed")).failed ?? 0;
  if (failedCrawls > 0) {
    await crawlQueue.retryJobs({ state: "failed", count: 1000 });
  }

  const failedEntries = await EntryModel.find({ failed: true }).select({ _id: 1, link: 1 }).lean();
  for (const entry of failedEntries) {
    await EntryModel.updateOne(
      { _id: entry._id },
      { $set: { failed: false, entryErrors: [] }, $unset: { failedAt: 1 } }
    );
    await enqueueNotionSync(String(entry._id), entry.link);
  }

  logger.info(`Retrying ${failedCrawls} failed crawls and ${failedEntries.length} failed Notion syncs`);
  return { crawls: failedCrawls, syncs: failedEntries.length };
}
