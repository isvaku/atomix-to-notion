import { Job } from "bullmq";
import { database } from "../database";
import { EntryModel } from "../models";
import { redis } from "../queue/connection";
import { closeQueues, crawlQueue, notionSyncQueue } from "../queue/queues";
import { notionJobId } from "../queue/links";
import { retryFailed } from "../services/retry";
import { CrawlJobData } from "../queue/queues";
import { processCrawlJob } from "../workers/crawlWorker";
import { processNotionSyncJob } from "../workers/notionSyncWorker";
import { ScrapedArticle } from "../utils/scraper";
import { readContent } from "../models/entryContent";

const LINK = "https://atomix.vg/an-article";

const article: ScrapedArticle = {
  entryId: "https://atomix.vg/?p=1",
  title: "An article",
  author: "Someone",
  content: "<p>Body</p>",
  summary: "",
  link: LINK,
  date: new Date("2026-09-16T12:00:00Z"),
};

const crawlJob = (data: Partial<CrawlJobData> = {}) =>
  ({ data: { link: LINK, sourceName: "Atomix", origin: "api", ...data } }) as Job<CrawlJobData>;

const syncJob = (entryId: string, attemptsMade = 0, attempts = 5) =>
  ({ data: { entryId, link: LINK }, attemptsMade, opts: { attempts } }) as Job<{
    entryId: string;
    link: string;
  }>;

beforeAll(async () => {
  await database.connect();
});

beforeEach(async () => {
  await EntryModel.deleteMany({});
  await crawlQueue.obliterate({ force: true });
  await notionSyncQueue.obliterate({ force: true });
});

afterAll(async () => {
  await closeQueues();
  await redis.quit();
  await database.disconnect();
});

describe("crawl worker", () => {
  it("saves the article and queues it for Notion", async () => {
    const scraper = { scrapeArticle: jest.fn().mockResolvedValue(article) };

    const result = await processCrawlJob(crawlJob(), scraper);

    const entry = await EntryModel.findOne({ link: LINK });
    expect(entry?.title).toBe("An article");
    // Stored compressed, with the original size recorded
    expect(entry?.content).toBeUndefined();
    expect(readContent(entry!)).toBe("<p>Body</p>");
    expect(entry?.contentBytes).toBe("<p>Body</p>".length);
    expect(entry?.created).toBe(false);
    expect(result.entryId).toBe(String(entry?._id));
    expect(await notionSyncQueue.getJob(notionJobId(String(entry?._id)))).toBeDefined();
  });

  it("throws when the article has no content, so the queue retries", async () => {
    const scraper = { scrapeArticle: jest.fn().mockResolvedValue(null) };

    await expect(processCrawlJob(crawlJob(), scraper)).rejects.toThrow("Could not scrape");
    expect(await EntryModel.countDocuments()).toBe(0);
  });

  it("does not scrape a link we already have", async () => {
    await EntryModel.create({ entryId: "x", content: "x", link: LINK, entryDate: new Date() });
    const scraper = { scrapeArticle: jest.fn() };

    const result = await processCrawlJob(crawlJob(), scraper);

    expect(result.skipped).toBe("exists");
    expect(scraper.scrapeArticle).not.toHaveBeenCalled();
  });

  it("fails without retrying when the source is unknown", async () => {
    const scraper = { scrapeArticle: jest.fn() };
    await expect(processCrawlJob(crawlJob({ sourceName: "Nope" }), scraper)).rejects.toThrow(
      'Unknown source "Nope"'
    );
  });
});

describe("notion sync worker", () => {
  const createEntry = () =>
    EntryModel.create({ entryId: "x", title: "An article", content: "<p>x</p>", link: LINK, entryDate: new Date() });

  it("marks the entry as created on success", async () => {
    const entry = await createEntry();
    const notion = { syncEntry: jest.fn().mockResolvedValue(undefined) };

    await processNotionSyncJob(syncJob(String(entry._id)), notion);

    const updated = await EntryModel.findById(entry._id);
    expect(updated?.created).toBe(true);
    expect(updated?.failed).toBe(false);
  });

  it("records the error and rethrows while attempts are left", async () => {
    const entry = await createEntry();
    const notion = { syncEntry: jest.fn().mockRejectedValue(new Error("notion down")) };

    await expect(processNotionSyncJob(syncJob(String(entry._id), 0), notion)).rejects.toThrow("notion down");

    const updated = await EntryModel.findById(entry._id);
    expect(updated?.failed).toBe(false);
    expect(updated?.entryErrors?.[0]).toContain("notion down");
  });

  it("marks the entry as failed on the last attempt", async () => {
    const entry = await createEntry();
    const notion = { syncEntry: jest.fn().mockRejectedValue(new Error("notion down")) };

    await expect(processNotionSyncJob(syncJob(String(entry._id), 4), notion)).rejects.toThrow();

    const updated = await EntryModel.findById(entry._id);
    expect(updated?.failed).toBe(true);
    expect(updated?.failedAt).toBeInstanceOf(Date);
  });

  it("does nothing when the entry is already in Notion", async () => {
    const entry = await createEntry();
    await EntryModel.updateOne({ _id: entry._id }, { $set: { created: true } });
    const notion = { syncEntry: jest.fn() };

    const result = await processNotionSyncJob(syncJob(String(entry._id)), notion);

    expect(result.skipped).toBe("already-created");
    expect(notion.syncEntry).not.toHaveBeenCalled();
  });

  it("retryFailed clears the failed state and queues the entry again", async () => {
    const entry = await createEntry();
    await EntryModel.updateOne(
      { _id: entry._id },
      { $set: { failed: true, failedAt: new Date(), entryErrors: ["boom"] } }
    );

    const result = await retryFailed();

    const updated = await EntryModel.findById(entry._id);
    expect(result.syncs).toBe(1);
    expect(updated?.failed).toBe(false);
    expect(updated?.entryErrors).toEqual([]);
    expect(await notionSyncQueue.getJob(notionJobId(String(entry._id)))).toBeDefined();
  });
});
