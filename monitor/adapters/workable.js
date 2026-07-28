// adapters/workable.js — Workable-hosted boards.
// Public widget API: apply.workable.com/api/v1/widget/accounts/<token>?details=true
// token = the account subdomain (e.g. "zirtual-llc"). Free, no key. Includes a
// telecommuting flag + employment_type, which feed remote + BYOD-relevance.

const strip = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

export async function workable(agency, token) {
  if (!token) return [];
  const r = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`, {
    headers: { "User-Agent": "remote-job-radar/1.0", Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`workable ${token} -> ${r.status}`);
  const d = await r.json();
  return (d.jobs || []).map(j => {
    const cityState = [j.city, j.state].filter(Boolean).join(", ");
    const location = j.telecommuting
      ? (cityState ? `${cityState} · Remote` : "Remote")
      : [j.city, j.state, j.country].filter(Boolean).join(", ") || "Remote";
    return {
      agency,
      title: j.title,
      location,
      // append employment_type (e.g. "Contract") so scan.js reads job type
      description: `${strip(j.description)} ${j.employment_type || ""}`.slice(0, 4000),
      url: j.shortlink || j.url || j.application_url,
      postedAt: j.published_on || j.created_at || null,
      source: "Workable",
    };
  }).filter(j => j.title && j.url);
}
