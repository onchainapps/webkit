/**
 * Content extraction from an HTML document.
 *
 * - Metadata: title, meta tags, og:*, canonical, favicon
 * - Links: internal/external, classified, with rel
 * - Images: src, alt, dimensions when present
 * - Main content: a Readability-style heuristic extractor
 *   (no external deps — score blocks by text density, link density,
 *   and structural hints like <article>, <main>, class names).
 */

import type { Document as HDocument, Element as HElement } from "happy-dom";
import { parseHtml } from "../core/dom.ts";

export interface PageMetadata {
  title: string;
  description: string | null;
  canonical: string | null;
  favicon: string | null;
  /** All <meta name|property=... content=...> pairs. */
  meta: Record<string, string>;
  /** Open Graph tags. */
  og: Record<string, string>;
  /** Twitter card tags. */
  twitter: Record<string, string>;
  language: string | null;
  charset: string | null;
}

export interface Link {
  href: string;
  text: string;
  rel: string | null;
  absolute: string | null;
  external: boolean;
}

export interface Image {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
  absolute: string | null;
}

export interface ExtractedContent {
  /** Readability-style main content, as plain text (whitespace-normalized). */
  text: string;
  /** The same content as HTML (tags preserved) for downstream rendering. */
  html: string;
  /** The tag the extractor settled on as the content root. */
  contentRootTag: string | null;
  /** Character count of the extracted text. */
  charCount: number;
  /** Estimated reading time in seconds (~200 wpm). */
  readingTimeSec: number;
}

export interface PageData {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  metadata: PageMetadata;
  links: Link[];
  images: Image[];
  content: ExtractedContent;
}

function abs(base: string | null, href: string): string | null {
  if (!href) return null;
  if (/^https?:/i.test(href)) return href;
  if (!base) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function extractMetadata(doc: HDocument, baseUrl: string): PageMetadata {
  const meta: Record<string, string> = {};
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  let canonical: string | null = null;
  let favicon: string | null = null;
  let language: string | null = null;
  let charset: string | null = null;

  for (const m of Array.from(doc.querySelectorAll("meta"))) {
    const name = (m.getAttribute("name") || m.getAttribute("property") || "").trim().toLowerCase();
    const content = (m.getAttribute("content") || "").trim();
    if (!name) continue;
    if (name.startsWith("og:")) og[name] = content;
    else if (name.startsWith("twitter:")) twitter[name] = content;
    else meta[name] = content;
  }

  for (const l of Array.from(doc.querySelectorAll("link"))) {
    const rel = (l.getAttribute("rel") || "").toLowerCase();
    const href = l.getAttribute("href") || "";
    if (rel === "canonical") canonical = abs(baseUrl, href);
    else if (rel.includes("icon")) favicon = abs(baseUrl, href);
  }

  // Absolutize og: and twitter: URLs (og:image, og:url, twitter:image) so
  // relative refs like "/img/og.png" become fetchable absolute URLs.
  for (const key of Object.keys(og)) {
    const val = og[key];
    if (val && /(image|url|video|icon|logo)$/i.test(key)) og[key] = abs(baseUrl, val) ?? val;
  }
  for (const key of Object.keys(twitter)) {
    const val = twitter[key];
    if (val && /(image|url|video|logo)$/i.test(key)) twitter[key] = abs(baseUrl, val) ?? val;
  }

  const htmlEl = doc.querySelector("html");
  language = htmlEl?.getAttribute("lang") || null;
  const metaCharset = doc.querySelector('meta[charset]');
  charset = metaCharset?.getAttribute("charset") || meta["content-type"] || null;

  return {
    title: doc.title?.trim() || "",
    description:
      meta["description"] || og["og:description"] || null,
    canonical,
    favicon,
    meta,
    og,
    twitter,
    language,
    charset,
  };
}

export function extractLinks(doc: HDocument, baseUrl: string): Link[] {
  const base = new URL(baseUrl).origin;
  const out: Link[] = [];
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") || "";
    if (href.startsWith("mailto:") || href.startsWith("javascript:") || href.startsWith("#")) {
      continue;
    }
    const absolute = abs(baseUrl, href);
    let external = false;
    if (absolute) {
      try {
        external = new URL(absolute).origin !== base;
      } catch {
        external = false;
      }
    }
    out.push({
      href,
      text: a.textContent?.trim().replace(/\s+/g, " ") ?? "",
      rel: a.getAttribute("rel"),
      absolute,
      external,
    });
  }
  return out;
}

export function extractImages(doc: HDocument, baseUrl: string): Image[] {
  const out: Image[] = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
    if (!src) continue;
    out.push({
      src,
      alt: img.getAttribute("alt") || "",
      width: img.getAttribute("width") ? Number(img.getAttribute("width")) : null,
      height: img.getAttribute("height") ? Number(img.getAttribute("height")) : null,
      absolute: abs(baseUrl, src),
    });
  }
  // Also catch <source> inside <picture>
  for (const src of Array.from(doc.querySelectorAll("source[src]"))) {
    const s = src.getAttribute("src") || "";
    if (!s) continue;
    out.push({ src: s, alt: "", width: null, height: null, absolute: abs(baseUrl, s) });
  }
  return out;
}

/**
 * Readability-style main content extraction.
 *
 * Heuristic: score each candidate block (<p>, <pre>, <h1>-<h6>, <li>, <blockquote>)
 * by:
 *   + text length (words)
 *   + bonus if inside <article>, <main>, or an element with a contenty class name
 *   - penalty for high link density (nav/footer/sidebar signals)
 *   - penalty for very short blocks
 * Then pick the contiguous region of highest cumulative score.
 */
export function extractMainContent(doc: HDocument, baseUrl: string): ExtractedContent {
  // Remove noise first.
  for (const sel of [
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    "form",
    "nav",
    "footer",
    "header",
    "aside",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    ".nav",
    ".navigation",
    ".menu",
    ".sidebar",
    ".footer",
    ".header",
    ".cookie",
    ".advert",
    ".ad",
    ".promo",
    ".related",
    ".comments",
    ".share",
    ".social",
  ]) {
    for (const el of Array.from(doc.querySelectorAll(sel))) el.remove();
  }

  const CONTENTY_CLASSES = /article|content|post|entry|body|main|text|story|blog|page|detail/i;
  const NOISY_CLASSES = /nav|menu|sidebar|footer|header|breadcrumb|comment|related|share|social|advert|promo|cookie/i;

  interface Scored {
    el: HElement;
    score: number;
  }

  const candidates: Scored[] = [];
  const blockSels = "p, pre, h1, h2, h3, h4, h5, h6, li, blockquote, figure";
  for (const el of Array.from(doc.querySelectorAll(blockSels))) {
    const text = (el.textContent || "").trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 2) continue;

    let score = words; // base: text density

    // Ancestral structure bonuses
    let anc = el.parentElement;
    let depth = 0;
    while (anc && depth < 12) {
      const tag = anc.tagName.toLowerCase();
      const cls = (anc.getAttribute("class") || "").toLowerCase();
      if (tag === "article" || tag === "main") score *= 1.5;
      if (CONTENTY_CLASSES.test(cls)) score *= 1.2;
      if (NOISY_CLASSES.test(cls)) score *= 0.3;
      anc = anc.parentElement;
      depth++;
    }

    // Link density penalty (nav-like blocks)
    const linkText = Array.from(el.querySelectorAll("a"))
      .reduce((n, a) => n + (a.textContent || "").length, 0);
    const linkDensity = text.length > 0 ? linkText / text.length : 0;
    if (linkDensity > 0.6) score *= 0.2;

    candidates.push({ el, score });
  }

  if (candidates.length === 0) {
    const bodyText = (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      text: bodyText,
      html: doc.body?.innerHTML || "",
      contentRootTag: null,
      charCount: bodyText.length,
      readingTimeSec: Math.ceil(bodyText.split(/\s+/).filter(Boolean).length / 200 * 60),
    };
  }

  // Find the contiguous run of highest cumulative score (Kadane's algorithm).
  // Candidates are already in document order (querySelectorAll guarantees this).
  let bestStart = 0;
  let bestEnd = 0;
  let bestSum = -Infinity;
  let curStart = 0;
  let curSum = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (curSum <= 0) {
      curStart = i;
      curSum = c.score;
    } else {
      curSum += c.score;
    }
    if (curSum > bestSum) {
      bestSum = curSum;
      bestStart = curStart;
      bestEnd = i;
    }
  }

  // Collect the chosen elements' HTML
  const chosen = candidates.slice(bestStart, bestEnd + 1).map((c) => c.el);
  const html = chosen.map((el) => el.outerHTML).join("\n");
  const text = chosen
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    text,
    html,
    contentRootTag: chosen[0]?.tagName.toLowerCase() || null,
    charCount: text.length,
    readingTimeSec: Math.ceil((words / 200) * 60),
  };
}

/**
 * Full extraction: metadata + links + images + main content.
 */
export function extractPage(html: string, url: string): PageData {
  const doc = parseHtml(html);
  return {
    url,
    status: 200,
    contentType: "text/html",
    metadata: extractMetadata(doc, url),
    links: extractLinks(doc, url),
    images: extractImages(doc, url),
    content: extractMainContent(doc, url),
  };
}
