import parse, { HTMLElement, TextNode } from "node-html-parser";

import { Client } from "@notionhq/client";
import type {
  BlockObjectRequest,
  CreatePageParameters,
} from "@notionhq/client/build/src/api-endpoints";
import { MAX_BODY_LENGTH, MAX_RICH_TEXT_LENGTH } from "./constants";
import { config } from "../config";
import { logger } from "./logger";
import { IEntry } from "../models";

type RichText = {
  type: "text";
  text: {
    content: string;
    link?: { url: string };
  };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
  };
};

export class NotionClient {
  private notion: Client;
  private databaseId: string;

  constructor() {
    this.notion = new Client({
      auth: config.notion.token,
    });
    this.databaseId = config.notion.databaseId;
  }

  public async createPage(entry: IEntry): Promise<boolean> {
    try {
      if (!config.notion.token || !this.databaseId) {
        logger.error("Notion token or database ID not configured");
        return false;
      }

      const noteBody: CreatePageParameters = {
        parent: {
          type: "database_id",
          database_id: this.databaseId,
        },
        properties: {
          title: {
            title: [
              {
                text: {
                  content: entry.title ?? "",
                },
              },
            ],
          },
          author: {
            rich_text: [
              {
                text: {
                  content: entry.author ?? "",
                },
              },
            ],
          },
          link: {
            url: entry.link ?? "",
          },
          entryDate: {
            date: {
              start: entry.entryDate.toISOString(),
            },
          },
          summary: {
            rich_text: [
              {
                text: {
                  content: entry.summary ?? "",
                },
              },
            ],
          },
        },

        children: [],
      };

      // Parse HTML content and convert it to Notion blocks
      if (entry.content) {
        const root = parse(entry.content);
        const contentBlocks: BlockObjectRequest[] = [];

        const processNode = (
          node: HTMLElement | TextNode,
          richTextArray: RichText[] = []
        ): void => {
          if (node instanceof TextNode) {
            const textContent = node.text.trim();
            if (textContent) {
              richTextArray.push({
                type: "text",
                text: {
                  content: textContent,
                },
              });
            }
          } else if (node instanceof HTMLElement) {
            switch (node.tagName) {
              case "P": {
                const paragraphRichText: RichText[] = [];
                node.childNodes.forEach((child) => {
                  if (
                    child instanceof HTMLElement ||
                    child instanceof TextNode
                  ) {
                    processNode(child, paragraphRichText);
                  }
                });
                if (paragraphRichText.length > 0) {
                  let currentRichText: RichText[] = [];
                  let currentLength = 0;

                  paragraphRichText.forEach((richText) => {
                    const textLength = richText.text.content.length;

                    if (currentLength + textLength > MAX_RICH_TEXT_LENGTH) {
                      // Push the current paragraph block and reset
                      contentBlocks.push({
                        object: "block",
                        type: "paragraph",
                        paragraph: {
                          rich_text: currentRichText,
                        },
                      });
                      currentRichText = [];
                      currentLength = 0;
                    }

                    currentRichText.push(richText);
                    currentLength += textLength;
                  });

                  // Push the remaining rich text as a paragraph block
                  if (currentRichText.length > 0) {
                    contentBlocks.push({
                      object: "block",
                      type: "paragraph",
                      paragraph: {
                        rich_text: currentRichText,
                      },
                    });
                  }
                }
                break;
              }
              case "A": {
                const linkText = node.text.trim();
                const href = node.getAttribute("href") || "";
                if (linkText) {
                  if (
                    richTextArray.length > 0 &&
                    !richTextArray[
                      richTextArray.length - 1
                    ].text.content.endsWith(" ")
                  ) {
                    richTextArray.push({
                      type: "text",
                      text: {
                        content: " ",
                      },
                    });
                  }
                  richTextArray.push({
                    type: "text",
                    text: {
                      content: linkText,
                      link: { url: href },
                    },
                  });
                  if (
                    richTextArray.length > 0 &&
                    !richTextArray[
                      richTextArray.length - 1
                    ].text.content.endsWith(" ")
                  ) {
                    richTextArray.push({
                      type: "text",
                      text: {
                        content: " ",
                      },
                    });
                  }
                }
                break;
              }
              case "IMG": {
                const src = node.getAttribute("src")?.toLocaleLowerCase() || "";
                if (src) {
                  contentBlocks.push({
                    object: "block",
                    type: "image",
                    image: {
                      type: "external",
                      external: { url: src },
                    },
                  });
                }
                break;
              }
              case "B":
              case "STRONG":
              case "I":
              case "EM":
              case "U": {
                const annotation: RichText["annotations"] = {};
                if (node.tagName === "B" || node.tagName === "STRONG") {
                  annotation.bold = true;
                } else if (node.tagName === "I" || node.tagName === "EM") {
                  annotation.italic = true;
                } else if (node.tagName === "U") {
                  annotation.underline = true;
                }

                const childRichText: RichText[] = [];
                node.childNodes.forEach((child) => {
                  if (
                    child instanceof HTMLElement ||
                    child instanceof TextNode
                  ) {
                    processNode(child, childRichText);
                  }
                });

                childRichText.forEach((richText) => {
                  richText.annotations = {
                    ...richText.annotations,
                    ...annotation,
                  };
                });

                if (
                  richTextArray.length > 0 &&
                  !richTextArray[
                    richTextArray.length - 1
                  ].text.content.endsWith(" ")
                ) {
                  richTextArray.push({
                    type: "text",
                    text: {
                      content: " ",
                    },
                  });
                }

                richTextArray.push(...childRichText);

                if (
                  childRichText.length > 0 &&
                  !childRichText[
                    childRichText.length - 1
                  ].text.content.endsWith(" ")
                ) {
                  richTextArray.push({
                    type: "text",
                    text: {
                      content: " ",
                    },
                  });
                }
                break;
              }
              default:
                node.childNodes.forEach((child) => {
                  if (
                    child instanceof HTMLElement ||
                    child instanceof TextNode
                  ) {
                    processNode(child, richTextArray);
                  }
                });
                break;
            }
          }
        };

        root.childNodes.forEach((child) => {
          if (child instanceof HTMLElement || child instanceof TextNode) {
            processNode(child);
          }
        });

        // Limit blocks to MAX_BODY_LENGTH
        noteBody.children = contentBlocks.slice(0, MAX_BODY_LENGTH);
      }

      if (noteBody.children && noteBody.children.length > MAX_BODY_LENGTH)
        noteBody.children = noteBody.children?.slice(0, MAX_BODY_LENGTH);

      await this.notion.pages.create(noteBody);

      logger.info(
        `Successfully created Notion page for entry: ${entry.entryId}`
      );
      return true;
    } catch (error) {
      logger.error(
        `Failed to create Notion page for entry ${entry.entryId}:`,
        error
      );
      return false;
    }
  }

  public async testConnection(): Promise<boolean> {
    try {
      if (!config.notion.token || !this.databaseId) {
        logger.error("Notion token or database ID not configured");
        return false;
      }

      await this.notion.databases.retrieve({
        database_id: this.databaseId,
      });

      logger.info("Notion connection test successful");
      return true;
    } catch (error) {
      logger.error("Notion connection test failed:", error);
      return false;
    }
  }

  public async createDatabaseIfNotExists(): Promise<void> {
    try {
      // This would require a parent page ID and is more complex
      // For now, we assume the database exists
      logger.info(
        "Database creation not implemented - please create the Notion database manually"
      );
    } catch (error) {
      logger.error("Failed to create Notion database:", error);
    }
  }
}
