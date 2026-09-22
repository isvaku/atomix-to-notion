import { config } from "../config";
import { database } from "../database";
import { EntryModel } from "../models";
import { packContent, readContent } from "../models/entryContent";
import { redis } from "../queue/connection";
import { closeQueues } from "../queue/queues";
import { getStorageUsage } from "../services/storage";
import { dropOldContent } from "../workers/maintenanceWorker";
import { ReportData, buildReport, reportNeedsAttention } from "../utils/telegram";

const baseReport: ReportData = {
  since: new Date(),
  failedSyncs: [],
  failedSyncTotal: 0,
  failedCrawls: [],
  failedCrawlTotal: 0,
  savedCount: 12,
  pendingCrawls: 0,
  pendingSyncs: 0,
  storage: { usedMb: 5.6, limitMb: 512, percent: 1.1, overThreshold: false },
};

beforeAll(async () => {
  await database.connect();
});

beforeEach(async () => {
  await EntryModel.deleteMany({});
  config.storage.contentRetentionDays = 0;
});

afterAll(async () => {
  // The maintenance worker's queues connect on import
  await closeQueues();
  await redis.quit();
  await database.disconnect();
});

describe("getStorageUsage", () => {
  it("reports what the database occupies against the limit", async () => {
    const usage = await getStorageUsage();

    expect(usage).not.toBeNull();
    expect(usage!.usedMb).toBeGreaterThan(0);
    expect(usage!.limitMb).toBe(config.storage.limitMb);
    expect(usage!.percent).toBeCloseTo((usage!.usedMb / usage!.limitMb) * 100, 0);
    expect(usage!.overThreshold).toBe(false);
  });

  it("flags usage past the warning threshold", async () => {
    const original = config.storage.limitMb;
    // A limit the test database is certainly over
    config.storage.limitMb = 0.001;

    expect((await getStorageUsage())!.overThreshold).toBe(true);

    config.storage.limitMb = original;
  });
});

describe("the daily report", () => {
  it("shows the database size", () => {
    expect(buildReport(baseReport)).toContain("Database: 5.6 MB of 512 MB (1.1%)");
  });

  it("stays quiet at normal usage", () => {
    expect(reportNeedsAttention(baseReport)).toBe(false);
  });

  it("asks for attention when storage passes the threshold", () => {
    const data = { ...baseReport, storage: { ...baseReport.storage!, percent: 82, overThreshold: true } };

    expect(reportNeedsAttention(data)).toBe(true);
    expect(buildReport(data)).toContain("⚠️");
  });

  it("copes with the size being unavailable", () => {
    const data = { ...baseReport, storage: null };

    expect(reportNeedsAttention(data)).toBe(false);
    expect(buildReport(data)).not.toContain("Database:");
  });
});

describe("dropOldContent", () => {
  const createEntry = (entryDate: Date, created: boolean) =>
    EntryModel.create({
      entryId: `x-${entryDate.getTime()}-${created}`,
      link: `https://atomix.vg/a-${entryDate.getTime()}-${created}`,
      entryDate,
      created,
      ...packContent("<p>body</p>"),
    });

  const oldDate = new Date(Date.now() - 200 * 864e5);

  it("does nothing while retention is off", async () => {
    await createEntry(oldDate, true);

    expect(await dropOldContent()).toBe(0);
    expect(readContent((await EntryModel.findOne())!)).toBe("<p>body</p>");
  });

  it("drops the HTML of old synced articles once configured", async () => {
    config.storage.contentRetentionDays = 90;
    await createEntry(oldDate, true);

    expect(await dropOldContent()).toBe(1);

    const entry = await EntryModel.findOne();
    expect(readContent(entry!)).toBe("");
    // The article itself is still there, only its HTML is gone
    expect(entry!.link).toContain("https://atomix.vg/");
    expect(entry!.contentBytes).toBeGreaterThan(0);
  });

  it("keeps anything not yet in Notion, however old", async () => {
    config.storage.contentRetentionDays = 90;
    await createEntry(oldDate, false);

    expect(await dropOldContent()).toBe(0);
    expect(readContent((await EntryModel.findOne())!)).toBe("<p>body</p>");
  });

  it("keeps recent articles", async () => {
    config.storage.contentRetentionDays = 90;
    await createEntry(new Date(), true);

    expect(await dropOldContent()).toBe(0);
  });
});
