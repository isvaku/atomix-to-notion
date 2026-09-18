const pagesCreate = jest.fn().mockResolvedValue({ id: "new-page" });
const pagesUpdate = jest.fn().mockResolvedValue({});
const dataSourcesQuery = jest.fn();
const databasesRetrieve = jest.fn().mockResolvedValue({ data_sources: [{ id: "data-source" }] });
const blocksList = jest.fn();
const blocksAppend = jest.fn().mockResolvedValue({});

jest.mock("@notionhq/client", () => ({
  Client: jest.fn().mockImplementation(() => ({
    pages: { create: pagesCreate, update: pagesUpdate },
    databases: { retrieve: databasesRetrieve },
    dataSources: { query: dataSourcesQuery },
    blocks: { children: { list: blocksList, append: blocksAppend } },
  })),
}));

import { NotionClient } from "../utils/notion";
import { IEntry } from "../models";

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
