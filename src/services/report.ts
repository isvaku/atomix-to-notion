import { config } from "../config";
import { EntryModel } from "../models";
import { crawlQueue, notionSyncQueue } from "../queue/queues";
import { logger } from "../utils/logger";
import {
  ReportData,
  buildReport,
  isTelegramConfigured,
  reportNeedsAttention,
  sendTelegramMessage,
} from "../utils/telegram";

const DAY_MS = 24 * 60 * 60 * 1000;
// Failed crawl jobs scanned for the report (they're kept for 30 days)
const MAX_FAILED_JOBS_SCANNED = 1000;

export async function collectReportData(now: Date = new Date()): Promise<ReportData> {
  const since = new Date(now.getTime() - DAY_MS);

  const [failedSyncEntries, failedSyncTotal, savedCount, failedJobs, crawlCounts, syncCounts] =
    await Promise.all([
      EntryModel.find({ failed: true, failedAt: { $gte: since } })
        .select({ title: 1, link: 1, entryErrors: { $slice: -1 } })
        .sort({ failedAt: -1 })
        .lean(),
      EntryModel.countDocuments({ failed: true }),
      EntryModel.countDocuments({ createdAt: { $gte: since } }),
      crawlQueue.getFailed(0, MAX_FAILED_JOBS_SCANNED - 1),
      crawlQueue.getJobCounts("waiting", "active", "delayed", "failed"),
      notionSyncQueue.getJobCounts("waiting", "active", "delayed"),
    ]);

  const failedCrawls = failedJobs
    .filter((job) => (job.finishedOn ?? 0) >= since.getTime())
    .map((job) => ({ link: String(job.data?.link ?? job.id), error: job.failedReason }));

  return {
    since,
    failedSyncs: failedSyncEntries.map((entry) => ({
      title: entry.title ?? "",
      link: entry.link,
      error: entry.entryErrors?.[0],
    })),
    failedSyncTotal,
    failedCrawls,
    failedCrawlTotal: crawlCounts.failed ?? 0,
    savedCount,
    pendingCrawls: (crawlCounts.waiting ?? 0) + (crawlCounts.active ?? 0) + (crawlCounts.delayed ?? 0),
    pendingSyncs: (syncCounts.waiting ?? 0) + (syncCounts.active ?? 0) + (syncCounts.delayed ?? 0),
  };
}

export interface ReportResult {
  sent: boolean;
  reason: "sent" | "nothing-to-report" | "telegram-not-configured";
  text: string;
}

/** Builds the daily report and sends it when something needs attention (or always, if forced). */
export async function sendDailyReport(force: boolean = config.report.always): Promise<ReportResult> {
  const data = await collectReportData();
  const text = buildReport(data);

  if (!force && !reportNeedsAttention(data)) {
    logger.info("Daily report: nothing needs attention, not sending");
    return { sent: false, reason: "nothing-to-report", text };
  }

  if (!isTelegramConfigured()) {
    logger.warn("Daily report not sent: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set");
    return { sent: false, reason: "telegram-not-configured", text };
  }

  await sendTelegramMessage(text);
  return { sent: true, reason: "sent", text };
}
