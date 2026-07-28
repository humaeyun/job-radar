// adapters/rss.js — RSS/Atom job feeds (very common on WordPress "WP Job Manager"
// boards at /feed/?post_type=job, and some ATS boards). Free, server-side, and
// perfect for a "new job" radar since the feed lists the latest postings.
// token/feedUrl = the feed URL.

const unescape = s => String(s || "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&#8217;/g, "'").replace(/&amp;/g, "&");
const strip = s => unescape(s).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : ""; };
const iso = d => { const t = Date.parse(d); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

export async function rss(agency, feedUrl) {
  if (!feedUrl) return [];
  // Some WP feeds 403 a bot UA, so present a browser UA for the (public) RSS.
  const r = await fetch(feedUrl, { headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "application/rss+xml,application/xml,text/xml,*/*",
  } });
  if (!r.ok) throw new Error(`rss ${feedUrl} -> ${r.status}`);
  const xml = await r.text();
  const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  return blocks.map(b => {
    const title = strip(tag(b, "title"));
    let link = strip(tag(b, "link"));
    if (!link || /^https?:/.test(link) === false) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1]; }
    const desc = strip(tag(b, "content:encoded") || tag(b, "description") || tag(b, "summary"));
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated");
    const locM = desc.match(/Location:\s*([A-Za-z0-9 ,.\-\/()]+?)(?:\s{2,}|Pay:|Salary:|Job Type:|Type:|Category:|$)/i);
    return {
      agency, title,
      location: locM ? locM[1].trim().slice(0, 80) : "",
      description: desc.slice(0, 4000),
      url: link, postedAt: iso(date), source: "RSS",
    };
  }).filter(j => j.title && /^https?:/.test(j.url || ""));
}
