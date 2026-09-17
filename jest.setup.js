// Runs before test modules load, so src/config picks these up instead of the
// values in .env (dotenv doesn't override variables that are already set).
// This is what keeps tests away from the production database and Redis.
process.env.NODE_ENV = "test";
process.env.MONGODB_URI =
  process.env.MONGODB_TEST_URI || "mongodb://localhost:27017/atomix-test";
process.env.REDIS_URL = process.env.REDIS_TEST_URL || "redis://localhost:6379";
process.env.QUEUE_PREFIX = "atomix-test";
process.env.LOG_TO_FILE = "false";
process.env.LOG_LEVEL = "error";
process.env.API_KEY = "test-api-key";
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";
