#!/usr/bin/env tsx
/**
 * Re-imports Notion pages that came out empty (e.g. from an earlier manual
 * import): it reads their links, queues them for crawling and archives the
 * empty pages, so each article ends up with one good page.
 *
 * Nothing is changed without --apply.
 *
 *   pnpm reimport-notion                       # dry run, writes the list to a file
 *   pnpm reimport-notion --apply               # queue the links and archive the old pages
 *   pnpm reimport-notion --apply --api-url http://raspberrypi:3000
 *
 * Options:
 *   --api-url <url>   where the crawler API lives (default http://localhost:3000)
 *   --min-blocks <n>  a page with fewer content blocks than this counts as empty (default 1)
 *   --out <file>      where to write the links (default notion-reimport.txt)
 */
import { Client, isFullPage } from "@notionhq/client";
import { writeFileSync } from "fs";
import { config } from "../config";
import { logger } from "../utils";

interface EmptyPage {
  id: string;
  url: string;
  title: string;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : fallback;
};

const APPLY = args.includes("--apply");
const API_URL = (flag("api-url", "http://localhost:3000") as string).replace(/\/$/, "");
const MIN_BLOCKS = Number(flag("min-blocks", "1"));
const OUT_FILE = flag("out", "notion-reimport.txt") as string;
// Notion allows about 3 requests per second
const REQUEST_DELAY_MS = 350;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const notion = new Client({ auth: config.notion.token });

/** Reads the article URL from the page's "link" property. */
function getLink(page: { properties: Record<string, unknown> }): string | null {
  for (const property of Object.values(page.properties)) {
    const value = property as { type?: string; url?: string | null };
    if (value.type === "url" && value.url) return value.url;
  }
  return null;
}

function getTitle(page: { properties: Record<string, unknown> }): string {
  for (const property of Object.values(page.properties)) {
    const value = property as { type?: string; title?: { plain_text: string }[] };
    if (value.type === "title") {
      return (value.title ?? []).map((part) => part.plain_text).join("");
    }
  }
  return "";
}

/** Counts blocks that actually carry content, ignoring empty paragraphs. */
async function countContentBlocks(pageId: string): Promise<number> {
  const { results } = await notion.blocks.children.list({ block_id: pageId, page_size: 10 });

  return results.filter((block) => {
    const typed = block as { type?: string; paragraph?: { rich_text: unknown[] } };
    if (typed.type === "paragraph") {
      return (typed.paragraph?.rich_text ?? []).length > 0;
    }
    return Boolean(typed.type);
  }).length;
}

async function findEmptyPages(): Promise<EmptyPage[]> {
  const empty: EmptyPage[] = [];
  let cursor: string | undefined;
  let scanned = 0;

  do {
    const response = await notion.databases.query({
      database_id: config.notion.databaseId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      if (!isFullPage(page) || page.archived) continue;
      scanned++;

      const url = getLink(page);
      if (!url) continue;

      const blocks = await countContentBlocks(page.id);
      await delay(REQUEST_DELAY_MS);

      if (blocks < MIN_BLOCKS) {
        empty.push({ id: page.id, url, title: getTitle(page) });
        logger.info(`Empty: ${getTitle(page) || url}`);
      }
    }

    cursor = response.next_cursor ?? undefined;
    logger.info(`Scanned ${scanned} pages, ${empty.length} empty so far`);
  } while (cursor);

  return empty;
}

interface CrawlResponse {
  queued: { link: string }[];
  skipped: { link: string; reason: string }[];
  rejected: { link: string; reason: string }[];
}

async function queueLinks(links: string[]): Promise<CrawlResponse> {
  const all: CrawlResponse = { queued: [], skipped: [], rejected: [] };

  // The API takes at most 100 links per request
  for (let start = 0; start < links.length; start += 100) {
    const response = await fetch(`${API_URL}/api/crawl`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.server.apiKey}`,
      },
      body: JSON.stringify({ links: links.slice(start, start + 100) }),
    });

    if (!response.ok) {
      throw new Error(`${API_URL}/api/crawl responded ${response.status}: ${await response.text()}`);
    }

    const batch = (await response.json()) as CrawlResponse;
    all.queued.push(...batch.queued);
    all.skipped.push(...batch.skipped);
    all.rejected.push(...batch.rejected);
  }

  return all;
}

async function main(): Promise<void> {
  if (!config.notion.token || !config.notion.databaseId) {
    throw new Error("NOTION_TOKEN and NOTION_DATABASE_ID must be set");
  }

  logger.info(`Looking for pages with fewer than ${MIN_BLOCKS} content block(s)...`);
  const empty = await findEmptyPages();

  if (empty.length === 0) {
    logger.info("No empty pages found, nothing to do");
    return;
  }

  const links = empty.map((page) => page.url);
  writeFileSync(OUT_FILE, links.join("\n") + "\n", "utf8");
  logger.info(`Found ${empty.length} empty pages. Links written to ${OUT_FILE}`);

  if (!APPLY) {
    logger.info("Dry run: nothing was queued or archived. Re-run with --apply to do it.");
    return;
  }

  if (!config.server.apiKey) {
    throw new Error("API_KEY must be set to queue the links");
  }

  const result = await queueLinks(links);
  logger.info(
    `Queued ${result.queued.length}, skipped ${result.skipped.length}, rejected ${result.rejected.length}`
  );

  for (const item of result.rejected) {
    logger.warn(`Not a crawlable link, page kept: ${item.link} (${item.reason})`);
  }

  // Only archive pages the crawler accepted. A rejected link would otherwise
  // lose its page without ever getting a new one.
  const rejected = new Set(result.rejected.map((item) => item.link));
  const toArchive = empty.filter((page) => !rejected.has(page.url));

  let archived = 0;
  for (const page of toArchive) {
    await notion.pages.update({ page_id: page.id, archived: true });
    archived++;
    await delay(REQUEST_DELAY_MS);
    if (archived % 25 === 0) {
      logger.info(`Archived ${archived}/${toArchive.length} pages`);
    }
  }

  logger.info(`Done. Archived ${archived} empty pages; the crawler is refilling them.`);
  logger.info("Watch progress on the dashboard, or with GET /api/status");
}

main().catch((error) => {
  logger.error("Re-import failed:", error);
  process.exit(1);
});
