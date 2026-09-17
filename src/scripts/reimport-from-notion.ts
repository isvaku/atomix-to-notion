#!/usr/bin/env tsx
/**
 * Re-fills Notion pages that came out empty (e.g. from an earlier manual
 * import): it reads their links and queues them for crawling. The sync then
 * updates those same pages in place - author, entry date, summary and content -
 * so nothing is deleted or duplicated.
 *
 * A page counts as failed when it has neither an author nor an entry date.
 *
 * Nothing is changed without --apply.
 *
 *   pnpm reimport-notion                       # dry run, writes the list to a file
 *   pnpm reimport-notion --apply --limit 5     # try it on five pages first
 *   pnpm reimport-notion --apply --api-url http://raspberrypi:3000
 *
 * Options:
 *   --api-url <url>   where the crawler API lives (default http://localhost:3000)
 *   --limit <n>       only handle the first n pages found
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
const LIMIT = Number(flag("limit", "0"));
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

/** A page that never got filled in has neither an author nor an entry date. */
const EMPTY_PAGE_FILTER = {
  and: [
    { property: "author", rich_text: { is_empty: true as const } },
    { property: "entryDate", date: { is_empty: true as const } },
  ],
};

async function findEmptyPages(): Promise<EmptyPage[]> {
  const empty: EmptyPage[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.databases.query({
      database_id: config.notion.databaseId,
      filter: EMPTY_PAGE_FILTER,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      if (!isFullPage(page) || page.archived) continue;

      const url = getLink(page);
      if (!url) {
        logger.warn(`Page without a link, skipped: ${getTitle(page) || page.id}`);
        continue;
      }

      empty.push({ id: page.id, url, title: getTitle(page) });
      if (LIMIT > 0 && empty.length >= LIMIT) return empty;
    }

    cursor = response.next_cursor ?? undefined;
    logger.info(`Found ${empty.length} pages to re-import so far`);
    await delay(REQUEST_DELAY_MS);
  } while (cursor);

  return empty;
}

interface CrawlResponse {
  queued: { link: string }[];
  skipped: { link: string; reason: string }[];
  rejected: { link: string; reason: string }[];
}

/** Asks the app to write stored articles to Notion again, updating their pages. */
async function resyncLinks(links: string[]): Promise<string[]> {
  const resynced: string[] = [];

  for (let start = 0; start < links.length; start += 100) {
    const response = await fetch(`${API_URL}/api/resync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.server.apiKey}`,
      },
      body: JSON.stringify({ links: links.slice(start, start + 100) }),
    });

    if (!response.ok) {
      throw new Error(`${API_URL}/api/resync responded ${response.status}: ${await response.text()}`);
    }

    const batch = (await response.json()) as { resynced: string[] };
    resynced.push(...batch.resynced);
  }

  return resynced;
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

  logger.info("Looking for pages without an author and without an entry date...");
  const empty = await findEmptyPages().catch(async (error) => {
    // The usual cause is different property names in the database
    const database = await notion.databases.retrieve({ database_id: config.notion.databaseId });
    const names = Object.keys((database as { properties?: object }).properties ?? {});
    logger.error(`Could not query the database. Its properties are: ${names.join(", ")}`);
    logger.error('This script expects an "author" (text) and an "entryDate" (date) property.');
    throw error;
  });

  if (empty.length === 0) {
    logger.info("No empty pages found, nothing to do");
    return;
  }

  const links = empty.map((page) => page.url);
  writeFileSync(OUT_FILE, links.join("\n") + "\n", "utf8");
  logger.info(`Found ${empty.length} empty pages. Links written to ${OUT_FILE}`);

  if (!APPLY) {
    logger.info("Dry run: nothing was queued. Re-run with --apply to do it.");
    return;
  }

  if (!config.server.apiKey) {
    throw new Error("API_KEY must be set to queue the links");
  }

  const result = await queueLinks(links);
  logger.info(
    `Queued ${result.queued.length}, already crawled ${result.skipped.length}, rejected ${result.rejected.length}`
  );

  for (const item of result.rejected) {
    logger.warn(`Not a crawlable link, page left as is: ${item.link} (${item.reason})`);
  }

  // Links we already have in MongoDB aren't crawled again, so their pages are
  // filled from what's stored instead
  const alreadyCrawled = result.skipped.map((item) => item.link);
  if (alreadyCrawled.length > 0) {
    const resynced = await resyncLinks(alreadyCrawled);
    logger.info(`Queued ${resynced.length} already-crawled articles for a Notion update`);
  }

  logger.info("Done. The pages are updated in place as each article is processed.");
  logger.info("Watch progress on the dashboard, or with GET /api/status");
}

main().catch((error) => {
  logger.error("Re-import failed:", error);
  process.exit(1);
});
