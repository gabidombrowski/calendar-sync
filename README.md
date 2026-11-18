# calendar-sync

A Google Apps Script that copies your other calendars onto one main Google calendar.

- Copies iCal links and Google calendars onto one Google calendar.
- No duplicates. Hand edits and deletions stick.
- Runs in your own Google account, so no one else sees your calendar data.

## Download

[calendar-sync-kit.zip](https://github.com/gabidombrowski/calendar-sync/releases/latest/download/calendar-sync-kit.zip) (latest release)

## Setup

Follow the [setup guide](docs/setup-guide.md). It is also available as a [Word document](docs/setup-guide.docx).

## What to expect

- Google shows an "unverified app" screen. This happens because each person runs their own copy of the script. To get past it, click **Advanced**, then **Go to (project name)**.
- The sync runs every 15 minutes.
- Calendars added "From URL" in Google Calendar are not used. Put the iCal link in `config.gs` instead.

## Status

Tested on the author's own Google accounts. If something goes wrong, open a [GitHub issue](https://github.com/gabidombrowski/calendar-sync/issues) and include the setup log.

## Development

The files in `apps-script/` are the files you paste into Apps Script. Edit them directly.

| File | What it is |
| --- | --- |
| `apps-script/calendar-sync.gs` | Setup wizard, sync, iCal import, Calendar API access |
| `apps-script/config.gs` | Your settings and the functions you run |
| `apps-script/cleanup.gs` | Reset back to zero (`previewReset`, `resetEverything`) |
| `apps-script/ical.js.gs` | Third-party iCalendar parser (see below) |
| `apps-script/appsscript.json` | Apps Script manifest (turns on the Calendar API) |
| `docs/` | Setup guide in Markdown and Word |

To build the release zip:

```bash
scripts/package.sh
```

This writes `release/calendar-sync-kit.zip`. Attach it to a GitHub release.

## Support the project

If this saves you time, you can [sponsor the project on GitHub](https://github.com/sponsors/gabidombrowski).

## License

MIT for this project's own code. See [LICENSE](LICENSE).

### Third-party code

`apps-script/ical.js.gs` is [ical.js](https://github.com/kewisch/ical.js) v2.0.1, an iCalendar parser by Philipp Kewisch and contributors. The copy here comes from the [GAS-ICS-Sync](https://github.com/derekantrican/GAS-ICS-Sync) project, which made three small changes so it parses imperfect feeds instead of stopping. It keeps its own license, the [Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/), and its license header. The MIT license does not apply to it.
