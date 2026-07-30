// adapters/enrich.js — BYOD enrichment. Aggregators hand us a ~150-char snippet,
// but the tell-tale "use your own Windows 11 laptop, 8GB RAM" text lives in the
// FULL posting. This fetches a candidate job's full description page and hands
// back the plain text so scan.js can re-run the spec detector on the real thing.
//
// Only pages we can actually fetch server-side are worth it. Jooble's own job
// pages (jooble.org/jdp/...) return the full JD; Adzuna's /land/ redirect 403s,
// so we skip those. Agency-direct jobs already carry full descriptions.

import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) remote-job-radar/1.0";

// A URL is enrichable if we can fetch its full JD server-side (Jooble job pages).
export const isEnrichable = (url = "") => /jooble\.org\/jdp\//i.test(url);

// Fetch one job page and return its visible text (or null on any failure).
export async function fetchJD(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!r.ok) return null;
    const $ = cheerio.load(await r.text());
    $("script, style, noscript").remove();
    return $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch many JDs with a small concurrency pool; returns Map(url -> text|null).
export async function fetchJDs(urls, { concurrency = 5 } = {}) {
  const out = new Map();
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < urls.length) {
      const url = urls[i++];
      out.set(url, await fetchJD(url));
    }
  }));
  return out;
}
