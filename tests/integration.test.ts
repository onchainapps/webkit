/**
 * Live integration tests — hit the real web.
 *
 * NOTE: uses runtime `if (!online) return;` guards (NOT test.skipIf), because
 * Bun evaluates skipIf conditions at collection time — before beforeAll runs —
 * which would always skip. The offline check also sets online=false so these
 * no-op (count as pass) in sandboxes with no network.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { search, scrape, top } from "../src/index.ts";

const OFFLINE = process.env.WEBKIT_OFFLINE === "1";

let online = false;
beforeAll(async () => {
  if (OFFLINE) return;
  try {
    const res = await fetch("https://example.com", {
      method: "HEAD",
      signal: AbortSignal.timeout(6000),
    });
    online = res.ok;
  } catch {
    online = false;
  }
});

// Gate: tests that need the network bail early (and pass) when offline.
const need = () => {
  if (!online) {
    // Record that we skipped so a full-offline run is visible but green.
    console.log("  (offline — skipping live test)");
    return false;
  }
  return true;
};

describe("live: search", () => {
  test("returns results for a real query", async () => {
    if (!need()) return;
    const results = await search("cardano utxo model", { count: 3 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.rank).toBeGreaterThan(0);
    }
  }, 30000);

  test("results have unique URLs", async () => {
    if (!need()) return;
    const results = await search("bun typescript runtime", { count: 5 });
    const urls = new Set(results.map((r) => r.url));
    expect(urls.size).toBe(results.length);
  }, 30000);
});

describe("live: scrape", () => {
  test("scrapes a static page", async () => {
    if (!need()) return;
    const page = await scrape("https://example.com");
    expect(page.status).toBe(200);
    expect(page.metadata.title).toContain("Example Domain");
    expect(page.content.text).toContain("This domain is for use in documentation examples");
  }, 30000);

  test("handles a 404 gracefully in strict mode", async () => {
    if (!need()) return;
    await expect(
      scrape("https://example.com/definitely-not-a-real-page-404", { strict: true }),
    ).rejects.toThrow(/404/);
  }, 30000);

  test("non-strict returns partial data on 404", async () => {
    if (!need()) return;
    const page = await scrape("https://example.com/nope-404", { strict: false });
    expect(page.status).toBe(404);
  }, 30000);
});

describe("live: top pipeline", () => {
  test("search + scrape top results", async () => {
    if (!need()) return;
    const results = await top("cardano eutxo", { count: 2, scrapeCount: 2 });
    expect(results.length).toBe(2);
    expect(results.some((r) => r.page !== undefined)).toBe(true);
    const withPage = results.find((r) => r.page);
    if (withPage) {
      expect(withPage.page!.content.charCount).toBeGreaterThan(0);
    }
  }, 45000);
});
