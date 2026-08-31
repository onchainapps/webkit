# webkit

Self-hosted **web search + scraping** tool. Bun + TypeScript. **No API keys, no
headless browser required** for the common case.

Built to feed LLMs and agent pipelines with clean, structured web data.

## Why

- `search` — DuckDuckGo HTML (primary) with a Bing fallback. No key, no JS.
- `scrape` — plain HTTP + DOM parsing extracts title, meta/og: tags, links,
  images, and a Readability-style main-content block. Fast (sub-second).
- `top` — the killer feature: search a query **and** scrape the top N results
  in one call. Ideal for RAG grounding.
- Optional `browser` mode (Playwright) for JS-rendered pages, with automatic
  fallback to fast mode if Playwright isn't installed.

## Install / run

```bash
cd /media/bakon/data/llms/webkit
bun install            # already installed
bun test               # 17 tests: unit (fixture) + live integration
bun run typecheck      # tsc --noEmit
```

### CLI

```bash
# Search
bun run src/cli/index.ts search "cardano utxo model" -c 5
bun run src/cli/index.ts search "gravity dex" --json | jq '.[0].url'

# Scrape one URL (human-readable)
bun run src/cli/index.ts scrape https://developers.cardano.org --chars 500

# Scrape as structured JSON
bun run src/cli/index.ts json https://iohk.io/en/blog/

# Search + scrape the top N in one shot
bun run src/cli/index.ts top "cardano eutxo" -n 3 --chars 300
```

### Library

```ts
import { search, scrape, top } from "/media/bakon/data/llms/webkit/src/index.ts";

// Search
const results = await search("cardano utxo model", { count: 5 });
// [{ rank, title, url, snippet, engine }, ...]

// Scrape
const page = await scrape("https://developers.cardano.org");
page.metadata.title;        // "..."
page.metadata.description;  // meta/og description
page.metadata.og;           // all og:* tags
page.links;                 // [{ href, text, rel, absolute, external }]
page.images;                // [{ src, alt, width, height, absolute }]
page.content.text;          // main content, plain text
page.content.html;          // main content, HTML
page.content.readingTimeSec;

// Search + scrape pipeline
const pages = await top("gravity dex cardano", { count: 3, mode: "fast" });
// [{ result, page?, error? }, ...]  (error set if a page 403'd, etc.)
```

## Architecture

```
src/
  index.ts           public API + top() pipeline
  core/
    http.ts          fetch w/ retries, backoff, browser-like headers, timeouts
    search.ts        DDG HTML parser + Bing fallback → normalized results
    scrape.ts        fast (HTTP) + browser (Playwright) scrape modes
    dom.ts           happy-dom Window pool (Bun-compatible HTML parse)
  extract/
    content.ts       metadata, links, images, Kadane-scored main-content extractor
  cli/
    index.ts         the `webkit` command
tests/
  unit.test.ts       fixture-based, deterministic
  integration.test.ts live (auto no-ops offline)
```

### Notes / gotchas

- **Bun + happy-dom:** happy-dom's `DOMParser` global shim is broken under Bun
  (`window.HTMLDocument` undefined at module eval). We work around it by parsing
  through a `Window` instance (see `core/dom.ts`). Don't swap in the shim.
- **TS7 (native tsc):** `baseUrl` is removed; use `paths` only. `tsc` here is the
  native TypeScript 7 compiler.
- **Bun test quirk:** `test.skipIf(cond)` is evaluated at *collection* time, before
  `beforeAll` — so live tests use runtime `if (!online) return;` guards instead.
- **Bot protection:** some sites (e.g. cardanoscan.io) return 403 to our
  non-browser UA. `scrape({ strict: false })` returns partial data; `strict: true`
  (default) throws. Use `--mode browser` for JS-heavy/bot-gated pages.

## Roadmap (ideas)

- [ ] Crawl mode: BFS from a URL with depth + same-origin filters
- [ ] Markdown output for `content` (for LLM ingestion)
- [ ] Respect `robots.txt`
- [ ] Cache layer (SQLite/HTTP cache) to avoid re-fetching
- [ ] Sitemap + RSS discovery
- [ ] `webkit watch <url>` — poll for changes
