import puppeteer, { Browser, Page } from "puppeteer";
import * as cheerio from "cheerio";
import { config, Source } from "../config";
import { logger } from "./logger";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

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

// Titles Cloudflare shows while its challenge is running
const CHALLENGE_TITLES = ["Just a moment", "Un momento"];

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

export class WebScraper {
  private timeout: number;
  private retries: number;
  private retryDelay: number;
  private browser: Browser | null = null;
  private page: Page | null = null;
  // Origin whose Cloudflare challenge the current page has already passed
  private verifiedOrigin: string | null = null;
  // Serializes browser use: several queue workers share this one Chromium
  private lock: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.timeout = config.crawler.timeout;
    this.retries = config.crawler.retries;
    this.retryDelay = config.crawler.retryDelay;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Runs fn with exclusive use of the browser. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = async () => {
      this.cancelIdleClose();
      try {
        return await fn();
      } finally {
        this.scheduleIdleClose();
      }
    };
    const run = this.lock.then(task, task);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // Chromium uses a lot of memory on a Pi, so it's closed when nothing needs it
  private cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    if (!this.browser) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      logger.debug("Closing idle browser");
      void this.lock.then(() => this.closeBrowser());
    }, config.crawler.browser.idleCloseMs);
    this.idleTimer.unref();
  }

  public isBrowserOpen(): boolean {
    return this.browser !== null;
  }

  private async initBrowser(): Promise<Page> {
    if (this.browser?.connected && this.page && !this.page.isClosed()) {
      return this.page;
    }
    if (this.browser) {
      // Chromium crashed or the page died: start over
      await this.closeBrowser();
    }

    const { browser: browserConfig } = config.crawler;

    // Cloudflare blocks headless browsers, so Chromium runs headful. In Docker the
    // window lives in a virtual display (Xvfb, see docker-entrypoint.sh).
    this.browser = await puppeteer.launch({
      headless: browserConfig.headless,
      browser: "chrome",
      executablePath: browserConfig.executablePath,
      timeout: browserConfig.timeout,
      protocolTimeout: browserConfig.timeout,
      args: [
        "--disable-blink-features=AutomationControlled",
        // Keep writes off the disk (SD card): no crash dumps, minimal disk cache
        "--disable-breakpad",
        "--disk-cache-size=1",
        "--window-size=1366,768",
        ...(browserConfig.noSandbox
          ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
          : []),
        ...(browserConfig.disableGpu
          ? ["--disable-gpu", "--in-process-gpu", "--no-zygote"]
          : []),
      ],
    });

    const browser = this.browser;
    browser.on("disconnected", () => {
      // closeBrowser() clears this.browser first, so a match means Chromium died
      if (this.browser === browser) {
        logger.warn("Chromium disconnected unexpectedly");
        this.browser = null;
        this.page = null;
        this.verifiedOrigin = null;
      }
    });

    this.page = (await this.browser.pages())[0] ?? (await this.browser.newPage());
    this.verifiedOrigin = null;
    return this.page;
  }

  /**
   * Loads the site in the browser and waits until the Cloudflare challenge is
   * solved. Afterwards requests made from inside the page carry its cookies.
   */
  private async passChallenge(origin: string, attempt: number = 1): Promise<Page> {
    const page = await this.initBrowser();

    if (this.verifiedOrigin === origin) {
      return page;
    }

    try {
      logger.info(`Opening ${origin} in the browser (attempt ${attempt})`);
      await page.goto(origin, {
        waitUntil: "domcontentloaded",
        timeout: config.crawler.browser.timeout,
      });
      await page.waitForFunction(
        (titles: string[]) =>
          document.readyState !== "loading" &&
          !titles.some((title) => document.title.includes(title)),
        { timeout: config.crawler.browser.timeout, polling: 1000 },
        CHALLENGE_TITLES
      );

      this.verifiedOrigin = origin;
      logger.info(`Passed Cloudflare check for ${origin}`);
      return page;
    } catch (error) {
      logger.warn(`Failed to load ${origin} on attempt ${attempt}:`, error);

      if (attempt < this.retries) {
        // Start over with a fresh browser in case it got stuck
        await this.closeBrowser();
        await this.delay(this.retryDelay * attempt);
        return this.passChallenge(origin, attempt + 1);
      }

      throw error;
    }
  }

  /**
   * Requests a URL with fetch() from inside the browser page, so the request
   * goes through with the Cloudflare clearance cookies.
   */
  private async browserFetch(
    url: string,
    method: "GET" | "POST" = "GET",
    attempt: number = 1
  ): Promise<string> {
    const { origin } = new URL(url);

    try {
      logger.debug(`Fetching URL: ${url} (attempt ${attempt})`);
      const page = await this.passChallenge(origin);

      const response = await page.evaluate(
        async (target: string, requestMethod: string, timeout: number) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const res = await fetch(target, {
              method: requestMethod,
              credentials: "include",
              signal: controller.signal,
            });
            return { status: res.status, body: await res.text() };
          } finally {
            clearTimeout(timer);
          }
        },
        url,
        method,
        this.timeout
      );

      if (response.status !== 200) {
        if (response.status === 403 || response.status === 503) {
          // Clearance expired, solve the challenge again on the next attempt
          this.verifiedOrigin = null;
        }
        throw new Error(`Request to ${url} failed with status ${response.status}`);
      }

      return response.body;
    } catch (error) {
      logger.warn(`Failed to fetch ${url} on attempt ${attempt}:`, error);

      if (attempt < this.retries) {
        await this.delay(this.retryDelay * attempt);
        return this.browserFetch(url, method, attempt + 1);
      }

      throw error;
    }
  }

  public async getArticleLinks(source: Source): Promise<string[]> {
    return this.exclusive(() => this.collectArticleLinks(source));
  }

  private async collectArticleLinks(source: Source): Promise<string[]> {
    try {
      const links = source.listingApi
        ? await this.getLinksFromApi(source)
        : await this.getLinksFromListingPage(source);

      // Remove duplicates and filter valid URLs
      const uniqueLinks = [...new Set(links)].filter(
        (link) =>
          link.includes("http") &&
          !link.includes("#") &&
          !link.includes("javascript:")
      );

      logger.info(`Found ${uniqueLinks.length} article links from ${source.url}`);
      return uniqueLinks.slice(0, config.crawler.maxArticlesPerRun);
    } catch (error) {
      logger.error(`Failed to get article links from ${source.url}:`, error);
      return [];
    }
  }

  /**
   * Uses the JSON endpoint behind Atomix's "siguiente" button. Each call returns
   * the newest articles that are not in `excludeids`.
   */
  private async getLinksFromApi(source: Source): Promise<string[]> {
    const { maxPages, maxArticlesPerRun } = config.crawler;
    const pageSize = Math.min(maxArticlesPerRun, 100);
    const seenIds: string[] = [];
    const links: string[] = [];

    for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
      const apiUrl =
        `${source.url}${source.listingApi}?top=${pageSize}` +
        `&excludeids=${seenIds.join(",")}`;
      const body = await this.browserFetch(apiUrl, "POST");
      const items: { IdNota: string; url: string; TipoNota: string }[] =
        JSON.parse(body).items ?? [];

      if (items.length === 0) {
        logger.info("No more pages found");
        break;
      }

      for (const item of items) {
        seenIds.push(item.IdNota);
        if (source.listingApiExcludeTypes?.includes(item.TipoNota)) continue;
        links.push(new URL(item.url, source.url).href);
      }

      logger.info(`Found ${items.length} links on page ${currentPage}`);

      if (links.length >= maxArticlesPerRun) break;
    }

    return links;
  }

  private async getLinksFromListingPage(source: Source): Promise<string[]> {
    const linkSelector = source.selectors.articleLinks;
    const page = await this.passChallenge(new URL(source.url).origin);
    const fullUrl = `${source.url}${source.listingPath}`;

    if (page.url() !== fullUrl) {
      await page.goto(fullUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.crawler.browser.timeout,
      });
    }

    const links: string[] = [];
    let currentPage = 1;
    const { maxPages } = config.crawler;

    while (currentPage <= maxPages) {
      try {
        await page.waitForSelector(linkSelector, { timeout: 20000 });
      } catch (error) {
        logger.warn(`Selector ${linkSelector} not found on page ${currentPage}`, error);
        break;
      }

      const pageLinks = await page.evaluate(
        (selector: string, baseUrl: string) =>
          Array.from(document.querySelectorAll(selector))
            .map((element) => element.getAttribute("href"))
            .filter((href): href is string => !!href)
            .map((href) => new URL(href, baseUrl).href),
        linkSelector,
        source.url
      );

      links.push(...pageLinks);
      logger.info(`Found ${pageLinks.length} links on page ${currentPage}`);

      if (!source.nextPageSelector || !(await page.$(source.nextPageSelector))) {
        break;
      }

      try {
        if (source.nextPageLoadsInSamePage) {
          await page.click(source.nextPageSelector);
          await this.delay(4000);
          await page.waitForSelector(linkSelector, { timeout: 5000 });
        } else {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded" }),
            page.click(source.nextPageSelector),
          ]);
        }
        currentPage++;
      } catch (error) {
        logger.warn(`Failed to navigate to next page: ${error}`);
        break;
      }
    }

    return links;
  }

  public async scrapeArticle(
    url: string,
    source: Source
  ): Promise<ScrapedArticle | null> {
    return this.exclusive(() => this.scrape(url, source));
  }

  private async scrape(url: string, source: Source): Promise<ScrapedArticle | null> {
    try {
      logger.debug(`Scraping article: ${url}`);
      const html = await this.browserFetch(url);
      const article = parseArticle(html, url, source);
      logger.debug(`Successfully scraped article: ${url}`);
      return article;
    } catch (error) {
      logger.error(`Failed to scrape article ${url}:`, error);
      return null;
    }
  }

  /** Closes Chromium once any job using it has finished. */
  public async close(): Promise<void> {
    this.cancelIdleClose();
    await this.lock;
    await this.closeBrowser();
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.verifiedOrigin = null;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
