/**
 * CALENDAR SYNC: SETTINGS, AND THE FUNCTIONS YOU RUN
 *
 * Everything you set for this account is in this file: replace each <...>
 * with your value. Below those come the advanced settings, usually left as
 * they are, and at the bottom the functions you run: open this file, pick
 * one in the Run menu at the top, and click Run. calendar-sync.gs holds no
 * settings, so a new version of it replaces it whole.
 *
 * STEP BY STEP (the setup guide has the same steps, with more detail)
 *   setup is a wizard. Run it after each step: it checks everything, does what
 *   it can by itself, and prints NEXT: with the one thing to do next.
 *
 *   1. Create the project. In the Google account whose calendar should show
 *      everything, go to script.google.com, New project. Add script files
 *      (+ next to Files, Script) named config, calendar-sync and cleanup, and
 *      paste in config.gs, calendar-sync.gs and cleanup.gs (the editor adds
 *      the .gs). If you sync iCal links, add one named ical.js too and paste
 *      in ical.js.gs.
 *   2. Turn on the Calendar API. Project Settings (gear icon in the left
 *      sidebar), tick "Show "appsscript.json" manifest file in editor". Back
 *      in Editor, open appsscript.json (it is already there; do not add a new
 *      file) and replace everything in it with appsscript.json. Change
 *      "timeZone" to yours. Save.
 *   3. Fill in this file:
 *        OWN            your label and your Google email address;
 *        ICAL_IMPORT    one line per iCal link (or enabled: false if none);
 *        MIRROR_SHARES  only if other Google accounts take part (else {}).
 *      Leave <OWN_MIRROR_ID> and <ICAL_IMPORT_ID> as they are: setup creates
 *      those calendars and remembers them.
 *   4. Run setup (Run menu at the top, with this file open), and allow the
 *      permissions Google asks for (tick Select all). The first time, Google
 *      warns the app is unverified: Advanced, Go to (project name).
 *   5. Follow each NEXT: until setup says "Setup complete". From then on it
 *      runs every 15 minutes by itself.
 *   With other Google accounts: do steps 1 to 5 in each. Each shares its
 *   mirror with the others, which get an invitation email: open it in that
 *   account and click "Add this calendar", then run setup there again.
 *
 * WHAT IT DOES ON EVERY RUN
 *   0. Import   Only with ICAL_IMPORT on: copies the feeds' events onto the
 *               import calendar. A feed that cannot be read this run changes
 *               nothing, and the sync below still runs.
 *   1. Mirror   Only with other Google accounts (MIRROR_SHARES): copies this
 *               account's own events from its main calendar to its mirror.
 *               The mirror never holds synced events, so it can be shared at
 *               any level, "See only free/busy" included.
 *   2. Sync     Reads every mirror and import calendar shared with this
 *               account, plus EXTRA_SOURCES, and writes their events onto the
 *               main calendar, with whatever each source shares: titles,
 *               places and notes at "See event details"; busyTitle at "See
 *               only free/busy" or for an event marked private. Changes and
 *               deletions follow.
 *   The same meeting on several sources lands once, and not at all if the main
 *   calendar already holds it.
 *
 * HOW SOURCES ARE FOUND
 *   setup tags each mirror and the import calendar with a line in the
 *   calendar's description. Every run, the sync reads each tagged calendar
 *   in this account's list, so a new account's mirror is picked up as soon as
 *   it is added here. setup expects one from each account in MIRROR_SHARES
 *   and says which are missing. Other calendars in this account's list are
 *   skipped and never synced: coworkers' calendars, public calendars you
 *   follow, and any untagged calendar shared with details. setup names them.
 *   Never add another account's MAIN calendar to EXTRA_SOURCES: it holds
 *   synced events, which would be copied back. setup refuses one that looks
 *   like it.
 *
 * EDITING AND DELETING
 *   Edit or delete the original; its copies follow on the next runs. A synced
 *   event you delete by hand stays deleted; one you edit keeps your edit until
 *   the original changes. Do not edit the mirror by hand. On the import
 *   calendar the same holds, with the feed as the original.
 *
 * FREE/BUSY SOURCES
 *   They give busy periods, not events: back-to-back events arrive as one, and
 *   the same meeting is recognised by identical start and end times.
 *
 * COLORS (colorId and the name Calendar shows)
 *   1 Lavender  2 Sage  3 Grape  4 Flamingo  5 Banana  6 Tangerine
 *   7 Peacock   8 Graphite  9 Blueberry  10 Basil  11 Tomato
 */
/**
 * This account.
 *   label       A short name for this account, one word, such as "work". It is
 *               shown on this account's events in other accounts' calendars
 *               ("Synced from: work").
 *   main        The calendar that should show everything. For your main
 *               Google calendar, your Google email address.
 *   mirror      Leave as is. Used only with other Google accounts: setup
 *               creates a mirror calendar and remembers it.
 *   mirrorName  Name for that mirror. {label} becomes the label above.
 */
const OWN = {
    label: "<OWN_MIRROR_LABEL>",
    main: "<OWN_MIRROR_EMAIL>",
    mirror: "<OWN_MIRROR_ID>",
    mirrorName: "{label} mirror",
};
/**
 * The iCal links to copy onto your calendar: one line per link, as many as
 * you like. Set enabled to false if you have none.
 *   feeds       url: the link, starting with https:// or webcal:// (often
 *               ending in .ics); label: a short name for it, shown in the
 *               description of its events ("Synced from: Yoga studio"), no
 *               [ or ]. Treat the links as passwords. Use only calendars of
 *               your own events, never one that shows this Google calendar.
 *   calendarId  Leave as is: setup creates the calendar the links are copied
 *               into, and remembers it.
 *   shares      Other Google accounts that should see these events too, and
 *               how much, as in MIRROR_SHARES. Usually {}.
 *   calendarName, label, fallbackTitle, hiddenTitles, daysBack, daysAhead,
 *   maxIterations: usually left as they are. calendarName names the calendar
 *               setup creates; label is used where a link's own label is not
 *               available; fallbackTitle is the title, on that calendar, of
 *               events whose link hides it (must differ from busyTitle);
 *               hiddenTitles are titles that only mean "busy" (a link that
 *               hides details often writes "Busy"): events with them, or
 *               with no title, are copied onto your calendar as busyTitle,
 *               "Busy (synced event)"; daysBack and
 *               daysAhead set the dates copied; maxIterations limits how far
 *               a repeating event is followed.
 */
const ICAL_IMPORT = {
    enabled: true,
    calendarId: "<ICAL_IMPORT_ID>",
    feeds: [
        { url: "<ICAL_URL>", label: "<FEED_LABEL>" },
        // { url: "<ICAL_URL>", label: "<FEED_LABEL>" },
    ],
    shares: {},
    calendarName: "iCal import",
    label: "ical",
    fallbackTitle: "Busy (iCal)",
    hiddenTitles: ["Busy", "Occupied", "Unavailable", "Not available", "Blocked"],
    daysBack: 1,
    daysAhead: 120,
    maxIterations: 2000,
};
/**
 * Only if other Google accounts take part, each running its own copy of this
 * project: their email addresses, and how much of this account's calendar
 * each may see. Leave {} if this is the only Google account.
 *   "free/busy"  busy times only; they see busyTitle
 *   "details"    titles, places and notes, except events marked private
 * For example: { "someone@example.com": "free/busy" }
 * setup shares this account's mirror with each, and never removes access.
 */
const MIRROR_SHARES = {};
/**
 * Colors of the copied events, by label (OWN.label of each account, a link's
 * label, or "ical" for all links): colorId "1" to "11", listed above. With
 * colorCalendars on (SETTINGS below), the calendars in the sidebar too.
 */
const SOURCE_COLORS = {
    ical: "7",
};
/**
 * Optional. Other Google calendars to copy onto yours that this account can
 * already see, such as a calendar someone shared with you: its Calendar ID
 * (Google Calendar, Settings and sharing, that calendar, Integrate calendar)
 * and a label. Never another account's main calendar that runs this sync.
 *   { id: "<CALENDAR_ID>", label: "<ONE_WORD>" }
 */
const EXTRA_SOURCES = [];
/* ------------------------------------------------------------------------- *
 * Advanced settings. Usually left as they are.
 * ------------------------------------------------------------------------- */
/** How the sync behaves. */
const SETTINGS = {
    // Windows counted from the start of today. Keep mirrorDaysAhead at least as
    // long as blockDaysAhead in every account that reads this mirror.
    blockDaysBack: 0,
    blockDaysAhead: 60,
    mirrorDaysBack: 1,
    mirrorDaysAhead: 120,
    // Title of a synced event when its source hides the original title.
    busyTitle: "Busy (synced event)",
    // Title of every synced event. {title} becomes the original title (or
    // busyTitle); {calendar}, if used, the source's label. "{title}" keeps the
    // title as is; "{title} [{calendar}]" adds the source, as in
    // "Busy (synced event) [work]". The source is always in the description
    // (busyDescription) and the color (SOURCE_COLORS).
    titleFormat: "{title}",
    // Last line of every synced event's description. {calendar} becomes the
    // source's label. Set to "" for no line.
    busyDescription: "Synced from: {calendar}",
    // Only events overlapping these days and hours are synced onto the main
    // calendar, for example { weekdaysOnly: true, startHour: 8, endHour: 19 }.
    // null syncs every hour of every day.
    blockHours: null,
    // All-day events marked busy. Most all-day events are free and never sync.
    includeAllDayEvents: false,
    // Visibility of synced events on the main calendar: "default", "public",
    // "private" or "confidential". "private" hides them from coworkers who can
    // see your calendar's details; admins can still see them.
    blockVisibility: "default",
    // Events on the main calendar with these titles are not treated as your
    // own, such as busy blocks left by an earlier setup.
    ignoreTitles: ["Busy (synced event)"],
    // Also color the calendars in this account's sidebar from SOURCE_COLORS
    // (only this account's view; nobody else's). Set false to keep your own.
    colorCalendars: true,
    // Time zone for blockHours. null uses the project's.
    timeZone: null,
    // How often the sync runs: 1, 5, 10, 15 or 30 minutes.
    syncEveryMinutes: 15,
    // Google throttles bursts of writes. A run that hits maxWritesPerRun stops
    // cleanly and the next run continues.
    maxWritesPerRun: 200,
    pacingMs: 300,
    maxRetries: 4,
    backoffMs: 2000,
    // Apps Script stops a run at 6 minutes.
    maxRuntimeMs: 4.5 * 60 * 1000,
};
/* ------------------------------------------------------------------------- *
 * Functions you run. Open this file, pick one in the Run menu, click Run.
 * ------------------------------------------------------------------------- */
/** The setup wizard: run it after each step above, until it says the setup is complete. */
function setup() {
    return setup_();
}
/** What a run would write, writing nothing. */
function previewSync() {
    return previewSync_();
}
/** One run now. The trigger setup installs runs this every few minutes; keep its name. */
function runSync() {
    return runSync_();
}
/** Pause syncing (removes the trigger). Run setup to resume. */
function removeTriggers() {
    return pauseSync_();
}
/** Email the sharing invitations again, for an account that never got one or removed the calendar. */
function resendInvites() {
    resendInvites_();
}
/** Let synced events you deleted by hand come back on the next run. */
function forgetHandDeletions() {
    forgetHandDeletions_();
}
/** Delete every event this copy wrote (main calendar, mirror, import calendar). Run removeTriggers first. */
function deleteEverything() {
    deleteEverything_();
}
/* The next four need cleanup.gs in this project. They work even when the values above are not filled in. */
/** What resetEverything would do, changing nothing. */
function previewReset() {
    return reset_(true, false);
}
/**
 * Back to zero in this account: removes the trigger, deletes synced events and "Busy (synced event)" leftovers,
 * deletes this account's mirror and import calendar, unsubscribes from the other accounts' mirrors, and forgets
 * everything. Run it in each account; then put <OWN_MIRROR_ID> and <ICAL_IMPORT_ID> back (or empty them) and run setup.
 */
function resetEverything() {
    return reset_(false, false);
}
/** Only the synced events on the main calendar (everything the sync wrote there, and busy-titled leftovers): lists them. */
function previewBusyBlocks() {
    return reset_(true, true);
}
/** Only the synced events on the main calendar (everything the sync wrote there, and busy-titled leftovers): deletes them. */
function deleteBusyBlocks() {
    return reset_(false, true);
}
