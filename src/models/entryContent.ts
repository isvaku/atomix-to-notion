import { gunzipSync, gzipSync } from "zlib";
import { IEntry } from "./Entry";

/**
 * Article HTML is stored gzipped: it compresses to about a third of its size
 * and only ever leaves the database on its way to Notion.
 */
export interface PackedContent {
  contentGzip: Buffer;
  contentBytes: number;
}

export function packContent(html: string): PackedContent {
  return {
    contentGzip: gzipSync(Buffer.from(html, "utf8")),
    contentBytes: Buffer.byteLength(html, "utf8"),
  };
}

type ContentFields = Pick<IEntry, "content" | "contentGzip">;

/**
 * The article HTML, whichever way it was stored. Rows written before
 * compression keep plain `content`; a row whose content was dropped by the
 * retention setting returns "".
 */
export function readContent(entry: ContentFields): string {
  if (entry.contentGzip) {
    try {
      return gunzipSync(entry.contentGzip).toString("utf8");
    } catch {
      // Unreadable compressed content is treated as missing, not as a crash:
      // the entry still has its title, link and date
      return "";
    }
  }
  return entry.content ?? "";
}
