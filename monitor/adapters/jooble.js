// adapters/jooble.js — Jooble's official job-search API. Free (key via a short
// form at jooble.org/api/about, emailed to you), and FAILURE-PROOF: a real REST
// API returning JSON, so no scraping, no proxies, no datacenter-IP blocking.
//
// Why this covers ZipRecruiter + SimplyHired: both killed their own job-search
// APIs (ZipRecruiter's ZipSearch ended 2025-03-31; SimplyHired never had one and
// is just Indeed's index). Jooble aggregates 140k+ sources INCLUDING ZipRecruiter
// and Indeed, and — unlike Adzuna — returns a `source` field naming the origin
// board, so cards show "ZipRecruiter"/"Indeed" and we get the distinct-source
// view back. Whether ZR/Indeed are actually in the results is what the first run
// verifies.
//
// DORMANT until JOOBLE_API_KEY is set. Without it -> [].

// Same role buckets we sweep elsewhere.
export const JOOBLE_QUERIES = [
  "customer service remote",
  "call center remote",
  "data entry remote",
  "chat support remote",
  "medical records remote",
  "member services remote",
  "collections remote",
  "virtual assistant remote",
];
// One POST per query => calls per run = query count.
export const JOOBLE_CALLS_PER_RUN = JOOBLE_QUERIES.length;

const mapJob = (j) => ({
  agency: j.company || "Jooble",
  title: j.title,
  location: j.location || "Remote",
  // salary + type are free text -> fold into description so scan.js's extractPay
  // / extractEmployment pick them up; leave payMin/payMax null.
  description: [j.snippet, j.salary, j.type].filter(Boolean).join(" — ").slice(0, 4000),
  url: j.link,
  postedAt: j.updated || null,
  // Jooble's `source` names the origin board (ZipRecruiter, Indeed, …); keep it
  // so the dashboard shows the real source. Fall back to "Jooble".
  source: j.source || "Jooble",
  payMin: null,
  payMax: null,
});

async function joobleQuery(key, keywords, { page = "1", resultOnPage = 40 } = {}) {
  const r = await fetch(`https://jooble.org/api/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keywords, location: "United States", page, ResultOnPage: resultOnPage }),
  });
  if (!r.ok) throw new Error(`jooble ${r.status}`);
  const data = await r.json();
  return (data.jobs || []);
}

// Broad sweep across role buckets; each hit attributed to its real employer and
// origin board. Deduped by url so the same posting counts once.
export async function jooble() {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) return [];
  const seen = new Set();
  const out = [];
  for (const q of JOOBLE_QUERIES) {
    let rows = [];
    try { rows = await joobleQuery(key, q); }
    catch (e) { console.warn(`  ! jooble "${q}": ${e.message}`); }
    for (const j of rows.map(mapJob)) {
      if (j.url && j.title && !seen.has(j.url)) { seen.add(j.url); out.push(j); }
    }
  }
  return out;
}
