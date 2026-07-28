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
import { avionte } from "./adapters/avionte.js";
import { workable } from "./adapters/workable.js";
import { jsearch, scrape, aggregator, AGGREGATOR_QUERY_COUNT } from "./adapters/fallback.js";
import { classify, jobKey, extractPay, extractEmployment, payLabel } from "./config.js";
import { notifyTelegram } from "./notify.js";

const AGENCIES = "./data/agencies.json";
const SEEN = "./data/seen.json";     // { [key]: firstSeenISO }
const FEED = "./data/feed.json";     // rolling list the dashboard renders

// The JSearch (paid) tier costs API quota, so it's throttled below the free
// adapters (which sweep every ~30 min). Two independent cadences keep monthly
// usage well under the plan cap while still surfacing new roles fast:
//   - job-board aggregator: only 3 requests/run -> cheap -> run every sweep
//   - 97 per-agency name searches: expensive     -> run ~once a day
// Budget at these defaults ≈ 3*48*30 + 97*1*30 ≈ 7,230 requests/month (< 10k).
const AGGREGATOR_EVERY_HOURS = 0.5;   // job boards: every 30-min sweep (near real-time)
const PAID_AGENCY_EVERY_HOURS = 24;   // per-agency JSearch: ~1x/day

// Hard monthly ceiling on JSearch requests, enforced in code so overage can
// never be billed even if RapidAPI has no hard-limit toggle. Set safely under
// the plan's 10,000/mo cap. The running count persists in seen.json.
const MONTHLY_JSEARCH_CAP = 9500;

const readJSON = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };

async function fetchAgency(a) {
  try {
    if (a.ats in ATS) return await ATS[a.ats](a.name, a.atsToken);
    if (a.ats === "haley")   return await haley(a.name, a.atsToken || a.careersUrl);
    if (a.ats === "avionte") return await avionte(a.name, a.atsToken);
    if (a.ats === "workable") return await workable(a.name, a.atsToken);
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
  const all = (await readJSON(AGENCIES, [])).filter(a => a.enabled);
  const seen = await readJSON(SEEN, {});
  const feed = await readJSON(FEED, []);
  const now = new Date();
  const nowIso = now.toISOString();

  // Free adapters run every sweep. The paid JSearch tier (per-agency queries +
  // the job-board aggregator) runs only a couple times a day, or on a manual
  // "Run workflow" click, so it stays within the API quota.
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const slot = Math.floor((now.getUTCHours() * 60 + now.getUTCMinutes()) / 30); // 30-min slot of day
  const everyNSlots = h => Math.max(1, Math.round(h * 2));
  const runAgencies = manual || (slot % everyNSlots(PAID_AGENCY_EVERY_HOURS) === 0);
  const runAgg      = manual || (slot % everyNSlots(AGGREGATOR_EVERY_HOURS) === 0);

  // ---- monthly JSearch budget guard (never exceed the plan cap) ----
  const hasKey = !!process.env.RAPIDAPI_KEY;
  const month = nowIso.slice(0, 7); // YYYY-MM (UTC)
  const budget = (seen.__budget && seen.__budget.month === month) ? seen.__budget.count : 0;
  let spent = budget;
  const jsearchCost = all.filter(a => a.ats === "jsearch").length; // 1 request per jsearch agency
  // Only spend paid quota if there's a key AND this run fits under the cap.
  const doAgencies = runAgencies && hasKey && (spent + jsearchCost <= MONTHLY_JSEARCH_CAP);
  const doAgg      = runAgg      && hasKey && (spent + AGGREGATOR_QUERY_COUNT <= MONTHLY_JSEARCH_CAP);

  const agencies = doAgencies ? all : all.filter(a => a.ats !== "jsearch");

  const fresh = [];
  const consider = (job) => {
    if (!job || !job.url || !job.title) return;
    const tag = classify(job.title, job.location, job.description);
    if (!tag) return;
    const key = jobKey(job);
    if (seen[key]) return;                    // already alerted on a prior sweep
    seen[key] = nowIso;

    // Pay: prefer structured (JSearch) hourly, else parse from title/description.
    const text = `${job.title} ${job.description || ""}`;
    let payMin = job.payMin ?? null, payMax = job.payMax ?? null;
    if (payMin == null && payMax == null) { const p = extractPay(text); payMin = p.min; payMax = p.max; }
    const employment = extractEmployment(text);

    fresh.push({
      id: key, agency: job.agency, title: job.title,
      category: tag.category, maybeHybrid: tag.maybeHybrid,
      byod: tag.byod, equipment: tag.equipment,
      pay: payLabel(payMin, payMax), payMin, payMax, employment,
      location: job.location || "Remote", source: job.source,
      url: job.url, postedAt: job.postedAt, firstSeen: nowIso,
    });
  };

  // Fetch agencies concurrently (network-bound). consider() is synchronous so
  // interleaving is safe. Keeps sweeps fast as the agency count grows.
  let ai = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (ai < agencies.length) {
      const a = agencies[ai++];
      const raw = await fetchAgency(a);
      for (const job of raw) consider(job);
    }
  }));
  if (doAgencies) spent += jsearchCost;

  // Job-board aggregator (Indeed/ZipRecruiter/SimplyHired via JSearch).
  if (doAgg) {
    try { for (const job of await aggregator()) consider(job); }
    catch (e) { console.warn(`  ! aggregator: ${e.message}`); }
    spent += AGGREGATOR_QUERY_COUNT;
  }

  // Persist the month's running JSearch spend so the cap survives across runs.
  seen.__budget = { month, count: spent };

  // Newest first; keep the feed to the last 500 so the file stays small.
  const merged = [...fresh, ...feed].slice(0, 500);

  await fs.writeFile(SEEN, JSON.stringify(seen, null, 0));
  await fs.writeFile(FEED, JSON.stringify(merged, null, 2));

  const parts = ["free"];
  if (doAgencies) parts.push("agencies");
  if (doAgg) parts.push("job-boards");
  const capNote = hasKey ? ` | JSearch used ${spent}/${MONTHLY_JSEARCH_CAP} this month` : "";
  console.log(`Sweep done: ${fresh.length} new remote role(s) across ${agencies.length} agencies [${parts.join("+")}]${capNote}.`);
  if (fresh.length) await notifyTelegram(fresh);
}

main().catch(e => { console.error(e); process.exit(1); });
