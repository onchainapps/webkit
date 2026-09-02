/**
 * Document creation for webkit.
 *
 * happy-dom's `DOMParser` global shim is incompatible with Bun (it references
 * `window.HTMLDocument` which is undefined at module-eval time). The `Window`
 * API, however, works fine, so we create documents via a Window.
 *
 * Library code should use `withDoc()`: it borrows a Window from a small pool,
 * runs a synchronous callback against the parsed document, and returns the
 * Window to the pool. `parseHtml()` is the escape hatch for callers that need
 * to hold on to a Document (tests, REPL use): it hands out a dedicated Window
 * that the caller must release with `disposeDoc()`.
 *
 * All Windows are created with script evaluation and external resource
 * loading disabled — we parse untrusted HTML and must never run it.
 */

import { Window, type Document as HDocument } from "happy-dom";

const pool: Window[] = [];
const POOL_MAX = 4;

function createWindow(): Window {
  return new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableComputedStyleRendering: true,
    },
  });
}

function acquire(): Window {
  const w = pool.pop() ?? createWindow();
  // Reset the document so we don't leak state between parses.
  w.document.open();
  w.document.close();
  return w;
}

function release(w: Window) {
  if (pool.length < POOL_MAX) {
    pool.push(w);
  } else {
    void w.close();
  }
}

/**
 * Run a synchronous callback against a fresh document parsed from `html`.
 * The Window is returned to the pool when the callback returns, so do not
 * retain `doc` (or any node from it) beyond the callback.
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

/**
 * Parse an HTML string into a happy-dom Document backed by its own Window.
 * The caller owns it: call `disposeDoc(doc)` when finished, or the Window is
 * kept alive until process exit. Prefer `withDoc()` in library code.
 */
export function parseHtml(html: string): HDocument {
  const w = createWindow();
  try {
    w.document.write(html);
    return w.document;
  } catch (err) {
    void w.close();
    throw err;
  }
}

/** Release a Document obtained from `parseHtml()`. */
export function disposeDoc(doc: HDocument): void {
  const w = doc.defaultView as Window | null;
  if (w) void w.close();
}

/** Force-close the pool (for tests / clean shutdown). */
export function _closePool() {
  for (const w of pool) void w.close();
  pool.length = 0;
}
