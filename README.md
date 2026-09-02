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

Requires [Bun](https://bun.sh) 1.x.

```bash
git clone <this-repo> webkit && cd webkit
bun install            # happy-dom + (optional) playwright
bun test               # unit (fixture-based) + live integration (auto-skips offline)
bun run typecheck      # tsc --noEmit
```

`browser` mode also needs a Chromium build: `bunx playwright install chromium`.
Without it, browser mode transparently falls back to fast mode and sets
`fellBackToFast: true` on the result.

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
// From a sibling project: import from the repo's src/index.ts, or add it as a
// path dependency in package.json ("webkit": "file:../webkit") and import "webkit".
import { search, scrape, top } from "webkit";

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
    price.ts         JSON-LD / microdata / class-based price extraction
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
  non-browser UA. `scrape({ strict: false })` (CLI: `--lenient`) returns partial
  data; `strict: true` (default) throws. Use `--mode browser` or `--mode auto`
  for JS-heavy/bot-gated pages. Both modes set `blocked` / `challenge` when a
  Cloudflare-style interstitial is detected instead of real content.
- **DuckDuckGo 202:** after a burst of queries DDG serves a captcha page with
  HTTP 202 instead of results. The cascade falls through to Bing automatically;
  with `--engine ddg` forced you get a clear error instead. Back off for a while.
- **Untrusted HTML:** pages are parsed with script evaluation and external
  resource loading disabled (`core/dom.ts`). Scraped JavaScript never runs.
- **Price extraction is USD-only** for now: it recognises `$` amounts and
  JSON-LD/microdata `price` fields, and reports `currency` from JSON-LD when
  declared (else `"USD"`). Locale formats like `1.609,99 €` are not parsed.

### Responsible use

`search` works by fetching DuckDuckGo's and Bing's HTML result pages with a
browser-like User-Agent and parsing them. This is not an official API: it may
break whenever their markup changes, and automated querying is against both
engines' terms of service. `scrape` does not (yet) honor `robots.txt` or apply
per-host rate limits beyond `top()`'s small concurrency cap. Use it for
personal/research workloads at low volume, respect site owners, and don't point
it at sites that prohibit scraping.

## License

MIT — see [LICENSE](LICENSE).

## Roadmap (ideas)

- [ ] Crawl mode: BFS from a URL with depth + same-origin filters
- [ ] Markdown output for `content` (for LLM ingestion)
- [ ] Respect `robots.txt`
- [ ] Cache layer (SQLite/HTTP cache) to avoid re-fetching
- [ ] Sitemap + RSS discovery
- [ ] `webkit watch <url>` — poll for changes
