// adapters/haley.js — Haley Marketing job boards, ubiquitous in US staffing
// (they power most "jobs.<agency>.com" boards, backed by Bullhorn data).
//
// Every Haley board publishes a full sitemap of live postings at
// <board>/sitemap.xml, server-side and free — no API key, no JS rendering.
// Job URLs encode title + location in the slug:
//   https://jobs.acme.com/jb/<Title-slug>-Jobs-in-<City-State-slug>/<jobId>
//
// token/board = the board base URL (e.g. "https://jobs.acme.com").

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "remote-job-radar/1.0" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

const deslug = s => decodeURIComponent(s || "").replace(/-/g, " ").replace(/\s+/g, " ").trim();

function parseJobLocs(xml) {
  const urls = [];
  const re = /<loc>\s*([^<\s]+\/jb\/[^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) urls.push(m[1].trim());
  return urls;
}

function toJob(agency, url) {
  // strip the trailing /<id>, then split "<Title>-Jobs-in-<Location>"
  const path = (url.split("/jb/")[1] || "").replace(/\/\d+\/?$/, "");
  let title = path, location = "";
  const idx = path.search(/-Jobs-in-/i);
  if (idx >= 0) {
    title = path.slice(0, idx);
    location = path.slice(idx + "-Jobs-in-".length);
  }
  title = deslug(title);
  location = deslug(location);
  return { agency, title, location, description: `${title} ${location}`,
    url, postedAt: null, source: "Haley" };
}

export async function haley(agency, board) {
  if (!board) return [];
  const base = String(board).replace(/\/+$/, "");
  const xml = await getText(`${base}/sitemap.xml`);

  let locs = parseJobLocs(xml);

  // Some boards use a sitemap index that points at child sitemaps. If we found
  // no job URLs directly, follow up to a few child sitemaps that look job-ish.
  if (locs.length === 0) {
    const children = [...xml.matchAll(/<loc>\s*([^<\s]+\.xml)\s*<\/loc>/gi)]
      .map(m => m[1].trim())
      .filter(u => /job|sitemap/i.test(u))
      .slice(0, 5);
    for (const child of children) {
      try { locs.push(...parseJobLocs(await getText(child))); } catch { /* skip */ }
    }
  }

  const seen = new Set();
  const jobs = [];
  for (const url of locs) {
    if (seen.has(url)) continue;
    seen.add(url);
    jobs.push(toJob(agency, url));
  }
  return jobs;
}
