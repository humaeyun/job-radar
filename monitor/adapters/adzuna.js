// adapters/adzuna.js — Adzuna's official job-search API. Free, self-serve
// (app_id + app_key from developer.adzuna.com, no card), and FAILURE-PROOF:
// it's a real REST API returning JSON, so there's no datacenter-IP blocking,
// no proxies, no CAPTCHAs — the things that make Indeed scraping expensive.
//
// Adzuna is an aggregator: it indexes many boards/feeds, so results span lots of
// employers. It does NOT expose per-source attribution (you can't ask it "only
// Indeed"), and Indeed coverage specifically is unverified — this run is the
// test. Structured salary is ANNUAL USD; we normalize to hourly like the others.
//
// DORMANT until ADZUNA_APP_ID + ADZUNA_APP_KEY are set. Without them -> [].

const HOST = "https://api.adzuna.com/v1/api/jobs/us/search";

// Free tier is ~1,000 calls/month, so scan.js throttles + budgets these.
export const ADZUNA_QUERIES = [
  "customer service remote",
  "call center remote",
  "data entry remote",
  "chat support remote",
  "medical records remote",
  "member services remote",
  "collections remote",
  "virtual assistant remote",
];
// One call per query (50 results each) => calls per run = query count.
export const ADZUNA_CALLS_PER_RUN = ADZUNA_QUERIES.length;

// Adzuna salary fields are annual USD; convert to an hourly number. Only trust
// them when NOT predicted (salary_is_predicted "0"), so our BYOD "real low pay"
// logic isn't fed Adzuna's model estimates.
const toHourly = (v, predicted) => (v == null || predicted === "1" ? null : v / 2080);

const mapJob = (j) => ({
  agency: (j.company && j.company.display_name) || "Adzuna",
  title: j.title,
  location: (j.location && j.location.display_name) || "Remote",
  description: (j.description || "").slice(0, 4000),
  url: j.redirect_url,
  postedAt: j.created || null,               // ISO date
  source: "Adzuna",
  payMin: toHourly(j.salary_min, j.salary_is_predicted),
  payMax: toHourly(j.salary_max, j.salary_is_predicted),
});

async function adzunaQuery(id, key, query, { maxDaysOld = 7, perPage = 50 } = {}) {
  const params = new URLSearchParams({
    app_id: id,
    app_key: key,
    what: query,
    results_per_page: String(perPage),
    max_days_old: String(maxDaysOld),
    sort_by: "date",
    "content-type": "application/json",
  });
  const r = await fetch(`${HOST}/1?${params}`);
  if (!r.ok) throw new Error(`adzuna ${r.status}`);
  const data = await r.json();
  return (data.results || []);
}

// Broad sweep across the role buckets; each hit attributed to its real employer.
// Deduped by url so the same posting from two queries counts once.
export async function adzuna() {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return [];
  const seen = new Set();
  const out = [];
  for (const q of ADZUNA_QUERIES) {
    let rows = [];
    try { rows = await adzunaQuery(id, key, q); }
    catch (e) { console.warn(`  ! adzuna "${q}": ${e.message}`); }
    for (const j of rows.map(mapJob)) {
      if (j.url && j.title && !seen.has(j.url)) { seen.add(j.url); out.push(j); }
    }
  }
  return out;
}
