import { chunkBlocks, htmlToBlocks, resolveHttpUrl } from "../utils/notion";

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

  it("keeps long articles whole, instead of cutting them at 100 blocks", () => {
    const blocks = htmlToBlocks("<p>x</p>".repeat(250), BASE);
    expect(blocks).toHaveLength(250);
  });

  it("turns headings into Notion headings", () => {
    const blocks = htmlToBlocks("<h2>Big</h2><h4>Small</h4>", BASE) as unknown as {
      type: string;
      heading_2?: { rich_text: { text: { content: string } }[] };
      heading_3?: { rich_text: { text: { content: string } }[] };
    }[];

    expect(blocks[0].type).toBe("heading_2");
    expect(blocks[0].heading_2?.rich_text[0].text.content).toBe("Big");
    expect(blocks[1].type).toBe("heading_3");
  });

  it("turns list items into bulleted and numbered items", () => {
    const blocks = htmlToBlocks("<ul><li>one</li></ul><ol><li>two</li></ol>", BASE) as unknown as {
      type: string;
    }[];

    expect(blocks.map((block) => block.type)).toEqual(["bulleted_list_item", "numbered_list_item"]);
  });

  it("turns a blockquote into a quote", () => {
    const blocks = htmlToBlocks("<blockquote>cited</blockquote>", BASE) as unknown as {
      type: string;
      quote: { rich_text: { text: { content: string } }[] };
    }[];

    expect(blocks[0].type).toBe("quote");
    expect(blocks[0].quote.rich_text[0].text.content).toBe("cited");
  });

  it("turns a YouTube embed into a video block Notion accepts", () => {
    const blocks = htmlToBlocks('<iframe src="https://www.youtube.com/embed/NEziLnExMRw"></iframe>', BASE) as unknown as {
      type: string;
      video: { external: { url: string } };
    }[];

    expect(blocks[0].type).toBe("video");
    expect(blocks[0].video.external.url).toBe("https://www.youtube.com/watch?v=NEziLnExMRw");
  });

  it("turns any other iframe into an embed", () => {
    const blocks = htmlToBlocks('<iframe src="https://example.com/player"></iframe>', BASE) as unknown as {
      type: string;
    }[];

    expect(blocks[0].type).toBe("embed");
  });
});

describe("chunkBlocks", () => {
  it("splits into batches Notion will accept", () => {
    const chunks = chunkBlocks(htmlToBlocks("<p>x</p>".repeat(250), BASE));

    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
  });

  it("returns nothing for an empty article", () => {
    expect(chunkBlocks([])).toEqual([]);
  });
});
