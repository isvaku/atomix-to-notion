import { Redis } from "ioredis";
import { config } from "../config";
import { logger } from "../utils/logger";

// BullMQ requires maxRetriesPerRequest: null so blocking commands wait out reconnects
export const redisOptions = { maxRetriesPerRequest: null };

/** Options for Workers, which open their own (blocking) connections. */
export const workerConnection = { url: config.redis.url, ...redisOptions };

/** Shared connection for Queues, health checks and status queries. */
export const redis = new Redis(config.redis.url, {
  ...redisOptions,
  lazyConnect: true,
});

redis.on("error", (error) => {
  logger.error("Redis connection error:", error);
});

export async function connectRedis(): Promise<void> {
  if (redis.status === "wait") {
    await redis.connect();
  }
  logger.info("Successfully connected to Redis");
}

export async function isRedisHealthy(): Promise<boolean> {
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}
