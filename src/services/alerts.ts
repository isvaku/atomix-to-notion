import { config } from "../config";
import { redis } from "../queue/connection";
import { logger } from "../utils/logger";
import { escapeHtml, isTelegramConfigured, sendTelegramMessage } from "../utils/telegram";

const COOLDOWN_KEY = "alerts:discover-failed";

/**
 * Pings the external watchdog (healthchecks.io or similar) to say the crawler
 * is alive. The watchdog alerts when the pings stop, which covers the app
 * being down, the Pi losing power and the network dropping - none of which the
 * app itself can report.
 */
export async function pingWatchdog(): Promise<void> {
  const { pingUrl } = config.alerts;
  if (!pingUrl) return;

  try {
    const response = await fetch(pingUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      logger.warn(`Watchdog ping responded ${response.status}`);
    }
  } catch (error) {
    // A failed ping must never fail the job that triggered it
    logger.warn("Watchdog ping failed:", error);
  }
}

/**
 * Tells you straight away that discovery is failing, instead of waiting for
 * the daily report. Rate-limited, so an outage doesn't turn into a flood.
 */
export async function alertDiscoverFailed(error: Error): Promise<void> {
  if (!isTelegramConfigured()) return;

  const cooldownSeconds = config.alerts.discoverFailureCooldownMinutes * 60;
  // set NX: the first failure in the window wins, the rest are silent
  const firstInWindow = await redis.set(COOLDOWN_KEY, "1", "EX", cooldownSeconds, "NX");
  if (firstInWindow === null) return;

  const text = [
    "🚨 <b>Atomix crawler: discovery failed</b>",
    "",
    `<code>${escapeHtml(error.message.slice(0, 500))}</code>`,
    "",
    "No new articles are being found. Usually Cloudflare or a change to the site.",
    `Muted for ${config.alerts.discoverFailureCooldownMinutes} minutes.`,
  ].join("\n");

  await sendTelegramMessage(text).catch((sendError) => {
    logger.error("Could not send the discovery alert:", sendError);
  });
}
