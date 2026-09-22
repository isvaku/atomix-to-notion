const pagesCreate = jest.fn().mockResolvedValue({ id: "new-page" });
const pagesUpdate = jest.fn().mockResolvedValue({});
const dataSourcesQuery = jest.fn();
const databasesRetrieve = jest.fn().mockResolvedValue({ data_sources: [{ id: "data-source" }] });
const blocksList = jest.fn();
const blocksAppend = jest.fn().mockResolvedValue({});
const fileUploadsCreate = jest.fn();
const fileUploadsRetrieve = jest.fn();

jest.mock("@notionhq/client", () => ({
  Client: jest.fn().mockImplementation(() => ({
    pages: { create: pagesCreate, update: pagesUpdate },
    databases: { retrieve: databasesRetrieve },
    dataSources: { query: dataSourcesQuery },
    blocks: { children: { list: blocksList, append: blocksAppend } },
    fileUploads: { create: fileUploadsCreate, retrieve: fileUploadsRetrieve },
  })),
}));

import { NotionClient, describeImage } from "../utils/notion";
import { IEntry } from "../models";
import { config } from "../config";

const entry = {
  entryId: "https://atomix.vg/?p=1",
  title: "An article",
  author: "Someone",
  summary: "A summary",
  content: "<p>Body</p>",
  link: "https://atomix.vg/an-article",
  entryDate: new Date("2026-09-16T12:00:00Z"),
} as IEntry;

describe("NotionClient.syncEntry", () => {
  let notion: NotionClient;

  beforeEach(() => {
    jest.clearAllMocks();
    fileUploadsCreate.mockResolvedValue({ id: "upload-1", status: "uploaded" });
    // Explicit credentials: the tests must not depend on a local .env
    notion = new NotionClient({ token: "token", databaseId: "database" });
  });

  it("creates a page when no page has that link", async () => {
    dataSourcesQuery.mockResolvedValue({ results: [] });

    expect(await notion.syncEntry(entry)).toBe("created");
    expect(pagesCreate).toHaveBeenCalledTimes(1);
    expect(pagesUpdate).not.toHaveBeenCalled();

    const properties = pagesCreate.mock.calls[0][0].properties;
    expect(properties.author.rich_text[0].text.content).toBe("Someone");
    expect(properties.entryDate.date.start).toBe("2026-09-16T12:00:00.000Z");
  });

  it("updates the existing page instead of creating a second one", async () => {
    dataSourcesQuery.mockResolvedValue({ results: [{ id: "existing-page" }] });
    blocksList.mockResolvedValue({ results: [] });

    expect(await notion.syncEntry(entry)).toBe("updated");
    expect(pagesCreate).not.toHaveBeenCalled();

    const [{ page_id, properties }] = pagesUpdate.mock.calls[0];
    expect(page_id).toBe("existing-page");
    // The empty page gets exactly what it was missing
    expect(properties.author.rich_text[0].text.content).toBe("Someone");
    expect(properties.entryDate.date.start).toBe("2026-09-16T12:00:00.000Z");
    expect(properties.title.title[0].text.content).toBe("An article");
    expect(properties.summary.rich_text[0].text.content).toBe("A summary");
  });

  it("adds the article body to a page that has none", async () => {
    dataSourcesQuery.mockResolvedValue({ results: [{ id: "existing-page" }] });
    blocksList.mockResolvedValue({ results: [] });

    await notion.syncEntry(entry);

    expect(blocksAppend).toHaveBeenCalledTimes(1);
    expect(blocksAppend.mock.calls[0][0].block_id).toBe("existing-page");
  });

  it("leaves the body alone when the page already has content", async () => {
    dataSourcesQuery.mockResolvedValue({ results: [{ id: "existing-page" }] });
    blocksList.mockResolvedValue({ results: [{ id: "block-1" }] });

    await notion.syncEntry(entry);

    expect(pagesUpdate).toHaveBeenCalledTimes(1);
    expect(blocksAppend).not.toHaveBeenCalled();
  });

  it("looks the page up by its exact link, in the database's data source", async () => {
    dataSourcesQuery.mockResolvedValue({ results: [] });

    await notion.syncEntry(entry);

    expect(dataSourcesQuery.mock.calls[0][0]).toMatchObject({
      data_source_id: "data-source",
      filter: { property: "link", url: { equals: "https://atomix.vg/an-article" } },
    });
  });

  it("looks the data source up once, then reuses it", async () => {
    dataSourcesQuery.mockResolvedValue({ results: [] });

    await notion.syncEntry(entry);
    await notion.syncEntry(entry);

    expect(databasesRetrieve).toHaveBeenCalledTimes(1);
  });
});

describe("image hosting", () => {
  let notion: NotionClient;

  const withImage = {
    ...entry,
    content: '<p>text</p><img src="https://blob.atomix.vg/images/shot.webp">',
  } as IEntry;

  beforeEach(() => {
    jest.clearAllMocks();
    config.notionSync.hostImages = true;
    dataSourcesQuery.mockResolvedValue({ results: [] });
    fileUploadsCreate.mockResolvedValue({ id: "upload-1", status: "uploaded" });
    notion = new NotionClient({ token: "token", databaseId: "database" });
  });

  const imageBlocks = () =>
    (pagesCreate.mock.calls[0][0].children as { type: string; image: Record<string, unknown> }[])
      .filter((block) => block.type === "image");

  it("hands the image to Notion and references the upload", async () => {
    await notion.syncEntry(withImage);

    expect(fileUploadsCreate.mock.calls[0][0]).toMatchObject({
      mode: "external_url",
      external_url: "https://blob.atomix.vg/images/shot.webp",
      content_type: "image/webp",
    });
    expect(imageBlocks()[0].image).toEqual({ type: "file_upload", file_upload: { id: "upload-1" } });
  });

  it("waits while Notion is still fetching", async () => {
    fileUploadsCreate.mockResolvedValue({ id: "upload-1", status: "pending" });
    fileUploadsRetrieve.mockResolvedValue({ id: "upload-1", status: "uploaded" });

    await notion.syncEntry(withImage);

    expect(fileUploadsRetrieve).toHaveBeenCalled();
    expect(imageBlocks()[0].image).toMatchObject({ type: "file_upload" });
  });

  it("keeps the original link when the upload fails", async () => {
    fileUploadsCreate.mockRejectedValue(new Error("upload refused"));

    await notion.syncEntry(withImage);

    expect(imageBlocks()[0].image).toEqual({
      type: "external",
      external: { url: "https://blob.atomix.vg/images/shot.webp" },
    });
  });

  it("keeps the link when Notion reports the upload failed", async () => {
    fileUploadsCreate.mockResolvedValue({ id: "upload-1", status: "failed" });

    await notion.syncEntry(withImage);

    expect(imageBlocks()[0].image).toMatchObject({ type: "external" });
  });

  it("uploads an image used twice in one article only once", async () => {
    const twice = {
      ...entry,
      content: '<img src="https://blob.atomix.vg/a.webp"><p>x</p><img src="https://blob.atomix.vg/a.webp">',
    } as IEntry;

    await notion.syncEntry(twice);

    expect(fileUploadsCreate).toHaveBeenCalledTimes(1);
    expect(imageBlocks()).toHaveLength(2);
  });

  it("leaves images alone when hosting is switched off", async () => {
    config.notionSync.hostImages = false;

    await notion.syncEntry(withImage);

    expect(fileUploadsCreate).not.toHaveBeenCalled();
    expect(imageBlocks()[0].image).toMatchObject({ type: "external" });
  });
});

describe("describeImage", () => {
  it("names the file and its type", () => {
    expect(describeImage("https://blob.atomix.vg/images/2026/01/shot-abc.webp")).toEqual({
      filename: "shot-abc.webp",
      contentType: "image/webp",
    });
  });

  it("handles the formats Notion accepts", () => {
    expect(describeImage("https://x.test/a.JPG")?.contentType).toBe("image/jpeg");
    expect(describeImage("https://x.test/a.png")?.contentType).toBe("image/png");
  });

  it("returns nothing for anything else", () => {
    expect(describeImage("https://x.test/page.html")).toBeNull();
    expect(describeImage("https://x.test/noextension")).toBeNull();
    expect(describeImage("not a url")).toBeNull();
  });
});
