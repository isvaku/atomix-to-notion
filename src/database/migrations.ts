import { EntryModel } from "../models";
import { logger } from "../utils/logger";

/**
 * Runs idempotent data migrations at startup.
 */
export async function runMigrations(): Promise<void> {
  // Before the `failed` flag existed, an entry that failed to sync 5 times was
  // marked `created: true` without ever reaching Notion. A successful sync
  // clears entryErrors, so created + 5 or more errors means it never synced.
  const result = await EntryModel.updateMany(
    { created: true, "entryErrors.4": { $exists: true } },
    { $set: { created: false, failed: true, failedAt: new Date() } }
  );

  if (result.modifiedCount > 0) {
    logger.warn(
      `Marked ${result.modifiedCount} entries that never reached Notion as failed`
    );
  }
}
