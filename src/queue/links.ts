import { createHash } from "crypto";
import { Source } from "../config";

export type LinkCheck =
  | { ok: true; link: string; source: Source }
  | { ok: false; link: string; reason: "invalid-url" | "unsupported-host" };

/** Canonical form of an article URL: https, no hash/query, no trailing slash. */
export function normalizeLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "https:";
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./, "");
    const href = url.href;
    return href.endsWith("/") && url.pathname !== "/" ? href.slice(0, -1) : href;
  } catch {
    return null;
  }
}

/** Normalizes a link and matches it to a configured source by host. */
export function checkLink(value: string, sources: Source[]): LinkCheck {
  const link = normalizeLink(value);
  if (!link) return { ok: false, link: value, reason: "invalid-url" };

  const { hostname, pathname } = new URL(link);
  const source = sources.find(
    (candidate) => new URL(candidate.url).hostname.replace(/^www\./, "") === hostname
  );
  if (!source || pathname === "/") {
    return { ok: false, link, reason: source ? "invalid-url" : "unsupported-host" };
  }
  return { ok: true, link, source };
}

/** BullMQ job ids can't contain ":", so links are identified by a hash. */
export function crawlJobId(link: string): string {
  return `crawl-${createHash("sha1").update(link).digest("hex")}`;
}

export function notionJobId(entryId: string): string {
  return `notion-${entryId}`;
}
