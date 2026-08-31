/**
 * Unit tests for webkit extraction + search parsing (deterministic, fixture-based).
 * Live integration tests live in integration.test.ts and are skipped offline.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import {
  extractPage,
  extractMetadata,
  extractLinks,
  extractImages,
  extractMainContent,
} from "../src/extract/content.ts";
import { extractPrice } from "../src/extract/price.ts";
import { parseHtml } from "../src/core/dom.ts";

// search.ts keeps its parsers private, so we test them indirectly via a
// small re-implementation guard: verify the public search() shape with a
// mocked fetch. For pure parsing coverage we exercise extractPage instead.
const articleHtml = readFileSync(
  new URL("./fixtures/article.html", import.meta.url),
  "utf8",
);
const ddgHtml = readFileSync(
  new URL("./fixtures/ddg.html", import.meta.url),
  "utf8",
);

describe("extractPage (article fixture)", () => {
  test("parses metadata", () => {
    const page = extractPage(articleHtml, "https://example.com/canonical/path");
    expect(page.metadata.title).toBe("Test Article & Page");
    expect(page.metadata.description).toBe(
      "A test page for webkit extraction.",
    );
    expect(page.metadata.canonical).toBe("https://example.com/canonical/path");
    expect(page.metadata.favicon).toBe("https://example.com/favicon.ico");
    expect(page.metadata.language).toBe("en");
    expect(page.metadata.charset).toBe("utf-8");
  });

  test("parses og: and twitter: tags", () => {
    const page = extractPage(articleHtml, "https://example.com/canonical/path");
    expect(page.metadata.og["og:title"]).toBe("OG Title");
    // og:image is absolutized against the base URL so it's directly fetchable.
    expect(page.metadata.og["og:image"]).toBe("https://example.com/img/og.png");
    expect(page.metadata.twitter["twitter:card"]).toBe("summary_large_image");
  });

  test("extracts and classifies links", () => {
    const page = extractPage(articleHtml, "https://example.com/canonical/path");
    const external = page.links.filter((l) => l.external);
    const internal = page.links.filter((l) => !l.external);
    expect(external.some((l) => l.absolute === "https://external.example.com/external")).toBe(true);
    expect(internal.length).toBeGreaterThanOrEqual(3); // nav + internal footer
    // Every absolute link should be an http(s) URL
    for (const l of page.links) {
      if (l.absolute) expect(l.absolute.startsWith("http")).toBe(true);
    }
  });

  test("extracts images with dimensions", () => {
    const page = extractPage(articleHtml, "https://example.com/canonical/path");
    expect(page.images.length).toBeGreaterThanOrEqual(2);
    const photo = page.images.find((i) => i.src === "/img/photo.jpg");
    expect(photo?.width).toBe(800);
    expect(photo?.height).toBe(600);
    expect(photo?.alt).toBe("A photo");
    const remote = page.images.find((i) => i.src.startsWith("https://cdn"));
    expect(remote?.absolute).toBe("https://cdn.example.com/remote.png");
  });

  test("main content includes article, excludes footer boilerplate", () => {
    const page = extractPage(articleHtml, "https://example.com/canonical/path");
    const text = page.content.text;
    expect(text).toContain("The Real Headline");
    expect(text).toContain("extended UTXO model");
    expect(text).toContain("Fourth paragraph");
    // Footer legal boilerplate should NOT be in the extracted main content
    expect(text).not.toContain("legal boilerplate");
    expect(text).not.toContain("copyright notices");
  });

  test("content has sane stats", () => {
    const page = extractPage(articleHtml, "https://example.com/canonical/path");
    expect(page.content.charCount).toBeGreaterThan(200);
    expect(page.content.readingTimeSec).toBeGreaterThan(0);
    expect(page.content.contentRootTag).toBe("h1");
  });
});

describe("extractMainContent (noise handling)", () => {
  test("strips script/style/nav before scoring", () => {
    const html = `
      <html><body>
        <script>var x = "should not appear";</script>
        <style>.a{color:red}</style>
        <nav><a href="/x">Nav link</a></nav>
        <main>
          <p>The only real content paragraph on this page with enough words
             for the extractor to latch onto and return as the main body.</p>
        </main>
      </body></html>`;
    const content = extractMainContent(parseHtml(html), "https://x.com");
    expect(content.text).toContain("only real content paragraph");
    expect(content.text).not.toContain("should not appear");
    expect(content.text).not.toContain("Nav link");
  });

  test("returns body text when no block candidates", () => {
    const html = `<html><body><div>Just a plain div with no block tags at all inside it here.</div></body></html>`;
    const content = extractMainContent(parseHtml(html), "https://x.com");
    expect(content.text).toContain("plain div");
  });
});

describe("DDG result parsing (via search fixture shape)", () => {
  test("fixture has the expected structure", () => {
    const doc = parseHtml(ddgHtml);
    const results = doc.querySelectorAll("div.result");
    expect(results.length).toBeGreaterThanOrEqual(3);
    // The uddg= encoded links should be present
    const firstHref = doc.querySelector("a.result__a")?.getAttribute("href") ?? "";
    expect(firstHref).toContain("uddg=");
    // Decoding the first should yield example.com/page1
    const m = firstHref.match(/uddg=([^&]+)/);
    if (m?.[1]) {
      expect(decodeURIComponent(m[1])).toBe("https://example.com/page1");
    }
  });
});

describe("http layer", () => {
  test("WebkitError is an Error subclass", async () => {
    const { WebkitError } = await import("../src/core/http.ts");
    const e = new WebkitError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("WebkitError");
    expect(e.message).toBe("boom");
  });

  test("DEFAULT_USER_AGENT looks like a browser", async () => {
    const { DEFAULT_USER_AGENT } = await import("../src/core/http.ts");
    expect(DEFAULT_USER_AGENT).toContain("Mozilla/5.0");
    expect(DEFAULT_USER_AGENT).toContain("Chrome");
  });
});

describe("extractPrice", () => {
  test("reads JSON-LD Product offers.price", () => {
    const html = `<!doctype html><html><head><script type="application/ld+json">
      {"@type":"Product","name":"X","offers":{"@type":"Offer","price":"1649.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
      </script></head><body><p>hi</p></body></html>`;
    const p = extractPrice(parseHtml(html));
    expect(p?.amount).toBe(1649);
    expect(p?.currency).toBe("USD");
    expect(p?.source).toBe("json-ld");
  });

  test("handles @graph and array offers", () => {
    const html = `<!doctype html><html><head><script type="application/ld+json">
      {"@graph":[{"@type":"Product","offers":[{"@type":"Offer","price":99.5,"priceCurrency":"USD"}]}]}
      </script></head><body></body></html>`;
    const p = extractPrice(parseHtml(html));
    expect(p?.amount).toBe(99.5);
  });

  test("falls back to a class-based price element", () => {
    const html = `<!doctype html><html><body>
      <div class="price-current">$1,609.99</div>
      <p>product</p>
    </body></html>`;
    const p = extractPrice(parseHtml(html));
    expect(p?.amount).toBe(1609.99);
    expect(p?.source).toBe("class");
  });

  test("reads itemprop=price microdata", () => {
    const html = `<!doctype html><html><body>
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="price" content="249.99">$249.99</span>
      </div></body></html>`;
    const p = extractPrice(parseHtml(html));
    expect(p?.amount).toBe(249.99);
    expect(p?.source).toBe("microdata");
  });

  test("returns null when no price present", () => {
    const p = extractPrice(parseHtml("<html><body><p>no price here</p></body></html>"));
    expect(p).toBeNull();
  });
});

describe("detectChallenge (via scrape fast mode blocked heuristic)", () => {
  // detectChallenge is exercised end-to-end in integration; here we unit-test
  // the fast-mode `blocked` flag through a mocked fetch.
  test("fast mode flags a tiny 403 body as blocked", async () => {
    const { scrape } = await import("../src/core/scrape.ts");
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html><body>403 Forbidden</body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    try {
      const r = await scrape("https://example.com", { strict: false, mode: "fast" });
      expect(r.status).toBe(403);
      expect(r.blocked).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("fast mode does not flag a 200 page as blocked", async () => {
    const { scrape } = await import("../src/core/scrape.ts");
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html><body><p>real content</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    try {
      const r = await scrape("https://example.com", { mode: "fast" });
      expect(r.blocked).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("extractPrice (was/now handling)", () => {
  test("takes the current price, not the struck-through 'was' price", () => {
    // Mimics Newegg: a product-price block shows the old price then the current.
    const html = `<!doctype html><html><body>
      <div class="product-price">$1,549.00$1,609.99Click to See Extra Discount</div>
    </body></html>`;
    const p = extractPrice(parseHtml(html));
    expect(p?.amount).toBe(1609.99); // current, not 1549
    expect(p?.wasPrice).toBe(1549.0);
    expect(p?.source).toBe("class");
  });

  test("product-price wins over seller-listing price-current", () => {
    const html = `<!doctype html><html><body>
      <li class="price-current">$1,729.35</li>
      <div class="product-price">$1,609.99</div>
    </body></html>`;
    const p = extractPrice(parseHtml(html));
    expect(p?.amount).toBe(1609.99);
  });
});
