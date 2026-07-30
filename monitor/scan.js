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
import { rss } from "./adapters/rss.js";
import { jsearch, scrape, aggregator, AGGREGATOR_QUERY_COUNT } from "./adapters/fallback.js";
import { ziprecruiter, simplyhired, indeed, ZR_CENTS_PER_RESULT, SH_CENTS_PER_RESULT, IN_CENTS_PER_RESULT } from "./adapters/apify.js";
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
// The deep job-board aggregator (many targeted queries × pages) is the only
// paid work now — per-agency name searches were dropped as redundant + costly.
// Every 2h with ~24 requests/run keeps monthly usage under the cap while pulling
// hundreds of recent postings from Indeed/LinkedIn/ZipRecruiter/SimplyHired/etc.
const AGGREGATOR_EVERY_HOURS = 2;

// Hard monthly ceiling on JSearch requests, enforced in code so overage can
// never be billed even if RapidAPI has no hard-limit toggle. Set safely under
// the plan's 10,000/mo cap. The running count persists in seen.json.
const MONTHLY_JSEARCH_CAP = 9500;

// --- Apify per-board scrapers (SimplyHired + ZipRecruiter) — the two sources
// JSearch can't surface as themselves. Dormant until APIFY_TOKEN is set.
// Apify's Free plan grants $5/mo prepaid credit and hard-blocks when spent, so
// nothing can be billed; we cap BELOW that to leave headroom and keep the proof
// runs free. Spend (in cents) persists in seen.json like the JSearch budget.
// NOTE: Apify bills COMPUTE per run (not just per result), so the $5/mo free
// credit is spent mainly by how OFTEN we run, not how many jobs we pull. Running
// every 6h burned the month's credit in a day of testing. Once/day keeps ZR+SH
// comfortably inside the free $5. (The cents cap below tracks only per-result
// charges — Apify's own hard limit is the real backstop, so nothing can bill.)
const APIFY_EVERY_HOURS = 24;             // once/day — sustainable on the free $5
const MONTHLY_APIFY_CAP_CENTS = 450;      // per-result ceiling; Apify hard-stops at $5
// Indeed needs paid residential proxy ($8/GB) + its actor is flaky, so it's OFF
// by default. Set APIFY_INDEED=1 (a secret) to enable it once willing to spend.
const INDEED_ENABLED = !!process.env.APIFY_INDEED;

const readJSON = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };

async function fetchAgency(a) {
  try {
    if (a.ats in ATS) return await ATS[a.ats](a.name, a.atsToken);
    if (a.ats === "haley")   return await haley(a.name, a.atsToken || a.careersUrl);
    if (a.ats === "avionte") return await avionte(a.name, a.atsToken);
    if (a.ats === "workable") return await workable(a.name, a.atsToken);
    if (a.ats === "rss")     return await rss(a.name, a.atsToken || a.careersUrl);
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

  // Free adapters run every 30-min sweep. The paid job-board aggregator runs on
  // its own slower cadence (or on a manual "Run workflow" click), within quota.
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const slot = Math.floor((now.getUTCHours() * 60 + now.getUTCMinutes()) / 30); // 30-min slot of day
  const everyNSlots = h => Math.max(1, Math.round(h * 2));
  const runAgg = manual || (slot % everyNSlots(AGGREGATOR_EVERY_HOURS) === 0);
  const runApify = manual || (slot % everyNSlots(APIFY_EVERY_HOURS) === 0);

  // ---- monthly JSearch budget guard (never exceed the plan cap) ----
  const hasKey = !!process.env.RAPIDAPI_KEY;
  const month = nowIso.slice(0, 7); // YYYY-MM (UTC)
  const budget = (seen.__budget && seen.__budget.month === month) ? seen.__budget.count : 0;
  let spent = budget;
  const doAgg = runAgg && hasKey && (spent + AGGREGATOR_QUERY_COUNT <= MONTHLY_JSEARCH_CAP);

  // ---- monthly Apify budget guard (never exceed the free $5 credit) ----
  const hasApify = !!process.env.APIFY_TOKEN;
  const apifyBudget = (seen.__apify && seen.__apify.month === month) ? seen.__apify.cents : 0;
  let apifyCents = apifyBudget;
  const apifyRemaining = MONTHLY_APIFY_CAP_CENTS - apifyCents;
  const doApify = runApify && hasApify && apifyRemaining > 0;

  // jsearch agencies have no free reader — the deep aggregator covers them now.
  const agencies = all.filter(a => a.ats !== "jsearch");

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

    // BYOD tier: confirmed (own computer + specs) > likely (gig type / $10-18 /
    // soft "bring your own") > maybe (seasonal, part-time, or peripheral-only).
    const gig = ["Contract", "Temp-to-hire", "Temporary"].includes(employment) || /\b1099\b/i.test(text);
    const payInBand = payMin != null && payMin >= 8 && payMin <= 18;
    let byodTier = "";
    if (tag.byod) byodTier = "confirmed";
    else if (tag.softBYOD || gig || payInBand) byodTier = "likely";
    else if (["Seasonal", "Part-time"].includes(employment) || tag.equipment.length > 0) byodTier = "maybe";

    fresh.push({
      id: key, agency: job.agency, title: job.title,
      category: tag.category, maybeHybrid: tag.maybeHybrid,
      byod: tag.byod, byodTier, equipment: tag.equipment,
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

  // Job-board aggregator (Indeed/ZipRecruiter/SimplyHired via JSearch).
  if (doAgg) {
    try { for (const job of await aggregator()) consider(job); }
    catch (e) { console.warn(`  ! aggregator: ${e.message}`); }
    spent += AGGREGATOR_QUERY_COUNT;
  }

  // Apify per-board scrapers (SimplyHired + ZipRecruiter + Indeed). Split the
  // remaining monthly budget across them; size each run's result cap from its
  // price so we stay inside the free $5 credit. Charge actual results returned.
  if (doApify) {
    const shareCents = apifyRemaining / (INDEED_ENABLED ? 3 : 2);
    const zrCap = Math.floor(shareCents / ZR_CENTS_PER_RESULT);
    const shCap = Math.floor(shareCents / SH_CENTS_PER_RESULT);
    try {
      const zr = zrCap > 0 ? await ziprecruiter(zrCap) : [];
      for (const job of zr) consider(job);
      apifyCents += zr.length * ZR_CENTS_PER_RESULT;
    } catch (e) { console.warn(`  ! ziprecruiter: ${e.message}`); }
    try {
      const sh = shCap > 0 ? await simplyhired(shCap) : [];
      for (const job of sh) consider(job);
      apifyCents += sh.length * SH_CENTS_PER_RESULT;
    } catch (e) { console.warn(`  ! simplyhired: ${e.message}`); }
    if (INDEED_ENABLED) {
      const inCap = Math.floor(shareCents / IN_CENTS_PER_RESULT);
      try {
        const inn = inCap > 0 ? await indeed(inCap) : [];
        for (const job of inn) consider(job);
        apifyCents += inn.length * IN_CENTS_PER_RESULT;
      } catch (e) { console.warn(`  ! indeed: ${e.message}`); }
    }
  }

  // Persist the month's running JSearch spend so the cap survives across runs.
  seen.__budget = { month, count: spent };
  seen.__apify = { month, cents: Math.round(apifyCents * 100) / 100 };

  // Newest first; keep the feed to the last 500 so the file stays small.
  const merged = [...fresh, ...feed].slice(0, 500);

  await fs.writeFile(SEEN, JSON.stringify(seen, null, 0));
  await fs.writeFile(FEED, JSON.stringify(merged, null, 2));

  const parts = ["free"];
  if (doAgg) parts.push("job-boards");
  if (doApify) parts.push(INDEED_ENABLED ? "simplyhired+ziprecruiter+indeed" : "simplyhired+ziprecruiter");
  const capNote = (hasKey ? ` | JSearch used ${spent}/${MONTHLY_JSEARCH_CAP} this month` : "")
    + (hasApify ? ` | Apify spent ${apifyCents.toFixed(1)}/${MONTHLY_APIFY_CAP_CENTS}¢ this month` : "");
  console.log(`Sweep done: ${fresh.length} new remote role(s) across ${agencies.length} agencies [${parts.join("+")}]${capNote}.`);
  if (fresh.length) await notifyTelegram(fresh);
}

main().catch(e => { console.error(e); process.exit(1); });
