# Calendar Sync: Setup Guide

## Set up

You need the five kit files (`appsscript.json`, `calendar-sync.gs`, `config.gs`, `cleanup.gs`, `ical.js.gs`) and your iCal links. Use Chrome.

1. Sign in to the Google account whose calendar should show everything. Go to script.google.com and click **New project**.
2. Click the gear icon (**Project Settings**) on the left. Tick **Show "appsscript.json" manifest file in editor**.
3. Click the `<>` icon (**Editor**) on the left. Open `appsscript.json`, delete everything in it, and paste in the contents of `appsscript.json`. Change `America/New_York` to your time zone.
4. Open `Code.gs`, delete everything in it, and paste in `calendar-sync.gs`. Click the three dots next to it, **Rename**, and type `calendar-sync`.
5. Click **+** next to **Files**, then **Script**. Name it `config` and paste in `config.gs`.
6. Do the same for `cleanup` (paste `cleanup.gs`) and `ical.js` (paste `ical.js.gs`).
7. In `config`, replace `<OWN_MIRROR_LABEL>` with one word, such as `home`, and `<OWN_MIRROR_EMAIL>` with your Google email address.
8. Under `feeds`, replace `<ICAL_URL>` with your first iCal link and `<FEED_LABEL>` with a short name for it.
9. For each other link: delete the `//` at the start of the next line and fill it in the same way. For more links, copy that line.
10. Press Ctrl+S (Mac: Cmd+S) to save.
11. In the bar at the top, pick `setup` from the list next to **Debug**, then click **Run**.
12. Click **Review permissions**, pick your account, click **Advanced**, then **Go to Untitled project (unsafe)**. Tick **Select all** and click **Continue**.
13. Look at the log at the bottom. If its last line starts with `NEXT:`, do what it says and click **Run** again. Repeat until it says `Setup complete`.
14. Open Google Calendar and untick **iCal import** in the left sidebar.

## Add another Google account (optional)

1. In the first account's `config`, change `const MIRROR_SHARES = {};` to `const MIRROR_SHARES = { "bob@example.org": "free/busy" };`, using the other account's email. Save.
2. Run `setup` in the first account.
3. In the other account, do steps 1 to 5 and 7 of Set up. Skip `ical.js`.
4. In that account's `config`, set `enabled: false` under `ICAL_IMPORT`, and put the first account's email in `MIRROR_SHARES` the same way. Save.
5. Run `setup` in the other account and approve, as in steps 11 and 12.
6. In each account's email, open "… has shared a calendar with you" and click **Add this calendar**.
7. Run `setup` again in each account until it says `Setup complete`.
8. In each account's Google Calendar, untick the mirror calendar in the left sidebar.

## Add a Google calendar someone shared with you (optional)

1. In Google Calendar, point at the calendar in the left sidebar, click its three dots, then **Settings and sharing**.
2. Scroll to **Integrate calendar** and copy the **Calendar ID**.
3. In `config`, change `const EXTRA_SOURCES = [];` to `const EXTRA_SOURCES = [{ id: "the ID you copied", label: "work" }];`. Use any one word for the label. Save.
4. Run `setup`.

## Add, change or remove an iCal link

1. In `config`, edit the lines under `feeds`. Save.
2. Run `setup`.

## Start over or remove everything

1. In `config`, pick `previewReset` from the list at the top and click **Run**. Check the log.
2. Pick `resetEverything` and click **Run**. If the log says to run it again, do.
3. To set up again, pick `setup` and click **Run**.

## If something goes wrong

- "400. That's an error" when approving: open a Chrome incognito window, sign in to that account only, and run `setup` again.
- "missing a permission": run `setup` and tick **Select all** when asked.
- Anything else: do what the last `NEXT:` line in the log says, then run `setup` again.
