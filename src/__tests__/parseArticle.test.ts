import { readFileSync } from "fs";
import path from "path";
import { config, Source } from "../config";
import { parseArticle } from "../utils/scraper";

// A real article page, saved so a site change shows up here instead of in production
const html = readFileSync(path.join(__dirname, "fixtures/atomix-article.html"), "utf8");
const url = "https://atomix.vg/review-code-vein-ii";
const source = config.sources.find((item) => item.name === "Atomix") as Source;

describe("parseArticle, on a saved Atomix article", () => {
  const article = parseArticle(html, url, source);

  it("reads the title", () => {
    expect(article.title).toBe("Review – Code Vein II");
  });

  it("reads the author", () => {
    expect(article.author).toBe("AldoLawson");
  });

  it("reads the publication date, in the afternoon", () => {
    // "26/01/2026 5:00 p. m."
    expect(article.date.getFullYear()).toBe(2026);
    expect(article.date.getMonth()).toBe(0);
    expect(article.date.getDate()).toBe(26);
    expect(article.date.getHours()).toBe(17);
  });

  it("reads the summary from the page's meta description", () => {
    expect(article.summary.length).toBeGreaterThan(50);
    expect(article.summary).toContain("El inicio de año");
  });

  it("takes the entry id from the post's CSS class", () => {
    expect(article.entryId).toMatch(/^https:\/\/atomix\.vg\/\?p=\d+$/);
  });

  it("keeps the article body, with its headings and images", () => {
    expect(article.content.length).toBeGreaterThan(1000);
    expect(article.content).toContain("<h2");
    expect(article.content).toContain("<img");
    expect(article.content).toContain("Code Vein II");
  });

  it("records the link it was given", () => {
    expect(article.link).toBe(url);
  });
});

describe("parseArticle, on a page that doesn't match", () => {
  it("returns empty fields and the current time rather than throwing", () => {
    const article = parseArticle("<html><body><p>nothing here</p></body></html>", url, source);

    expect(article.title).toBe("");
    expect(article.author).toBe("");
    expect(article.content).toBe("");
    // No usable date: falls back to now, and the worker rejects it for having no content
    expect(Date.now() - article.date.getTime()).toBeLessThan(5000);
    expect(article.entryId).toBe("reviewcodeveinii");
  });
});
