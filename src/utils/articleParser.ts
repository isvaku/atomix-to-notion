import * as cheerio from "cheerio";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { Source } from "../config";
import { logger } from "./logger";

dayjs.extend(customParseFormat);

export interface ScrapedArticle {
  entryId: string;
  title: string;
  author: string;
  content: string;
  summary: string;
  link: string;
  date: Date;
}

/**
 * Parses an article date with the source's dayjs format. Spanish "p. m." /
 * "a. m." suffixes are normalized first, because dayjs only knows "pm"/"am".
 * Returns null when the text doesn't match the format.
 */
export function parseArticleDate(dateText: string, format: string): Date | null {
  const normalized = dateText
    .trim()
    .replace(/([ap])\.?\s*m\.?/i, (_, ap: string) => ap.toLowerCase() + "m");
  const parsed = dayjs(normalized, format, true);
  return parsed.isValid() ? parsed.toDate() : null;
}


/**
 * Reads the values of a selector list, in order, and returns the first hit.
 * A <meta> match yields its content attribute rather than its (empty) text.
 */
function readSelectors($: cheerio.CheerioAPI, selectorString: string | undefined): string {
  for (const selector of (selectorString ?? "").split(", ").filter(Boolean)) {
    try {
      const element = $(selector).first();
      if (element.length === 0) continue;

      const value = element.is("meta") ? (element.attr("content") ?? "") : element.text();
      if (value.trim()) return value.trim();
    } catch {
      /* a bad selector shouldn't stop the others */
    }
  }
  return "";
}

/** Concatenates the inner HTML of every element matching the first selector that hits. */
function readHtml($: cheerio.CheerioAPI, selectorString: string | undefined): string {
  for (const selector of (selectorString ?? "").split(", ").filter(Boolean)) {
    try {
      const contents: string[] = [];
      $(selector).each((_, element) => {
        const html = $(element).html()?.trim();
        if (html) contents.push(html);
      });
      if (contents.length > 0) return contents.join("\n\n");
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** Derives the entry id from the post's CSS classes, falling back to the URL slug. */
function readEntryId($: cheerio.CheerioAPI, url: string, source: Source): string {
  for (const selector of (source.selectors.entryId ?? "").split(", ").filter(Boolean)) {
    try {
      const classes = ($(selector).first().attr("class") ?? "").split(" ");
      for (const className of classes) {
        if (!className.startsWith("post-")) continue;
        const id = className.split("-")[1];
        if (!id) continue;
        return source.name === "Atomix" ? `${source.url}/?p=${id}` : id;
      }
    } catch {
      /* ignore */
    }
  }

  const slug = url.split("/").pop() ?? "";
  return slug.replace(/[^a-zA-Z0-9]/g, "");
}

/** Turns an article page into an entry. Pure, so it can be tested against saved HTML. */
export function parseArticle(html: string, url: string, source: Source): ScrapedArticle {
  const $ = cheerio.load(html);

  const dateText = readSelectors($, source.selectors.date);
  let date: Date | null = source.dateFormat
    ? parseArticleDate(dateText, source.dateFormat)
    : new Date(dateText);
  if (!date || Number.isNaN(date.getTime())) {
    logger.warn(`Could not parse date "${dateText}" for ${url}, using the current time`);
    date = new Date();
  }

  return {
    entryId: readEntryId($, url, source),
    title: readSelectors($, source.selectors.title),
    author: readSelectors($, source.selectors.author),
    content: readHtml($, source.selectors.content),
    summary: readSelectors($, source.selectors.summary),
    link: url,
    date,
  };
}
