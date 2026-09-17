import { checkLink, crawlJobId, normalizeLink } from "../queue/links";
import { Source } from "../config";

const source = { name: "Atomix", url: "https://atomix.vg" } as Source;

describe("normalizeLink", () => {
  it("keeps a clean article URL as is", () => {
    expect(normalizeLink("https://atomix.vg/some-article")).toBe("https://atomix.vg/some-article");
  });

  it("strips www, query, hash and a trailing slash", () => {
    expect(normalizeLink("http://www.atomix.vg/some-article/?utm=x#top")).toBe(
      "https://atomix.vg/some-article"
    );
  });

  it("rejects values that aren't http(s) URLs", () => {
    expect(normalizeLink("not a url")).toBeNull();
    expect(normalizeLink("javascript:alert(1)")).toBeNull();
    expect(normalizeLink("ftp://atomix.vg/file")).toBeNull();
  });
});

describe("checkLink", () => {
  it("accepts an article of a configured source", () => {
    const result = checkLink("https://www.atomix.vg/an-article/", [source]);
    expect(result).toEqual({ ok: true, link: "https://atomix.vg/an-article", source });
  });

  it("rejects other hosts", () => {
    expect(checkLink("https://example.com/foo", [source])).toMatchObject({
      ok: false,
      reason: "unsupported-host",
    });
  });

  it("rejects the home page, which is not an article", () => {
    expect(checkLink("https://atomix.vg/", [source])).toMatchObject({
      ok: false,
      reason: "invalid-url",
    });
  });
});

describe("crawlJobId", () => {
  it("is stable and contains no colons (BullMQ job ids can't)", () => {
    const id = crawlJobId("https://atomix.vg/an-article");
    expect(id).toBe(crawlJobId("https://atomix.vg/an-article"));
    expect(id).not.toContain(":");
  });

  it("differs per link", () => {
    expect(crawlJobId("https://atomix.vg/a")).not.toBe(crawlJobId("https://atomix.vg/b"));
  });
});
