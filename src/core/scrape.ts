/**
 * Scraper: fetch a URL and return structured page data.
 *
 * Two modes:
 *   - "fast" (default): plain HTTP fetch + DOMParser extraction.
 *     Works for ~90% of static sites. No browser needed.
 *   - "browser": Playwright headless Chromium for JS-rendered pages.
 *     Falls back to fast mode if Playwright isn't installed.
 */

import { fetchText, WebkitError } from "../core/http.ts";
import { extractPage, type PageData } from "../extract/content.ts";

export type ScrapeMode = "fast" | "browser";

export interface ScrapeOptions {
  /** "fast" (default) or "browser" (Playwright). */
  mode?: ScrapeMode;
  /** Wait for network idle in browser mode (ms). Default 5000. */
  waitUntilMs?: number;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** User-agent override. */
  userAgent?: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** On 4xx/5xx: throw (default) or return partial data with the status. */
  strict?: boolean;
}

export interface ScrapeResult extends PageData {
  mode: ScrapeMode;
  durationMs: number;
  retries: number;
}

export async function scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  const {
    mode = "fast",
    waitUntilMs = 5000,
    headers = {},
    userAgent,
    signal,
    strict = true,
  } = opts;

  const started = Date.now();
  const target = normalizeUrl(url);

  if (mode === "browser") {
    try {
      return await scrapeWithBrowser(target, { waitUntilMs, userAgent, signal });
    } catch (err) {
      if (isPlaywrightMissing(err)) {
        // Fall through to fast mode with a note on stderr.
        process.stderr.write(
          "[webkit] Playwright not available, falling back to fast mode. " +
            "Install with: bun add playwright && bunx playwright install chromium\n",
        );
      } else if (strict) {
        throw err;
      }
    }
  }

  return scrapeFast(target, { headers, userAgent, signal, strict });
}

function normalizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

async function scrapeFast(
  url: string,
  opts: {
    headers?: Record<string, string>;
    userAgent?: string;
    signal?: AbortSignal;
    strict?: boolean;
  },
): Promise<ScrapeResult> {
  const started = Date.now();
  const res = await fetchText(url, {
    headers: opts.headers,
    userAgent: opts.userAgent,
    signal: opts.signal,
  });

  if (opts.strict !== false && res.status >= 400) {
    throw new WebkitError(`HTTP ${res.status} for ${url}`);
  }

  const elapsed = Date.now() - started;
  const contentType = res.contentType.toLowerCase();
  const isHtml =
    contentType.includes("text/html") ||
    contentType === "" ||
    res.text.trimStart().startsWith("<");

  if (!isHtml) {
    // Non-HTML: return raw body as content.text, no metadata.
    return {
      url: res.url,
      status: res.status,
      contentType: res.contentType,
      mode: "fast",
      durationMs: elapsed,
      retries: res.retries,
      metadata: {
        title: "",
        description: null,
        canonical: null,
        favicon: null,
        meta: {},
        og: {},
        twitter: {},
        language: null,
        charset: null,
      },
      links: [],
      images: [],
      content: {
        text: res.text,
        html: res.text,
        contentRootTag: null,
        charCount: res.text.length,
        readingTimeSec: Math.ceil(res.text.split(/\s+/).filter(Boolean).length / 200 * 60),
      },
    };
  }

  const page = extractPage(res.text, res.url);
  return {
    ...page,
    url: res.url,
    status: res.status,
    contentType: res.contentType,
    mode: "fast",
    durationMs: Date.now() - started,
    retries: res.retries,
  };
}

async function scrapeWithBrowser(
  url: string,
  opts: { waitUntilMs?: number; userAgent?: string; signal?: AbortSignal },
): Promise<ScrapeResult> {
  const { chromium } = await import("playwright");
  const started = Date.now();
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent:
        opts.userAgent ||
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    const timeout = opts.waitUntilMs ?? 5000;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeout + 10000 });
    // Give JS a moment to render.
    await page.waitForTimeout(Math.min(timeout, 3000));
    const html = await page.content();
    const finalUrl = page.url();
    const data = extractPage(html, finalUrl);
    return {
      ...data,
      url: finalUrl,
      mode: "browser",
      durationMs: Date.now() - started,
      retries: 0,
    };
  } finally {
    await browser.close();
  }
}

function isPlaywrightMissing(err: unknown): boolean {
  return (
    err instanceof Error &&
    (/Cannot find module|playwright/i.test(err.message) ||
      (err as { code?: string }).code === "ERR_MODULE_NOT_FOUND")
  );
}
