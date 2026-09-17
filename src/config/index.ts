import dotenv from "dotenv";

dotenv.config();

// Define TypeScript types for the sources object
export interface SourceSelectors {
  articleLinks: string;
  title: string;
  author: string;
  content: string;
  date: string;
  entryId: string;
  summary?: string; // Optional field
}

export interface Source {
  name: string;
  url: string;
  listingPath: string;
  // Optional JSON endpoint (relative to url) that lists articles; used instead of listingPath
  listingApi?: string;
  // Article types (TipoNota) from listingApi to ignore
  listingApiExcludeTypes?: string[];
  nextPageSelector?: string; // Optional field
  nextPageLoadsInSamePage: boolean;
  dateFormat?: string; // Optional field
  selectors: SourceSelectors;
}

const env = process.env.NODE_ENV || "development";

const int = (value: string | undefined, fallback: number): number => {
  const parsed = parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const config = {
  // Database Configuration
  database: {
    // No default in production: a missing URI must fail fast, not hit localhost
    uri:
      process.env.MONGODB_URI ||
      (env === "production" ? "" : "mongodb://localhost:27017/gaming-news-crawler"),
    options: {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 50000,
      socketTimeoutMS: 45000,
      bufferCommands: false,
    },
  },

  // Redis (BullMQ queues)
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
    // Namespaces all BullMQ keys, so tests can use their own prefix
    prefix: process.env.QUEUE_PREFIX || "atomix",
  },

  // Timezone for all schedules (cron patterns)
  cronTimezone: process.env.TZ || "America/Mexico_City",

  // HTTP API
  server: {
    host: process.env.HOST || "0.0.0.0",
    port: int(process.env.PORT, 3000),
    apiKey: process.env.API_KEY || "",
    maxLinksPerRequest: 100,
  },

  // Notion Configuration
  notion: {
    token: process.env.NOTION_TOKEN || "",
    databaseId: process.env.NOTION_DATABASE_ID || "",
  },

  // Crawler Configuration
  crawler: {
    // How often new article links are discovered and queued
    interval: process.env.CRAWLER_INTERVAL || "*/15 * * * *",
    maxArticlesPerRun: int(process.env.MAX_ARTICLES_PER_RUN, 100),
    timeout: 30000,
    // In-request retries (e.g. an expired Cloudflare clearance); the queue retries on top
    retries: 2,
    retryDelay: 5000,
    maxPages: int(process.env.MAX_PAGES, 10),
    // Queue attempts per link before the crawl job is marked failed
    maxAttempts: int(process.env.CRAWL_MAX_ATTEMPTS, 3),
    browser: {
      // Cloudflare blocks headless mode; in Docker Chromium runs headful inside Xvfb
      headless: process.env.BROWSER_HEADLESS === "true",
      // Puppeteer ships no Chrome for Linux ARM, so Docker uses the system Chromium
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      noSandbox: process.env.CHROME_NO_SANDBOX === "true",
      // Containers have no GPU; without this Chromium's GPU process crashes on arm64
      disableGpu: process.env.CHROME_DISABLE_GPU === "true",
      // A Raspberry Pi starts Chromium and solves the challenge much slower than a PC
      timeout: int(process.env.BROWSER_TIMEOUT_MS, 180000),
      // Close Chromium when the crawl queue has been idle this long, to free memory
      idleCloseMs: int(process.env.BROWSER_IDLE_CLOSE_MS, 120000),
    },
  },

  // Notion Sync Configuration
  notionSync: {
    // Safety net: queues entries that aren't in Notion yet (new ones are queued right away)
    interval: process.env.NOTION_SYNC_INTERVAL || "0 * * * *",
    // Attempts per entry before it's marked failed
    maxAttempts: int(process.env.NOTION_SYNC_MAX_ATTEMPTS, 5),
    // Notion allows ~3 requests per second
    rateLimitPerSecond: 3,
  },

  // Alerting
  alerts: {
    // Pinged after every successful discover. An external watchdog
    // (e.g. healthchecks.io) alerts when the pings stop, which is the one
    // failure this app cannot report itself: being down.
    pingUrl: process.env.HEALTHCHECK_PING_URL || "",
    // Telegram message when discovery fails, at most once per this many minutes
    discoverFailureCooldownMinutes: int(process.env.DISCOVER_ALERT_COOLDOWN_MINUTES, 360),
  },

  // Daily report of failures, sent to Telegram
  report: {
    interval: process.env.REPORT_INTERVAL || "0 9 * * *",
    // Send even when nothing failed
    always: process.env.REPORT_ALWAYS === "true",
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_CHAT_ID || "",
    },
  },

  // Gaming News Sources
  sources: [
    {
      name: "Atomix",
      url: "https://atomix.vg",
      listingPath: "",
      // Same endpoint the "siguiente" button on the home page uses
      listingApi: "/funcionalidades/search/indexitems.aspx",
      // Video pages have a different layout and no title/content for the selectors below
      listingApiExcludeTypes: ["Video"],
      nextPageLoadsInSamePage: true,
      dateFormat: "DD/MM/YYYY h:mm a",
      selectors: {
        articleLinks:
          "div.wrapper-wide .post div.twelve.columns h1.featured-image-narrow-title a",
        title: "h1.featured-image-narrow-title",
        author:
          "div.single-post-content div.row span.author-dark a[rel='author']",
        content: "div.single-post-content div.row div.post-text",
        date: "div.single-post-content div.row span.date-dark",
        // The intro paragraph, which the page exposes as a meta tag
        summary: "meta[property='og:description'], meta[name='description']",
        entryId: "div.post",
      },
    },
    // {
    //   name: "IGN",
    //   url: "https://www.ign.com",
    //   listingPath: "/news",
    //   selectors: {
    //     articleLinks: 'a[href*="/articles/"]',
    //     title: "h1.headline, h1.article-headline",
    //     author: ".article-author a, .byline a",
    //     content: ".article-content p, .article-body p",
    //     summary: ".article-summary, .summary",
    //     date: "time[datetime], .publish-date",
    //   },
    // },
    // {
    //   name: "Polygon",
    //   url: "https://www.polygon.com",
    //   listingPath: "/gaming",
    //   selectors: {
    //     articleLinks: 'a[href*="/polygon/"]',
    //     title: "h1.duet--article--dangerously-set-cms-markup, h1.entry-title",
    //     author: ".byline-author, .author-name",
    //     content: ".duet--article--article-body p, .entry-content p",
    //     summary: ".entry-summary, .summary",
    //     date: "time[datetime], .publish-date",
    //   },
    // },
  ] as Source[],

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || "info",
    filePath: process.env.LOG_FILE_PATH || "./logs/app.log",
    // Docker logs go to stdout only (rotated by Docker) to spare the SD card
    toFile: process.env.LOG_TO_FILE !== "false",
  },

  // Environment
  env,
};
