import parse, { HTMLElement, TextNode, Node } from "node-html-parser";

import { Client } from "@notionhq/client";
import type {
  BlockObjectRequest,
  CreatePageParameters,
} from "@notionhq/client/build/src/api-endpoints";
import { MAX_BODY_LENGTH, MAX_RICH_TEXT_LENGTH } from "./constants";
import { config } from "../config";
import { logger } from "./logger";
import { IEntry } from "../models";

// Notion rejects rich text arrays longer than this in a single block
const MAX_RICH_TEXT_ITEMS = 100;
// Notion rejects URLs longer than this
const MAX_URL_LENGTH = 2000;

export type RichText = {
  type: "text";
  text: {
    content: string;
    link?: { url: string };
  };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
  };
};

const truncate = (text: string | undefined, max: number = MAX_RICH_TEXT_LENGTH): string =>
  (text ?? "").slice(0, max);

/**
 * Resolves a possibly relative URL against the article URL. Returns null for
 * anything Notion would reject (non-http(s), unparsable or too long).
 */
export function resolveHttpUrl(value: string | undefined, baseUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href.length <= MAX_URL_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

const text = (content: string, extra: Partial<RichText> = {}): RichText => ({
  type: "text",
  text: { content },
  ...extra,
});

const endsWithSpace = (items: RichText[]): boolean =>
  items.length === 0 || items[items.length - 1].text.content.endsWith(" ");

/** Splits rich text items longer than Notion's per-item limit, keeping link and annotations. */
function splitLongItems(items: RichText[]): RichText[] {
  return items.flatMap((item) => {
    const { content } = item.text;
    if (content.length <= MAX_RICH_TEXT_LENGTH) return [item];

    const parts: RichText[] = [];
    for (let start = 0; start < content.length; start += MAX_RICH_TEXT_LENGTH) {
      parts.push({
        ...item,
        text: { ...item.text, content: content.slice(start, start + MAX_RICH_TEXT_LENGTH) },
      });
    }
    return parts;
  });
}

/** Groups rich text into paragraph blocks within Notion's length and item limits. */
function toParagraphBlocks(items: RichText[]): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [];
  let current: RichText[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length > 0) {
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: current } });
    }
    current = [];
    currentLength = 0;
  };

  for (const item of splitLongItems(items)) {
    const length = item.text.content.length;
    if (
      currentLength + length > MAX_RICH_TEXT_LENGTH ||
      current.length >= MAX_RICH_TEXT_ITEMS
    ) {
      flush();
    }
    current.push(item);
    currentLength += length;
  }
  flush();

  return blocks;
}

/**
 * Converts article HTML into Notion blocks: paragraphs (with links, bold,
 * italic and underline) and images. Text outside <p> elements is ignored.
 */
export function htmlToBlocks(html: string, baseUrl: string): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [];

  const processChildren = (node: HTMLElement, richText: RichText[]) => {
    node.childNodes.forEach((child: Node) => {
      if (child instanceof HTMLElement || child instanceof TextNode) {
        processNode(child, richText);
      }
    });
  };

  const processNode = (node: HTMLElement | TextNode, richText: RichText[] = []): void => {
    if (node instanceof TextNode) {
      const content = node.text.trim();
      if (content) richText.push(text(content));
      return;
    }

    switch (node.tagName) {
      case "P": {
        const paragraph: RichText[] = [];
        processChildren(node, paragraph);
        blocks.push(...toParagraphBlocks(paragraph));
        break;
      }
      case "A": {
        const linkText = node.text.trim();
        if (!linkText) break;

        if (!endsWithSpace(richText)) richText.push(text(" "));
        const url = resolveHttpUrl(node.getAttribute("href"), baseUrl);
        richText.push(text(linkText, url ? { text: { content: linkText, link: { url } } } : {}));
        richText.push(text(" "));
        break;
      }
      case "IMG": {
        // URLs are case-sensitive, so the src is kept as is
        const url = resolveHttpUrl(node.getAttribute("src"), baseUrl);
        if (url) {
          blocks.push({ object: "block", type: "image", image: { type: "external", external: { url } } });
        }
        break;
      }
      case "B":
      case "STRONG":
      case "I":
      case "EM":
      case "U": {
        const annotation: RichText["annotations"] =
          node.tagName === "B" || node.tagName === "STRONG"
            ? { bold: true }
            : node.tagName === "U"
              ? { underline: true }
              : { italic: true };

        const children: RichText[] = [];
        processChildren(node, children);
        children.forEach((child) => {
          child.annotations = { ...child.annotations, ...annotation };
        });

        if (!endsWithSpace(richText)) richText.push(text(" "));
        richText.push(...children);
        if (!endsWithSpace(children)) richText.push(text(" "));
        break;
      }
      default:
        processChildren(node, richText);
        break;
    }
  };

  parse(html).childNodes.forEach((child: Node) => {
    if (child instanceof HTMLElement || child instanceof TextNode) {
      processNode(child);
    }
  });

  return blocks.slice(0, MAX_BODY_LENGTH);
}

export interface NotionClientOptions {
  token?: string;
  databaseId?: string;
}

export class NotionClient {
  private notion: Client;
  private token: string;
  private databaseId: string;

  constructor(options: NotionClientOptions = {}) {
    this.token = options.token ?? config.notion.token;
    this.databaseId = options.databaseId ?? config.notion.databaseId;
    this.notion = new Client({ auth: this.token });
  }

  public isConfigured(): boolean {
    return Boolean(this.token && this.databaseId);
  }

  private buildProperties(entry: IEntry): CreatePageParameters["properties"] {
    return {
      title: {
        title: [{ text: { content: truncate(entry.title) } }],
      },
      author: {
        rich_text: [{ text: { content: truncate(entry.author) } }],
      },
      link: {
        url: entry.link ?? "",
      },
      entryDate: {
        date: {
          start: entry.entryDate.toISOString(),
        },
      },
      summary: {
        rich_text: [{ text: { content: truncate(entry.summary) } }],
      },
    };
  }

  /** Finds a page in the database with this exact link, if there is one. */
  private async findPageByLink(link: string): Promise<string | null> {
    const { results } = await this.notion.databases.query({
      database_id: this.databaseId,
      filter: { property: "link", url: { equals: link } },
      page_size: 1,
    });

    return results[0]?.id ?? null;
  }

  private async hasContent(pageId: string): Promise<boolean> {
    const { results } = await this.notion.blocks.children.list({
      block_id: pageId,
      page_size: 1,
    });
    return results.length > 0;
  }

  /**
   * Writes an entry to Notion: updates the page that already has this link, or
   * creates one. Existing pages keep their id, comments and creation date, and
   * content is only added when the page has none, so nothing is duplicated.
   * Throws on failure so the queue can retry.
   */
  public async syncEntry(entry: IEntry): Promise<"created" | "updated"> {
    if (!this.isConfigured()) {
      throw new Error("Notion token or database ID not configured");
    }

    const properties = this.buildProperties(entry);
    const children = entry.content ? htmlToBlocks(entry.content, entry.link) : [];
    const existingPageId = await this.findPageByLink(entry.link);

    if (!existingPageId) {
      await this.notion.pages.create({
        parent: { type: "database_id", database_id: this.databaseId },
        properties,
        children,
      });
      logger.info(`Created Notion page for entry: ${entry.entryId}`);
      return "created";
    }

    await this.notion.pages.update({ page_id: existingPageId, properties });

    if (children.length > 0 && !(await this.hasContent(existingPageId))) {
      await this.notion.blocks.children.append({
        block_id: existingPageId,
        children,
      });
    }

    logger.info(`Updated existing Notion page for entry: ${entry.entryId}`);
    return "updated";
  }

  public async testConnection(): Promise<boolean> {
    try {
      if (!this.isConfigured()) {
        logger.error("Notion token or database ID not configured");
        return false;
      }

      await this.notion.databases.retrieve({
        database_id: this.databaseId,
      });

      logger.info("Notion connection test successful");
      return true;
    } catch (error) {
      logger.error("Notion connection test failed:", error);
      return false;
    }
  }
}
