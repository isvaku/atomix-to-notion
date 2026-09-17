import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { config } from "../config";
import { database } from "../database";
import { isRedisHealthy } from "../queue/connection";
import { SCHEDULERS, SchedulerName, enqueueLinks, runMaintenanceNow } from "../queue/queues";
import { sendDailyReport } from "../services/report";
import { retryFailed } from "../services/retry";
import { getCrawlJobStatus, getStatus } from "../services/status";
import { logger } from "../utils/logger";

export interface ServerDeps {
  /** Whether all queue workers are running. */
  workersRunning: () => boolean;
  apiKey?: string;
}

// public/ sits at the repo root, two levels above both src/server and dist/server
const DASHBOARD_PATH = path.resolve(__dirname, "../../public/index.html");

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

function isAuthorized(request: FastifyRequest, apiKey: string): boolean {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  // Compare fixed-length digests so the comparison takes constant time
  return token.length > 0 && timingSafeEqual(digest(token), digest(apiKey));
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const apiKey = deps.apiKey ?? config.server.apiKey;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  if (!apiKey) {
    logger.warn("API_KEY is not set: the API is open to anyone who can reach it");
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (apiKey && request.url.startsWith("/api/") && !isAuthorized(request, apiKey)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      logger.error(`${request.method} ${request.url} failed:`, error);
    }
    reply.code(statusCode).send({ error: statusCode >= 500 ? "Internal Server Error" : error.message });
  });

  let dashboard: string | null = null;
  app.get("/", async (_request, reply) => {
    dashboard ??= readFileSync(DASHBOARD_PATH, "utf8");
    return reply.type("text/html; charset=utf-8").send(dashboard);
  });

  app.get("/health", async (_request, reply) => {
    const checks = {
      mongo: database.isConnectedToDb(),
      redis: await isRedisHealthy(),
      workers: deps.workersRunning(),
    };
    const healthy = Object.values(checks).every(Boolean);
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? "ok" : "unhealthy", checks });
  });

  app.post<{ Body: { links: string[] } }>(
    "/api/crawl",
    {
      schema: {
        body: {
          type: "object",
          required: ["links"],
          additionalProperties: false,
          properties: {
            links: {
              type: "array",
              minItems: 1,
              maxItems: config.server.maxLinksPerRequest,
              items: { type: "string", minLength: 1, maxLength: 2000 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await enqueueLinks(request.body.links, "api");
      return reply.code(202).send(result);
    }
  );

  app.get<{ Params: { jobId: string } }>("/api/crawl/:jobId", async (request, reply) => {
    const status = await getCrawlJobStatus(request.params.jobId);
    return status ?? reply.code(404).send({ error: "Job not found" });
  });

  app.get("/api/status", async () => getStatus());

  app.post("/api/retry-failed", async () => retryFailed());

  app.post<{ Params: { name: string } }>("/api/schedulers/:name/run", async (request, reply) => {
    const name = request.params.name as SchedulerName;
    if (!Object.values(SCHEDULERS).includes(name)) {
      return reply.code(404).send({ error: "Unknown scheduler" });
    }
    return reply.code(202).send({ jobId: await runMaintenanceNow(name) });
  });

  app.post("/api/report", async () => {
    const { sent, reason } = await sendDailyReport(true);
    return { sent, reason };
  });

  return app;
}
