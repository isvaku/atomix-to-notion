import puppeteer, { Browser, Page } from "puppeteer";
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

export class WebScraper {
  private userAgent: string;
  private timeout: number;
  private retries: number;
  private retryDelay: number;
  private browser: Browser | null = null;

  constructor() {
    this.userAgent = config.crawler.userAgent;
    this.timeout = config.crawler.timeout;
    this.retries = config.crawler.retries;
    this.retryDelay = config.crawler.retryDelay;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async initBrowser(): Promise<void> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        browser: "firefox",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
      });
    }
  }

  private async fetchWithRetry(
    url: string,
    attempt: number = 1
  ): Promise<Page> {
    try {
      logger.debug(`Fetching URL: ${url} (attempt ${attempt})`);

      await this.initBrowser();
      const page = await this.browser!.newPage();

      await page.setUserAgent(this.userAgent);
      await page.setViewport({ width: 1366, height: 768 });

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: this.timeout,
      });

      return page;
    } catch (error) {
      logger.warn(`Failed to fetch ${url} on attempt ${attempt}:`, error);

      if (attempt < this.retries) {
        await this.delay(this.retryDelay * attempt);
        return this.fetchWithRetry(url, attempt + 1);
      }

      throw error;
    }
  }

  public async getArticleLinks(
    sourceUrl: string,
    listingPath: string,
    linkSelector: string,
    nextPageSelector?: string,
    nextPageLoadsInSamePage: boolean = false
  ): Promise<string[]> {
    let page: Page | null = null;

    try {
      const fullUrl = `${sourceUrl}${listingPath}`;
      page = await this.fetchWithRetry(fullUrl);

      const links: string[] = [];
      let currentPage = 1;
      const { maxPages } = config.crawler;

      while (currentPage <= maxPages) {
        // Wait for content to load
        try {
          await page.waitForSelector(linkSelector, { timeout: 10000 });
        } catch (error) {
          logger.warn(
            `Selector ${linkSelector} not found on page ${currentPage}`,
            error
          );
          break;
        }

        // Extract links from current page
        const pageLinks = await page.evaluate(
          (selector: string, baseUrl: string) => {
            const links: string[] = [];
            const elements = document.querySelectorAll(selector);

            elements.forEach((element: Element) => {
              const href = element.getAttribute("href");
              const isAbsolute = href?.startsWith("http");
              if (href) {
                const absoluteUrl = isAbsolute ? href : `${baseUrl}/${href}`;
                links.push(absoluteUrl);
              }
            });

            return links;
          },
          linkSelector,
          sourceUrl
        );

        links.push(...pageLinks);
        logger.info(`Found ${pageLinks.length} links on page ${currentPage}`);

        // Check for next page
        if (nextPageSelector) {
          await page.waitForSelector(nextPageSelector, { timeout: 5000 });
          const nextPageExists = await page.$(nextPageSelector);

          if (nextPageExists) {
            try {
              if (nextPageLoadsInSamePage) {
                // Click and wait for content to reload in the same page
                await page.evaluate((selector) => {
                  const el = document.querySelector(selector);
                  if (el) (el as HTMLElement).click();
                }, nextPageSelector);
                await this.delay(4000); // Wait for content to load
                await page.waitForSelector(linkSelector, { timeout: 5000 });
              } else {
                // Click and wait for navigation to new page
                await Promise.all([
                  page.waitForNavigation({ waitUntil: "networkidle2" }),
                  page.click(nextPageSelector),
                ]);
              }

              currentPage++;
            } catch (error) {
              logger.warn(`Failed to navigate to next page: ${error}`);
              break;
            }
          } else {
            logger.info("No more pages found");
            break;
          }
        } else {
          break;
        }
      }

      // Remove duplicates and filter valid URLs
      const uniqueLinks = [...new Set(links)].filter(
        (link) =>
          link.includes("http") &&
          !link.includes("#") &&
          !link.includes("javascript:")
      );

      logger.info(
        `Found ${uniqueLinks.length} article links from ${sourceUrl}`
      );
      return uniqueLinks.slice(0, config.crawler.maxArticlesPerRun);
    } catch (error) {
      logger.error(`Failed to get article links from ${sourceUrl}:`, error);
      return [];
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  public async scrapeArticle(
    url: string,
    source: Source
  ): Promise<ScrapedArticle | null> {
    let page: Page | null = null;

    try {
      page = await this.fetchWithRetry(url);

      if (!page) {
        logger.error(`Failed to open page for URL: ${url}`);
        return null;
      }

      // Wait for main content to load
      if (source.selectors.content) {
        const contentSelectors = source.selectors.content.split(", ");
        try {
          await page.waitForSelector(contentSelectors[0], { timeout: 5000 });
        } catch (error) {
          logger.warn(`Content selector not found for ${url}:`, error);
        }
      }

      // Extract article data using page.evaluate with plain JavaScript
      // Use Puppeteer's page.$eval and page.$$eval instead of page.evaluate
      // Helper to get text from selectors
      async function getTextFromSelectors(
        selectorString: string
      ): Promise<string> {
        if (!selectorString) return "";
        const selectorList = selectorString.split(", ");
        for (const selector of selectorList) {
          try {
            const text = await page?.$eval(
              selector,
              (el) => el.textContent?.trim() || ""
            );
            if (text) return text;
          } catch {
            /* ignore */
          }
        }
        return "";
      }

      // Helper to get content from selectors (multiple elements)
      async function getContentFromSelectors(
        selectorString: string
      ): Promise<string> {
        if (!selectorString) return "";
        const selectorList = selectorString.split(", ");
        for (const selector of selectorList) {
          try {
            const contents =
              (await page?.$$eval(selector, (elements) =>
                elements
                  .map((el) => el.outerHTML.trim())
                  .filter((html) => html.length > 0)
              )) ?? [];
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
            const className = await page.$eval(
              selector,
              (el) => el.getAttribute("class") || ""
            );
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

      let dateText = await getTextFromSelectors(source.selectors.date);
      let parsedDate: Date;
      if (source.dateFormat && dateText) {
        if (source.name === "Atomix") {
          dateText = dateText.replace(".", "").trim();
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
        title: await getTextFromSelectors(source.selectors.title),
        author: await getTextFromSelectors(source.selectors.author),
        content: await getContentFromSelectors(source.selectors.content),
        summary: await getTextFromSelectors(source.selectors.summary ?? ""),
        link: url,
        date: parsedDate,
      };

      logger.info(`Scraped article data from ${url}`);
      return articleData;
    } catch (error) {
      logger.error(`Failed to scrape article ${url}:`, error);
      return null;
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
