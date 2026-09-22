import { gzipSync } from "zlib";
import { IEntry } from "../models";
import { packContent, readContent } from "../models/entryContent";

const HTML = "<p>Una reseña con acentos: café, niño</p>".repeat(20);

describe("packContent / readContent", () => {
  it("round trips the article, accents included", () => {
    const packed = packContent(HTML);
    expect(readContent(packed as unknown as IEntry)).toBe(HTML);
  });

  it("stores the original size and something smaller", () => {
    const packed = packContent(HTML);

    expect(packed.contentBytes).toBe(Buffer.byteLength(HTML, "utf8"));
    expect(packed.contentGzip.length).toBeLessThan(packed.contentBytes);
  });

  it("reads rows written before compression", () => {
    expect(readContent({ content: "<p>old row</p>" } as IEntry)).toBe("<p>old row</p>");
  });

  it("prefers the compressed copy when both are present", () => {
    const entry = { content: "<p>stale</p>", ...packContent("<p>current</p>") } as unknown as IEntry;
    expect(readContent(entry)).toBe("<p>current</p>");
  });

  it("returns nothing for an entry whose content was dropped", () => {
    expect(readContent({} as IEntry)).toBe("");
  });

  it("returns nothing rather than throwing on damaged data", () => {
    const entry = { contentGzip: Buffer.from("not gzip at all") } as IEntry;
    expect(readContent(entry)).toBe("");
  });

  it("reads content compressed by anything standard", () => {
    const entry = { contentGzip: gzipSync(Buffer.from("<p>hola</p>")) } as IEntry;
    expect(readContent(entry)).toBe("<p>hola</p>");
  });
});
