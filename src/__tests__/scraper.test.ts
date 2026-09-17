import { parseArticleDate } from "../utils/scraper";

const FORMAT = "DD/MM/YYYY h:mm a";
const local = (date: Date | null) => (date ? date.toString().slice(0, 21) : null);

describe("parseArticleDate", () => {
  it("reads Spanish afternoon times as PM", () => {
    // The bug this guards: "4:47 p. m." used to be stored as 04:47
    expect(parseArticleDate("15/09/2026 4:47 p. m.", FORMAT)?.getHours()).toBe(16);
  });

  it("reads morning times as AM", () => {
    expect(parseArticleDate("15/09/2026 7:30 a. m.", FORMAT)?.getHours()).toBe(7);
  });

  it("handles noon and midnight", () => {
    expect(parseArticleDate("15/09/2026 12:05 p. m.", FORMAT)?.getHours()).toBe(12);
    expect(parseArticleDate("15/09/2026 12:05 a. m.", FORMAT)?.getHours()).toBe(0);
  });

  it("reads the day, month and year", () => {
    expect(local(parseArticleDate("05/09/2026 1:00 p. m.", FORMAT))).toContain("Sep 05 2026");
  });

  it("returns null for text that doesn't match the format", () => {
    expect(parseArticleDate("ayer", FORMAT)).toBeNull();
    expect(parseArticleDate("", FORMAT)).toBeNull();
  });
});
