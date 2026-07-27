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

async function jsQuery(key, query) {
  const url = `https://${JS_HOST}/search?query=${encodeURIComponent(query)}&remote_jobs_only=true&num_pages=1`;
  const r = await fetch(url, { headers: jsHeaders(key) });
  if (!r.ok) return [];
  const data = await r.json();
  return data.data || [];
}

const mapJob = (agency, j) => ({
  agency,
  title: j.job_title,
  location: j.job_city || j.job_state || j.job_country || "Remote",
  description: (j.job_description || "").slice(0, 4000),
  url: j.job_apply_link,
  postedAt: j.job_posted_at_datetime_utc || null,
  source: j.job_publisher || "JSearch",
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
const AGGREGATOR_QUERIES = [
  "remote customer service OR customer support OR help desk OR chat support",
  "remote call center OR data entry OR medical records OR claims OR member services",
  "remote sales representative OR appointment setter OR collections OR virtual assistant",
];

export async function aggregator() {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return [];
  const out = [];
  for (const q of AGGREGATOR_QUERIES) {
    for (const j of await jsQuery(key, q)) {
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
