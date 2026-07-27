// scan.js — one sweep across every agency. Run on a schedule (GitHub Actions).
//
//   1. load agencies + the "seen" ledger
//   2. fetch each agency via its adapter (ATS feed, aggregator, or scrape)
//   3. keep only remote roles that match your role buckets
//   4. drop anything already seen  ->  what's left is NEW
//   5. push NEW to Telegram, append to the public feed the dashboard reads
//
// State lives in plain JSON files committed back to the repo, so there's no
// database to run and every sweep is diffable. Swap in Cloudflare D1 / Supabase
// later by replacing loadState/saveState.

import fs from "node:fs/promises";
import { ATS } from "./adapters/ats.js";
import { haley } from "./adapters/haley.js";
import { sitemap } from "./adapters/sitemap.js";
import { jsearch, scrape } from "./adapters/fallback.js";
import { classify, jobKey } from "./config.js";
import { notifyTelegram } from "./notify.js";

const AGENCIES = "./data/agencies.json";
const SEEN = "./data/seen.json";     // { [key]: firstSeenISO }
const FEED = "./data/feed.json";     // rolling list the dashboard renders

const readJSON = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };

async function fetchAgency(a) {
  try {
    if (a.ats in ATS) return await ATS[a.ats](a.name, a.atsToken);
    if (a.ats === "haley")   return await haley(a.name, a.atsToken || a.careersUrl);
    if (a.ats === "sitemap") return await sitemap(a.name, a.atsToken || a.careersUrl || a.site);
    if (a.ats === "jsearch") return await jsearch(a.name, null, { name: a.name });
    if (a.ats === "scrape")  return await scrape(a.name, a.careersUrl);
    return []; // unknown -> skip until classified
  } catch (e) {
    console.warn(`  ! ${a.name}: ${e.message}`);
    return [];
  }
}

async function main() {
  const agencies = (await readJSON(AGENCIES, [])).filter(a => a.enabled);
  const seen = await readJSON(SEEN, {});
  const feed = await readJSON(FEED, []);
  const now = new Date().toISOString();

  const fresh = [];
  for (const a of agencies) {
    const raw = await fetchAgency(a);
    for (const job of raw) {
      const tag = classify(job.title, job.location, job.description);
      if (!tag) continue;
      const key = jobKey(job);
      if (seen[key]) continue;               // already alerted on a prior sweep
      seen[key] = now;
      const entry = {
        id: key, agency: job.agency, title: job.title,
        category: tag.category, maybeHybrid: tag.maybeHybrid,
        byod: tag.byod, equipment: tag.equipment,
        location: job.location || "Remote", source: job.source,
        url: job.url, postedAt: job.postedAt, firstSeen: now,
      };
      fresh.push(entry);
    }
  }

  // Newest first; keep the feed to the last 500 so the file stays small.
  const merged = [...fresh, ...feed].slice(0, 500);

  await fs.writeFile(SEEN, JSON.stringify(seen, null, 0));
  await fs.writeFile(FEED, JSON.stringify(merged, null, 2));

  console.log(`Sweep done: ${fresh.length} new remote role(s) across ${agencies.length} agencies.`);
  if (fresh.length) await notifyTelegram(fresh);
}

main().catch(e => { console.error(e); process.exit(1); });
