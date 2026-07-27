// adapters/sitemap.js — generic sitemap harvester for boards that publish job
// URLs in their XML sitemap but render the listing UI client-side (common on
// WordPress "WP Job Manager" and several ATS boards).
//
// Strategy that keeps requests bounded:
//   1. read <site>/sitemap.xml (+ one level of job-ish child sitemaps)
//   2. keep only job URLs whose slug hints at a target ROLE (cheap, no fetch)
//   3. fetch just those few pages for real title/location/description so
//      scan.js's classify() can judge remote-ness accurately
//
// token/base = the site origin (e.g. "https://www.acme.com").

import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 remote-job-radar/1.0";
const ROLE_HINT = /(customer|support|service|chat|data.?entry|call.?cent|contact.?cent|records|member|patient|claims|enrollment|eligibilit|sales|telemarket|telesales|appointment|collections|virtual.?assist|help.?desk|receptionist|clerk|representative|agent|csr|billing|schedul|intake|verification|authorization|moderat|typist|transcription|concierge|escalation)/i;
const REMOTE_HINT = /(remote|work.?from.?home|wfh|telecommute|virtual|anywhere)/i;
const JOB_LOC = /\/(?:jb|job|jobs|job-details?|job-openings?|careers?)\/[^<\s"]*[a-z0-9][^<\s"]*/i;
const MAX_FETCH = 40; // per agency per sweep

async function getText(url, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { redirect: "follow", signal: c.signal, headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } finally { clearTimeout(t); }
}

const roughTitle = (url) => {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean)
      .filter(s => !/^(jb|job|jobs|job-details?|job-openings?|careers?)$/i.test(s)) // drop the prefix segment
      .filter(s => !/^\d+$/.test(s));                                                // drop pure-numeric id segments
    return decodeURIComponent(parts.join(" ")).replace(/[-_]+/g, " ").replace(/\b\d{4,}\b/g, "").replace(/\s+/g, " ").trim();
  } catch { return ""; }
};

function jobLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]).filter(u => JOB_LOC.test(u));
}
function childSitemaps(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+\.xml[^<\s]*)\s*<\/loc>/gi)].map(m => m[1]).filter(u => /job|sitemap|post/i.test(u));
}

async function harvest(origin) {
  const roots = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`, `${origin}/job-sitemap.xml`];
  for (const root of roots) {
    const xml = await getText(root);
    if (!xml || !xml.includes("<")) continue;
    let locs = jobLocs(xml);
    if (locs.length < 3) {
      for (const child of childSitemaps(xml).slice(0, 6)) {
        const cx = await getText(child);
        if (cx) locs.push(...jobLocs(cx));
      }
    }
    if (locs.length) return [...new Set(locs)];
  }
  return [];
}

// Prefer schema.org JobPosting JSON-LD — clean, structured, and it states remote
// explicitly via jobLocationType TELECOMMUTE, avoiding page-chrome false positives.
function jobPostingLd($) {
  let hit = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (hit) return;
    let data; try { data = JSON.parse($(el).contents().text()); } catch { return; }
    const nodes = Array.isArray(data) ? data : (data["@graph"] || [data]);
    for (const n of nodes) {
      const types = n && (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]);
      if (types && types.includes("JobPosting")) { hit = n; break; }
    }
  });
  return hit;
}

const stripTags = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

function extract($, url) {
  const jp = jobPostingLd($);
  if (jp) {
    const title = stripTags(jp.title);
    const loc = jp.jobLocation;
    const addr = (Array.isArray(loc) ? loc[0] : loc)?.address || {};
    const location = [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ");
    // TELECOMMUTE is the only authoritative remote flag in JobPosting schema
    // (applicantLocationRequirements just scopes eligibility, NOT remoteness).
    const telecommute = /telecommute/i.test(jp.jobLocationType || "");
    const description = stripTags(jp.description).slice(0, 4000);
    return { title, location, description, url, telecommute };
  }
  // fallback: title + meta description only (no full body -> avoids boilerplate noise)
  const title = ($('meta[property="og:title"]').attr("content") || $("h1").first().text() || $("title").text() || "").trim();
  const location = ($('meta[name="geo.placename"]').attr("content") || "").replace(/\s+/g, " ").trim();
  const description = ($('meta[name="description"]').attr("content") || title).replace(/\s+/g, " ").trim().slice(0, 4000);
  return { title, location, description, url, telecommute: false };
}

export async function sitemap(agency, base) {
  if (!base) return [];
  const origin = (() => { try { return new URL(base).origin; } catch { return String(base).replace(/\/+$/, ""); } })();
  const locs = await harvest(origin);
  // pre-filter by slug so we only fetch role-relevant pages
  const candidates = locs.filter(u => ROLE_HINT.test(roughTitle(u))).slice(0, MAX_FETCH);
  const jobs = [];
  for (const url of candidates) {
    const html = await getText(url);
    if (!html) {
      // slug-only fallback: keep only if the slug itself names remote (high precision)
      if (REMOTE_HINT.test(roughTitle(url)))
        jobs.push({ agency, title: roughTitle(url), location: "Remote", description: roughTitle(url), url, postedAt: null, source: "Sitemap" });
      continue;
    }
    const $ = cheerio.load(html);
    const e = extract($, url);
    // Gate on a STRONG remote signal — title/location wording or schema TELECOMMUTE.
    // Free-text descriptions carry marketing boilerplate ("remote opportunities")
    // that would otherwise cause false positives, so they don't qualify a role here.
    const title = e.title || roughTitle(url);
    const strongRemote = e.telecommute || REMOTE_HINT.test(title) || REMOTE_HINT.test(e.location);
    if (!strongRemote) continue;
    const location = e.telecommute && !/remote/i.test(e.location) ? (e.location ? `${e.location} · Remote` : "Remote") : e.location;
    jobs.push({ agency, title, location, description: e.description || title, url, postedAt: null, source: "Sitemap" });
  }
  return jobs;
}
