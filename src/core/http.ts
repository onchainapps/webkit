/**
 * HTTP layer for webkit.
 *
 * - Browser-like headers (most search/scrape targets fingerprint these)
 * - Retries with exponential backoff on 429/5xx/network errors
 * - Timeout control
 * - Follows redirects, records the final URL
 */

export interface FetchOptions {
  /** Request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Max attempts (default 3). Retries on 429, 5xx, and network errors. */
  maxAttempts?: number;
  /** Override the User-Agent (defaults to a modern desktop Chrome UA). */
  userAgent?: string;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/** A realistic modern desktop UA — many sites gate content behind this. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

export interface FetchResult {
  /** Final URL after redirects. */
  url: string;
  /** Response status code. */
  status: number;
  /** Decoded text body. */
  text: string;
  /** Final response content-type header. */
  contentType: string;
  /** Whether the request was retried at least once. */
  retries: number;
  /** Wall-clock duration of the whole operation (ms). */
  durationMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultHeaders(userAgent: string): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: DEFAULT_ACCEPT,
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
  };
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const {
    timeoutMs = 15000,
    maxAttempts = 3,
    userAgent = DEFAULT_USER_AGENT,
    headers = {},
    signal,
  } = opts;

  const allHeaders = { ...defaultHeaders(userAgent), ...headers };
  const started = Date.now();
  let attempt = 0;
  let lastError: unknown;

  for (;;) {
    attempt += 1;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const controller = new AbortController();
    // Chain an external abort into our timeout controller.
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }

    try {
      const res = await fetch(url, {
        headers: allHeaders,
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) {
        const delay = 750 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        await sleep(delay);
        continue;
      }

      const text = await res.text();
      return {
        url: res.url || url,
        status: res.status,
        text,
        contentType: res.headers.get("content-type") ?? "",
        retries: attempt - 1,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      // Don't retry explicit aborts from the caller.
      if (signal?.aborted) throw err;
      if (attempt < maxAttempts && !isAbort) {
        const delay = 500 * 2 ** (attempt - 1);
        await sleep(delay);
        continue;
      }
      throw new WebkitError(
        `Request to ${url} failed after ${attempt} attempt(s): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export class WebkitError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "WebkitError";
  }
}
