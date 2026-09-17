import { htmlToBlocks, resolveHttpUrl } from "../utils/notion";

const BASE = "https://atomix.vg/an-article";

type ParagraphBlock = { type: string; paragraph: { rich_text: { text: { content: string; link?: { url: string } }; annotations?: Record<string, boolean> }[] } };
type ImageBlock = { type: string; image: { external: { url: string } } };

describe("resolveHttpUrl", () => {
  it("resolves relative URLs against the article", () => {
    expect(resolveHttpUrl("/images/a.png", BASE)).toBe("https://atomix.vg/images/a.png");
  });

  it("keeps the case of the path, which is case-sensitive", () => {
    const url = "https://Atomix.blob.core.windows.net/images/AaKaK-Focus.webp";
    expect(resolveHttpUrl(url, BASE)).toContain("/images/AaKaK-Focus.webp");
  });

  it("rejects anything that isn't http(s)", () => {
    expect(resolveHttpUrl("data:image/png;base64,AAA", BASE)).toBeNull();
    expect(resolveHttpUrl(undefined, BASE)).toBeNull();
  });
});

describe("htmlToBlocks", () => {
  it("turns paragraphs into paragraph blocks", () => {
    const blocks = htmlToBlocks("<p>Hola</p><p>Mundo</p>", BASE) as unknown as ParagraphBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].paragraph.rich_text[0].text.content).toBe("Hola");
  });

  it("splits text longer than Notion's 2000 character limit", () => {
    const long = "a".repeat(4500);
    const blocks = htmlToBlocks(`<p>${long}</p>`, BASE) as unknown as ParagraphBlock[];
    const items = blocks.flatMap((block) => block.paragraph.rich_text);

    expect(items.every((item) => item.text.content.length <= 2000)).toBe(true);
    expect(items.map((item) => item.text.content).join("")).toHaveLength(4500);
  });

  it("keeps links, resolving relative ones", () => {
    const blocks = htmlToBlocks('<p>See <a href="/other">this</a></p>', BASE) as unknown as ParagraphBlock[];
    const link = blocks[0].paragraph.rich_text.find((item) => item.text.link);
    expect(link?.text.link?.url).toBe("https://atomix.vg/other");
  });

  it("keeps the text of a link with an unusable URL, without the link", () => {
    const blocks = htmlToBlocks('<p>See <a href="javascript:alert(1)">this</a></p>', BASE) as unknown as ParagraphBlock[];
    const items = blocks[0].paragraph.rich_text;
    expect(items.some((item) => item.text.content === "this")).toBe(true);
    expect(items.every((item) => !item.text.link)).toBe(true);
  });

  it("marks bold and italic text", () => {
    const blocks = htmlToBlocks("<p><strong>bold</strong> and <em>italic</em></p>", BASE) as unknown as ParagraphBlock[];
    const items = blocks[0].paragraph.rich_text;
    expect(items.find((item) => item.text.content === "bold")?.annotations).toMatchObject({ bold: true });
    expect(items.find((item) => item.text.content === "italic")?.annotations).toMatchObject({ italic: true });
  });

  it("adds image blocks and skips images Notion would reject", () => {
    const blocks = htmlToBlocks(
      '<p>x</p><img src="/a.png"><img src="data:image/png;base64,AAA">',
      BASE
    ) as unknown as ImageBlock[];
    const images = blocks.filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].image.external.url).toBe("https://atomix.vg/a.png");
  });

  it("never exceeds Notion's block limit", () => {
    const html = "<p>x</p>".repeat(250);
    expect(htmlToBlocks(html, BASE).length).toBeLessThanOrEqual(100);
  });
});
