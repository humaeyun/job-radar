// adapters/fallback.js — for the messy majority of small agencies that don't
// expose a clean ATS feed. Two options:
//   1) jsearch   — query an aggregator by company name (covers Indeed/LinkedIn/ZipRecruiter)
//   2) scrape    — pull the agency's own careers page HTML and extract links

import * as cheerio from "cheerio";

// --- Option 1: JSearch (RapidAPI). Needs a paid-ish key (RAPIDAPI_KEY) because
// the free tier is tiny. JSearch aggregates Google-for-Jobs, so results span
// Indeed, LinkedIn, ZipRecruiter, SimplyHired, Glassdoor, etc. ---
const JS_HOST = "jsearch.p.rapidapi.com";
const jsHeaders = key => ({ "X-RapidAPI-Key": key, "X-RapidAPI-Host": JS_HOST });

async function jsQuery(key, query, { pages = 1, datePosted = "all" } = {}) {
  // JSearch v5: endpoint is /search-v2, jobs under data.jobs. num_pages fetches
  // 10 results per page (and bills per page). date_posted keeps results recent.
  const url = `https://${JS_HOST}/search-v2?query=${encodeURIComponent(query)}&remote_jobs_only=true&num_pages=${pages}&date_posted=${datePosted}&country=us`;
  const r = await fetch(url, { headers: jsHeaders(key) });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.data && data.data.jobs) || [];
}

// v5 remote roles often report job_is_remote / job_location "Anywhere" rather than a city.
const jsLocation = (j) => {
  const cs = [j.job_city, j.job_state].filter(Boolean).join(", ");
  if (cs) return cs;
  if (j.job_is_remote) return "Remote";
  return (j.job_location && j.job_location !== "Anywhere" ? j.job_location : j.job_country) || "Remote";
};

// Convert JSearch structured salary to an hourly number.
const toHourly = (v, per) => {
  if (v == null) return null;
  switch (String(per || "").toUpperCase()) {
    case "HOUR": return v;
    case "WEEK": return v / 40;
    case "MONTH": return (v * 12) / 2080;
    case "YEAR": return v / 2080;
    default: return null;
  }
};

const mapJob = (agency, j) => ({
  agency,
  title: j.job_title,
  location: jsLocation(j),
  description: (j.job_description || "").slice(0, 4000),
  url: j.job_apply_link,
  postedAt: j.job_posted_at_datetime_utc || null,
  source: j.job_publisher || "JSearch",
  // structured pay when JSearch provides it (scan.js falls back to text parsing)
  payMin: toHourly(j.job_min_salary, j.job_salary_period),
  payMax: toHourly(j.job_max_salary, j.job_salary_period),
});

// Per-agency: search the aggregator by company name across our role buckets.
export async function jsearch(agency, _token, { name }) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return [];
  const q = `${name} remote (customer service OR chat OR data entry OR call center OR medical records OR member services OR sales OR collections)`;
  return (await jsQuery(key, q)).map(j => mapJob(agency, j));
}

// --- "Job board" feature: broad aggregator sweep NOT tied to any one agency.
// Runs a few role-bucket queries; each result is attributed to its real employer
// (from JSearch) with the source publisher (Indeed/ZipRecruiter/SimplyHired/...). ---
const AGG_PAGES = 3;              // JSearch pages per query (10 results each)
const AGG_DATE_POSTED = "week";   // recent only — no stale year-old postings
const AGGREGATOR_QUERIES = [
  // one focused query per role bucket pulls far more relevant hits than broad ORs
  "remote customer service representative",
  "remote call center agent",
  "remote data entry clerk",
  "remote chat support agent",
  "remote medical records OR medical billing OR prior authorization",
  "remote member services OR patient access OR claims processor",
  "remote sales representative OR appointment setter OR collections OR virtual assistant",
  // BYOD-targeted: surface postings that spell out own-computer + specs
  "remote customer service OR data entry own laptop OR bring your own device OR byod",
];
// Budget cost of one aggregator run = queries * pages (JSearch bills per page).
export const AGGREGATOR_QUERY_COUNT = AGGREGATOR_QUERIES.length * AGG_PAGES;

export async function aggregator() {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return [];
  const seen = new Set();
  const out = [];
  for (const q of AGGREGATOR_QUERIES) {
    for (const j of await jsQuery(key, q, { pages: AGG_PAGES, datePosted: AGG_DATE_POSTED })) {
      const url = j.job_apply_link;
      if (!url || seen.has(url)) continue;   // dedupe across queries/pages
      seen.add(url);
      out.push(mapJob(j.employer_name || "Job Board", j));
    }
  }
  return out;
}

// --- Option 2: generic scrape. Grabs anchor tags that look like job links.
// Works for many WordPress / Bullhorn-embedded boards. For JS-rendered boards
// you'll need a per-site adapter (see CLAUDE.md). ---
export async function scrape(agency, careersUrl) {
  if (!careersUrl) return [];
  const r = await fetch(careersUrl, { headers: { "User-Agent": "Mozilla/5.0 remote-job-radar/1.0" } });
  if (!r.ok) throw new Error(`${careersUrl} -> ${r.status}`);
  const $ = cheerio.load(await r.text());
  const jobs = [];
  $("a").each((_, el) => {
    const title = $(el).text().trim().replace(/\s+/g, " ");
    let href = $(el).attr("href") || "";
    if (!title || title.length < 6 || title.length > 120) return;
    // heuristic: link text that reads like a job title
    if (!/(remote|customer|support|data entry|call center|records|representative|agent|specialist|clerk)/i.test(title)) return;
    if (href.startsWith("/")) href = new URL(href, careersUrl).href;
    if (!href.startsWith("http")) return;
    jobs.push({ agency, title, location: "", description: title, url: href, postedAt: null, source: "Careers page" });
  });
  // de-dupe within page
  const seen = new Set();
  return jobs.filter(j => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}
