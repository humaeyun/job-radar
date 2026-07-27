// adapters/fallback.js — for the messy majority of small agencies that don't
// expose a clean ATS feed. Two options:
//   1) jsearch   — query an aggregator by company name (covers Indeed/LinkedIn/ZipRecruiter)
//   2) scrape    — pull the agency's own careers page HTML and extract links

import * as cheerio from "cheerio";

// --- Option 1: JSearch (RapidAPI). Free tier is small, so use it only for
// agencies you can't scrape. Set RAPIDAPI_KEY in the environment. ---
export async function jsearch(agency, _token, { name }) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return [];
  const q = encodeURIComponent(`${name} remote customer service OR data entry OR call center`);
  const url = `https://jsearch.p.rapidapi.com/search?query=${q}&remote_jobs_only=true&num_pages=1`;
  const r = await fetch(url, {
    headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": "jsearch.p.rapidapi.com" },
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.data || []).map(j => ({
    agency, title: j.job_title, location: j.job_city || j.job_country || "Remote",
    description: (j.job_description || "").slice(0, 4000),
    url: j.job_apply_link, postedAt: j.job_posted_at_datetime_utc || null, source: "JSearch",
  }));
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
