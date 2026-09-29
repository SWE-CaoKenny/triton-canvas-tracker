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
- **Check things off** as you finish them.
- **Filter by course.**
- **Private by design.** No accounts and no Canvas password. Your feed link, checkmarks and weights are saved only in your own browser.

## How to use it

1. In Canvas, open **Calendar**, then click **Calendar Feed** (bottom right) and copy the link.
2. Paste it into the tracker and click **Connect**.
3. Optional: click **Grade weights** and copy each course's grading breakdown from the syllabus.

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

Everything else, including parsing, grade math and storage, happens in your browser.

## License

MIT
