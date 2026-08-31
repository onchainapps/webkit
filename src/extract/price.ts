/**
 * Price extraction from a rendered document.
 *
 * Prices on retailer pages usually live in one of three places, in order of
 * reliability:
 *   1. JSON-LD `schema.org/Product` (structured, most trustworthy)
 *   2. `price`/`itemprop="price"` microdata attributes
 *   3. Well-known price class names (`.product-price`, `.price-current`, …)
 *
 * We prefer the JSON-LD value when present and fall back to the visible
 * price element otherwise. When a page is bot-challenged (see scrape.ts) the
 * caller should treat the result as absent — we can't know the real price
 * from a "Just a moment…" page.
 *
 * Class-based extraction is the fiddly part: a product page often shows a
 * strikethrough "was" price next to the current one, and marketplace/seller
 * listings add more numbers. We therefore:
 *   - prefer the product's own price container (`.product-price`) over
 *     seller-listing containers (`.price-current`, `.price`),
 *   - skip numbers that are visually struck through or in a "was" element,
 *   - when a container has multiple numbers, take the one that is the
 *     current price (the last non-"was" number in a product-price block).
 */

import type { Document as HDocument, Element as HElement } from "happy-dom";

export interface PriceInfo {
  /** The price as a plain number, e.g. 1609.99. */
  amount: number;
  /** ISO 4217 code if declared, else "USD". */
  currency: string;
  /** Where we got it from. */
  source: "json-ld" | "microdata" | "class";
  /** The raw string as it appeared, for transparency. */
  raw: string;
  /** Availability string if declared (e.g. "InStock"), else null. */
  availability: string | null;
  /** A previous/"was" price, if one was detected alongside the current price. */
  wasPrice: number | null;
}

/**
 * Price container selectors, in priority order. The product's own price block
 * comes first; seller/marketplace listings come later so they only win if the
 * product price is absent.
 */
const PRICE_SELECTORS = [
  ".product-price",
  ".product-price .price",
  ".price-current",
  ".price__current",
  ".sale-price",
  ".price",
  "[class*='Price']--current",
  "[class*='price']--current",
];

function parseMoney(s: string): number | null {
  const cleaned = s.replace(/[^0-9.]/g, "");
  if (!cleaned || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Given a container's text, return { current, was }. We split on currency
 * boundaries and treat a struck-through or "was"-labeled number as the old
 * price. For a product-price block like "$1,549.00$1,609.99Click to See",
 * the LAST number is the current price and an earlier lower one is "was".
 */
function splitPrices(containerText: string): { current: number | null; was: number | null } {
  // All $-amounts in order of appearance.
  const amounts = (containerText.match(/\$[\d,]+(?:\.\d{2})?/g) || []).map((s) =>
    parseMoney(s),
  );
  const valid = amounts.filter((n): n is number => n !== null && n > 0);
  if (valid.length === 0) return { current: null, was: null };
  if (valid.length === 1) return { current: valid[0]!, was: null };

  // Multiple numbers: the current price is the last one in the block (retailers
  // show "was" before "now"). The first is the "was" price.
  return { current: valid[valid.length - 1]!, was: valid[0]! };
}

export function extractPrice(doc: HDocument): PriceInfo | null {
  // 1. JSON-LD
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const txt = script.textContent || "";
    let data: unknown;
    try {
      data = JSON.parse(txt);
    } catch {
      continue;
    }
    const found = walkJsonLd(data);
    if (found) return found;
  }

  // 2. Microdata
  for (const el of Array.from(doc.querySelectorAll('[itemprop="price"]'))) {
    const raw = el.getAttribute("content") || el.textContent || "";
    const amount = parseMoney(raw);
    if (amount !== null) {
      const parent = el.closest('[itemtype*="schema.org/Product"]') || el.parentElement;
      const availEl = parent?.querySelector('[itemprop="availability"]');
      return {
        amount,
        currency: "USD",
        source: "microdata",
        raw: raw.trim(),
        availability: availEl?.textContent?.trim() || null,
        wasPrice: null,
      };
    }
  }

  // 3. Class-based visible price
  for (const sel of PRICE_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      const direct = el.getAttribute("data-price");
      if (direct) {
        const amount = parseMoney(direct);
        if (amount !== null && amount > 0) {
          return {
            amount,
            currency: "USD",
            source: "class",
            raw: direct.trim(),
            availability: null,
            wasPrice: null,
          };
        }
      }
      const { current, was } = splitPrices(el.textContent || "");
      if (current !== null) {
        return {
          amount: current,
          currency: "USD",
          source: "class",
          raw: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
          availability: null,
          wasPrice: was,
        };
      }
    }
  }

  return null;
}

/** Recursively find a Product's offers.price inside parsed JSON-LD. */
function walkJsonLd(data: unknown): PriceInfo | null {
  if (Array.isArray(data)) {
    for (const d of data) {
      const r = walkJsonLd(d);
      if (r) return r;
    }
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const type = o["@type"];
  const isProduct =
    type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (isProduct) {
    const price = readOffer(o.offers);
    if (price) return price;
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") {
      const r = walkJsonLd(v);
      if (r) return r;
    }
  }
  return null;
}

function readOffer(offers: unknown): PriceInfo | null {
  const list = Array.isArray(offers) ? offers : [offers];
  for (const off of list) {
    if (!off || typeof off !== "object") continue;
    const o = off as Record<string, unknown>;
    const amount =
      typeof o.price === "number" ? o.price : parseMoney(String(o.price ?? ""));
    if (amount === null) continue;
    return {
      amount,
      currency: typeof o.priceCurrency === "string" ? o.priceCurrency : "USD",
      source: "json-ld",
      raw: String(o.price),
      availability: typeof o.availability === "string" ? o.availability : null,
      wasPrice: null,
    };
  }
  return null;
}
