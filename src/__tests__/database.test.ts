import { database } from "../database";
import { EntryModel } from "../models";

// MONGODB_URI points to a test database, see jest.setup.js

describe("Database Connection", () => {
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
