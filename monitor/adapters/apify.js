// adapters/apify.js — dedicated per-board scrapers for the two sources JSearch
// CANNOT surface as distinct publishers: SimplyHired and ZipRecruiter.
//
// JSearch attributes Google-for-Jobs results to whichever reposter it saw, so
// SimplyHired's big CSR pool and ZipRecruiter's listings never show up as
// themselves (see the jsearch-board-coverage note). These two Apify actors hit
// each board directly and return the real listing.
//
// PROOF-BEFORE-PAY: both actors are pay-per-result on Apify's Store, drawing on
// Apify's Free plan, which grants $5 in prepaid platform credit every month with
// NO credit card and hard-blocks once spent — so nothing can ever be billed on
// the free plan. That $5 is plenty to prove the feed:
//   - ZipRecruiter (fatihtahta/ziprecruiter-scraper): $1.00 / 1,000 results
//   - SimplyHired  (easyapi/simplyhired-job-scraper):  $4.99 / 1,000 results
//   - Indeed       (misceres/indeed-scraper):          $3.00 / 1,000 results
// Cost per result (cents) is exported below so scan.js can cap monthly spend the
// same paranoid way it caps JSearch.
//
// DORMANT until APIFY_TOKEN is set (a GitHub Actions secret, like RAPIDAPI_KEY).
// Without it every function here returns [] and costs nothing.

// Apify's run-sync-get-dataset-items endpoint: starts the actor, waits for it to
// finish, and returns the dataset rows as JSON in one call. Perfect for a sweep.
const API = "https://api.apify.com/v2/acts";

// Actor ids (the "/" in a store id becomes "~" in the REST path).
export const ZR_ACTOR = "fatihtahta~ziprecruiter-scraper";
export const SH_ACTOR = "easyapi~simplyhired-job-scraper";
export const IN_ACTOR = "misceres~indeed-scraper";

// Pay-per-result price, in cents, so scan.js can budget by real cost.
export const ZR_CENTS_PER_RESULT = 0.1;    // $1.00 / 1000
export const SH_CENTS_PER_RESULT = 0.499;  // $4.99 / 1000
export const IN_CENTS_PER_RESULT = 0.3;    // $3.00 / 1000

// The role buckets we sweep — same intent as the JSearch aggregator queries.
const QUERIES = [
  "customer service representative",
  "call center agent",
  "data entry clerk",
  "chat support agent",
  "medical records",
  "member services",
  "collections representative",
  "virtual assistant",
];
export const APIFY_QUERY_COUNT = QUERIES.length;

async function runActor(actorId, input, maxWaitSecs = 300) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return [];
  const url = `${API}/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=${maxWaitSecs}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${actorId} -> ${r.status} ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  const items = Array.isArray(data) ? data : [];
  // TEMP: crash-safe first-run dump to confirm a new actor's field names.
  if (process.env.APIFY_DEBUG && items[0]) {
    console.log(`DEBUG ${actorId} keys:`, Object.keys(items[0]).join(","));
    console.log(`DEBUG ${actorId} sample:`, JSON.stringify(items[0]).slice(0, 1200));
  }
  return items;
}

// The ZipRecruiter actor nests fields under groups: entity{title,url},
// company{company_name}, location{city,region}, compensation{salary_min,
// pay_period,…}. Confirmed against live output; a couple of fallbacks stay for
// safety. NOTE: these MCP-search records carry no post date (enrichment_status
// "partial"), so postedAt is null — fine, we always scrape days:"30" so every
// hit is <=30d, and the dashboard shows "found <firstSeen>" when postedAt is null.
const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const pick = (obj, ...paths) => { for (const p of paths) { const v = get(obj, p); if (v != null && v !== "") return v; } return null; };

const zrLocation = (j) => {
  const city = pick(j, "location.city", "job.city", "city");
  const region = pick(j, "location.region", "location.state", "job.state", "state");
  const cs = [city, region].filter(Boolean).join(", ");
  return cs || "Remote";
};

const zrUrl = (j) => pick(j, "entity.url", "application.application_url", "job.url", "url");

// compensation.salary_min/max are in units of pay_period ("Hour"/"Year"/…), so
// normalize to an hourly number the way the JSearch adapter does.
const toHourly = (v, per) => {
  if (v == null) return null;
  switch (String(per || "").toUpperCase()) {
    case "HOUR": return v;
    case "WEEK": return v / 40;
    case "MONTH": return (v * 12) / 2080;
    case "YEAR": return v / 2080;
    default: return v > 200 ? v / 2080 : v; // no period: infer annual if it's a big number
  }
};

const mapZip = (j) => {
  const per = pick(j, "compensation.pay_period", "pay_period", "compensation.salary_period");
  return {
    agency: pick(j, "company.company_name", "company.name", "employer_name", "company") || "ZipRecruiter",
    title: pick(j, "entity.title", "job.job_title", "job.title", "title"),
    location: zrLocation(j),
    description: String(pick(j, "job.description", "content.descriptions.text", "description") || "").slice(0, 4000),
    url: zrUrl(j),
    postedAt: pick(j, "job.posted_at", "job.rolling_posted_at", "entity.posted_at", "posted_at", "datePosted") || null,
    source: "ZipRecruiter",
    // structured hourly pay when present (scan.js falls back to text parsing)
    payMin: toHourly(pick(j, "compensation.salary_min", "salary_min"), per),
    payMax: toHourly(pick(j, "compensation.salary_max", "salary_max"), per),
  };
};

// ZipRecruiter: one run, all role queries, remote-only, last 30 days. `limit` is
// per-query, so cap it to keep the run inside the monthly budget scan.js passes.
export async function ziprecruiter(maxResults = 200) {
  const perQuery = Math.max(1, Math.floor(maxResults / QUERIES.length));
  const items = await runActor(ZR_ACTOR, {
    queries: QUERIES,
    location_remote: true,   // forces ZipRecruiter's US remote search mode
    remote_options: "only_remote",
    days: "30",
    limit: perQuery,
  });
  return items.map(mapZip).filter(j => j.url && j.title);
}

// SimplyHired takes search URLs, not query fields. It's slower (a full page
// scrape per URL) and pricier than ZR, and sweeping all 8 buckets overran the
// sync wait, so use a few BROAD queries that still cover the role buckets.
const SH_QUERIES = [
  "customer service remote",
  "call center remote",
  "data entry remote",
  "medical records remote",
];
const shUrl = (q) =>
  `https://www.simplyhired.com/search?q=${encodeURIComponent(q)}&l=Remote&fdb=30`;

const mapSimply = (j) => {
  const bot = j.botUrl || "";
  const url = /^https?:/.test(bot) ? bot
    : bot ? `https://www.simplyhired.com${bot}`
    : j.jobKey ? `https://www.simplyhired.com/job/${j.jobKey}` : null;
  const salary = j.salaryInfo ? (Array.isArray(j.salaryInfo) ? j.salaryInfo.join(" ") : String(j.salaryInfo)) : "";
  return {
    agency: j.company || "SimplyHired",
    title: j.title,
    location: j.location || "Remote",
    description: [j.snippet, salary].filter(Boolean).join(" — ").slice(0, 4000),
    url,
    postedAt: j.dateOnIndeed || null,
    source: "SimplyHired",
    payMin: null,
    payMax: null,
  };
};

export async function simplyhired(maxItems = 120) {
  const items = await runActor(SH_ACTOR, {
    searchUrls: SH_QUERIES.map(shUrl),
    maxItems,
  });
  return items.map(mapSimply).filter(j => j.url && j.title);
}

// Indeed (misceres/indeed-scraper) takes position + location fields (no date
// field), so we sweep a few plain remote queries and let the dashboard's
// freshness filter drop anything stale. Indeed reports postedAt as relative text
// ("3 days ago", "Just posted", "30+ days ago"); convert it to an ISO date so
// freshness filtering + the card's age label work. Indeed blocks datacenter IPs
// hard, so the actor needs residential proxy (billed pay-as-you-go from credit).
const IN_QUERIES = ["customer service", "data entry", "call center", "medical records"];

const relToIso = (t) => {
  if (!t) return null;
  const s = String(t).toLowerCase();
  if (/just posted|today|posted today/.test(s)) return new Date().toISOString();
  const m = s.match(/(\d+)\+?\s*(day|hour|week|month)/);
  if (!m) return null;
  const n = +m[1];
  const d = new Date();
  const unit = m[2];
  if (unit === "hour") d.setHours(d.getHours() - n);
  else if (unit === "day") d.setDate(d.getDate() - n);
  else if (unit === "week") d.setDate(d.getDate() - n * 7);
  else if (unit === "month") d.setMonth(d.getMonth() - n);
  return d.toISOString();
};

const mapIndeed = (j) => ({
  agency: j.company || "Indeed",
  title: j.positionName || j.title,
  location: j.location || "Remote",
  // salary is free text ("$15 - $18 an hour") -> fold into description so
  // scan.js's extractPay picks it up; leave payMin/payMax null.
  description: [j.description, j.salary].filter(Boolean).join(" — ").slice(0, 4000),
  url: j.url || j.externalApplyLink,
  postedAt: relToIso(j.postedAt),
  source: "Indeed",
  payMin: null,
  payMax: null,
});

export async function indeed(maxItems = 120) {
  const perQuery = Math.max(10, Math.floor(maxItems / IN_QUERIES.length));
  const out = [];
  const seen = new Set();
  for (const q of IN_QUERIES) {
    let items = [];
    try {
      items = await runActor(IN_ACTOR, {
        position: q,
        location: "remote",
        country: "US",
        maxItemsPerSearch: perQuery,
        parseCompanyDetails: false,
        saveOnlyUniqueItems: true,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
      });
    } catch (e) { console.warn(`  ! indeed "${q}": ${e.message}`); }
    for (const j of items.map(mapIndeed)) {
      if (j.url && j.title && !seen.has(j.url)) { seen.add(j.url); out.push(j); }
    }
  }
  return out;
}
