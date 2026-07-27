# Remote Job Radar

Watches 121 US staffing agencies and alerts you the moment a new remote role
(CSR, chat, data entry, call center, medical records, member services) is posted.

**Cost: $0.** GitHub Actions runs the sweep, the repo stores the data, Telegram
delivers alerts, Cloudflare Pages hosts the dashboard.

## Setup (about 15 minutes)

1. **Push this folder to a new GitHub repo.**

2. **Make a Telegram bot** (for instant alerts)
   - Message `@BotFather` → `/newbot` → copy the token.
   - Message `@userinfobot` → copy your numeric chat id.
   - In the repo: **Settings → Secrets and variables → Actions** → add
     `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
   - *(Optional)* add `RAPIDAPI_KEY` if you use the JSearch fallback.

3. **Classify the agencies.** Open this repo in Claude Code and say:
   *"Follow CLAUDE.md and run the classification pass on data/agencies.json."*
   It fills in each agency's careers URL and ATS so the scraper knows how to read it.

4. **Turn on the schedule.** The workflow in `.github/workflows/scan.yml` runs every
   30 min automatically. Hit **Actions → Remote job radar → Run workflow** to test now.

5. **Host the dashboard** (free): deploy the `dashboard/` app to Cloudflare Pages or
   Vercel and point it at your repo's raw `data/feed.json`.

## Run a sweep locally
```bash
npm install
node scan.js         # prints how many new roles it found
```

## How dedup works
Every posting gets a stable `id` from agency+title+url. `data/seen.json` remembers
what you've already been alerted on, so you're never pinged twice — even across restarts.

## Upgrade path (when you outgrow JSON files)
Replace `loadState`/`saveState` in `scan.js` with Cloudflare D1 or Supabase. Nothing
else changes. You already run both from Alpha Radar, so it's a drop-in.
