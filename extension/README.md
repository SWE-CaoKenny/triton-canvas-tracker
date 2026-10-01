# Triton Tracker Sync (Chrome / Edge extension)

Some courses don't put homework on the Canvas calendar: it's a PDF in **Modules** (`HW1.pdf`) and you submit it on **Gradescope**. This extension finds that homework automatically and adds it to [Triton Tracker](https://triton-canvas-tracker-production.up.railway.app).

## What it does

1. **Canvas modules:** scans your current courses' modules for homework-like items (*homework, hw, problem set, pset, assignment, worksheet, lab, project*, …), skipping solutions, slides and notes.
2. **Gradescope:** reads each current course's assignment list for due dates and whether you've submitted.
3. **Matches them:** `HW1.pdf` in Canvas and "Homework 1" on Gradescope become one item with Gradescope's due date. Things already on the Canvas calendar aren't duplicated.
4. **Estimates when there's no date:** homework with no date on Gradescope or in its title gets an estimated due date from when it was posted and the course's usual rhythm, labeled "Estimated".
5. **Sends them to Triton Tracker:** they show up with countdowns and grade weights. Anything you've submitted on Gradescope is checked off automatically. Homework with no date anywhere shows in a "found without a due date" list where you can set one.

It checks every 3 hours (you can turn this off) and also whenever you open a Gradescope course page.

## Privacy

- Uses the Canvas and Gradescope logins already in your browser. It never sees or stores your password.
- Read-only: it never clicks, submits or changes anything.
- Data goes only to Triton Tracker in your own browser. Nothing is sent to the Triton Tracker server.
- Permissions: `canvas.ucsd.edu`, `www.gradescope.com`, and the Triton Tracker site.

## Install (developer mode, for now)

1. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
2. In Chrome go to `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.
4. Make sure you're logged in to Canvas and Gradescope, click the extension's icon, and press **Sync now**.
5. Open Triton Tracker. The found homework appears in the List tab.

If something looks wrong, click **Copy diagnostics** in the extension popup and include it in a GitHub issue. It contains your course names and a few assignment titles, so only share it if you're comfortable with that.

## Tests

```bash
node extension/test/shared.test.js
node extension/test/canvas-scan.test.js
```

`extension/test/run.html` runs the Gradescope parser against sample pages (serve the `extension` folder and open it in a browser).
