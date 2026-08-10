# Dead Link Watchdog

Watches your saved links (bookmarks, research sources, article lists) and
tells you when a page dies or its content quietly changes — before you
find out the hard way. Each at-risk link is also snapshotted to the
**Internet Archive's Wayback Machine** so you don't lose the reference.

## How it works

- **Backend** (`/backend`): Express API + SQLite (`better-sqlite3`).
  - Fetches each watched URL, strips it down to readable text, and hashes it.
  - Compares the new hash/text against the last snapshot using a word-level
    diff ratio — this filters out noise (ads, timestamps) so you're only
    alerted on real content changes.
  - Calls the Wayback Machine's "Save Page Now" API to force a public
    archive snapshot whenever a link is new, dead, or changed.
  - A `node-cron` job (`src/scheduler.js`) runs every 15 minutes and checks
    any link whose `check_interval_hours` has elapsed (default: weekly).
- **Frontend** (`/frontend`): React + Vite. Add a link, see live status
  (Alive / Changed / Dead), trigger a manual check, and jump to the archived
  snapshot.

## One-time setup: archive.org API keys (required for archiving)

Since 2023, the Wayback Machine's Save Page Now no longer reliably accepts
anonymous requests. You need a free archive.org account:

1. Sign up at https://archive.org/account/signup (free, instant).
2. Once logged in, go to https://archive.org/account/s3.php to generate
   your API keys — you'll get an **access key** and a **secret key**.
3. Set these as environment variables wherever you run the app:
   - `ARCHIVE_ACCESS_KEY`
   - `ARCHIVE_SECRET_KEY`

Locally, create a `.env` file in `backend/` (or export them in your shell)
and load them before `npm start`. On Render: Dashboard → your service →
Environment tab → Add Environment Variable, for both keys, then redeploy.

Without these keys, link health checks (alive/dead/changed) still work —
only the Wayback archiving step is skipped, and the app will show
"No archive.org API keys configured" instead of a broken link.

## Run it locally

You'll need Node.js 18+ installed.

```bash
# Terminal 1 — backend
cd backend
npm install
npm start
# API running on http://localhost:4000

# Terminal 2 — frontend
cd frontend
npm install
npm run dev
# App running on http://localhost:5173
```

Open `http://localhost:5173`, add a URL, and click **Check now** to see it
work immediately (don't wait for the 15-minute scheduler on your first try).

## Does it "just work" if you deploy it?

Mostly yes, but a few things matter:

1. **The backend needs to stay running as a live process**, not just be
   deployed as static files. The scheduler (`node-cron`) only fires while
   the Node process is alive. That means:
   - ✅ Works on: Render, Railway, Fly.io, a VPS, Replit (with an always-on
     plan), or your own server running `npm start` persistently.
   - ❌ Won't work on purely static hosts like Vercel's default deploy or
     GitHub Pages — those don't keep a background process running, so the
     scheduled checks would never fire (though the API routes on serverless
     platforms could still work if triggered manually or via an external
     cron service like cron-job.org hitting a `/api/run-check` endpoint —
     not included here, but a natural next step).

2. **SQLite file storage**: `better-sqlite3` writes to a local file
   (`watchdog.db`). On most platforms this is fine, but on ephemeral/
   serverless filesystems the file can be wiped on redeploy. For a real
   deployment, swap in a hosted Postgres (Railway/Render both offer this
   free tier) — the schema in `db.js` translates directly.

3. **The frontend needs to know where the backend lives.** Locally, Vite's
   dev proxy forwards `/api` calls to `localhost:4000`. In production,
   you'll either serve both from the same domain (put Express behind a
   reverse proxy that also serves the built frontend) or set the frontend's
   fetch calls to point at your deployed backend URL.

4. **Wayback Machine rate limits**: the Save Page Now API is free but not
   unlimited — if you add many links at once, some archive calls may be
   throttled. The code already treats archiving as best-effort so it never
   blocks the health check itself.

## What to highlight on your resume / in interviews

- Content-diff detection that filters signal from noise (word-level Jaccard
  distance) instead of naive string comparison
- A scheduling system that only processes "due" work instead of re-checking
  everything on every tick
- Third-party API integration with graceful degradation (archiving failures
  never break the core feature)
- Clear separation between manual (on-demand) and scheduled (background)
  code paths sharing the same core logic

## Suggested next steps

- Email notifications (e.g., via Resend or Nodemailer) when a link goes
  dead or changes
- Browser extension for one-click "watch this page"
- Auth + multi-user support (currently single-user/local)
- Swap SQLite for Postgres for a persistent cloud deployment
