import { database } from "../src/database";
import { EntryModel } from "../src/models";
import { logger } from "../src/utils";

describe("Database Connection", () => {
  beforeAll(async () => {
    // Use test database
    process.env.MONGODB_URI = "mongodb://localhost:27017/test-gaming-news";
  });

  afterAll(async () => {
    await database.disconnect();
  });

  test("should connect to database", async () => {
    await expect(database.connect()).resolves.not.toThrow();
    expect(database.isConnectedToDb()).toBe(true);
  });

  test("should create and save an entry", async () => {
    const testEntry = new EntryModel({
      entryId: "test-123",
      title: "Test Article",
      content: "This is test content",
      link: "https://example.com/test",
      entryDate: new Date(),
    });

    const savedEntry = await testEntry.save();
    expect(savedEntry.entryId).toBe("test-123");
    expect(savedEntry.title).toBe("Test Article");

    // Cleanup
    await EntryModel.deleteOne({ entryId: "test-123" });
  });
});
