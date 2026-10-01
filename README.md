# Triton Tracker

See every Canvas assignment, quiz and exam in one WebReg-style dashboard, sorted by **how soon it's due** and **how much it counts toward your grade**.

Built for UC San Diego students, but it works with **any school that uses Canvas**.

**👉 Use it now: [triton-canvas-tracker-production.up.railway.app](https://triton-canvas-tracker-production.up.railway.app)**

> Unofficial student project. Not affiliated with UC San Diego or Instructure.

## Features

- **Three views, WebReg-style:** a **List** tab (grouped into Overdue, Next 3 days, This week and Later), a weekly **Calendar**, and an **Exams & Quizzes** tab, similar to WebReg's Finals view.
- **Time-left countdowns** that turn from green to blue to orange to red as the deadline gets closer.
- **Exams and quizzes stand out** with gold highlighting and a badge. Multi-day testing windows show as one entry.
- **Grade impact.** Enter your syllabus's grading breakdown (for example "Midterms 40%, Final 45%, Homework 15%") and every card shows its share of your final grade, like "20% of grade". You can sort by it.
- **My Schedule (UCSD):** paste your [Class Planner](https://classplanner.apps.ucsd.edu/) share link to see your weekly classes with times, rooms and professors, a campus map, walking times between back-to-back classes (with tight transfers and time conflicts flagged), and your midterms and finals, which also show up as countdowns.
- **Sync extension (Chrome/Edge):** finds homework the Canvas calendar misses, like `HW1.pdf` in Modules that's turned in on Gradescope, and pulls due dates from Gradescope automatically. Submitted work is checked off for you. See [extension/README.md](extension/README.md).
- **Homework posted only in Modules, no extension needed:** paste a Canvas access token in **Settings** and the site scans your modules for `HW1.pdf`-style homework. When there's no due date anywhere, it **estimates** one from when the homework was posted and the course's usual rhythm (for example "due 7 days after posting at 11:59pm"). Estimates are labeled, and one click sets the real date. The token is kept only in your browser and never stored on the server.
- **Add anything Canvas missed**, like an in-class midterm or a paper handout, with **+ Add Item**. Added items show in every tab, count toward grade weights, and can be edited or deleted.
- **Check things off** as you finish them.
- **Filter by course.**
- **Private by design.** No accounts and no Canvas password. Your feed link, checkmarks and weights are saved only in your own browser.

## How to use it

1. In Canvas, open **Calendar**, then click **Calendar Feed** (bottom right) and copy the link.
2. Paste it into the tracker and click **Connect**.
3. Optional: click **Grade weights** and copy each course's grading breakdown from the syllabus.
4. Optional (UCSD): in Class Planner, click **Save & share**, copy the link, and paste it into the **My Schedule** tab.

Don't want to share the link? You can download the `.ics` file from that same link and upload it instead. That's a one-time snapshot, so upload it again to update.

> Your Canvas feed link works like a password for your calendar. Don't post it publicly.

### How grade weights work

Each category's weight is split evenly across the items whose titles contain its keywords.

| Category | Weight | Keywords | Items in Canvas | Each item |
|---|---|---|---|---|
| Midterms | 40% | `midterm` | 2 | 20% |
| Final | 45% | `final` | 1 | 45% |
| Homework | 15% | `homework, hw` | 10 | 1.5% |

If not all items are posted in Canvas yet, set **# items** to the number listed in your syllabus.

## Run it yourself

It needs Node.js 18 or newer and has no dependencies.

```bash
npm start
```

Then open http://localhost:3000.

## Deploy on Railway

1. Fork or push this repo to GitHub.
2. In [Railway](https://railway.app), choose **New Project → Deploy from GitHub repo** and pick this repo.
3. Railway detects Node and runs `npm start` automatically. Under **Settings → Networking**, click **Generate Domain**.

Every push to `main` redeploys automatically.

## Using it at another school

Everyone can change their school's Canvas address in the app under **Settings**. To rebrand your own copy, edit `public/config.js` (name, school, default Canvas address and colors).

## How it works (and why there's a server)

Browsers aren't allowed to read Canvas calendar feeds directly from another website (CORS), so `server.js` has one small endpoint, `POST /api/feed`, that fetches the feed for you and passes it straight back. It:

- only fetches URLs shaped like `https://<host>/feeds/calendars/<id>.ics`, so it can't be used as a general proxy
- refuses private and internal network addresses
- receives the link in the request body, never the URL, so it doesn't show up in access logs
- doesn't store or log feed links or calendar data
- rate-limits each IP address

`POST /api/canvas-scan` takes a Canvas host and access token, makes read-only Canvas API calls on that host only (capped at 150 calls), and returns homework candidates with posting dates. The token is used for that request alone: never stored, cached or logged. Due-date estimates are computed in your browser so they use your time zone (`extension/shared.js`, served at `/lib/shared.js`).

A second endpoint, `POST /api/schedule`, loads a UCSD Class Planner share page. It only accepts `https://classplanner.apps.ucsd.edu/view/…` links, reads the schedule data embedded in the page (see `planner.js`), and caches each schedule for 15 minutes to go easy on UCSD's servers.

Everything else, including parsing, grade math and storage, happens in your browser. The campus map uses [MapLibre GL](https://maplibre.org/) with free, keyless tiles from [OpenFreeMap](https://openfreemap.org/) (© OpenMapTiles, data © OpenStreetMap contributors).

## License

MIT
