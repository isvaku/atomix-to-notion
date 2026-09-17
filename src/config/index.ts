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

export const config = {
  // Database Configuration
  database: {
    uri: process.env.MONGODB_URI || "localhost:27017/gaming-news-crawler",
    options: {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 50000,
      socketTimeoutMS: 45000,
      bufferCommands: false,
    },
  },

  // Notion Configuration
  notion: {
    token: process.env.NOTION_TOKEN || "",
    databaseId: process.env.NOTION_DATABASE_ID || "",
  },

  // Crawler Configuration
  crawler: {
    interval: process.env.CRAWLER_INTERVAL || "0 */6 * * *", // Every 6 hours
    maxArticlesPerRun: parseInt(process.env.MAX_ARTICLES_PER_RUN || "100"),
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    timeout: 30000,
    retries: 3,
    retryDelay: 20000,
    maxPages: parseInt(process.env.MAX_PAGES || "10"),
    browser: {
      // Cloudflare blocks headless mode; in Docker Chromium runs headful inside Xvfb
      headless: process.env.BROWSER_HEADLESS === "true",
      // Puppeteer ships no Chrome for Linux ARM, so Docker uses the system Chromium
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      noSandbox: process.env.CHROME_NO_SANDBOX === "true",
      // Containers have no GPU; without this Chromium's GPU process crashes on arm64
      disableGpu: process.env.CHROME_DISABLE_GPU === "true",
      // A Raspberry Pi starts Chromium and solves the challenge much slower than a PC
      timeout: parseInt(process.env.BROWSER_TIMEOUT_MS || "180000"),
    },
  },

  // Notion Sync Configuration
  notionSync: {
    interval: process.env.NOTION_SYNC_INTERVAL || "0 */4 * * *", // Every 4 hours
    batchSize: parseInt(process.env.NOTION_SYNC_BATCH_SIZE || "10"),
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
  },

  // Environment
  env: process.env.NODE_ENV || "development",
};
