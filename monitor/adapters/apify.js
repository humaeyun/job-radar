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

// Pay-per-result price, in cents, so scan.js can budget by real cost.
export const ZR_CENTS_PER_RESULT = 0.1;    // $1.00 / 1000
export const SH_CENTS_PER_RESULT = 0.499;  // $4.99 / 1000

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

async function runActor(actorId, input, maxWaitSecs = 120) {
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
  // TEMP first-run diagnostics: dump one raw record so we can confirm exact
  // field paths (posted date, pay_period). Remove once the mapping is verified.
  if (process.env.APIFY_DEBUG && items[0]) {
    console.log(`DEBUG ${actorId} raw[0]:`, JSON.stringify(items[0]).slice(0, 1500));
  }
  return items;
}

// The ZipRecruiter actor nests fields under groups (entity/job/company/…), and a
// summarizer couldn't pin every exact path, so read defensively: first present
// value across the likely candidates. First live run should confirm the shape.
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

// SimplyHired takes search URLs, not query fields. Build one remote, last-30-day
// search URL per role bucket. salaryInfo is free text -> pass it into description
// so scan.js's extractPay picks it up; leave payMin/payMax null.
const shUrl = (q) =>
  `https://www.simplyhired.com/search?q=${encodeURIComponent(q + " remote")}&l=Remote&fdb=30`;

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

export async function simplyhired(maxItems = 200) {
  const items = await runActor(SH_ACTOR, {
    searchUrls: QUERIES.map(shUrl),
    maxItems,
  });
  return items.map(mapSimply).filter(j => j.url && j.title);
}
