import {
  ReportData,
  buildReport,
  escapeHtml,
  reportNeedsAttention,
  splitMessage,
} from "../utils/telegram";

const baseData: ReportData = {
  since: new Date("2026-09-16T09:00:00Z"),
  failedSyncs: [],
  failedSyncTotal: 0,
  failedCrawls: [],
  failedCrawlTotal: 0,
  savedCount: 12,
  pendingCrawls: 0,
  pendingSyncs: 0,
};

describe("reportNeedsAttention", () => {
  it("is quiet when articles were saved and nothing failed", () => {
    expect(reportNeedsAttention(baseData)).toBe(false);
  });

  it("flags a day without any saved articles", () => {
    expect(reportNeedsAttention({ ...baseData, savedCount: 0 })).toBe(true);
  });

  it("flags failures", () => {
    expect(
      reportNeedsAttention({
        ...baseData,
        failedSyncs: [{ title: "x", link: "https://atomix.vg/x" }],
      })
    ).toBe(true);
  });
});

describe("buildReport", () => {
  it("lists failures with their links", () => {
    const text = buildReport({
      ...baseData,
      failedSyncs: [{ title: "Título", link: "https://atomix.vg/a", error: "boom" }],
      failedSyncTotal: 1,
      failedCrawls: [{ link: "https://atomix.vg/b", error: "timeout" }],
      failedCrawlTotal: 1,
    });

    expect(text).toContain('<a href="https://atomix.vg/a">Título</a>');
    expect(text).toContain("https://atomix.vg/b");
    expect(text).toContain("timeout");
  });

  it("warns when nothing was saved", () => {
    expect(buildReport({ ...baseData, savedCount: 0 })).toContain("No articles saved");
  });

  it("escapes titles so they can't break the HTML markup", () => {
    const text = buildReport({
      ...baseData,
      failedSyncs: [{ title: "<b>x</b> & co", link: "https://atomix.vg/a" }],
      failedSyncTotal: 1,
    });
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt; &amp; co");
  });

  it("summarizes instead of listing hundreds of failures", () => {
    const failedSyncs = Array.from({ length: 80 }, (_, index) => ({
      title: `t${index}`,
      link: `https://atomix.vg/${index}`,
    }));
    expect(buildReport({ ...baseData, failedSyncs, failedSyncTotal: 80 })).toContain("and 30 more");
  });
});

describe("escapeHtml", () => {
  it("escapes the characters Telegram parses as markup", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("splitMessage", () => {
  it("keeps a short message in one piece", () => {
    expect(splitMessage("hola")).toEqual(["hola"]);
  });

  it("splits on line boundaries within the limit", () => {
    const parts = splitMessage(["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n"), 70);
    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.length <= 70)).toBe(true);
  });

  it("hard-splits a single line that is too long", () => {
    const parts = splitMessage("x".repeat(250), 100);
    expect(parts.map((part) => part.length)).toEqual([100, 100, 50]);
  });
});
