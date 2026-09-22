import mongoose from "mongoose";
import { config } from "../config";
import { logger } from "../utils/logger";

export interface StorageUsage {
  usedMb: number;
  limitMb: number;
  percent: number;
  overThreshold: boolean;
  warnPercent: number;
}

/**
 * How much of the database plan is in use. Storage plus indexes is what the
 * plan's quota counts, not the uncompressed size of the documents.
 */
export async function getStorageUsage(): Promise<StorageUsage | null> {
  try {
    const stats = await mongoose.connection.db!.command({ dbStats: 1 });
    const usedMb = (stats.storageSize + stats.indexSize) / 1e6;
    const { limitMb, warnPercent } = config.storage;
    const percent = limitMb > 0 ? (usedMb / limitMb) * 100 : 0;

    return {
      // Two decimals so a small database doesn't read as 0 MB
      usedMb: Number(usedMb.toFixed(2)),
      limitMb,
      percent: Number(percent.toFixed(1)),
      overThreshold: percent >= warnPercent,
      warnPercent,
    };
  } catch (error) {
    // Reporting size is never worth failing a dashboard or a report over
    logger.warn("Could not read database size:", error);
    return null;
  }
}
