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
  nextPageSelector?: string; // Optional field
  nextPageLoadsInSamePage: boolean;
  selectors: SourceSelectors;
}

export const config = {
  // Database Configuration
  database: {
    uri: process.env.MONGODB_URI || "localhost:27017/gaming-news-crawler",
    name: process.env.DB_NAME || "gaming-news-crawler",
    options: {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
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
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    timeout: 30000,
    retries: 3,
    retryDelay: 2000,
    maxPages: parseInt(process.env.MAX_PAGES || "10"),
  },

  // Notion Sync Configuration
  notionSync: {
    interval: process.env.NOTION_SYNC_INTERVAL || "0 */4 * * *", // Every 4 hours
    batchSize: 100,
  },

  // Gaming News Sources
  sources: [
    {
      name: "Atomix",
      url: "https://atomix.vg",
      listingPath: "/seccion/noticias",
      nextPageSelector: "div.pagination-center > span", // Example selector for next page
      nextPageLoadsInSamePage: true, // Navigate to new page
      selectors: {
        articleLinks: 'div.archivefit .post div.twelve.columns h2 a[href*="/"]',
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
