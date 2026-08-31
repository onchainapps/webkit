/**
 * Search engine adapters.
 *
 * Primary: DuckDuckGo HTML endpoint (https://html.duckduckgo.com/html/?q=...) —
 *   no API key, no JS, plain GET with an HTML response.
 * Fallback: Bing (https://www.bing.com/search?q=...) — GET, robust HTML.
 *
 * Both return normalized SearchResults.
 */

import { fetchText, WebkitError } from "./http.ts";
import { parseHtml } from "./dom.ts";

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  /** Snippet as shown by the engine (may be empty). */
  snippet: string;
  /** Which engine produced this result. */
  engine: "duckduckgo" | "bing";
}

export interface SearchOptions {
  /** Number of results to return (default 10). */
  count?: number;
  /** Force a specific engine instead of the DDG→Bing cascade. */
  engine?: "duckduckgo" | "bing";
  /** Safety filter: "strict" | "moderate" | "off" (default "moderate"). */
  safeSearch?: "strict" | "moderate" | "off";
  /** Abort signal. */
  signal?: AbortSignal;
}

function parseDuckDuckGo(html: string, count: number): SearchResult[] {
  const doc = parseHtml(html);
  const results: SearchResult[] = [];

  // DDG HTML lists results in <div class="result results_links ..."> containers
  // each holding an <a class="result__a"> title and a snippet element.
  const items = doc.querySelectorAll("div.result, div.web-result");

  items.forEach((item) => {
    if (results.length >= count) return;

    const linkEl = item.querySelector("a.result__a, h2 a");
    const snippetEl = item.querySelector(
      "a.result__snippet, div.result__snippet, .result__snippet",
    );
    if (!linkEl) return;

    const href = linkEl.getAttribute("href") ?? "";
    const url = resolveDdgUrl(href);
    if (!url) return;

    results.push({
      rank: results.length + 1,
      title: linkEl.textContent?.trim() ?? "",
      url,
      snippet: snippetEl?.textContent?.trim() ?? "",
      engine: "duckduckgo",
    });
  });

  return results;
}

/**
 * DuckDuckGo wraps result URLs in /l/?uddg=<encoded-url>.
 * Also handles bare absolute hrefs (some layouts).
 */
function resolveDdgUrl(href: string): string | null {
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  const m = href.match(/uddg=([^&]+)/);
  if (m) {
    const encoded = m[1];
    if (encoded === undefined) return null;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }
  return null;
}

function parseBing(html: string, count: number): SearchResult[] {
  const doc = parseHtml(html);
  const results: SearchResult[] = [];

  // Bing organic results: <li class="b_algo"> with <h2><a>
  const items = doc.querySelectorAll("li.b_algo");
  items.forEach((item) => {
    if (results.length >= count) return;

    const linkEl = item.querySelector("h2 a");
    const snippetEl = item.querySelector(
      "p.b_lineclamp, .b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_lineclamp5, p",
    );
    if (!linkEl) return;

    const href = linkEl.getAttribute("href") ?? "";
    if (!href.startsWith("http")) return;

    results.push({
      rank: results.length + 1,
      title: linkEl.textContent?.trim() ?? "",
      url: href,
      snippet: snippetEl?.textContent?.trim() ?? "",
      engine: "bing",
    });
  });

  return results;
}

/**
 * Run a web search. Tries DuckDuckGo first; if it returns nothing parseable,
 * falls back to Bing. Returns normalized results (empty array only if the
 * query genuinely has no results).
 */
export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const { count = 10, engine, safeSearch = "moderate", signal } = opts;

  const engines: Array<"duckduckgo" | "bing"> = engine
    ? [engine]
    : ["duckduckgo", "bing"];

  let lastError: unknown = null;

  for (const eng of engines) {
    try {
      if (eng === "duckduckgo") {
        const q = new URLSearchParams({ q: query, kl: "us-en" });
        const res = await fetchText(`https://html.duckduckgo.com/html/?${q.toString()}`, {
          signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        const results = parseDuckDuckGo(res.text, count);
        if (results.length > 0) return results;
        lastError = new WebkitError("DuckDuckGo returned no parseable results");
      } else {
        const q = new URLSearchParams({ q: query, setlang: "en" });
        if (safeSearch === "strict") q.set("family", "1");
        const res = await fetchText(`https://www.bing.com/search?${q.toString()}`, {
          signal,
        });
        if (res.status !== 200) {
          lastError = new WebkitError(`Bing returned HTTP ${res.status}`);
          continue;
        }
        const results = parseBing(res.text, count);
        if (results.length > 0) return results;
        lastError = new WebkitError("Bing returned no parseable results");
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw new WebkitError(
    `Search for "${query}" failed on all engines: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
