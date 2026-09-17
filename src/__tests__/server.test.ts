import { FastifyInstance } from "fastify";
import { database } from "../database";
import { EntryModel } from "../models";
import { redis } from "../queue/connection";
import { closeQueues, crawlQueue, notionSyncQueue } from "../queue/queues";
import { buildServer } from "../server";

const API_KEY = "test-api-key";
const auth = { authorization: `Bearer ${API_KEY}` };

let app: FastifyInstance;

beforeAll(async () => {
  await database.connect();
  app = buildServer({ workersRunning: () => true, apiKey: API_KEY });
  await app.ready();
});

beforeEach(async () => {
  await EntryModel.deleteMany({});
  await crawlQueue.obliterate({ force: true });
  await notionSyncQueue.obliterate({ force: true });
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await redis.quit();
  await database.disconnect();
});

describe("auth", () => {
  it("rejects API calls without a key", async () => {
    const response = await app.inject({ method: "GET", url: "/api/status" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a wrong key", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer nope" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("leaves /health open, for the Docker health check", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", checks: { mongo: true, redis: true } });
  });
});

describe("POST /api/crawl", () => {
  it("queues, skips and rejects links in one request", async () => {
    await EntryModel.create({
      entryId: "x",
      content: "x",
      link: "https://atomix.vg/known",
      entryDate: new Date(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/crawl",
      headers: auth,
      payload: {
        links: [
          "https://atomix.vg/new-one",
          "https://www.atomix.vg/new-one/",
          "https://atomix.vg/known",
          "https://example.com/other",
          "nonsense",
        ],
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.queued).toHaveLength(1);
    expect(body.skipped.map((item: { reason: string }) => item.reason).sort()).toEqual([
      "already-queued",
      "exists",
    ]);
    expect(body.rejected.map((item: { reason: string }) => item.reason).sort()).toEqual([
      "invalid-url",
      "unsupported-host",
    ]);
  });

  it("refuses more links than the limit", async () => {
    const links = Array.from({ length: 101 }, (_, index) => `https://atomix.vg/a${index}`);
    const response = await app.inject({ method: "POST", url: "/api/crawl", headers: auth, payload: { links } });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a request without links", async () => {
    const response = await app.inject({ method: "POST", url: "/api/crawl", headers: auth, payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe("status endpoints", () => {
  it("reports a queued job and then its entry", async () => {
    const queued = await app.inject({
      method: "POST",
      url: "/api/crawl",
      headers: auth,
      payload: { links: ["https://atomix.vg/an-article"] },
    });
    const { jobId } = queued.json().queued[0];

    const response = await app.inject({ method: "GET", url: `/api/crawl/${jobId}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jobId,
      link: "https://atomix.vg/an-article",
      state: "waiting",
      entry: null,
    });
  });

  it("returns 404 for an unknown job", async () => {
    const response = await app.inject({ method: "GET", url: "/api/crawl/crawl-nope", headers: auth });
    expect(response.statusCode).toBe(404);
  });

  it("summarizes queues, schedules and article stats", async () => {
    await EntryModel.create({
      entryId: "x",
      title: "An article",
      content: "x",
      link: "https://atomix.vg/an-article",
      entryDate: new Date(),
    });

    const response = await app.inject({ method: "GET", url: "/api/status", headers: auth });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stats.totals).toMatchObject({ synced: 0, pending: 1, failed: 0 });
    expect(body.recentEntries[0]).toMatchObject({ title: "An article", notion: "pending" });
    expect(body.queues).toHaveProperty("crawl");
    expect(body.schedulers.map((item: { name: string }) => item.name)).toContain("discover");
  });

  it("rejects an unknown scheduler", async () => {
    const response = await app.inject({ method: "POST", url: "/api/schedulers/nope/run", headers: auth });
    expect(response.statusCode).toBe(404);
  });

  it("queues a scheduler run on demand", async () => {
    const response = await app.inject({ method: "POST", url: "/api/schedulers/discover/run", headers: auth });
    expect(response.statusCode).toBe(202);
    expect(response.json().jobId).toBeTruthy();
  });
});

describe("dashboard", () => {
  it("serves the page without a key", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Atomix to Notion");
  });
});
