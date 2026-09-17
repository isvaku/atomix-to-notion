# Atomix to Notion

Crawls articles from [atomix.vg](https://atomix.vg), stores them in MongoDB and creates a page for each one in a Notion database. Built to run unattended on a Raspberry Pi 4.

- **Queue-based**: links are queued and processed one at a time, with retries and backoff (BullMQ + Redis).
- **HTTP API**: submit links to crawl on demand, check job status, retry failures.
- **Dashboard**: a built-in page showing schedules, queues, failures and articles per day.
- **Daily Telegram report**: what failed in the last 24 hours, with links, and a warning when nothing was crawled at all.
- **Gentle on the SD card**: nothing is written to disk on the Pi (see [SD card](#sd-card)).

## How it works

```
schedule "discover" (every 15 min) ─┐
                                    ├─> queue "crawl"  (one at a time, one Chromium)
POST /api/crawl {links:[…]} ────────┘      3 attempts, exponential backoff
                                           │ scrape + save to MongoDB
                                           └─> queue "notion-sync"
                                                 5 attempts, max 3 requests/second
                                                 │ updates the page with this link,
                                                 │ or creates one
                                                 ├ ok     → entry marked created
                                                 └ failed → entry marked failed
schedule "sweep" (hourly): re-queues entries that never reached Notion
schedule "report" (daily 09:00) ─> Telegram summary of failures
```

MongoDB holds the articles and their sync state. Redis only holds jobs.

### Why it needs a real browser

atomix.vg is behind a Cloudflare challenge. Plain HTTP requests (axios, curl) and headless browsers get the "Just a moment…" page, so Chromium runs **headful** inside a virtual display (Xvfb) in the container. Article links come from the JSON endpoint behind the site's "siguiente" button, and article pages are fetched from inside the browser session so they carry the Cloudflare cookies.

Puppeteer doesn't ship Chrome for Linux ARM, so the image uses Debian's `chromium` package.

## Running it on a Raspberry Pi

The image is built for arm64 and published on every push to `main`.

1. Copy `docker-compose.yml` and a `.env` file (see [`.env.example`](.env.example)) to the Pi.
2. Set at least `MONGODB_URI`, `NOTION_TOKEN`, `NOTION_DATABASE_ID` and `API_KEY`.
3. Start it:

```bash
docker compose pull
docker compose up -d
```

The dashboard is then at `http://<pi>:3000`, and asks for the API key. For access from outside your network, put it behind a reverse proxy with HTTPS.

To pin a build instead of following `latest`, set `IMAGE_TAG` in `.env` to a version (`1.2.0`) or to a commit (`sha-1853076`). Both always point at the exact image that was built from that commit.

### Releasing

Every push to `main` publishes `latest`, the version from `package.json` and `sha-<commit>`. A version tag is never overwritten: if `package.json` still has a version that was already published, CI fails and asks you to bump it. So bump `version` in the same commit (or PR) as the change you want to ship.

To see what a running container actually is:

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <container>
```

## API

All `/api/*` calls need a bearer token: `Authorization: Bearer $API_KEY`. `/health` and the dashboard don't. The API is limited to 120 requests per minute per IP, which also caps key guessing; over that it answers 429.

### Crawl links

```bash
curl -X POST http://localhost:3000/api/crawl \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"links":["https://atomix.vg/some-article","https://atomix.vg/another"]}'
```

```json
{
  "queued": [{ "link": "https://atomix.vg/some-article", "jobId": "crawl-0ea9a9…" }],
  "skipped": [{ "link": "https://atomix.vg/another", "reason": "exists" }],
  "rejected": []
}
```

Up to 100 links per request. Links are normalized (`www`, trailing slash, query string and hash are dropped), so the same article can't be queued twice. `skipped` means we already have it (`exists`) or it's already queued (`already-queued`); `rejected` means it isn't a URL (`invalid-url`) or isn't from a configured source (`unsupported-host`).

### Everything else

| Endpoint | What it does |
|---|---|
| `GET /health` | MongoDB, Redis and worker state. 200 or 503. No auth. |
| `GET /api/crawl/:jobId` | State of one crawl job and of its Notion sync. |
| `GET /api/status` | Everything the dashboard shows. |
| `POST /api/retry-failed` | Queues failed crawls and failed Notion syncs again. |
| `POST /api/resync` | Writes stored articles to Notion again, by link, updating their pages. |
| `POST /api/schedulers/:name/run` | Runs `discover`, `sweep-unsynced` or `daily-report` now. |
| `POST /api/report` | Sends the Telegram report immediately. |

## Telegram report

Create a bot with [@BotFather](https://t.me/BotFather) for the token, send it a message, then read your chat id from `https://api.telegram.org/bot<TOKEN>/getUpdates`. Put both in `.env` as `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Discovery failures don't wait for the daily report: they trigger a Telegram message straight away, muted for `DISCOVER_ALERT_COOLDOWN_MINUTES` (6 hours by default) so an outage doesn't spam you.

The report goes out daily at 09:00 (`REPORT_INTERVAL`), but **only when something needs attention**: a failed sync, a failed crawl, or no articles saved in 24 hours (which is how a Cloudflare or site change shows up). Set `REPORT_ALWAYS=true` to get it every day regardless. Test it with `pnpm report` or the dashboard's "Send report".

## Knowing when it's down

Every alarm above assumes the app is running. If the container stops, the Pi loses power or the network drops, nothing can report it — silence looks exactly like a quiet day.

Set `HEALTHCHECK_PING_URL` to a check URL from [healthchecks.io](https://healthchecks.io) (free) or any similar watchdog. Each successful discovery pings it; if the pings stop, the watchdog emails or messages you. Set its period slightly above `CRAWLER_INTERVAL`.

## Development

Requires Node 22+, pnpm 12+, and MongoDB and Redis running locally.

```bash
pnpm install
cp .env.example .env
pnpm setup        # checks MongoDB, Redis, Notion and Telegram
pnpm dev          # starts everything, dashboard on http://localhost:3000
```

| Command | What it does |
|---|---|
| `pnpm crawler` | Discovers, crawls and syncs once, then exits. |
| `pnpm notion-sync` | Syncs everything not yet in Notion, then exits. |
| `pnpm report` | Sends the report now. |
| `pnpm retry-failed` | Queues failed crawls and syncs again. |
| `pnpm fix-notion-duplicates` | Cleans up duplicate pages from earlier imports: archives content-free copies, and completes hand-made pages (author, entry date, summary) while archiving their generated twins. Dry run unless `--apply`. |
| `pnpm reimport-notion` | Finds Notion pages with no author and no entry date (a failed manual import) and fills them in, updating each page in place. Dry run unless `--apply`; see the [script](src/scripts/reimport-from-notion.ts) for options. |
| `pnpm test` | Jest (needs MongoDB and Redis; uses separate test databases). |
| `pnpm lint` / `pnpm build` | ESLint / TypeScript build. |

Tests never touch your real data: [`jest.setup.js`](jest.setup.js) forces `MONGODB_TEST_URI` / `REDIS_TEST_URL` (defaults: localhost, `atomix-test`) before anything loads.

> On Windows, pnpm 12 can corrupt `node_modules` when installing on top of an existing tree. If a package goes missing, `rm -rf node_modules && pnpm install`.

## Configuration

See [`.env.example`](.env.example) for the full list. The ones that matter most:

| Variable | Default | What it's for |
|---|---|---|
| `MONGODB_URI` | – | Required. Articles and their sync state. |
| `REDIS_URL` | `redis://localhost:6379` | Queues. Compose sets `redis://redis:6379`. |
| `API_KEY` | – | Required in production. `openssl rand -hex 32`. |
| `NOTION_TOKEN`, `NOTION_DATABASE_ID` | – | Without them, Notion sync stays off. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | – | Without them, no report or alert is sent. |
| `HEALTHCHECK_PING_URL` | – | External watchdog pinged after each discovery. See [Knowing when it's down](#knowing-when-its-down). |
| `CRAWLER_INTERVAL` | `*/15 * * * *` | How often new articles are discovered. |
| `TZ` | `America/Mexico_City` | Schedules and displayed dates. **Wrong value = wrong article dates.** |
| `BROWSER_TIMEOUT_MS` | `180000` | Raise it if a slow Pi times out starting Chromium. |
| `BROWSER_IDLE_CLOSE_MS` | `120000` | Chromium closes after this long with no work. |

Syncing is **idempotent**: a page is looked up by its `link` property and updated if it exists, so re-syncing corrects a page rather than creating a duplicate. Body content is only added to a page that has none, so an edited page keeps its text.

The Notion database needs these properties: `title` (Title), `link` (URL), `author` (Rich text), `summary` (Rich text), `entryDate` (Date). Share it with your integration.

## SD card

SD cards die from writes, so on the Pi the app writes nothing to disk:

- The app container is **read-only**, with `/tmp` in RAM (Chromium's profile, the Xvfb socket, all caches).
- Logs go to stdout only, capped by Docker at 5 MB × 2 files.
- Redis keeps **no** append-only file, just an RDB snapshot every 15 minutes at most.
- The Docker health check runs every 5 minutes, because Docker writes container state on each check.

The trade-off: a power cut can lose up to 15 minutes of *queued* jobs. Saved articles are safe (MongoDB), the discover schedule finds the links again, and the hourly sweep re-queues anything missing from Notion. Only links submitted through the API in that window would need resubmitting.

You can confirm nothing is being written with `docker diff <container>`, which should list nothing from the app.

## Troubleshooting

**The dashboard says unhealthy / `/health` returns 503.** One of MongoDB, Redis or the workers is down; the response says which. Check `docker compose logs`.

**No articles for a day, or the report warns about it.** Usually Cloudflare or a site change. Look for "Failed to load" or "Timed out" in the logs. If Chromium is just slow on the Pi, raise `BROWSER_TIMEOUT_MS`.

**Notion syncs keep failing.** The error is stored on the entry and shown in the dashboard and the report. Fix the cause (token, database sharing, property names), then "Retry failed" or `pnpm retry-failed`.

**Queued jobs disappeared after a power cut.** Expected; see [SD card](#sd-card). They'll be re-queued by the next discover and sweep.

## License

MIT
