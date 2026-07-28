// adapters/avionte.js — Avionté "Compas" job boards (hire.myavionte.com).
// Tons of staffing agencies embed the Compas widget; it reads jobs from a public
// JSON endpoint keyed by the board's two ids (the page's data-bid / data-jbid).
// token = "<bid>:<jbid>". Free, no quota, and richer than JSearch here: full
// listings come with structured hourly pay (payMin/payMax) and job type.

const API = (bid, jbid) => `https://hire.myavionte.com/sonar/v2/jobBoard/${bid}/${jbid}`;

// Avionté pay can be hourly (e.g. 17) or annual (e.g. 90000); only trust hourly.
const hourly = n => (n != null && n > 0 && n <= 200 ? n : null);

export async function avionte(agency, token) {
  if (!token || !token.includes(":")) return [];
  const [bid, jbid] = token.split(":");
  const r = await fetch(API(bid, jbid), {
    headers: { "User-Agent": "remote-job-radar/1.0", Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`avionte ${bid} -> ${r.status}`);
  const d = await r.json();
  const base = String(d.primaryUrl || "").replace(/\/+$/, "");
  const posts = Object.values(d.jobPosts || {});
  return posts
    .map(j => ({
      agency,
      title: j.jobTitle,
      location: j.location || "Remote",
      // append jobType (e.g. "Contract to Perm") so scan.js reads employment
      description: `${j.descriptionText || j.description || ""} ${j.jobType || ""}`.trim(),
      url: base && j.jobPostIdEnc ? `${base}/${j.jobPostIdEnc}` : base,
      postedAt: j.postDateUtc || null,
      source: "Avionté",
      payMin: hourly(j.payMin),
      payMax: hourly(j.payMax),
    }))
    .filter(j => j.title && j.url);
}
