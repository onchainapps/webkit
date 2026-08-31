#!/usr/bin/env bun
/**
 * webkit CLI.
 *
 *   webkit search "cardano utxo" [--count N] [--engine ddg|bing] [--json]
 *   webkit scrape <url> [--mode fast|browser] [--json] [--meta] [--links] [--images] [--text]
 *   webkit json <url> [--mode fast|browser]   (full structured dump)
 *   webkit help
 */

import { search, scrape, top, WebkitError } from "../index.ts";

const args = process.argv.slice(2);
const [cmd, ...rest] = args;

function parseFlags(
  argv: string[],
): { flags: Map<string, string | boolean>; positional: string[] } {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !next.startsWith("-")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (a.startsWith("-") && a.length === 2) {
      // Short flag: -c 5, -h
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function printResults(results: Awaited<ReturnType<typeof search>>, json: boolean) {
  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log("(no results)");
    return;
  }
  for (const r of results) {
    console.log(`${r.rank}. ${r.title}`);
    console.log(`   ${r.url}`);
    if (r.snippet) console.log(`   ${r.snippet.slice(0, 220)}`);
    console.log();
  }
  console.log(`— ${results.length} result(s) via ${results[0]?.engine}`);
}

function printScrape(
  page: Awaited<ReturnType<typeof scrape>>,
  flags: Map<string, string | boolean>,
) {
  const json = flags.has("json");
  if (json) {
    // Respect --meta/--links/--images/--text as field filters if any given.
    const filter = new Set<string>();
    if (flags.has("meta")) filter.add("metadata");
    if (flags.has("links")) filter.add("links");
    if (flags.has("images")) filter.add("images");
    if (flags.has("text")) filter.add("content");
    if (filter.size === 0) {
      console.log(JSON.stringify(page, null, 2));
    } else {
      const out: Record<string, unknown> = { url: page.url, status: page.status };
      for (const k of filter) out[k] = (page as unknown as Record<string, unknown>)[k];
      console.log(JSON.stringify(out, null, 2));
    }
    return;
  }

  // Human-readable
  console.log(`# ${page.metadata.title || "(untitled)"}`);
  console.log(`URL: ${page.url}`);
  if (page.metadata.description) console.log(`Description: ${page.metadata.description}`);
  if (page.metadata.canonical) console.log(`Canonical: ${page.metadata.canonical}`);
  console.log(`Mode: ${page.mode} · ${page.status} · ${page.durationMs}ms${page.retries ? ` · ${page.retries} retries` : ""}`);
  console.log(`Links: ${page.links.length} (${page.links.filter((l) => l.external).length} external) · Images: ${page.images.length}`);
  console.log(`Content: ${page.content.charCount} chars · ~${Math.ceil(page.content.readingTimeSec / 60)} min read`);
  console.log();
  const text = page.content.text;
  const max = typeof flags.get("chars") === "string" ? Number(flags.get("chars")) : 2000;
  console.log(text.slice(0, max));
  if (text.length > max) console.log(`\n[...truncated, ${text.length - max} more chars — use --chars N or --json]`);
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  const { flags, positional } = parseFlags(rest);

  if (cmd === "search") {
    const query = positional.join(" ").trim();
    if (!query) throw new WebkitError("Usage: webkit search <query>");
    const results = await search(query, {
      count:
        typeof flags.get("count") === "string"
          ? Number(flags.get("count"))
          : typeof flags.get("c") === "string"
            ? Number(flags.get("c"))
            : 10,
      engine: (flags.get("engine") as "duckduckgo" | "bing" | undefined) || undefined,
      safeSearch: (flags.get("safe") as "strict" | "moderate" | "off" | undefined) || "moderate",
    });
    printResults(results, flags.has("json"));
    return;
  }

  if (cmd === "top") {
    const query = positional.join(" ").trim();
    if (!query) throw new WebkitError("Usage: webkit top <query>");
    const scrapeCount =
      typeof flags.get("n") === "string"
        ? Number(flags.get("n"))
        : typeof flags.get("count") === "string"
          ? Number(flags.get("count"))
          : 3;
    const maxChars =
      typeof flags.get("chars") === "string" ? Number(flags.get("chars")) : 400;
    const json = flags.has("json");
    const results = await top(query, {
      count: scrapeCount,
      scrapeCount,
      mode: (flags.get("mode") as "fast" | "browser" | undefined) || "fast",
    });
    if (json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const r of results) {
        console.log(`\n${"=".repeat(72)}`);
        console.log(`${r.result.rank}. ${r.result.title}`);
        console.log(`   ${r.result.url}`);
        if (r.error) {
          console.log(`   [scrape failed: ${r.error}]`);
          continue;
        }
        const p = r.page!;
        console.log(
          `   ${p.status} · ${p.durationMs}ms · ${p.content.charCount} chars`,
        );
        const body = p.content.text.replace(/\n+/g, " ").trim();
        console.log(`   ${body.slice(0, maxChars)}`);
      }
      console.log(`\n${"=".repeat(72)}`);
      console.log(
        `— scraped ${results.filter((r) => r.page).length}/${results.length}`,
      );
    }
    return;
  }

  if (cmd === "scrape" || cmd === "json") {
    const url = positional[0];
    if (!url) throw new WebkitError(`Usage: webkit ${cmd} <url>`);
    const waitMs =
      typeof flags.get("wait") === "string"
        ? Number(flags.get("wait"))
        : undefined;
    const page = await scrape(url, {
      mode: (flags.get("mode") as "fast" | "browser" | undefined) || "fast",
      strict: true,
      waitUntilMs: waitMs,
    });
    if (cmd === "json") {
      console.log(JSON.stringify(page, null, 2));
    } else {
      printScrape(page, flags);
    }
    return;
  }

  throw new WebkitError(`Unknown command: ${cmd}\n\n` + helpText());
}

function helpText(): string {
  return `webkit — self-hosted web search + scraping

Usage:
  webkit search <query> [options]
      -c, --count <n>     number of results (default 10)
          --engine <e>    force engine: duckduckgo|bing (default: ddg, fallback bing)
          --safe <s>      strict|moderate|off (default moderate)
          --json          JSON output

  webkit top <query> [options]
      -n, --count <n>   how many top results to scrape (default 3)
          --chars <n>   max chars of each page's content to print (default 400)
          --mode <m>    fast (default) | browser
          --json        JSON output
      Search + scrape the top N results in one command.

  webkit scrape <url> [options]
          --mode <m>      fast (default) | browser (Playwright)
          --meta          include metadata in JSON mode
          --links         include links in JSON mode
          --images        include images in JSON mode
          --text          include main content in JSON mode
          --chars <n>     max chars of main text to print (default 2000)
          --json          JSON output

  webkit json <url> [--mode fast|browser]
      Full structured dump (metadata + links + images + content).

Examples:
  webkit search "cardano utxo model" -c 5
  webkit top "gravity dex cardano" -n 3
  webkit scrape cardanoscan.io --chars 500
  webkit search "gravity dex" --json | jq '.[0].url'
  webkit json https://blog.cardano.org --mode fast`;
}

function printHelp() {
  console.log(helpText());
}

main().catch((err) => {
  if (err instanceof WebkitError) {
    process.stderr.write(`Error: ${err.message}\n`);
  } else {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
  }
  process.exit(1);
});
