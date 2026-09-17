import { Job, Worker } from "bullmq";
import { config } from "../config";
import { EntryModel } from "../models";
import { workerConnection } from "../queue/connection";
import { NotionSyncJobData, QUEUE_NAMES } from "../queue/queues";
import { NotionClient } from "../utils/notion";
import { logger } from "../utils/logger";

export interface NotionSyncJobResult {
  skipped?: "missing" | "already-created";
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Creates the Notion page for an entry. Errors are recorded on the entry, and
 * on the last attempt the entry is marked failed (it shows up in the report).
 */
export async function processNotionSyncJob(
  job: Job<NotionSyncJobData>,
  notion: Pick<NotionClient, "syncEntry">
): Promise<NotionSyncJobResult> {
  const entry = await EntryModel.findById(job.data.entryId);
  if (!entry) {
    return { skipped: "missing" };
  }
  if (entry.created) {
    return { skipped: "already-created" };
  }

  try {
    await notion.syncEntry(entry);
  } catch (error) {
    const attempts = job.opts.attempts ?? 1;
    // attemptsMade counts finished attempts, so this one is attemptsMade + 1
    const isLastAttempt = job.attemptsMade + 1 >= attempts;
    const update: Record<string, unknown> = {
      $push: { entryErrors: `${new Date().toISOString()}: ${errorMessage(error)}` },
    };
    if (isLastAttempt) {
      update.$set = { failed: true, failedAt: new Date() };
      logger.error(`Notion sync failed after ${attempts} attempts for ${entry.link}: ${errorMessage(error)}`);
    }
    await EntryModel.updateOne({ _id: entry._id }, update);
    throw error;
  }

  await EntryModel.updateOne(
    { _id: entry._id },
    { $set: { created: true, failed: false, entryErrors: [] }, $unset: { failedAt: 1 } }
  );
  logger.info(`Synced to Notion: ${entry.title}`);
  return {};
}

export function createNotionSyncWorker(
  notion: NotionClient
): Worker<NotionSyncJobData, NotionSyncJobResult> {
  const worker = new Worker<NotionSyncJobData, NotionSyncJobResult>(
    QUEUE_NAMES.notionSync,
    (job) => processNotionSyncJob(job, notion),
    {
      connection: workerConnection,
      prefix: config.redis.prefix,
      concurrency: 1,
      limiter: { max: config.notionSync.rateLimitPerSecond, duration: 1000 },
    }
  );

  worker.on("failed", (job, error) => {
    if (job && job.attemptsMade < (job.opts.attempts ?? 1)) {
      logger.warn(`Notion sync attempt ${job.attemptsMade} failed for ${job.data.link}: ${error.message}`);
    }
  });

  return worker;
}
