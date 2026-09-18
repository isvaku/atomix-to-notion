#!/usr/bin/env tsx
/**
 * Cleans up duplicate Notion pages left by earlier imports.
 *
 * For every link with more than one page, pages are grouped as:
 *   - "filled": has an author or an entry date (created by this project)
 *   - "manual": has neither (imported by hand)
 *
 * A manual page with no real content (only a favicon image) is archived, since
 * its filled twin has the article. A manual page that does have content is kept
 * and completed from MongoDB (author, entry date, summary), and its filled twin
 * is archived instead - so the original page, its creation date and its
 * comments survive.
 *
 * Nothing is changed without --apply.
 *
 *   pnpm fix-notion-duplicates            # dry run
 *   pnpm fix-notion-duplicates --apply
 */
import { Client, isFullPage } from "@notionhq/client";
import { config } from "../config";
import { database } from "../database";
import { EntryModel } from "../models";
import { logger } from "../utils";
import { resolveDataSourceId } from "../utils/notion";

const APPLY = process.argv.includes("--apply");
// Notion allows about 3 requests per second
const REQUEST_DELAY_MS = 350;
// A page with no more than this many blocks holds no article, just the favicon
const THIN_PAGE_BLOCKS = 2;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notion = new Client({ auth: config.notion.token });

let dataSourceId: string | null = null;
const getDataSourceId = async (): Promise<string> => {
  dataSourceId ??= await resolveDataSourceId(notion, config.notion.databaseId);
  return dataSourceId;
};

interface PageInfo {
  id: string;
  link: string;
  filled: boolean;
  blocks: number;
}

const truncate = (value: string | undefined): string => (value ?? "").slice(0, 2000);

async function loadPages(): Promise<Map<string, PageInfo[]>> {
  const byLink = new Map<string, PageInfo[]>();
  let cursor: string | undefined;

  do {
    const response = await notion.dataSources.query({
      data_source_id: await getDataSourceId(),
      page_size: 100,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      if (!isFullPage(page) || page.archived) continue;

      const properties = page.properties as Record<string, { url?: string | null; rich_text?: unknown[]; date?: unknown }>;
      const link = properties.link?.url;
      if (!link) continue;

      const filled =
        (properties.author?.rich_text?.length ?? 0) > 0 || Boolean(properties.entryDate?.date);

      const list = byLink.get(link) ?? [];
      list.push({ id: page.id, link, filled, blocks: 0 });
      byLink.set(link, list);
    }

    cursor = response.next_cursor ?? undefined;
  } while (cursor);

  return byLink;
}

async function countBlocks(pageId: string): Promise<number> {
  const { results } = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  return results.length;
}

async function main(): Promise<void> {
  if (!config.notion.token || !config.notion.databaseId) {
    throw new Error("NOTION_TOKEN and NOTION_DATABASE_ID must be set");
  }
  // Only needed to complete pages that have content; archiving doesn't touch it
  const dbAvailable = await database
    .connect()
    .then(() => true)
    .catch((error) => {
      logger.warn(`No MongoDB connection (${(error as Error).message}). Pages with content will be left alone.`);
      return false;
    });

  logger.info("Reading the Notion database...");
  const byLink = await loadPages();

  const toArchive: string[] = [];
  const toComplete: { manual: PageInfo; twins: PageInfo[] }[] = [];

  for (const pages of byLink.values()) {
    if (pages.length < 2) continue;

    const manuals = pages.filter((page) => !page.filled);
    const filled = pages.filter((page) => page.filled);
    if (manuals.length === 0 || filled.length === 0) continue;

    for (const manual of manuals) {
      manual.blocks = await countBlocks(manual.id);
      await delay(REQUEST_DELAY_MS);

      if (manual.blocks <= THIN_PAGE_BLOCKS) {
        // No article on this page; its twin has it
        toArchive.push(manual.id);
      } else {
        // Real content: keep this page, complete it, drop the generated twin
        toComplete.push({ manual, twins: filled });
      }
    }
  }

  logger.info(`Content-free duplicates to archive: ${toArchive.length}`);
  logger.info(`Pages with content to complete (and their twins to archive): ${toComplete.length}`);

  if (!APPLY) {
    logger.info("Dry run: nothing was changed. Re-run with --apply.");
    return;
  }

  let archived = 0;
  for (const id of toArchive) {
    await notion.pages.update({ page_id: id, archived: true });
    archived++;
    await delay(REQUEST_DELAY_MS);
    if (archived % 50 === 0) logger.info(`Archived ${archived}/${toArchive.length}`);
  }
  logger.info(`Archived ${archived} content-free duplicates`);

  if (!dbAvailable) {
    if (toComplete.length > 0) {
      logger.warn(
        `${toComplete.length} pages with content still need author/date; re-run with a reachable MONGODB_URI`
      );
    }
    return;
  }

  let completed = 0;
  let twinsArchived = 0;
  for (const { manual, twins } of toComplete) {
    const entry = await EntryModel.findOne({ link: manual.link }).lean();
    if (!entry) {
      logger.warn(`No stored article for ${manual.link}, page left untouched`);
      continue;
    }

    await notion.pages.update({
      page_id: manual.id,
      properties: {
        author: { rich_text: [{ text: { content: truncate(entry.author) } }] },
        entryDate: { date: { start: new Date(entry.entryDate).toISOString() } },
        summary: { rich_text: [{ text: { content: truncate(entry.summary) } }] },
      },
    });
    completed++;
    await delay(REQUEST_DELAY_MS);

    for (const twin of twins) {
      await notion.pages.update({ page_id: twin.id, archived: true });
      twinsArchived++;
      await delay(REQUEST_DELAY_MS);
    }
  }

  logger.info(`Completed ${completed} pages and archived ${twinsArchived} generated twins`);
}

main()
  .then(async () => {
    await database.disconnect().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error("Cleanup failed:", error);
    await database.disconnect().catch(() => undefined);
    process.exit(1);
  });
