import { config } from "../config";
import { logger } from "./logger";

export const TELEGRAM_MAX_LENGTH = 4096;
// Longest list of links per section; the rest are summarized
const MAX_LISTED = 50;

export interface ReportData {
  since: Date;
  failedSyncs: { title: string; link: string; error?: string }[];
  failedSyncTotal: number;
  failedCrawls: { link: string; error?: string }[];
  failedCrawlTotal: number;
  savedCount: number;
  pendingCrawls: number;
  pendingSyncs: number;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function reportNeedsAttention(data: ReportData): boolean {
  return data.failedSyncs.length > 0 || data.failedCrawls.length > 0 || data.savedCount === 0;
}

function listSection<T>(items: T[], render: (item: T) => string): string[] {
  const lines = items.slice(0, MAX_LISTED).map(render);
  if (items.length > MAX_LISTED) {
    lines.push(`… and ${items.length - MAX_LISTED} more`);
  }
  return lines;
}

/** Builds the daily report as Telegram HTML. */
export function buildReport(data: ReportData): string {
  const lines: string[] = ["<b>📰 Atomix → Notion: daily report</b>", ""];

  lines.push(
    data.savedCount === 0
      ? "⚠️ <b>No articles saved in the last 24h.</b> The crawler may be blocked (Cloudflare) or the site changed."
      : `✅ Articles saved in the last 24h: <b>${data.savedCount}</b>`
  );
  lines.push(`Queued: ${data.pendingCrawls} to crawl, ${data.pendingSyncs} to sync`, "");

  lines.push(
    `<b>Failed Notion syncs (24h): ${data.failedSyncs.length}</b> — ${data.failedSyncTotal} failed in total`
  );
  lines.push(
    ...listSection(data.failedSyncs, (item) => {
      const title = escapeHtml(item.title || item.link);
      const error = item.error ? `\n   <i>${escapeHtml(item.error.slice(0, 200))}</i>` : "";
      return `• <a href="${escapeHtml(item.link)}">${title}</a>${error}`;
    })
  );
  lines.push("");

  lines.push(
    `<b>Failed crawls (24h): ${data.failedCrawls.length}</b> — ${data.failedCrawlTotal} failed in total`
  );
  lines.push(
    ...listSection(data.failedCrawls, (item) => {
      const error = item.error ? `\n   <i>${escapeHtml(item.error.slice(0, 200))}</i>` : "";
      return `• ${escapeHtml(item.link)}${error}`;
    })
  );

  if (data.failedSyncTotal > 0 || data.failedCrawlTotal > 0) {
    lines.push("", "Retry them from the dashboard or with <code>pnpm retry-failed</code>.");
  }

  return lines.join("\n");
}

/** Splits text into Telegram-sized messages, on line boundaries when possible. */
export function splitMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
  const messages: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    // A single line longer than the limit is hard-split
    const pieces = line.length > maxLength ? line.match(new RegExp(`.{1,${maxLength}}`, "gs")) ?? [] : [line];

    for (const piece of pieces) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (candidate.length > maxLength) {
        messages.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }

  if (current) messages.push(current);
  return messages;
}

export function isTelegramConfigured(): boolean {
  return Boolean(config.report.telegram.botToken && config.report.telegram.chatId);
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const { botToken, chatId } = config.report.telegram;
  if (!botToken || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set");
  }

  for (const message of splitMessage(text)) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // Don't log the URL: it contains the bot token
      throw new Error(`Telegram API responded ${response.status}: ${await response.text()}`);
    }
  }

  logger.info("Sent Telegram report");
}
