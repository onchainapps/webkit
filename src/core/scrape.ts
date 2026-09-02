/**
 * Scraper: fetch a URL and return structured page data.
 *
 * Three modes:
 *   - "fast" (default): plain HTTP fetch + DOM extraction.
 *     Works for ~90% of static sites. No browser needed.
 *   - "browser": Playwright headless Chromium for JS-rendered pages.
 *     Detects bot challenges (Cloudflare "Just a moment…") and reports them.
 *   - "auto": try fast first; if it 4xx/5xx, looks blocked, or times out,
 *     fall back to browser. Best default when a site's bot posture is unknown.
 *
 * Browser mode falls back to fast mode if Playwright isn't installed.
 */

import { fetchText, WebkitError, DEFAULT_USER_AGENT } from "../core/http.ts";
import { extractPageFromDoc, type PageData } from "../extract/content.ts";
import { extractPrice, type PriceInfo } from "../extract/price.ts";
import { withDoc } from "../core/dom.ts";

export type ScrapeMode = "fast" | "browser" | "auto";

export interface ScrapeOptions {
  /** "fast" (default), "browser" (Playwright), or "auto" (fast→browser). */
  mode?: ScrapeMode;
  /** Wait in browser mode for JS / bot-challenges to settle (ms). Default 8000. */
  waitUntilMs?: number;
  /** Extra headers (fast mode only). */
  headers?: Record<string, string>;
  /** User-agent override. */
  userAgent?: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** On 4xx/5xx: throw (default) or return partial data with the status. */
  strict?: boolean;
  /** Extract a price (JSON-LD / microdata / class). Default true. */
  price?: boolean;
}

export interface ScrapeResult extends PageData {
  mode: ScrapeMode;
  /** The mode that actually produced this data. */
  effectiveMode: "fast" | "browser";
  durationMs: number;
  retries: number;
  /** True when we believe a bot/challenge wall is blocking real content. */
  blocked: boolean;
  /** The bot-challenge message, if `blocked`. */
  challenge: string | null;
  /** Structured price, if found (absent when blocked or no price present). */
  price?: PriceInfo;
  /** Set when Playwright was missing and we silently used fast instead. */
  fellBackToFast?: boolean;
}

export async function scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  const {
    mode = "fast",
    waitUntilMs = 8000,
    headers = {},
    userAgent,
    signal,
    strict = true,
    price = true,
  } = opts;

  const target = normalizeUrl(url);
  const browserOpts = { waitUntilMs, userAgent, signal, strict, price };

  if (mode === "browser") {
    if (!(await hasPlaywright())) {
      const fast = await scrapeFast(target, { headers, userAgent, signal, strict, price });
      return { ...fast, mode: "browser", fellBackToFast: true };
    }
    return scrapeWithBrowser(target, browserOpts);
  }

  if (mode === "auto") {
    const playwrightReady = await hasPlaywright();
    // Try fast; if the site 4xx/5xx'd, looks blocked, or timed out, escalate.
    let fast: ScrapeResult;
    try {
      fast = await scrapeFast(target, { headers, userAgent, signal, strict: false, price });
    } catch (err) {
      // Fast threw (e.g. network timeout) — try the browser before giving up.
      if (err instanceof WebkitError && playwrightReady && !signal?.aborted) {
        try {
          return { ...(await scrapeWithBrowser(target, browserOpts)), mode: "auto" };
        } catch (browserErr) {
          throw strict ? browserErr : err;
        }
      }
      throw err;
    }
    fast.mode = "auto";

    const fastFailed = fast.status >= 400 || fast.blocked;
    if (fastFailed && playwrightReady) {
      try {
        return { ...(await scrapeWithBrowser(target, browserOpts)), mode: "auto" };
      } catch (browserErr) {
        // Browser also failed. Honor strict; otherwise hand back the fast attempt.
        if (strict) throw browserErr;
        return fast;
      }
    }
    if (strict && fast.status >= 400) throw new WebkitError(`HTTP ${fast.status} for ${target}`);
    return fast;
  }

  // Plain fast mode.
  return scrapeFast(target, { headers, userAgent, signal, strict, price });
}

function normalizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

/** Cheap Playwright-availability probe (cached) so `auto` doesn't double-import. */
let playwrightAvailable: boolean | null = null;
async function hasPlaywright(): Promise<boolean> {
  if (playwrightAvailable === null) {
    try {
      await import("playwright");
      playwrightAvailable = true;
    } catch {
      playwrightAvailable = false;
    }
  }
  return playwrightAvailable;
}

/**
 * Parse `html` once and run every extractor against it. Price runs first
 * because main-content extraction prunes the DOM.
 */
function extractAll(
  html: string,
  url: string,
  wantPrice: boolean,
): { page: PageData; price: PriceInfo | null } {
  return withDoc(html, (doc) => {
    const price = wantPrice ? extractPrice(doc) : null;
    const page = extractPageFromDoc(doc, url);
    return { page, price };
  });
}

function emptyPage(url: string, status: number, contentType: string, text: string): PageData {
  return {
    url,
    status,
    contentType,
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
      text,
      html: text,
      contentRootTag: null,
      charCount: text.length,
      readingTimeSec: Math.ceil((text.split(/\s+/).filter(Boolean).length / 200) * 60),
    },
  };
}

async function scrapeFast(
  url: string,
  opts: {
    headers?: Record<string, string>;
    userAgent?: string;
    signal?: AbortSignal;
    strict?: boolean;
    price?: boolean;
  },
): Promise<ScrapeResult> {
  const started = Date.now();
  const res = await fetchText(url, {
    headers: opts.headers,
    userAgent: opts.userAgent,
    signal: opts.signal,
  });

  const contentType = res.contentType.toLowerCase();
  const isHtml =
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml") ||
    (contentType === "" && res.text.trimStart().startsWith("<"));

  // Strict mode throws on any 4xx/5xx (callers can pass strict:false to get
  // partial data back instead).
  if (opts.strict !== false && res.status >= 400) {
    throw new WebkitError(`HTTP ${res.status} for ${url}`);
  }

  // Bot-block heuristics (fast mode):
  //  - a 4xx/5xx status with a tiny body is almost always a bot wall / error page
  //  - a challenge interstitial can also arrive with a 200, so run the detector too
  const challenge = isHtml ? detectChallenge(res.text) : null;
  const blocked = challenge !== null || (res.status >= 400 && res.text.length < 5000);

  if (!isHtml) {
    return {
      ...emptyPage(res.url, res.status, res.contentType, res.text),
      mode: "fast",
      effectiveMode: "fast",
      durationMs: Date.now() - started,
      retries: res.retries,
      blocked,
      challenge,
    };
  }

  const { page, price } = extractAll(res.text, res.url, opts.price === true && !blocked);
  const out: ScrapeResult = {
    ...page,
    url: res.url,
    status: res.status,
    contentType: res.contentType,
    mode: "fast",
    effectiveMode: "fast",
    durationMs: Date.now() - started,
    retries: res.retries,
    blocked,
    challenge,
  };
  if (price) out.price = price;
  return out;
}

async function scrapeWithBrowser(
  url: string,
  opts: {
    waitUntilMs?: number;
    userAgent?: string;
    signal?: AbortSignal;
    strict?: boolean;
    price?: boolean;
  },
): Promise<ScrapeResult> {
  const { chromium } = await import("playwright");
  const started = Date.now();
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: opts.userAgent || DEFAULT_USER_AGENT });
    const page = await ctx.newPage();
    const waitMs = opts.waitUntilMs ?? 8000;
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: waitMs + 15000,
    });
    // Give JS (and any bot-challenge) time to render.
    await page.waitForTimeout(waitMs);
    const html = await page.content();
    const finalUrl = page.url();
    const status = response?.status() ?? 200;

    // Detect a bot-challenge wall before we trust the DOM.
    const challenge = detectChallenge(html);
    const blocked = challenge !== null;

    if (opts.strict !== false && status >= 400 && !blocked) {
      throw new WebkitError(`HTTP ${status} for ${url}`);
    }

    // Don't report a price from a challenge page — the DOM is the wall, not the product.
    const { page: data, price } = extractAll(html, finalUrl, opts.price === true && !blocked);
    const out: ScrapeResult = {
      ...data,
      url: finalUrl,
      status,
      mode: "browser",
      effectiveMode: "browser",
      durationMs: Date.now() - started,
      retries: 0,
      blocked,
      challenge,
    };
    if (price) out.price = price;
    return out;
  } finally {
    await browser.close();
  }
}

/**
 * Detect a bot-challenge wall in HTML. Returns a short human reason,
 * or null when the page looks like real content.
 */
export function detectChallenge(html: string): string | null {
  const lower = html.slice(0, 40000).toLowerCase();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = (titleMatch?.[1] || "").trim();
  if (/just a moment/i.test(title)) return `Cloudflare challenge: "${title}"`;
  if (/please enable js|enable javascript to continue/i.test(lower)) {
    return "JavaScript-required gate (e.g. Incapsula/PerimeterX)";
  }
  if (/checking your browser|verify you are human|checking if your browser is ok/i.test(lower)) {
    return "Browser-verification interstitial";
  }
  // Cloudflare turnstile / challenge-platform script with no cf_clearance.
  if ((lower.includes("cf-challenge") || lower.includes("challenge-platform")) &&
      !lower.includes("cf_clearance")) {
    // Only flag if the body is also tiny — some sites load the platform script
    // as part of a normal page.
    const bodyText = html.replace(/<[^>]*>/g, " ").trim();
    if (bodyText.length < 600) return "Cloudflare challenge platform (no clearance cookie)";
  }
  return null;
}
