# Remote Job Radar — dashboard

React + Vite app that renders the live feed the monitor writes (`monitor/data/feed.json`).
New/All/Saved tabs, search, category filters, a 3-state equipment (BYOD) filter, and
save/dismiss state persisted in `localStorage`.

## Run locally
```bash
npm install
npm run dev
```
Local dev reads `public/feed.json` (a snapshot). To point at the live feed while
developing, set `VITE_FEED_URL` (see below).

## Feed source
The app fetches `VITE_FEED_URL`, falling back to `/feed.json` when it's unset.
- **Local:** leave unset → uses `public/feed.json`.
- **Production:** set `VITE_FEED_URL` to your repo's raw feed, e.g.
  `https://raw.githubusercontent.com/<you>/<repo>/main/monitor/data/feed.json`
  (raw.githubusercontent.com sends `Access-Control-Allow-Origin: *`, so cross-origin
  fetch works). The feed refreshes on the repo every sweep; reload to see new roles.

## Deploy to Cloudflare Pages
Connect the repo, then set:
- **Root directory:** `dashboard`
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Environment variable:** `VITE_FEED_URL` = the raw feed URL above

Vercel works the same way (root `dashboard`, framework Vite, same env var).

## Notes
- The Alerts drawer is informational — real alerts are delivered server-side by the
  monitor (Telegram). Channel settings here are stored locally only.
- To keep the view fresh without a manual reload, you could add a `setInterval`
  refetch of the feed; omitted to keep the first version simple.
