import { Worker } from "bullmq";
import { config } from "../config";
import { database } from "../database";
import { EntryModel } from "../models";
import { redis, workerConnection } from "../queue/connection";
import { crawlJobId } from "../queue/links";
import {
  QUEUE_NAMES,
  closeQueues,
  crawlQueue,
  enqueueLinks,
  notionSyncQueue,
} from "../queue/queues";
import { Source } from "../config";

const source = { name: "Atomix", url: "https://atomix.vg" } as Source;
const link = (slug: string) => `https://atomix.vg/${slug}`;

describe("enqueueLinks", () => {
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

  it("queues new links", async () => {
    const result = await enqueueLinks([link("a"), link("b")], "api", [source]);

    expect(result.queued).toHaveLength(2);
    expect(await crawlQueue.getJobCounts("waiting")).toMatchObject({ waiting: 2 });
  });

  it("skips a link that is already queued, including duplicates in one request", async () => {
    await enqueueLinks([link("a")], "api", [source]);
    const result = await enqueueLinks([link("a"), link("a")], "api", [source]);

    expect(result.queued).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toBe("already-queued");
    expect(await crawlQueue.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
  });

  it("skips links we already have as entries", async () => {
    await EntryModel.create({
      entryId: "a",
      content: "x",
      link: link("a"),
      entryDate: new Date(),
    });

    const result = await enqueueLinks([link("a")], "api", [source]);
    expect(result.skipped).toEqual([{ link: link("a"), reason: "exists" }]);
  });

  it("rejects invalid links and other hosts without queueing anything", async () => {
    const result = await enqueueLinks(["nope", "https://example.com/x"], "api", [source]);

    expect(result.queued).toHaveLength(0);
    expect(result.rejected.map((item) => item.reason)).toEqual(["invalid-url", "unsupported-host"]);
  });

  it("queues a previously failed link again", async () => {
    // A failed job keeps its id, which would otherwise block re-adding the link
    await crawlQueue.add(
      "crawl",
      { link: link("a"), sourceName: source.name, origin: "api" },
      { jobId: crawlJobId(link("a")), attempts: 1 }
    );

    const worker = new Worker(
      QUEUE_NAMES.crawl,
      async () => {
        throw new Error("boom");
      },
      { connection: workerConnection, prefix: config.redis.prefix }
    );
    await new Promise((resolve) => worker.once("failed", resolve));
    await worker.close();

    expect(await crawlQueue.getJobCounts("failed")).toMatchObject({ failed: 1 });

    const result = await enqueueLinks([link("a")], "api", [source]);

    expect(result.queued).toHaveLength(1);
    expect(await crawlQueue.getJobCounts("failed", "waiting")).toMatchObject({
      failed: 0,
      waiting: 1,
    });
  });
});
