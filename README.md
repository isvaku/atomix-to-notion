# Gaming News Crawler to Notion

A TypeScript-based gaming news crawler that scrapes articles from multiple gaming websites and syncs them to a Notion database via MongoDB.

## Features

- 🕷️ **Web Scraping**: Crawls multiple gaming news websites without relying on RSS feeds
- 📊 **MongoDB Storage**: Stores articles with full metadata in MongoDB using Mongoose
- 📝 **Notion Integration**: Automatically creates Notion pages for new articles
- ⏰ **Cron Jobs**: Automated scheduling for both crawling and Notion synchronization
- 🔧 **TypeScript**: Full type safety and modern JavaScript features
- 📦 **PNPM**: Fast and efficient package management
- 📋 **Logging**: Comprehensive logging with Winston
- 🛡️ **Error Handling**: Robust error handling and retry mechanisms

## Supported Gaming News Sources

- GameSpot
- IGN
- Polygon

## Prerequisites

- Node.js 18+
- PNPM 8+
- MongoDB instance
- Notion integration token and database ID

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd atomix-to-notion
```

2. Install dependencies:

```bash
pnpm install
```

3. Copy the environment configuration:

```bash
cp .env.example .env
```

4. Configure your environment variables in `.env`:

```env
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/gaming-news-crawler
DB_NAME=gaming_news
NOTION_TOKEN=your_notion_integration_token_here
NOTION_DATABASE_ID=your_notion_database_id_here
```

## Database Schema

Articles are stored with the following structure:

```typescript
interface IEntry extends Document {
  entryId: string; // Unique identifier
  title?: string; // Article title
  author?: string; // Article author
  summary?: string; // Article summary/excerpt
  content: string; // Full article content
  link: string; // Original article URL
  created?: boolean; // Whether synced to Notion
  entryErrors?: string[]; // Any sync errors
  entryDate: Date; // Article publication date
}
```

## Usage

### Development

Start the crawler in development mode with auto-reload:

```bash
pnpm dev
```

### Production

Build and start the application:

```bash
pnpm build
pnpm start
```

### Manual Operations

Run the crawler once:

```bash
pnpm crawler
```

Run the Notion sync once:

```bash
pnpm notion-sync
```

Or use the CLI flags:

```bash
tsx src/index.ts --crawler-once
tsx src/index.ts --notion-sync-once
```

## Configuration

### Cron Schedules

- **Crawler**: Runs every 6 hours by default (`0 */6 * * *`)
- **Notion Sync**: Runs every 4 hours by default (`0 */4 * * *`)

### Environment Variables

| Variable               | Description                   | Default                                         |
| ---------------------- | ----------------------------- | ----------------------------------------------- |
| `MONGODB_URI`          | MongoDB connection string     | `mongodb://localhost:27017/gaming-news-crawler` |
| `DB_NAME`              | Database name                 | `gaming_news`                                   |
| `NOTION_TOKEN`         | Notion integration token      | -                                               |
| `NOTION_DATABASE_ID`   | Notion database ID            | -                                               |
| `CRAWLER_INTERVAL`     | Cron schedule for crawler     | `0 */6 * * *`                                   |
| `NOTION_SYNC_INTERVAL` | Cron schedule for Notion sync | `0 */4 * * *`                                   |
| `MAX_ARTICLES_PER_RUN` | Max articles per crawler run  | `50`                                            |
| `LOG_LEVEL`            | Logging level                 | `info`                                          |

## Notion Setup

1. Create a new Notion integration at https://www.notion.so/my-integrations
2. Create a new database in Notion with the following properties:
   - **Title** (Title)
   - **Link** (URL)
   - **Author** (Rich Text)
   - **Summary** (Rich Text)
   - **Entry Date** (Date)
3. Share the database with your integration
4. Copy the database ID from the URL and set it in your `.env` file

## Logging

Logs are written to:

- Console (with colors in development)
- `./logs/combined.log` - All logs
- `./logs/error.log` - Error logs only
- `./logs/app.log` - Main application log

## Development

### Project Structure

```
src/
├── config/          # Configuration and environment setup
├── database/        # MongoDB connection and setup
├── jobs/           # Cron job implementations
│   ├── crawler.ts  # Main crawler job
│   └── notionSync.ts # Notion synchronization job
├── models/         # Mongoose models and TypeScript interfaces
├── utils/          # Utility functions and helpers
│   ├── logger.ts   # Winston logger configuration
│   ├── scraper.ts  # Web scraping utilities
│   └── notion.ts   # Notion API client
└── index.ts        # Main application entry point
```

### Available Scripts

- `pnpm dev` - Start development server with auto-reload
- `pnpm build` - Build TypeScript to JavaScript
- `pnpm start` - Start production server
- `pnpm test` - Run Jest tests
- `pnpm lint` - Run ESLint
- `pnpm clean` - Clean build directory

### Adding New News Sources

To add a new gaming news source, update the `config/index.ts` file:

```typescript
{
  name: 'NewSite',
  url: 'https://example.com',
  listingPath: '/news/',
  selectors: {
    articleLinks: 'a[href*="/articles/"]',
    title: 'h1.title',
    author: '.author',
    content: '.content p',
    summary: '.summary',
    date: 'time[datetime]'
  }
}
```

## Error Handling

The crawler includes comprehensive error handling:

- Automatic retries for failed requests
- Graceful handling of malformed HTML
- Error logging and tracking in the database
- Automatic skipping of duplicate articles

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Run the linter and tests
6. Submit a pull request

## License

MIT License - see LICENSE file for details.
