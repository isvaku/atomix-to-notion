import { config } from "../config";
import { redis } from "../queue/connection";
import { closeQueues } from "../queue/queues";
import { alertDiscoverFailed, pingWatchdog } from "../services/alerts";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

afterAll(async () => {
  await closeQueues();
  await redis.quit();
});

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
  await redis.del("alerts:discover-failed");
});

describe("pingWatchdog", () => {
  afterEach(() => {
    config.alerts.pingUrl = "";
  });

  it("does nothing when no watchdog is configured", async () => {
    config.alerts.pingUrl = "";
    await pingWatchdog();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pings the configured URL", async () => {
    config.alerts.pingUrl = "https://hc-ping.test/uuid";
    await pingWatchdog();
    expect(fetchMock.mock.calls[0][0]).toBe("https://hc-ping.test/uuid");
  });

  it("never throws when the watchdog is unreachable", async () => {
    config.alerts.pingUrl = "https://hc-ping.test/uuid";
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(pingWatchdog()).resolves.toBeUndefined();
  });
});

describe("alertDiscoverFailed", () => {
  const telegram = config.report.telegram;

  beforeEach(() => {
    telegram.botToken = "token";
    telegram.chatId = "chat";
  });

  afterEach(() => {
    telegram.botToken = "";
    telegram.chatId = "";
  });

  it("sends a Telegram message with the error", async () => {
    await alertDiscoverFailed(new Error("No links found for Atomix"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain("discovery failed");
    expect(body.text).toContain("No links found for Atomix");
  });

  it("stays quiet for later failures in the cooldown window", async () => {
    await alertDiscoverFailed(new Error("first"));
    await alertDiscoverFailed(new Error("second"));
    await alertDiscoverFailed(new Error("third"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says nothing when Telegram isn't configured", async () => {
    telegram.botToken = "";
    await alertDiscoverFailed(new Error("boom"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
