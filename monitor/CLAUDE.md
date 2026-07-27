# Remote Job Radar — build spec

Monitors 121 US staffing agencies and pushes NEW remote roles (CSR, chat support,
data entry, call center, medical records, member services) to Telegram + a dashboard.

## Architecture (already built — don't rewrite)
- `scan.js` — one sweep: fetch every agency → `classify()` → dedup vs `data/seen.json` → append to `data/feed.json` → Telegram.
- `config.js` — role/remote matching + stable `jobKey`. Tune keywords here.
- `adapters/ats.js` — universal Greenhouse / Lever / Ashby / SmartRecruiters (free JSON).
- `adapters/fallback.js` — `jsearch` (aggregator) + `scrape` (generic HTML).
- `notify.js` — Telegram push.
- `.github/workflows/scan.yml` — free cron every 30 min, commits the feed back.
- `data/agencies.json` — the 121, each with `ats: "unknown"` until you classify it.

## Your job: the classification pass (this is the real work)
For each agency in `data/agencies.json`, set `ats`, `atsToken`, and `careersUrl`.

1. **Find the careers page.** Fetch the site, locate the jobs/careers link, set `careersUrl`.
2. **Detect the ATS** by inspecting that page's network calls / embedded URLs:
   - `boards.greenhouse.io/<token>` or a `greenhouse` embed → `ats:"greenhouse"`, `atsToken:"<token>"`
   - `jobs.lever.co/<slug>` → `ats:"lever"`, `atsToken:"<slug>"`
   - `jobs.ashbyhq.com/<slug>` → `ats:"ashby"`, `atsToken:"<slug>"`
   - `jobs.smartrecruiters.com/<token>` → `ats:"smartrecruiters"`, `atsToken:"<token>"`
   - Bullhorn / JobDiva / Avionté / iCIMS / custom WordPress → `ats:"scrape"` (try generic scraper first)
   - If none work and the generic scraper returns junk → `ats:"jsearch"` (aggregator by name)
3. **Verify** each one returns real postings: `node -e "import('./adapters/ats.js').then(m=>m.greenhouse('X','<token>').then(console.log))"`.

Expect a rough split: a minority on clean ATS feeds (easy), the bulk on `scrape`,
a handful on `jsearch`. Work in batches of ~10 and commit after each.

## Per-site adapters (only when generic scrape fails)
If `scrape` returns nothing useful for a JS-rendered board, add a small function
in a new `adapters/sites/<agency>.js` returning the same shape as the ATS adapters:
`{ agency, title, location, description, url, postedAt, source }`. Wire it in
`scan.js#fetchAgency` behind `a.ats === "site:<agency>"`. Keep each ~10–20 lines.

## Output contract (never change — the dashboard depends on it)
`data/feed.json` = array, newest first, of:
```
{ id, agency, title, category, maybeHybrid, byod, equipment, pay, payMin, payMax, employment, location, source, url, postedAt, firstSeen }
```
`byod` (bool) is true only when the posting requires the worker to supply their
own gear; `equipment` is an array of matched item labels (e.g. `["Dual monitors",
"USB/wired headset"]`), empty when none are detected. `pay` is a display label
(e.g. `"$16/hr"`, `""` if unknown) with `payMin`/`payMax` the hourly numbers (or
null); `employment` is one of Temp-to-hire/Seasonal/Temporary/Contract/Part-time
or `""`. The dashboard ranks BYOD-likely roles (low pay + temp/seasonal/contract)
to the top without hiding anything.

## Guardrails
- Respect robots.txt; keep to one sweep per 30 min. Set a real User-Agent (already done).
- Never store secrets in the repo — Telegram/RapidAPI keys go in GitHub Actions secrets.
- If an adapter throws, `scan.js` logs and skips it; one bad site never breaks the sweep.
