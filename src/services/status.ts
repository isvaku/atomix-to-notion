import { readFileSync } from "fs";
import { join } from "path";
import { config } from "../config";
import { EntryModel } from "../models";
import { notionJobId } from "../queue/links";
import { getStorageUsage } from "./storage";
import {
  SCHEDULERS,
  crawlQueue,
  maintenanceQueue,
  notionSyncQueue,
} from "../queue/queues";

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

const APP_VERSION = readVersion();
const APP_COMMIT = process.env.GIT_SHA?.slice(0, 7) || null;

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 20;
const JOB_STATES = ["waiting", "active", "delayed", "completed", "failed"] as const;

export async function getSchedulerStatus() {
  const [schedulers, recentJobs] = await Promise.all([
    maintenanceQueue.getJobSchedulers(),
    maintenanceQueue.getJobs(["completed", "failed", "active"], 0, 49),
  ]);

  return Object.values(SCHEDULERS).map((name) => {
    const scheduler = schedulers.find((item) => item.key === name || item.name === name);
    const lastRun = recentJobs
      .filter((job) => job.name === name)
      .sort((a, b) => (b.processedOn ?? b.timestamp) - (a.processedOn ?? a.timestamp))[0];

    return {
      name,
      pattern: scheduler?.pattern ?? null,
      timezone: scheduler?.tz ?? config.cronTimezone,
      nextRun: scheduler?.next ?? null,
      lastRun: lastRun
        ? {
            startedAt: lastRun.processedOn ?? null,
            finishedAt: lastRun.finishedOn ?? null,
            status: lastRun.finishedOn ? (lastRun.failedReason ? "failed" : "completed") : "running",
            error: lastRun.failedReason || null,
            result: lastRun.returnvalue ?? null,
          }
        : null,
    };
  });
}

export async function getStatus() {
  const now = Date.now();
  const since24h = new Date(now - DAY_MS);
  const since14d = new Date(now - 14 * DAY_MS);

  const [
    schedulers,
    storage,
    crawlCounts,
    syncCounts,
    perDay,
    synced,
    pending,
    failed,
    saved24h,
    failedSyncs,
    failedCrawlJobs,
    recentEntries,
  ] = await Promise.all([
    getSchedulerStatus(),
    getStorageUsage(),
    crawlQueue.getJobCounts(...JOB_STATES),
    notionSyncQueue.getJobCounts(...JOB_STATES),
    EntryModel.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: since14d } } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: config.cronTimezone },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    EntryModel.countDocuments({ created: true }),
    EntryModel.countDocuments({ created: false, failed: { $ne: true } }),
    EntryModel.countDocuments({ failed: true }),
    EntryModel.countDocuments({ createdAt: { $gte: since24h } }),
    EntryModel.find({ failed: true })
      .select({ title: 1, link: 1, failedAt: 1, entryErrors: { $slice: -1 } })
      .sort({ failedAt: -1 })
      .limit(RECENT_LIMIT)
      .lean(),
    crawlQueue.getFailed(0, RECENT_LIMIT - 1),
    EntryModel.find()
      .select({ title: 1, link: 1, entryDate: 1, createdAt: 1, created: 1, failed: 1 })
      .sort({ createdAt: -1 })
      .limit(RECENT_LIMIT)
      .lean(),
  ]);

  return {
    generatedAt: now,
    version: { version: APP_VERSION, commit: APP_COMMIT },
    schedulers,
    storage,
    queues: { crawl: crawlCounts, notionSync: syncCounts },
    stats: {
      perDay: perDay.map((day) => ({ date: day._id, count: day.count })),
      totals: { synced, pending, failed },
      saved24h,
    },
    failures: {
      notion: failedSyncs.map((entry) => ({
        title: entry.title ?? "",
        link: entry.link,
        failedAt: entry.failedAt ?? null,
        error: entry.entryErrors?.[0] ?? null,
      })),
      crawl: failedCrawlJobs.map((job) => ({
        link: job.data?.link ?? null,
        error: job.failedReason ?? null,
        attempts: job.attemptsMade,
        failedAt: job.finishedOn ?? null,
      })),
    },
    recentEntries: recentEntries.map((entry) => ({
      title: entry.title ?? "",
      link: entry.link,
      entryDate: entry.entryDate,
      savedAt: entry.createdAt ?? null,
      notion: entry.created ? "synced" : entry.failed ? "failed" : "pending",
    })),
  };
}

export async function getCrawlJobStatus(jobId: string) {
  const job = await crawlQueue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  const entryId = (job.returnvalue as { entryId?: string } | undefined)?.entryId;
  const entry = entryId
    ? await EntryModel.findById(entryId).select({ title: 1, created: 1, failed: 1, entryErrors: 1 }).lean()
    : null;
  const notionJob = entryId ? await notionSyncQueue.getJob(notionJobId(entryId)) : undefined;

  return {
    jobId,
    link: job.data.link,
    state,
    attemptsMade: job.attemptsMade,
    error: job.failedReason || null,
    entry: entry
      ? {
          id: entryId,
          title: entry.title ?? "",
          notion: entry.created ? "synced" : entry.failed ? "failed" : "pending",
          notionJobState: notionJob ? await notionJob.getState() : null,
          errors: entry.entryErrors ?? [],
        }
      : null,
  };
}
