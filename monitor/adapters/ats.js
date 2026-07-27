// adapters/ats.js — universal adapters for the big applicant-tracking systems.
// These are free, official JSON endpoints. If an agency uses one of these, you
// only need its token/slug in agencies.json — no custom scraping.

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "remote-job-radar/1.0" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Greenhouse: token = board name in boards.greenhouse.io/<token>
export async function greenhouse(agency, token) {
  const data = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
  return (data.jobs || []).map(j => ({
    agency, title: j.title, location: j.location?.name || "",
    description: (j.content || "").slice(0, 4000),
    url: j.absolute_url, postedAt: j.updated_at || null, source: "Greenhouse",
  }));
}

// Lever: slug = company in jobs.lever.co/<slug>
export async function lever(agency, slug) {
  const data = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (data || []).map(j => ({
    agency, title: j.text, location: j.categories?.location || "",
    description: (j.descriptionPlain || "").slice(0, 4000),
    url: j.hostedUrl, postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null, source: "Lever",
  }));
}

// Ashby: slug = board name in jobs.ashbyhq.com/<slug>
export async function ashby(agency, slug) {
  const data = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`);
  return (data.jobs || []).map(j => ({
    agency, title: j.title, location: j.location || j.address?.postalAddress?.addressLocality || "",
    description: (j.descriptionPlain || "").slice(0, 4000),
    url: j.jobUrl, postedAt: j.publishedAt || null, source: "Ashby",
  }));
}

// SmartRecruiters: token = company identifier
export async function smartrecruiters(agency, token) {
  const data = await getJSON(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`);
  return (data.content || []).map(j => ({
    agency, title: j.name,
    location: [j.location?.city, j.location?.region].filter(Boolean).join(", "),
    description: "", url: `https://jobs.smartrecruiters.com/${token}/${j.id}`,
    postedAt: j.releasedDate || null, source: "SmartRecruiters",
  }));
}

export const ATS = { greenhouse, lever, ashby, smartrecruiters };
