import { Queue, Job } from "bullmq";
import { config, Source } from "../config";
import { EntryModel } from "../models";
import { logger } from "../utils/logger";
import { redis } from "./connection";
import { checkLink, crawlJobId, notionJobId } from "./links";

export const QUEUE_NAMES = {
  crawl: "crawl",
  notionSync: "notion-sync",
  maintenance: "maintenance",
} as const;

export const SCHEDULERS = {
  discover: "discover",
  sweepUnsynced: "sweep-unsynced",
  dailyReport: "daily-report",
} as const;

export type SchedulerName = (typeof SCHEDULERS)[keyof typeof SCHEDULERS];

export interface CrawlJobData {
  link: string;
  sourceName: string;
  origin: "api" | "cron";
}

export interface NotionSyncJobData {
  entryId: string; // Mongo _id
  link: string;
}

const DAY_SECONDS = 24 * 60 * 60;

const queueOptions = { connection: redis, prefix: config.redis.prefix };

export const crawlQueue = new Queue<CrawlJobData>(QUEUE_NAMES.crawl, {
  ...queueOptions,
  defaultJobOptions: {
    attempts: config.crawler.maxAttempts,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 7 * DAY_SECONDS },
    removeOnFail: { age: 30 * DAY_SECONDS },
  },
});

export const notionSyncQueue = new Queue<NotionSyncJobData>(QUEUE_NAMES.notionSync, {
  ...queueOptions,
  defaultJobOptions: {
    attempts: config.notionSync.maxAttempts,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { age: 7 * DAY_SECONDS },
    removeOnFail: { age: 30 * DAY_SECONDS },
  },
});

export const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, {
  ...queueOptions,
  defaultJobOptions: {
    attempts: 1,
    // Keep a short history for the dashboard
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

export const allQueues = [crawlQueue, notionSyncQueue, maintenanceQueue];

type AddResult = "queued" | "already-queued";

/**
 * Adds a job with a fixed id. BullMQ ignores adds for an id that still exists,
 * so a finished job with that id is retried (failed) or replaced (completed).
 */
async function addUnique<T>(
  queue: Queue<T>,
  name: string,
  data: T,
  jobId: string
): Promise<AddResult> {
  const existing = (await queue.getJob(jobId)) as Job<T> | undefined;

  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      await existing.retry("failed", { resetAttemptsMade: true });
      return "queued";
    }
    if (state !== "completed") {
      return "already-queued";
    }
    await existing.remove();
  }

  // Cast: BullMQ's generic name/data typing doesn't narrow well through wrappers
  await (queue as Queue).add(name, data, { jobId });
  return "queued";
}

export interface EnqueueResult {
  queued: { link: string; jobId: string }[];
  skipped: { link: string; reason: "exists" | "already-queued" }[];
  rejected: { link: string; reason: "invalid-url" | "unsupported-host" }[];
}

/** Validates, dedupes and queues article links for crawling. */
export async function enqueueLinks(
  links: string[],
  origin: CrawlJobData["origin"],
  sources: Source[] = config.sources
): Promise<EnqueueResult> {
  const result: EnqueueResult = { queued: [], skipped: [], rejected: [] };
  const seen = new Set<string>();
  const candidates: { link: string; source: Source }[] = [];

  for (const value of links) {
    const check = checkLink(value, sources);
    if (!check.ok) {
      result.rejected.push({ link: check.link, reason: check.reason });
      continue;
    }
    if (seen.has(check.link)) {
      result.skipped.push({ link: check.link, reason: "already-queued" });
      continue;
    }
    seen.add(check.link);
    candidates.push({ link: check.link, source: check.source });
  }

  if (candidates.length === 0) return result;

  // One database round-trip for the whole batch, not one per link
  const known = await EntryModel.find({ link: { $in: candidates.map((item) => item.link) } })
    .select({ link: 1 })
    .lean();
  const existing = new Set(known.map((entry) => entry.link));

  for (const { link, source } of candidates) {
    if (existing.has(link)) {
      result.skipped.push({ link, reason: "exists" });
      continue;
    }

    const jobId = crawlJobId(link);
    const added = await addUnique(
      crawlQueue,
      "crawl",
      { link, sourceName: source.name, origin },
      jobId
    );

    if (added === "queued") {
      result.queued.push({ link, jobId });
    } else {
      result.skipped.push({ link, reason: added });
    }
  }

  return result;
}

/** Queues an entry for creation in Notion. */
export async function enqueueNotionSync(entryId: string, link: string): Promise<AddResult> {
  return addUnique(notionSyncQueue, "sync", { entryId, link }, notionJobId(entryId));
}

/** Creates or updates the recurring maintenance jobs. */
export async function registerSchedulers(): Promise<void> {
  const tz = config.cronTimezone;
  const schedules: [SchedulerName, string][] = [
    [SCHEDULERS.discover, config.crawler.interval],
    [SCHEDULERS.sweepUnsynced, config.notionSync.interval],
    [SCHEDULERS.dailyReport, config.report.interval],
  ];

  for (const [name, pattern] of schedules) {
    await maintenanceQueue.upsertJobScheduler(name, { pattern, tz }, { name });
    logger.info(`Scheduled ${name}: "${pattern}" (${tz})`);
  }
}

/** Runs a maintenance job now, outside its schedule. */
export async function runMaintenanceNow(name: SchedulerName): Promise<string | undefined> {
  const job = await maintenanceQueue.add(name, {});
  return job.id;
}

export async function closeQueues(): Promise<void> {
  await Promise.all(allQueues.map((queue) => queue.close()));
}
