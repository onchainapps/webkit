/**
 * Document creation for webkit.
 *
 * happy-dom's `DOMParser` global shim is incompatible with Bun (it references
 * `window.HTMLDocument` which is undefined at module-eval time). The `Window`
 * API, however, works fine. So we create documents via a Window and expose a
 * parseHtml() helper that both the search and extraction modules use.
 *
 * We keep a small pool of Windows to avoid the (non-trivial) cost of spinning
 * one up per parse.
 */

import { Window, type Document as HDocument } from "happy-dom";

let pool: Window[] = [];
let poolSize = 0;
const POOL_MAX = 4;

function acquire(): Window {
  let w = pool.pop();
  if (!w) {
    w = new Window();
  }
  // Reset the document so we don't leak state between parses.
  w.document.open();
  w.document.close();
  poolSize++;
  return w;
}

function release(w: Window) {
  if (pool.length < POOL_MAX) {
    pool.push(w);
  } else {
    w.close();
  }
  poolSize = Math.max(0, poolSize - 1);
}

/**
 * Parse an HTML string into a happy-dom Document.
 * The returned Document is borrowed from an internal Window — do NOT retain it
 * across await boundaries in long-lived code (parse fresh when in doubt).
 */
export function parseHtml(html: string): HDocument {
  const w = acquire();
  try {
    w.document.write(html);
    return w.document;
  } catch (err) {
    w.close();
    throw err;
  }
}

/**
 * Run a synchronous callback against a fresh document parsed from `html`.
 * The Window is returned to the pool when the callback returns.
 */
export function withDoc<T>(html: string, fn: (doc: HDocument) => T): T {
  const w = acquire();
  try {
    w.document.write(html);
    return fn(w.document);
  } finally {
    release(w);
  }
}

/** Force-close the pool (for tests / clean shutdown). */
export function _closePool() {
  for (const w of pool) w.close();
  pool = [];
  poolSize = 0;
}
