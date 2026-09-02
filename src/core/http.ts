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
  /** How many times the request was retried (0 = first attempt succeeded). */
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

/** Parse a Retry-After header (seconds or HTTP-date) into a delay in ms, capped. */
function retryAfterMs(res: Response, cap = 10_000): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(cap, Math.max(0, secs * 1000));
  const at = Date.parse(h);
  if (Number.isNaN(at)) return null;
  return Math.min(cap, Math.max(0, at - Date.now()));
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

  for (;;) {
    attempt += 1;
    if (signal?.aborted) throw signal.reason ?? new WebkitError(`Request to ${url} aborted`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    // Chain an external abort into our per-attempt controller.
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(url, {
        headers: allHeaders,
        redirect: "follow",
        signal: controller.signal,
      });

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) {
        // Drain the body so the connection can be reused, then back off.
        await res.arrayBuffer().catch(() => {});
        const backoff = 750 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        await sleep(retryAfterMs(res) ?? backoff);
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
      // Don't retry explicit aborts from the caller.
      if (signal?.aborted) throw err;
      const isTimeout = controller.signal.aborted;
      if (attempt < maxAttempts && !isTimeout) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new WebkitError(
        `Request to ${url} failed after ${attempt} attempt(s): ${
          isTimeout ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err)
        }`,
        err,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export class WebkitError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "WebkitError";
  }
}
