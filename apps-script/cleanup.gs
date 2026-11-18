/**
 * CLEANUP: reset this account's calendar sync back to nothing.
 *
 * Run it from config.gs: previewReset, resetEverything, previewBusyBlocks,
 * deleteBusyBlocks. It needs nothing from config.gs or calendar-sync.gs (it
 * reads OWN.main, EXTRA_SOURCES and the title settings in SETTINGS when they
 * are there), and works whether or
 * not the Calendar API is turned on, falling back to the built-in CalendarApp.
 *
 * resetEverything, in this account only:
 *   1. removes this project's triggers, so nothing runs again;
 *   2. deletes every synced event on the main calendar: everything the sync
 *      stamped, whatever its title, and unstamped leftovers titled like a busy
 *      block: busyTitle (or "Busy (synced event)") or an ignoreTitles entry,
 *      alone or in titleFormat with any [label];
 *   3. removes from this account's calendar list every calendar the sync uses
 *      but another account owns: their mirrors, the import calendar, and
 *      EXTRA_SOURCES (unsubscribing; their owners' calendars are untouched);
 *   4. deletes the calendars this account's sync created: its mirror and, if
 *      it imports iCal URLs, the import calendar. Their events and sharing go
 *      with them;
 *   5. clears what the script remembers (hand deletions, created ids).
 * It leaves alone: your own events, calendars you added "From URL", public
 * and coworkers' calendars, and calendar colors.
 */

/**
 * @param {boolean} dryRun
 * @param {boolean} blocksOnly  only step 2: synced events on the main calendar, nothing else
 * @returns {number}
 */
function reset_(dryRun, blocksOnly) {
  /** @type {Record<string, unknown>} SETTINGS from config.gs, if it loads; the titles below follow it. */
  const settings = typeof SETTINGS !== "undefined" && SETTINGS ? SETTINGS : {};
  /** @type {string[]} Titles a busy block can have: the default, busyTitle, and ignoreTitles. */
  const busyTitles = ["Busy (synced event)"]
    .concat(typeof settings.busyTitle === "string" && settings.busyTitle ? [settings.busyTitle] : [])
    .concat(Array.isArray(settings.ignoreTitles) ? settings.ignoreTitles.filter((t) => typeof t === "string" && t) : []);
  /** @type {string[]} Title formats: the default, and titleFormat. */
  const formats = ["{title} [{calendar}]"].concat(typeof settings.titleFormat === "string" && settings.titleFormat ? [settings.titleFormat] : []);
  /** @param {string} t @returns {string} */
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** @type {RegExp[]} A busy title alone, or inside a title format with any source label. */
  const busyPatterns = busyTitles.map((t) => new RegExp(`^${esc(t)}$`)).concat(
    ...formats.filter((f) => f.indexOf("{title}") !== -1).map((f) =>
      busyTitles.map((t) => new RegExp(`^${f.split("{calendar}").map((part) => part.split("{title}").map(esc).join(esc(t))).join("[^\\]]+")}$`))
    )
  );
  /** @type {number} */
  const YEARS_BACK = 5;
  /** @type {number} */
  const YEARS_AHEAD = 3;
  /** @type {number} Apps Script stops a run at 6 minutes. */
  const STOP_AFTER_MS = 5 * 60 * 1000;
  /** @type {RegExp} The tag setup writes in each mirror's and import calendar's description. */
  const TAG = /\[calsync (mirror|import)=([^\s\]]+) owner=([^\s\]]+)\]/;

  const started = Date.now();
  /** @type {boolean} */
  const api = typeof Calendar !== "undefined" && !!Calendar && !!Calendar.Events;
  /** @type {string} */
  const main = typeof OWN !== "undefined" && OWN && OWN.main && !/<[A-Z0-9_]+>/.test(OWN.main) ? OWN.main : "primary";
  /** @type {string} */
  const verb = dryRun ? "Would" : "Did";
  /** @type {number} */
  let changes = 0;

  /** @param {string} title @returns {boolean} */
  const busyTitled = (title) => busyPatterns.some((re) => re.test(title));
  /** @param {unknown} err @returns {boolean} */
  const gone = (err) => /410|404|not found|deleted/i.test(String(err));
  /** @param {unknown} err @returns {boolean} */
  const retryable = (err) => /too many|rate ?limit|429|500|503|backend error|internal error/i.test(String(err));
  /** @returns {boolean} */
  const outOfTime = () => Date.now() - started > STOP_AFTER_MS;

  /**
   * One change, with retries; logs failures and carries on.
   * @param {string} what
   * @param {() => void} op
   * @returns {boolean} false when out of time
   */
  const change = (what, op) => {
    if (outOfTime()) return false;
    changes++;
    if (dryRun) return true;
    for (let attempt = 0; ; attempt++) {
      try {
        op();
        Utilities.sleep(200);
        return true;
      } catch (err) {
        if (gone(err)) return true;
        if (retryable(err) && attempt < 4) {
          Utilities.sleep(2000 * Math.pow(2, attempt));
          continue;
        }
        console.warn(`Could not ${what}: ${err}`);
        return true;
      }
    }
  };
  /** @returns {number} */
  const stoppedEarly = () => {
    console.warn(`Out of time after ${changes} change(s). NEXT: Run ${blocksOnly ? "deleteBusyBlocks" : "resetEverything"} again to finish.`);
    return changes;
  };

  /* 1. Triggers. */
  if (!blocksOnly) {
    const triggers = ScriptApp.getProjectTriggers();
    console.log(`${verb} remove ${triggers.length} trigger(s) of this project.`);
    for (const t of triggers) if (!change("remove a trigger", () => ScriptApp.deleteTrigger(t))) return stoppedEarly();
  }

  /* 2. Synced events on the main calendar. */
  const from = new Date(new Date().getFullYear() - YEARS_BACK, 0, 1);
  const to = new Date(new Date().getFullYear() + YEARS_AHEAD, 11, 31);
  /** @type {{ title: string, when: string, remove: () => void }[]} */
  const events = [];
  if (api) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @param {Record<string, unknown>} extra @param {(ev: GoogleAppsScript.Calendar.Schema.Event) => boolean} keep */
    const collect = (extra, keep) => {
      /** @type {string | undefined} */
      let pageToken;
      do {
        const params = Object.assign(
          { singleEvents: true, showDeleted: false, maxResults: 2500, fields: "nextPageToken,items(id,summary,start,extendedProperties)", pageToken: pageToken },
          extra
        );
        const page = Calendar.Events.list(main, params);
        for (const ev of page.items || []) {
          const id = String(ev.id);
          if (seen.has(id) || !keep(ev)) continue;
          seen.add(id);
          events.push({
            title: ev.summary || "",
            when: String((ev.start && (ev.start.dateTime || ev.start.date)) || "?"),
            remove: () => Calendar.Events.remove(main, id, { sendUpdates: "none" }),
          });
        }
        pageToken = page.nextPageToken || undefined;
      } while (pageToken);
    };
    // Then unstamped leftovers with a busy block's title, in the date range.
    // Everything the sync wrote on the main calendar (busy or titled, any title format), at any date.
    collect({ privateExtendedProperty: [blocksOnly ? "calsync_kind=block" : "calsync=1"] }, () => true);
    collect({ timeMin: from.toISOString(), timeMax: to.toISOString() }, (ev) => busyTitled(ev.summary || ""));
  } else {
    const cal = main === "primary" ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(main);
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
      for (const ev of cal.getEvents(new Date(y, 0, 1), new Date(y + 1, 0, 1))) {
        if (ev.getStartTime().getFullYear() !== y) continue; // spans New Year: counted in its start year
        const stamped = blocksOnly ? ev.getTag("calsync_kind") === "block" : ev.getTag("calsync") === "1";
        if (!stamped && !busyTitled(ev.getTitle() || "")) continue;
        events.push({ title: ev.getTitle(), when: ev.getStartTime().toISOString(), remove: () => ev.deleteEvent() });
      }
    }
  }
  console.log(`${verb} delete ${events.length} synced event(s) on the main calendar (${main}).`);
  events.slice(0, 10).forEach((e) => console.log(`  ${e.when}  ${e.title}`));
  if (events.length > 10) console.log(`  ...and ${events.length - 10} more`);
  for (const e of events) if (!change(`delete "${e.title}" at ${e.when}`, e.remove)) return stoppedEarly();

  if (!blocksOnly) {
    /* 3 and 4. Calendars: unsubscribe from others', delete this account's own. */
    /** @type {{ id: string, name: string, owned: boolean, primary: boolean, description: string }[]} */
    const list = [];
    if (api) {
      /** @type {string | undefined} */
      let pageToken;
      do {
        const page = Calendar.CalendarList.list({ showHidden: true, maxResults: 250, pageToken: pageToken });
        for (const c of page.items || []) {
          list.push({ id: String(c.id), name: c.summary || String(c.id), owned: c.accessRole === "owner", primary: !!c.primary, description: c.description || "" });
        }
        pageToken = page.nextPageToken || undefined;
      } while (pageToken);
    } else {
      const defaultId = CalendarApp.getDefaultCalendar().getId();
      for (const c of CalendarApp.getAllCalendars()) {
        list.push({ id: c.getId(), name: c.getName(), owned: c.isOwnedByMe(), primary: c.getId() === defaultId, description: c.getDescription() || "" });
      }
    }
    const store = PropertiesService.getScriptProperties();
    /** @type {Set<string>} ids this project created, as setup remembers them */
    const created = new Set(["mirrorId", "importId", "targetId"].map((k) => store.getProperty(k)).filter((v) => !!v).map((v) => String(v).toLowerCase()));
    /** @type {Set<string>} */
    const extra = new Set(
      (typeof EXTRA_SOURCES !== "undefined" && Array.isArray(EXTRA_SOURCES) ? EXTRA_SOURCES : []).map((x) => String(x.id).toLowerCase())
    );
    const mainId = main.toLowerCase();

    for (const c of list) {
      const id = c.id.toLowerCase();
      if (c.primary || id === mainId) continue;
      const ours = TAG.test(c.description) || created.has(id) || extra.has(id);
      if (!ours) continue;
      if (c.owned && (TAG.test(c.description) || created.has(id))) {
        console.log(`${verb} delete the calendar "${c.name}" (this account's; its events and sharing go with it).`);
        const ok = change(`delete "${c.name}"`, () =>
          api ? Calendar.Calendars.remove(c.id) : CalendarApp.getCalendarById(c.id).deleteCalendar()
        );
        if (!ok) return stoppedEarly();
      } else if (!c.owned) {
        console.log(`${verb} remove "${c.name}" from this account's calendar list (another account's; it is not deleted).`);
        const ok = change(`unsubscribe from "${c.name}"`, () =>
          api ? Calendar.CalendarList.remove(c.id) : CalendarApp.getCalendarById(c.id).unsubscribeFromCalendar()
        );
        if (!ok) return stoppedEarly();
      }
    }

    /* 5. What the script remembers. */
    const keys = Object.keys(store.getProperties());
    console.log(`${verb} clear ${keys.length} remembered value(s) (hand deletions, created calendar ids).`);
    if (keys.length && !change("clear the remembered values", () => store.deleteAllProperties())) return stoppedEarly();
  } else {
    /* Busy blocks only: forget which synced events were deleted by hand, or the sync would treat these
       deletions as yours and never write the events again. */
    const store = PropertiesService.getScriptProperties();
    const ledger = Object.keys(store.getProperties()).filter((k) => k.indexOf("ledger:") === 0);
    if (ledger.length) {
      console.log(`${verb} forget the record of hand deletions, so the next sync writes the current events again.`);
      for (const k of ledger) if (!change("forget hand deletions", () => store.deleteProperty(k))) return stoppedEarly();
    }
  }

  if (dryRun) {
    console.log(changes ? `NEXT: This was a preview. Run ${blocksOnly ? "deleteBusyBlocks" : "resetEverything"} to do it.` : "Nothing to do.");
  } else if (blocksOnly) {
    console.log(`Done: ${changes} change(s). NEXT: Run runSync (or wait for the next automatic run) to write the current synced events again; run removeTriggers first if you want them gone for good.`);
  } else {
    console.log(
      `Done: ${changes} change(s). NEXT: If other Google accounts take part, run resetEverything in each of their projects too. To start again: ` +
        "run setup (if you wrote calendar ids into config.gs, put <OWN_MIRROR_ID> and <ICAL_IMPORT_ID> back first). Your own events, calendars added " +
        "From URL, and calendar colors were left as they are."
    );
  }
  return changes;
}
