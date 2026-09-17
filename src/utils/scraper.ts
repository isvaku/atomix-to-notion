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

export class WebScraper {
  private timeout: number;
  private retries: number;
  private retryDelay: number;
  private browser: Browser | null = null;
  private page: Page | null = null;
  // Origin whose Cloudflare challenge the current page has already passed
  private verifiedOrigin: string | null = null;

  constructor() {
    this.timeout = config.crawler.timeout;
    this.retries = config.crawler.retries;
    this.retryDelay = config.crawler.retryDelay;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async initBrowser(): Promise<Page> {
    if (this.browser && this.page && !this.page.isClosed()) {
      return this.page;
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
        "--window-size=1366,768",
        ...(browserConfig.noSandbox
          ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
          : []),
        ...(browserConfig.disableGpu
          ? ["--disable-gpu", "--in-process-gpu", "--no-zygote"]
          : []),
      ],
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
        await this.close();
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
    try {
      logger.debug(`Scraping article: ${url}`);

      const html = await this.browserFetch(url);
      const $ = cheerio.load(html);

      // Helper to get text from selectors
      function getTextFromSelectors(selectorString: string): string {
        if (!selectorString) return "";
        const selectorList = selectorString.split(", ");
        for (const selector of selectorList) {
          try {
            const text = $(selector).first().text().trim();
            if (text) return text;
          } catch {
            /* ignore */
          }
        }
        return "";
      }

      // Helper to get content from selectors (multiple elements with HTML)
      function getContentFromSelectors(selectorString: string): string {
        if (!selectorString) return "";
        const selectorList = selectorString.split(", ");
        for (const selector of selectorList) {
          try {
            const contents: string[] = [];
            $(selector).each((_, element) => {
              const html = $(element).html()?.trim();
              if (html && html.length > 0) {
                contents.push(html);
              }
            });
            if (contents.length > 0) return contents.join("\n\n");
          } catch {
            /* ignore */
          }
        }
        return "";
      }

      // Get entryId
      let entryId = "";
      if (source.selectors.entryId) {
        const selectorList = source.selectors.entryId.split(", ");
        for (const selector of selectorList) {
          try {
            const className = $(selector).first().attr("class") || "";
            const classArray = className.split(" ");
            for (const classItem of classArray) {
              if (classItem.startsWith("post-")) {
                if (source.name === "Atomix") {
                  entryId = `${source.url}/?p=${classItem.split("-")[1] || ""}`;
                } else {
                  entryId = classItem.split("-")[1] || "";
                }
                if (entryId) break;
              }
            }
            if (entryId) break;
          } catch {
            /* ignore */
          }
        }
      }
      if (!entryId) {
        const urlParts = url.split("/");
        const lastPart = urlParts[urlParts.length - 1];
        if (lastPart) {
          entryId = lastPart.replace(/[^a-zA-Z0-9]/g, "");
        }
      }

      // Parse date
      let dateText = getTextFromSelectors(source.selectors.date);
      let parsedDate: Date;
      if (source.dateFormat && dateText) {
        if (source.name === "Atomix") {
          // "15/09/2026 4:47 p. m." -> "15/09/2026 4:47 pm" (dayjs only knows lowercase am/pm)
          dateText = dateText.replace(/([ap])\.?\s*m\.?/i, (_, ap: string) => `${ap.toLowerCase()}m`).trim();
        }
        const dayjsDate = dayjs(dateText, source.dateFormat);
        parsedDate = dayjsDate.isValid()
          ? dayjsDate.toDate()
          : dayjs().toDate();
      } else {
        parsedDate = new Date(dateText);
      }

      const articleData: ScrapedArticle = {
        entryId,
        title: getTextFromSelectors(source.selectors.title),
        author: getTextFromSelectors(source.selectors.author),
        content: getContentFromSelectors(source.selectors.content),
        summary: getTextFromSelectors(source.selectors.summary ?? ""),
        link: url,
        date: parsedDate,
      };

      logger.info(`Successfully scraped article: ${url}`);
      return articleData;
    } catch (error) {
      logger.error(`Failed to scrape article ${url}:`, error);
      return null;
    }
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      this.page = null;
      this.verifiedOrigin = null;
    }
  }
}
