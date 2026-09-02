/**
 * webkit — self-hosted web search + scraping.
 *
 * Public API:
 *   import { search, scrape, extractPage } from "webkit";
 *
 *   const results = await search("cardano utxo model", { count: 5 });
 *   const page    = await scrape("https://cardanoscan.io");
 *   console.log(page.metadata.title, page.content.text.slice(0, 200));
 */

import { search, type SearchResult, type SearchOptions } from "./core/search.ts";
import { scrape, type ScrapeResult, type ScrapeMode } from "./core/scrape.ts";

export {
  search,
  resolveEngine,
  type SearchEngine,
  type SearchResult,
  type SearchOptions,
} from "./core/search.ts";

export {
  scrape,
  type ScrapeOptions,
  type ScrapeResult,
  type ScrapeMode,
} from "./core/scrape.ts";

export {
  extractPage,
  extractPageFromDoc,
  extractMetadata,
  extractLinks,
  extractImages,
  extractMainContent,
  type PageData,
  type PageMetadata,
  type Link,
  type Image,
  type ExtractedContent,
} from "./extract/content.ts";

export {
  extractPrice,
  type PriceInfo,
} from "./extract/price.ts";

export { withDoc, parseHtml, disposeDoc } from "./core/dom.ts";

export {
  fetchText,
  WebkitError,
  DEFAULT_USER_AGENT,
  type FetchOptions,
  type FetchResult,
} from "./core/http.ts";

/**
 * Convenience pipeline: search, then scrape the top N results.
 *
 *   const pages = await top("cardano utxo", { count: 3, chars: 500 });
 *   // pages: Array<{ result, page, error? }>
 */
export interface TopResult {
  result: SearchResult;
  page?: ScrapeResult;
  /** Set when scraping this result failed (e.g. 403). */
  error?: string;
}

export interface TopOptions extends SearchOptions {
  /** Number of top results to scrape (default = count). */
  scrapeCount?: number;
  /** Scrape mode for each result. */
  mode?: ScrapeMode;
}

export async function top(
  query: string,
  opts: TopOptions = {},
): Promise<TopResult[]> {
  const { scrapeCount, mode = "fast", ...searchOpts } = opts;
  const results = await search(query, searchOpts);
  const n = scrapeCount ?? results.length;
  const chosen = results.slice(0, n);

  // Scrape in parallel with a small concurrency cap to stay polite.
  const out: TopResult[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < chosen.length; i += CONCURRENCY) {
    const batch = chosen.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (result) => {
        try {
          const page = await scrape(result.url, { mode });
          return { result, page } satisfies TopResult;
        } catch (err) {
          return {
            result,
            error: err instanceof Error ? err.message : String(err),
          } satisfies TopResult;
        }
      }),
    );
    out.push(...settled);
  }
  return out;
}
