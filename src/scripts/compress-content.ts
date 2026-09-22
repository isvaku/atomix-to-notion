#!/usr/bin/env tsx
/**
 * Compresses the article HTML of rows written before compression existed.
 * Safe to stop and re-run: rows already compressed are skipped.
 *
 *   pnpm compress-content            # dry run, reports what it would save
 *   pnpm compress-content --apply
 */
import { database } from "../database";
import { EntryModel } from "../models";
import { packContent } from "../models/entryContent";
import { logger } from "../utils";

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 100;

async function main(): Promise<void> {
  await database.connect();

  const filter = { content: { $type: "string", $ne: "" } };
  const total = await EntryModel.countDocuments(filter);

  if (total === 0) {
    logger.info("Nothing to compress: every row already stores compressed content");
    return;
  }

  logger.info(`${total} rows still store plain HTML`);

  let processed = 0;
  let before = 0;
  let after = 0;

  for (;;) {
    const batch = await EntryModel.find(filter).select({ content: 1 }).limit(BATCH_SIZE).lean();
    if (batch.length === 0) break;

    for (const entry of batch) {
      const packed = packContent(entry.content ?? "");
      before += packed.contentBytes;
      after += packed.contentGzip.length;
      processed++;

      if (APPLY) {
        await EntryModel.updateOne(
          { _id: entry._id },
          { $set: packed, $unset: { content: 1 } }
        );
      }
    }

    logger.info(`${processed}/${total}`);
    // Without --apply nothing changes, so the same batch would come back
    if (!APPLY) break;
  }

  const saved = before - after;
  logger.info(
    `${processed} rows: ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB ` +
      `(${(after / before * 100).toFixed(0)}%, saving ${(saved / 1e6).toFixed(1)} MB)`
  );

  if (!APPLY) {
    logger.info(
      `Dry run over the first ${processed} of ${total} rows; nothing was changed. Re-run with --apply.`
    );
  }
}

main()
  .then(async () => {
    await database.disconnect().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error("Compressing content failed:", error);
    await database.disconnect().catch(() => undefined);
    process.exit(1);
  });
