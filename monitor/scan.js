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
import { adzuna, ADZUNA_CALLS_PER_RUN } from "./adapters/adzuna.js";
import { jooble, JOOBLE_CALLS_PER_RUN } from "./adapters/jooble.js";
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
// Tuned for a PAID Apify plan (Starter ~$39/mo incl. $39 usage). Twice-daily
// ZR+SH pulls ~$27/mo in per-result charges — comfortably inside $39 with room
// for Indeed. On the free $5 tier this would drain the credit in days; drop
// APIFY_EVERY_HOURS to 72 (every 3 days) + halve the per-run caps to stay free.
// IMPORTANT: also set an Apify-side monthly usage hard limit (Settings→Billing)
// as the real backstop — MONTHLY_APIFY_CAP_CENTS only counts per-result charges,
// not compute/proxy, so it under-counts true spend.
const APIFY_EVERY_HOURS = 12;             // twice a day
const MONTHLY_APIFY_CAP_CENTS = 3000;     // ~$30 of per-result charges/mo
// Per-RUN result ceilings so a single early-month run can't spend the whole
// monthly budget at once (the budget-share sizing below would otherwise pull
// thousands of results in one go while apifyRemaining is still large).
const ZR_MAX_PER_RUN = 150;
const SH_MAX_PER_RUN = 60;
const IN_MAX_PER_RUN = 60;
// Indeed needs paid residential proxy ($8/GB) and its actor is still unproven
// (never a clean success), so it's OFF by default. Set APIFY_INDEED=1 (a secret)
// to enable once the upgrade is live and we've verified the actor runs.
const INDEED_ENABLED = !!process.env.APIFY_INDEED;

// --- Adzuna (free official job-search API). No cost/proxy — just a monthly
// call cap. Free tier ~1,000 calls/mo; run a few times/day well under it.
const ADZUNA_EVERY_HOURS = 8;             // ~3x/day
const MONTHLY_ADZUNA_CAP = 900;           // stay under the free 1,000/mo

// --- Jooble (free official API, covers ZipRecruiter + Indeed, labels source).
// Jooble's welcome letter states a default limit of 500 requests (time unit
// unspecified), so cap MONTHLY well under 500 to be safe whatever it means. At
// 8 queries/run, twice a day = 16/day ≈ 450/mo. Ask Jooble to raise the limit
// (reply to their email) if we want more, then bump these.
const JOOBLE_EVERY_HOURS = 12;            // 2x/day
const MONTHLY_JOOBLE_CAP = 450;           // safely under the 500 default

const readJSON = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };

// Collapse the same role that arrives under different URLs: multi-state remote
// repostings (same employer+title, different state) and cross-sweep re-fetches.
// The seen.json/jobKey dedup is URL-based so it can't catch these — this is a
// display-layer dedup on employer+title only (location dropped on purpose).
const feedDedupKey = (j) => `${j.agency}|${j.title}`.toLowerCase().replace(/\s+/g, " ").trim();

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
  const runAdzuna = manual || (slot % everyNSlots(ADZUNA_EVERY_HOURS) === 0);
  const runJooble = manual || (slot % everyNSlots(JOOBLE_EVERY_HOURS) === 0);

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

  // ---- monthly Adzuna call budget guard (never exceed the free tier) ----
  const hasAdzuna = !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
  const adzunaBudget = (seen.__adzuna && seen.__adzuna.month === month) ? seen.__adzuna.count : 0;
  let adzunaCalls = adzunaBudget;
  const doAdzuna = runAdzuna && hasAdzuna && (adzunaCalls + ADZUNA_CALLS_PER_RUN <= MONTHLY_ADZUNA_CAP);

  // ---- monthly Jooble call budget guard ----
  const hasJooble = !!process.env.JOOBLE_API_KEY;
  const joobleBudget = (seen.__jooble && seen.__jooble.month === month) ? seen.__jooble.count : 0;
  let joobleCalls = joobleBudget;
  const doJooble = runJooble && hasJooble && (joobleCalls + JOOBLE_CALLS_PER_RUN <= MONTHLY_JOOBLE_CAP);

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
    // Size each run by the cheaper of (a) an even slice of the remaining monthly
    // budget and (b) a fixed per-run ceiling, so no single run can overspend.
    const shareCents = apifyRemaining / (INDEED_ENABLED ? 3 : 2);
    const zrCap = Math.min(ZR_MAX_PER_RUN, Math.floor(shareCents / ZR_CENTS_PER_RESULT));
    const shCap = Math.min(SH_MAX_PER_RUN, Math.floor(shareCents / SH_CENTS_PER_RESULT));
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
      const inCap = Math.min(IN_MAX_PER_RUN, Math.floor(shareCents / IN_CENTS_PER_RESULT));
      try {
        const inn = inCap > 0 ? await indeed(inCap) : [];
        for (const job of inn) consider(job);
        apifyCents += inn.length * IN_CENTS_PER_RESULT;
      } catch (e) { console.warn(`  ! indeed: ${e.message}`); }
    }
  }

  // Free aggregator APIs (Adzuna + Jooble), PACKAGED together. Both pull the
  // same Indeed-syndicated pool via different affiliate feeds, so the same job
  // arrives under two different URLs — the URL-based jobKey wouldn't catch that.
  // Merge both, then de-dupe by employer+title+location (URL-agnostic) so each
  // real job lands once. Adzuna runs first + wins collisions (cleaner data:
  // structured pay, no reposter-title noise); Jooble only adds what's unique.
  const aggregatorJobs = [];
  if (doAdzuna) {
    try { aggregatorJobs.push(...await adzuna()); }
    catch (e) { console.warn(`  ! adzuna: ${e.message}`); }
    adzunaCalls += ADZUNA_CALLS_PER_RUN;
  }
  if (doJooble) {
    try { aggregatorJobs.push(...await jooble()); }
    catch (e) { console.warn(`  ! jooble: ${e.message}`); }
    joobleCalls += JOOBLE_CALLS_PER_RUN;
  }
  const aggSeen = new Set();
  for (const job of aggregatorJobs) {
    const k = feedDedupKey(job);
    if (aggSeen.has(k)) continue;   // same job already taken (other API or other state)
    aggSeen.add(k);
    consider(job);
  }

  // Persist the month's running JSearch spend so the cap survives across runs.
  seen.__budget = { month, count: spent };
  seen.__apify = { month, cents: Math.round(apifyCents * 100) / 100 };
  seen.__adzuna = { month, count: adzunaCalls };
  seen.__jooble = { month, count: joobleCalls };

  // Newest first, then collapse duplicate roles (employer+title) that slipped in
  // under different URLs across sources/sweeps. Fresh is prepended so the newest
  // copy wins. Keep the last 500 so the file stays small.
  const feedSeen = new Set();
  const merged = [];
  for (const j of [...fresh, ...feed]) {
    const k = feedDedupKey(j);
    if (feedSeen.has(k)) continue;
    feedSeen.add(k);
    merged.push(j);
    if (merged.length >= 500) break;
  }

  await fs.writeFile(SEEN, JSON.stringify(seen, null, 0));
  await fs.writeFile(FEED, JSON.stringify(merged, null, 2));

  const parts = ["free"];
  if (doAgg) parts.push("job-boards");
  if (doApify) parts.push(INDEED_ENABLED ? "simplyhired+ziprecruiter+indeed" : "simplyhired+ziprecruiter");
  if (doAdzuna) parts.push("adzuna");
  if (doJooble) parts.push("jooble");
  const capNote = (hasKey ? ` | JSearch used ${spent}/${MONTHLY_JSEARCH_CAP} this month` : "")
    + (hasApify ? ` | Apify spent ${apifyCents.toFixed(1)}/${MONTHLY_APIFY_CAP_CENTS}¢ this month` : "")
    + (hasAdzuna ? ` | Adzuna used ${adzunaCalls}/${MONTHLY_ADZUNA_CAP} calls this month` : "")
    + (hasJooble ? ` | Jooble used ${joobleCalls}/${MONTHLY_JOOBLE_CAP} calls this month` : "");
  console.log(`Sweep done: ${fresh.length} new remote role(s) across ${agencies.length} agencies [${parts.join("+")}]${capNote}.`);
  if (fresh.length) await notifyTelegram(fresh);
}

main().catch(e => { console.error(e); process.exit(1); });
