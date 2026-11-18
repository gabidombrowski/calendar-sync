/**
 * CALENDAR SYNC: ENGINE
 *
 * WHAT IT DOES ON EVERY RUN
 *   0. Import   Only with ICAL_IMPORT on: copies the feeds' events onto the
 *               import calendar. A feed that cannot be read this run changes
 *               nothing, and the sync below still runs.
 *   1. Mirror   Copies this account's own events from its main calendar to its
 *               mirror. The mirror never holds synced events, so it can be
 *               shared at any level, "See only free/busy" included.
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
 *   shared with this account, so a new account's mirror is picked up as soon
 *   as it is added here. setup expects one from each account in MIRROR_SHARES
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
 * No settings here; they are all in config.gs. The stamps
 * below identify events this sync wrote; changing them would make it lose
 * track of those events. `origin` must match the feed import's.
 */
/** Printed at the start of every run, so a log shows which version ran. */
const VERSION = "1.0.0";
const PROP = {
    marker: "calsync",
    kind: "calsync_kind",
    key: "calsync_key",
    src: "calsync_src",
    hash: "calsync_hash",
    origin: "calsync_origin",
};
/* ------------------------------------------------------------------------- *
 * An older config.gs keeps working: settings added since it was made take
 * their defaults, and setup says which ones.
 * ------------------------------------------------------------------------- */
const SETTING_DEFAULTS = {
    blockDaysBack: 0,
    blockDaysAhead: 60,
    mirrorDaysBack: 1,
    mirrorDaysAhead: 120,
    busyTitle: "Busy (synced event)",
    titleFormat: "{title}",
    busyDescription: "Synced from: {calendar}",
    blockHours: { weekdaysOnly: true, startHour: 8, endHour: 19 },
    includeAllDayEvents: false,
    blockVisibility: "default",
    ignoreTitles: ["Busy (synced event)"],
    colorCalendars: true,
    timeZone: null,
    syncEveryMinutes: 15,
    maxWritesPerRun: 200,
    pacingMs: 300,
    maxRetries: 4,
    backoffMs: 2000,
    maxRuntimeMs: 4.5 * 60 * 1000,
};
const IMPORT_DEFAULTS = {
    enabled: false,
    calendarId: "",
    calendarName: "iCal import",
    label: "ical",
    feeds: [],
    shares: {},
    fallbackTitle: "Busy (iCal)",
    hiddenTitles: ["Busy", "Occupied", "Unavailable", "Not available", "Blocked"],
    daysBack: 1,
    daysAhead: 120,
    maxIterations: 2000,
};
/**
 * Fill in settings missing from config.gs, and turn config.gs's placeholders for ids setup has not created yet
 * (<OWN_MIRROR_ID>, <ICAL_IMPORT_ID>) into empty values. Returns the names of missing settings.
 */
function fillDefaults_() {
    // An id left as a placeholder means: the one setup created and remembers (none yet: empty).
    if (isPlaceholder_(OWN.mirror))
        OWN.mirror = rememberedId_("mirrorId");
    if (OWN.label && !isPlaceholder_(OWN.label)) {
        const name = (OWN.mirrorName || "").split("<OWN_MIRROR_LABEL>").join("{label}");
        OWN.mirrorName = (name || "{label} mirror").split("{label}").join(OWN.label);
    }
    const missing = [];
    const settings = SETTINGS;
    const defaults = SETTING_DEFAULTS;
    for (const key of Object.keys(defaults)) {
        if (settings[key] === undefined) {
            settings[key] = defaults[key];
            missing.push(`SETTINGS.${key}`);
        }
    }
    if (typeof ICAL_IMPORT === "undefined")
        missing.push("ICAL_IMPORT (off)");
    if (typeof EXTRA_SOURCES === "undefined")
        missing.push("EXTRA_SOURCES (empty)");
    if (typeof SOURCE_COLORS === "undefined")
        missing.push("SOURCE_COLORS (no colors)");
    return missing;
}
/** The id of a calendar setup created, as it remembers it in Script Properties, or "". */
function rememberedId_(propKey) {
    try {
        return PropertiesService.getScriptProperties().getProperty(propKey) || "";
    }
    catch (err) {
        return "";
    }
}
/** The id an owned calendar resolves to: as written in config.gs, else the one setup remembers. */
function resolvedOwnedId_(c) {
    return isPlaceholder_(c.raw) ? rememberedId_(c.propKey) : c.raw;
}
/** A mirror only when MIRROR_SHARES lists other Google accounts. With none (iCal feeds only), there is nothing to mirror to. */
function mirrorOn_() {
    return Object.keys(MIRROR_SHARES).length > 0;
}
/** ICAL_IMPORT from config.gs, with defaults for anything it lacks; off if it has none. A placeholder calendarId means the one setup created and remembers. */
function imp_() {
    const out = Object.assign({}, IMPORT_DEFAULTS);
    const given = (typeof ICAL_IMPORT === "undefined" ? {} : ICAL_IMPORT);
    for (const key of Object.keys(given))
        if (given[key] !== undefined)
            out[key] = given[key];
    const c = out;
    if (isPlaceholder_(c.calendarId))
        c.calendarId = rememberedId_("importId");
    return c;
}
function extra_() {
    return typeof EXTRA_SOURCES === "undefined" ? [] : EXTRA_SOURCES;
}
function colors_() {
    return typeof SOURCE_COLORS === "undefined" ? {} : SOURCE_COLORS;
}
/* ------------------------------------------------------------------------- *
 * Functions you run by hand
 * ------------------------------------------------------------------------- */
/**
 * The setup wizard. Run it after every step in config.gs: it checks
 * everything in order, does what it can, and stops with NEXT: when you need to
 * do something. Once setup is complete, running it again re-checks everything.
 */
function setup_() {
    console.log(`calendar-sync ${VERSION}`);
    const rawMirror = OWN.mirror;
    const missing = fillDefaults_();
    if (missing.length) {
        console.warn(`config.gs is from an older version and lacks ${missing.join(", ")}. Using the defaults. To change them, ` +
            "copy those parts from the new config.gs into yours (keep your ids).");
    }
    if (typeof Calendar === "undefined" || !Calendar) {
        return stop_('Turn on the Calendar API with the manifest. Project Settings (gear icon), tick "Show "appsscript.json" ' +
            'manifest file in editor". Back in Editor, open appsscript.json (do not add a new file) and replace its ' +
            "contents with the appsscript.json provided. Save, then run setup again.");
    }
    // Google lets you untick permissions when authorizing. If any is missing, this shows the prompt again.
    requireScopes_(imp_().enabled);
    // This account.
    if (isPlaceholder_(OWN.label) || isPlaceholder_(OWN.main)) {
        return stop_("In config.gs, fill in OWN.label and OWN.main (this account's email address). Then run setup again.");
    }
    const mainRole = roleOrNull_(OWN.main);
    if (!mainRole || !hasWriteAccess_(mainRole)) {
        return stop_(`OWN.main ("${OWN.main}") must be a calendar this account owns. For your primary calendar, use this ` +
            `account's email address (${me_()}). Then run setup again.`);
    }
    // Who the mirror is shared with.
    const unfilled = Object.keys(MIRROR_SHARES).filter((e) => isPlaceholder_(e));
    if (unfilled.length) {
        return stop_(`In config.gs, replace ${unfilled.join(", ")} in MIRROR_SHARES with the other accounts' email addresses. ` +
            "Then run setup again.");
    }
    // The iCal import, if on: its own checks before any calendar is created.
    if (imp_().enabled) {
        const problem = importPrechecks_();
        if (problem)
            return stop_(problem);
    }
    // The calendars this account owns: created the first time and remembered, so there is nothing to paste;
    // an id written in config.gs is used instead. Their sharing is kept as configured.
    const owned = [];
    if (mirrorOn_()) {
        owned.push({ field: "OWN.mirror", raw: rawMirror, propKey: "mirrorId", name: OWN.mirrorName, kind: "mirror", label: OWN.label, shares: MIRROR_SHARES });
    }
    if (imp_().enabled) {
        owned.push({
            field: "ICAL_IMPORT.calendarId", raw: typeof ICAL_IMPORT === "undefined" ? "" : ICAL_IMPORT.calendarId, propKey: "importId",
            name: imp_().calendarName, kind: "import", label: imp_().label, shares: imp_().shares,
        });
    }
    for (const c of owned) {
        let id;
        if (isPlaceholder_(c.raw)) {
            const made = createCalendarOnce_(c.propKey, c.name);
            id = made.id;
            console.log(made.created
                ? `Created the calendar "${c.name}". The script remembers it: nothing to paste.`
                : `Using "${c.name}", created earlier.`);
            if (c.kind === "mirror")
                OWN.mirror = id;
        }
        else {
            id = c.raw;
            const role = roleOrNull_(id);
            if (!role || !hasWriteAccess_(role)) {
                return stop_(`${c.field} ("${id}") is not a calendar this account owns. Put <${c.kind === "mirror" ? "OWN_MIRROR_ID" : "ICAL_IMPORT_ID"}> ` +
                    `back in ${c.field} in config.gs (setup then creates one), or the right id. Then run setup again.`);
            }
            // An id pasted in the wrong place: the calendar already serves as the other kind.
            const tag = parseSourceTag_(withRetry_(() => api_().Calendars.get(id)).description);
            const other = owned.find((o) => o !== c && o.kind !== c.kind && id.toLowerCase() === resolvedOwnedId_(o).toLowerCase());
            if ((tag && tag.kind !== c.kind) || other) {
                const placeholder = c.kind === "mirror" ? "<OWN_MIRROR_ID>" : "<ICAL_IMPORT_ID>";
                return stop_(`${c.field} holds the id of the ${c.kind === "mirror" ? "import calendar" : "mirror"} ("${id}"), not the ` +
                    `${c.kind === "mirror" ? "mirror" : "import calendar"}. In config.gs, set ${c.field} back to "${placeholder}" ` +
                    "(setup finds or creates the right one by itself), then run setup again.");
            }
        }
        ensureSourceTag_(id, c.kind, c.label);
        console.log(`${c.field}: ${id}`);
        const shareProblems = applyShares_(id, c.name, c.shares);
        if (shareProblems.length) {
            console.warn(`"${c.name}" is not shared as configured yet. This account still works; the other accounts see less.`);
            reportProblems_(shareProblems);
        }
    }
    // Sources: every tagged calendar shared with this account, plus EXTRA_SOURCES.
    try {
        validateConfig_();
    }
    catch (err) {
        return stop_(`Fix config.gs: ${errorText_(err)} Then run setup again.`);
    }
    const found = resolveSources_();
    const shareEmails = new Set(Object.keys(MIRROR_SHARES).map((e) => e.toLowerCase()));
    for (const t of found.tagged) {
        console.log(`Found ${t.kind === "mirror" ? "mirror" : "import calendar"} "${t.name}" (label ${t.label}, owner ${t.owner}).`);
    }
    const others = found.people.filter((c) => !/\.v\.calendar\.google\.com$/i.test(c.id || ""));
    if (others.length) {
        console.log(`Not synced, since they are not a mirror or the import calendar: ${others.map((c) => `"${c.summary || c.id}"`).join(", ")}. ` +
            "These are other people's calendars or calendars you follow. To count one as your busy time anyway, add it to " +
            'EXTRA_SOURCES as { id: "<its id>", label: "<one word>" }.');
    }
    for (const c of found.subscriptions) {
        console.log(`"${c.summary || c.id}" was added in this account from a URL, so the sync skips it. To sync it anyway, add it ` +
            `to EXTRA_SOURCES as { id: "${c.id}", label: "<one word>" }. If the iCal import already brings in the same ` +
            "calendar, leave it out, or remove it from this account: Settings and sharing, that calendar, Remove calendar.");
    }
    // Each account in MIRROR_SHARES should share its mirror back, found by tag or listed in EXTRA_SOURCES.
    const fromOwners = new Set(found.tagged.filter((t) => t.kind === "mirror").map((t) => t.owner)
        .concat(extra_().map((x) => (x.owner || "").toLowerCase())));
    const missingOwners = Object.keys(MIRROR_SHARES).filter((email) => !fromOwners.has(email.toLowerCase()));
    if (missingOwners.length) {
        const strays = found.tagged.filter((t) => t.kind === "mirror" && !shareEmails.has(t.owner));
        const lines = missingOwners.map((email) => `Nothing shared from ${email} yet. In that account, run the calendar sync's setup, with ${me_()} in its ` +
            "MIRROR_SHARES: it creates the mirror and shares it with this account. Then, in this account, open the email " +
            `"${email} has shared a calendar with you" and click "Add this calendar".\n` +
            "    The email comes only the first time a calendar is shared. If it never came, was used already, or the " +
            "calendar was removed here since: run resendInvites in that account's project for a new email. Or skip the " +
            `email: copy the mirror id that account's setup prints, and add it to EXTRA_SOURCES here as { id: "<that id>", ` +
            `label: "<its OWN.label>", owner: "${email}" }; setup adds it to this account by itself.`);
        for (const t of strays) {
            lines.push(`A mirror owned by ${t.owner} is shared with this account, but ${t.owner} is not in MIRROR_SHARES. If ` +
                "that is the same account under another address, use this address in MIRROR_SHARES.");
        }
        if (found.unrecognised.length) {
            lines.push("These calendars are shared with this account but could not be identified. If one is another account's " +
                "mirror or the import calendar, add it to EXTRA_SOURCES in config.gs as\n" +
                '      { id: "<id below>", label: "<one word>", owner: "<email of the account that owns it>" }\n' +
                found.unrecognised.map((c) => `      "${c.summary || "(no name)"}"  id: ${c.id}`).join("\n"));
        }
        reportProblems_(lines);
        return stop_("Do the above, then run setup again. If an account will not take part, remove it from MIRROR_SHARES.");
    }
    const now = new Date();
    const week = { min: now, max: addDays_(now, 7) };
    for (const src of found.sources) {
        const role = roleOrNull_(src.id);
        if (!role || role === "none") {
            return stop_(`"${src.label}" is in EXTRA_SOURCES but not shared with this account. In the account that owns it: Google ` +
                `Calendar, Settings and sharing, that calendar, Share with specific people or groups, Add people, ${me_()}, ` +
                `"${SHARE_LABELS["free/busy"]}" or "${SHARE_LABELS.details}", Send. Then run setup again.`);
        }
        if (role === "freeBusyReader") {
            const busy = fill_(SETTINGS.titleFormat, SETTINGS.busyTitle, src.label);
            const note = SETTINGS.busyDescription ? `, with "${fill_(SETTINGS.busyDescription, "", src.label)}" in the description` : "";
            console.log(`${src.label}: shared at free/busy. Its events arrive here as "${busy}"${note}.`);
            continue;
        }
        const synced = listEvents_(src.id, week).filter((e) => { var _a, _b; return looksSynced_(e) || ((_b = (_a = e.extendedProperties) === null || _a === void 0 ? void 0 : _a.private) === null || _b === void 0 ? void 0 : _b[PROP.kind]) === "block"; }).length;
        if (synced > 0) {
            return stop_(`"${src.label}" holds synced events, so it is another account's main calendar. Remove it from ` +
                "EXTRA_SOURCES in config.gs and use that account's mirror instead. Then run setup again.");
        }
        console.log(`${src.label}: shared at details. Its events arrive here with their titles, places and notes.`);
    }
    if (!found.tagged.some((t) => t.kind === "import")) {
        console.log("No import calendar found. If you import iCal URLs, turn on ICAL_IMPORT in the account that should own the " +
            "import calendar (one account only), with this account's email in its shares; then open its invitation email " +
            'here and click "Add this calendar". The sync picks it up by itself.');
    }
    // Preview before the first write.
    const preview = run_(true);
    if (unreadSources_.length) {
        reportProblems_(unreadSources_);
        return stop_("Some sources could not be read, so setup stops before syncing. If it says a permission is missing, run " +
            "setup again and allow everything; otherwise run setup again in a few minutes, and if it repeats, send " +
            "this log to whoever maintains the script.");
    }
    if (onlyDeletes_(preview)) {
        return stop_("The first run would only delete events, which means a source is unreadable. Run setup again in a few minutes.");
    }
    const result = runLocked_(() => run_(false));
    if (!triggerInstalled_("runSync"))
        installTrigger_("runSync");
    console.log(result && result.stopped
        ? "Setup complete. The first sync stopped early; the trigger finishes it over the next runs."
        : "Setup complete.");
    const untick = (mirrorOn_() ? [OWN.mirrorName] : []).concat(imp_().enabled ? [imp_().calendarName] : []);
    const lines = [];
    const keptDeleted = result ? result.tallies.reduce((n, t) => n + t.keptDeleted, 0) : 0;
    if (keptDeleted > 0) {
        lines.push(`${keptDeleted} synced event(s) were deleted by hand, so they stay deleted. To bring them back, run ` +
            "forgetHandDeletions, then runSync.");
    }
    lines.push(untick.length
        ? `In Google Calendar, untick ${untick.map((n) => `"${n}"`).join(" and ")} in the left sidebar, or events show ` +
            `twice. From now on the sync runs every ${SETTINGS.syncEveryMinutes} minutes by itself.`
        : `From now on the sync runs every ${SETTINGS.syncEveryMinutes} minutes by itself.`);
    if (imp_().enabled && Object.keys(imp_().shares).length) {
        lines.push(`In each account in ICAL_IMPORT.shares, open the email "${me_()} has shared a calendar with you" and click ` +
            `"Add this calendar", then run setup there; its sync finds "${imp_().calendarName}" by itself.`);
    }
    if (mirrorOn_()) {
        lines.push(`Optional, to see this account's events in another calendar app: Google Calendar, Settings and sharing, ` +
            `"${OWN.mirrorName}", Integrate calendar, copy Secret address in iCal format, then add it in that app as a ` +
            "calendar from URL. Treat that address as a password.");
        lines.push(`This account's mirror id, for another account's EXTRA_SOURCES if its invitation does not work: ${OWN.mirror}`);
    }
    next_(lines.join("\n  "));
    return true;
}
function previewSync_() {
    const result = run_(true);
    next_(triggerInstalled_("runSync")
        ? `This was a preview; nothing was written. The sync runs every ${SETTINGS.syncEveryMinutes} minutes by itself.`
        : "This was a preview; nothing was written. Run setup to start syncing.");
    return result;
}
function runSync_() {
    const result = runLocked_(() => run_(false));
    if (!triggerInstalled_("runSync"))
        next_("Run setup to finish setting up and start the automatic sync.");
    return result;
}
function pauseSync_() {
    const removed = removeTriggers_(["runSync"]);
    next_("Syncing is paused. Run setup to resume, or deleteEverything to remove everything this sync wrote.");
    return removed;
}
/**
 * Sends the sharing invitation emails again: removes each share in MIRROR_SHARES (and ICAL_IMPORT.shares,
 * if on) and adds it back, which makes Google email it again. Use when an invitation never came or the
 * calendar was removed in the other account.
 */
function resendInvites_() {
    var _a;
    fillDefaults_();
    const targets = [];
    if (mirrorOn_() && OWN.mirror)
        targets.push([OWN.mirror, OWN.mirrorName, MIRROR_SHARES]);
    if (imp_().enabled && imp_().calendarId)
        targets.push([imp_().calendarId, imp_().calendarName, imp_().shares]);
    if (!targets.length) {
        next_("Nothing is shared yet. Run setup first.");
        return;
    }
    const problems = [];
    for (const [id, name, shares] of targets) {
        const rules = new Map();
        for (const rule of withRetry_(() => api_().Acl.list(id)).items || []) {
            if (((_a = rule.scope) === null || _a === void 0 ? void 0 : _a.type) === "user" && rule.scope.value && rule.id)
                rules.set(rule.scope.value.toLowerCase(), rule.id);
        }
        for (const email of Object.keys(shares)) {
            if (isPlaceholder_(email))
                continue;
            const ruleId = rules.get(email.toLowerCase());
            try {
                if (ruleId)
                    withRetry_(() => api_().Acl.remove(id, ruleId));
                withRetry_(() => api_().Acl.insert({ role: SHARE_ROLES[shares[email]], scope: { type: "user", value: email } }, id, { sendNotifications: true }));
                console.log(`"${name}": invitation sent again to ${email}.`);
            }
            catch (err) {
                if (err instanceof StopRun)
                    throw err;
                problems.push(`"${name}" to ${email}: ${errorText_(err)}`);
            }
        }
    }
    if (problems.length)
        reportProblems_(problems);
    next_('In each account invited, open the newest email "… has shared a calendar with you" and click "Add this ' +
        'calendar", then run setup there. If the email does not come, use the mirror id in that account\'s ' +
        "EXTRA_SOURCES instead; setup prints it.");
}
function forgetHandDeletions_() {
    clearLedgers_();
    next_("Run runSync, or wait for the next automatic run, to restore the synced events you had deleted.");
}
function deleteEverything_() {
    validateConfig_();
    const ctx = newContext_(false);
    try {
        const targets = [[`${OWN.label} main`, OWN.main, PROP]];
        if (OWN.mirror)
            targets.push([`${OWN.label} mirror`, OWN.mirror, PROP]);
        if (imp_().enabled && imp_().calendarId)
            targets.push([imp_().calendarName, imp_().calendarId, IMPORT_PROP]);
        for (const [label, id, props] of targets) {
            const ours = listEvents_(id, null, [`${props.marker}=1`]);
            for (const ev of ours)
                write_(ctx, () => removeEvent_(id, ev.id));
            console.log(`${label}: deleted ${ours.length}`);
        }
        clearLedgers_();
    }
    catch (err) {
        if (!(err instanceof StopRun))
            throw err;
        console.warn(`Stopped early (${err.message}).`);
        next_("Run deleteEverything again to finish.");
        return;
    }
    next_(triggerInstalled_("runSync")
        ? "Run removeTriggers too, or the next automatic run puts everything back."
        : "To remove the sync for good, run resetEverything: it also deletes the calendars it created. To start " +
            "again instead, run setup.");
}
/** Explain what needs doing and stop the wizard. */
function stop_(message) {
    next_(message);
    return false;
}
/** One run: the iCal import if on, then the sync, sharing one time and write budget. */
/** Sources that could not be read in the latest run, for setup to report. */
let unreadSources_ = [];
function run_(dryRun) {
    if (!dryRun)
        console.log(`calendar-sync ${VERSION}`);
    validateConfig_();
    unreadSources_ = [];
    return runSafely_(dryRun, (ctx, result, ledgers) => {
        if (imp_().enabled)
            importStep_(ctx, result, ledgers);
        syncStep_(ctx, result, ledgers);
    });
}
function syncStep_(ctx, result, ledgers) {
    const blockWin = dayWindow_(SETTINGS.blockDaysBack, SETTINGS.blockDaysAhead);
    const mirrorWin = dayWindow_(SETTINGS.mirrorDaysBack, SETTINGS.mirrorDaysAhead);
    const readWin = {
        min: new Date(Math.min(blockWin.min.getTime(), mirrorWin.min.getTime())),
        max: new Date(Math.max(blockWin.max.getTime(), mirrorWin.max.getTime())),
    };
    {
        const mirrored = mirrorOn_();
        const mirrorTally = newTally_(`${OWN.label} mirror`);
        const mainTally = newTally_(`${OWN.label} main`);
        if (mirrored)
            result.tallies.push(mirrorTally);
        result.tallies.push(mainTally);
        for (const [tally, id] of [[mainTally, OWN.main]].concat(mirrored ? [[mirrorTally, OWN.mirror]] : [])) {
            const role = accessRole_(id);
            if (!hasWriteAccess_(role)) {
                tally.skipped = `Access is "${role}"; this account must own it.`;
                return;
            }
        }
        // Your own events on the main calendar: everything this sync did not write.
        const mainEvents = listEvents_(OWN.main, padded_(readWin));
        const own = mainEvents.filter((e) => !isOurs_(e) && !looksSynced_(e));
        // 1. Mirror: the main calendar's own events, in full, and nothing else.
        const mirrorDesired = new Map();
        const mainKey = srcKey_(OWN.main);
        for (const ev of own) {
            if (!isCopyable_(ev, OWN.main))
                continue;
            const start = timeOf_(ev.start);
            const end = timeOf_(ev.end);
            if (!overlapsMs_(toMs_(start), toMs_(end), mirrorWin))
                continue;
            const key = googleKey_(ev);
            if (mirrorDesired.has(key))
                continue;
            const body = withJoinLink_(ev.description || "", ev);
            const resource = {
                summary: ev.summary || "(no title)",
                start,
                end,
                transparency: ev.transparency || "opaque",
                visibility: ev.visibility || "default",
                reminders: { useDefault: false, overrides: [] },
            };
            if (ev.location)
                resource.location = ev.location;
            if (body)
                resource.description = body;
            mirrorDesired.set(key, stamp_(resource, "mirror", key, mainKey));
        }
        if (mirrored) {
            const mirrorOurs = listEvents_(OWN.mirror, padded_(mirrorWin), [`${PROP.marker}=1`]);
            reconcile_(OWN.mirror, mirrorOurs, "mirror", mirrorDesired, mirrorWin, new Set(), null, ctx, mirrorTally);
        }
        // 2. Sync: every source's busy events onto the main calendar.
        const sourceConfigs = resolveSources_().sources;
        if (!ctx.dryRun)
            colorCalendars_(sourceConfigs);
        const sources = sourceConfigs.map((s) => loadSource_(s, readWin, blockWin));
        const unreadable = new Set(sources.filter((s) => !s.ok).map((s) => s.srcKey));
        const onMain = new Set();
        const timesTaken = new Set();
        for (const ev of own) {
            if (ev.status === "cancelled" || responseOf_(ev, OWN.main) === "declined")
                continue;
            onMain.add(googleKey_(ev));
            timesTaken.add(timesOf_(toMs_(ev.start), toMs_(ev.end)));
        }
        const blocks = new Map();
        // Sources with event identities first, so a free/busy period never wins over the real event.
        const ordered = sources.filter((s) => s.ok && !s.timesOnly).concat(sources.filter((s) => s.ok && s.timesOnly));
        for (const source of ordered) {
            for (const item of source.items) {
                if (onMain.has(item.key) || blocks.has(item.key))
                    continue;
                // Already busy at exactly this time: the same meeting, or a time already blocked.
                if (timesTaken.has(timesOf_(item.startMs, item.endMs)))
                    continue;
                if (!overlapsMs_(item.startMs, item.endMs, blockWin))
                    continue;
                if (item.allDay && !SETTINGS.includeAllDayEvents)
                    continue;
                if (!withinBlockHours_(item))
                    continue;
                blocks.set(item.key, buildBlock_(item, source));
                timesTaken.add(timesOf_(item.startMs, item.endMs));
            }
        }
        const mainOurs = mainEvents.filter((e) => isOurs_(e));
        reconcile_(OWN.main, mainOurs, "block", blocks, blockWin, unreadable, ledgerFor_(ledgers, OWN.main), ctx, mainTally);
    }
}
/** win: what to read for events; busyWin: the shorter window busy periods are read for, since they only become blocks. */
function loadSource_(config, win, busyWin) {
    const state = { config, srcKey: srcKey_(config.id), ok: false, timesOnly: false, items: [] };
    try {
        const role = accessRole_(config.id);
        if (role === "freeBusyReader") {
            state.timesOnly = true;
            state.items = readFreeBusy_(config.id, busyWin).map((p) => {
                const start = { dateTime: p.start };
                const end = { dateTime: p.end };
                return {
                    key: keyOf_(`freebusy:${config.id.toLowerCase()}`, `${p.start}|${p.end}`),
                    start,
                    end,
                    startMs: toMs_(start),
                    endMs: toMs_(end),
                    allDay: false,
                };
            });
        }
        else {
            state.items = listEvents_(config.id, win)
                .filter((ev) => !looksSynced_(ev) && isCopyable_(ev, config.id) && ev.transparency !== "transparent")
                .map((ev) => {
                var _a, _b, _c, _d;
                const start = timeOf_(ev.start);
                const end = timeOf_(ev.end);
                return {
                    key: googleKey_(ev),
                    start,
                    end,
                    startMs: toMs_(start),
                    endMs: toMs_(end),
                    allDay: !!start.date,
                    // An imported event whose feed hid its title arrives as busyTitle, like any hidden title.
                    title: ((_b = (_a = ev.extendedProperties) === null || _a === void 0 ? void 0 : _a.shared) === null || _b === void 0 ? void 0 : _b[NO_TITLE_PROP]) === "1" ? undefined : ev.summary || undefined,
                    location: ev.location || undefined,
                    description: withJoinLink_(ev.description || "", ev) || undefined,
                    feed: ((_d = (_c = ev.extendedProperties) === null || _c === void 0 ? void 0 : _c.shared) === null || _d === void 0 ? void 0 : _d[FEED_LABEL_PROP]) || undefined,
                };
            });
        }
        state.ok = true;
    }
    catch (err) {
        console.warn(`${config.label}: not read this run, so nothing it produced is removed. ${errorText_(err)}`);
        unreadSources_.push(`${config.label}: ${errorText_(err)}`);
    }
    return state;
}
/**
 * The sources for this run: every calendar in this account's list tagged as a
 * mirror or import calendar (other than this account's own mirror), plus
 * EXTRA_SOURCES. Also reports shared calendars it could not identify.
 */
function resolveSources_() {
    const norm = (id) => id.trim().toLowerCase();
    const own = new Set([norm(OWN.main), norm(OWN.mirror)]);
    const extra = new Set(extra_().map((x) => norm(x.id)));
    const tagged = [];
    const unrecognised = [];
    const subscriptions = [];
    const people = [];
    for (const entry of calendarList_()) {
        const id = entry.id || "";
        if (!id || own.has(norm(id)) || extra.has(norm(id)) || entry.primary)
            continue;
        const tag = parseSourceTag_(entry.description);
        if (tag) {
            if (!(tag.kind === "mirror" && tag.label === OWN.label))
                tagged.push({ id, name: entry.summary || id, ...tag });
        }
        else if (/@import\.calendar\.google\.com$/.test(id)) {
            // Added in this account with "From URL": Google fetches it, nobody shared it. Read only if in EXTRA_SOURCES.
            subscriptions.push(entry);
        }
        else if (!/@group\.calendar\.google\.com$/i.test(id)) {
            // A person's own calendar (a coworker's, id = their email), or Google's holidays, birthdays and the like.
            // Never a mirror or import calendar, which are always created calendars; skipped, and not synced.
            people.push(entry);
        }
        else if (entry.accessRole === "freeBusyReader" && !entry.description) {
            // Could be a mirror whose tag Google hides at free/busy level: setup lists it, with its id.
            unrecognised.push(entry);
        }
        else if (entry.accessRole !== "owner") {
            // Readable and untagged, so not a mirror or import calendar (their tag is readable at this level): a
            // public calendar you follow (holidays, moon phases), or a team calendar. Skipped, and not synced.
            people.push(entry);
        }
    }
    // Mirrors first, then EXTRA_SOURCES, then import calendars: when the same meeting comes from several,
    // the first one read wins, and a mirror holds the original Google event with its details.
    const of = (kind) => tagged.filter((t) => t.kind === kind).map((t) => ({ id: t.id, label: t.label }));
    const sources = of("mirror").concat(extra_(), of("import"));
    return { sources, tagged, unrecognised, subscriptions, people };
}
/** Details whenever the source shares them; busyTitle otherwise. */
function buildBlock_(item, source) {
    // An imported event names its feed ("studio"); everything else its source's label.
    const from = item.feed || source.config.label;
    const note = SETTINGS.busyDescription ? SETTINGS.busyDescription.split("{calendar}").join(from) : "";
    const resource = {
        summary: fill_(SETTINGS.titleFormat, item.title || SETTINGS.busyTitle, from),
        start: item.start,
        end: item.end,
        transparency: "opaque",
        visibility: SETTINGS.blockVisibility,
        reminders: { useDefault: false, overrides: [] },
    };
    const description = [item.title ? item.description || "" : "", note].filter((s) => s).join("\n\n");
    if (description)
        resource.description = description;
    if (item.title && item.location)
        resource.location = item.location;
    // A feed label in SOURCE_COLORS overrides the import calendar's color for that feed's events.
    const color = (item.feed && colors_()[item.feed]) || colors_()[source.config.label];
    if (color)
        resource.colorId = color;
    return stamp_(resource, "block", item.key, source.srcKey);
}
/** Leftovers and misconfigurations: titled busyTitle, an ignored title, or ending with the busyDescription line. */
function looksSynced_(ev) {
    const title = ev.summary || "";
    if (title && (title === SETTINGS.busyTitle || SETTINGS.ignoreTitles.indexOf(title) !== -1))
        return true;
    // busyTitle in the titleFormat, with any source label: a block left by another copy or an earlier setup.
    if (title && SETTINGS.titleFormat.indexOf("{calendar}") !== -1) {
        const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = SETTINGS.titleFormat.split("{calendar}").map((part) => part.split("{title}").map(esc).join(esc(SETTINGS.busyTitle)));
        if (new RegExp(`^${pattern.join("[^\\]]+")}$`).test(title))
            return true;
    }
    const template = SETTINGS.busyDescription.trim();
    if (!template || template.indexOf("{calendar}") === -1)
        return false;
    const parts = template.split("{calendar}").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`(^|\n)${parts.join(".+")}\\s*$`).test(ev.description || "");
}
/** Google Calendar's event colors as the web app shows them, by colorId. */
const EVENT_COLOR_HEX = {
    "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73", "5": "#f6bf26", "6": "#f4511e",
    "7": "#039be5", "8": "#616161", "9": "#3f51b5", "10": "#0b8043", "11": "#d50000",
};
/**
 * Color this account's calendar list from SOURCE_COLORS: its own calendars by OWN.label, sources by their
 * label. Only writes when a color differs, so a normal run writes nothing. Failures are warnings.
 */
function colorCalendars_(sources) {
    if (!SETTINGS.colorCalendars)
        return;
    const want = new Map();
    const own = [OWN.main].concat(OWN.mirror ? [OWN.mirror] : []);
    for (const id of own)
        if (colors_()[OWN.label])
            want.set(id.toLowerCase(), EVENT_COLOR_HEX[colors_()[OWN.label]]);
    if (imp_().enabled && colors_()[imp_().label]) {
        want.set(imp_().calendarId.toLowerCase(), EVENT_COLOR_HEX[colors_()[imp_().label]]);
    }
    for (const s of sources)
        if (colors_()[s.label])
            want.set(s.id.toLowerCase(), EVENT_COLOR_HEX[colors_()[s.label]]);
    if (want.size === 0)
        return;
    for (const entry of calendarList_()) {
        const id = (entry.id || "").toLowerCase();
        const color = want.get(id);
        if (!color || (entry.backgroundColor || "").toLowerCase() === color)
            continue;
        try {
            withRetry_(() => api_().CalendarList.patch({ backgroundColor: color, foregroundColor: "#ffffff" }, entry.id, { colorRgbFormat: true }));
            console.log(`Colored "${entry.summary || entry.id}" in this account's calendar list.`);
        }
        catch (err) {
            if (err instanceof StopRun)
                throw err;
            console.warn(`Could not color "${entry.summary || entry.id}": ${errorText_(err)}`);
        }
    }
}
/** A title or description template with {title} and {calendar} filled in. */
function fill_(template, title, calendar) {
    return template.split("{title}").join(title).split("{calendar}").join(calendar);
}
function timesOf_(startMs, endMs) {
    return `${startMs}|${endMs}`;
}
/** True if any part of the item overlaps the configured days and hours. */
function withinBlockHours_(item) {
    const h = SETTINGS.blockHours;
    if (!h)
        return true;
    const dayOk = (day) => !h.weekdaysOnly || (day >= 1 && day <= 5);
    if (item.allDay)
        return dayOk(zonedParts_(new Date(item.startMs)).day);
    const dayMs = 24 * 60 * 60 * 1000;
    const span = item.endMs - item.startMs;
    if (span >= 7 * dayMs)
        return true;
    if (span >= dayMs) {
        if (!h.weekdaysOnly)
            return true;
        for (let t = item.startMs; t <= item.endMs; t += dayMs)
            if (dayOk(zonedParts_(new Date(t)).day))
                return true;
        return false;
    }
    const from = zonedParts_(new Date(item.startMs));
    const to = zonedParts_(new Date(item.endMs));
    const winStart = h.startHour * 60;
    const winEnd = h.endHour * 60;
    if (from.day === to.day || to.minutes > from.minutes) {
        const endMinutes = to.minutes > from.minutes ? to.minutes : from.minutes + 1;
        return dayOk(from.day) && from.minutes < winEnd && endMinutes > winStart;
    }
    // Crosses midnight: the tail of the first day or the head of the next.
    return (dayOk(from.day) && from.minutes < winEnd) || (dayOk(to.day) && to.minutes > winStart);
}
/** day: 1 = Mon, 7 = Sun */
function zonedParts_(date) {
    const tz = SETTINGS.timeZone || Session.getScriptTimeZone();
    const parts = Utilities.formatDate(date, tz, "u|H|m").split("|");
    return { day: Number(parts[0]), minutes: Number(parts[1]) * 60 + Number(parts[2]) };
}
function validateConfig_() {
    fillDefaults_();
    if (!/^[^\s\]]+$/.test(OWN.label || ""))
        throw new Error("OWN.label must be one word, such as personal.");
    checkId_(OWN.main, `${OWN.label} main`);
    if (mirrorOn_())
        checkId_(OWN.mirror, `${OWN.label} mirror`);
    const norm = (id) => id.trim().toLowerCase();
    if (OWN.mirror && norm(OWN.main) === norm(OWN.mirror))
        throw new Error("The main calendar and the mirror must be different calendars.");
    const ids = new Set([norm(OWN.main), norm(OWN.mirror)]);
    const labels = new Set([OWN.label]);
    for (const src of extra_()) {
        if (!src.label)
            throw new Error("Every entry in EXTRA_SOURCES needs a label.");
        if (labels.has(src.label))
            throw new Error(`Label used twice: ${src.label}`);
        labels.add(src.label);
        checkId_(src.id, src.label);
        if (norm(src.id) === norm(OWN.main) || norm(src.id) === norm(OWN.mirror)) {
            throw new Error(`${src.label}: a source cannot be this account's own main calendar or mirror.`);
        }
        if (ids.has(norm(src.id)))
            throw new Error(`Calendar listed twice: ${src.id}`);
        ids.add(norm(src.id));
    }
    for (const label of Object.keys(colors_()).filter((l) => !isPlaceholder_(l))) {
        if (!/^(?:[1-9]|1[01])$/.test(colors_()[label]))
            throw new Error(`SOURCE_COLORS.${label} must be "1" to "11".`);
    }
    if (SETTINGS.blockDaysBack < 0 || SETTINGS.mirrorDaysBack < 0)
        throw new Error("daysBack cannot be negative.");
    if (SETTINGS.blockDaysAhead < 1 || SETTINGS.mirrorDaysAhead < 1)
        throw new Error("daysAhead must be at least 1.");
    if (!SETTINGS.busyTitle)
        throw new Error("busyTitle cannot be empty.");
    if (SETTINGS.titleFormat.indexOf("{title}") === -1)
        throw new Error('titleFormat must contain {title}, such as "{title}" or "{title} [{calendar}]".');
    const h = SETTINGS.blockHours;
    if (h && !(h.startHour >= 0 && h.endHour <= 24 && h.startHour < h.endHour)) {
        throw new Error("blockHours: startHour must be before endHour, within 0 to 24.");
    }
    if (imp_().enabled) {
        validateImport_();
        if (extra_().some((x) => x.label === imp_().label))
            throw new Error(`Label used twice: ${imp_().label}`);
    }
    checkCommonSettings_();
}

/**
 * CALENDAR SYNC: iCAL IMPORT
 *
 * The optional import (ICAL_IMPORT in config.gs). Its stamps keep the names the
 * separate feed import used, so a calendar it filled carries on without
 * duplicates.
 */
const IMPORT_PROP = {
    marker: "feedimport",
    kind: "feedimport_kind",
    key: "feedimport_key",
    src: "feedimport_src",
    hash: "feedimport_hash",
    origin: "calsync_origin",
};
/**
 * The import's part of setup, before any calendar is created. Returns a message
 * for NEXT: when something needs doing, or null when everything checks out.
 */
function importPrechecks_() {
    if (typeof ICAL === "undefined") {
        return ("ICAL_IMPORT is on, so this project needs ical.js: + next to Files, Script, name it ical.js (the editor adds " +
            ".gs), and paste in the contents of ical.js.gs. Then run setup again. If this account should not import, set " +
            "ICAL_IMPORT.enabled to false.");
    }
    const unset = imp_().feeds.filter((f) => !/^(https|webcal):\/\//i.test(f.url || ""));
    if (imp_().feeds.length === 0 || unset.length) {
        return ("Put your iCal URL in ICAL_IMPORT.feeds in config.gs. In the calendar app that holds the events, look for its " +
            "share link, public link or secret address in iCal format (https:// or webcal://, often ending in .ics). " +
            "Then run setup again.");
    }
    const unlabeled = imp_().feeds.filter((f) => isPlaceholder_(f.label));
    if (unlabeled.length) {
        return 'Give each feed in ICAL_IMPORT.feeds in config.gs a label, such as "studio". Then run setup again.';
    }
    const bad = [];
    for (const feed of imp_().feeds) {
        try {
            const ics = fetchIcs_(feed.url);
            const count = (ics.match(/BEGIN:VEVENT/g) || []).length;
            const placeholders = (imp_().hiddenTitles || []).map((t) => t.trim().toLowerCase());
            const titles = (ics.match(/\nSUMMARY[^:\r\n]*:([^\r\n]*)/g) || []).map((l) => l.replace(/^\nSUMMARY[^:]*:/, "").trim().toLowerCase());
            const titled = titles.some((t) => t && placeholders.indexOf(t) === -1);
            console.log(`${feed.label}: ${count} event(s) in the feed, ${titled ? "with titles" : "busy times only"}.`);
        }
        catch (err) {
            if (isPermissionError_(err))
                return `${feed.label}: ${errorText_(err)}\n  ${PERMISSION_FIX}`;
            bad.push(`${feed.label}: ${errorText_(err)} Check the iCal URL in the calendar app's sharing settings. If it was ` +
                "revoked or replaced, copy the current one and replace the url in ICAL_IMPORT.feeds.");
        }
    }
    if (bad.length) {
        reportProblems_(bad);
        return "Fix the feed links above in config.gs, then run setup again.";
    }
    const unfilled = Object.keys(imp_().shares).filter((e) => isPlaceholder_(e));
    if (unfilled.length) {
        return (`In config.gs, replace ${unfilled.join(", ")} in ICAL_IMPORT.shares with the email addresses of the ` +
            "accounts that read the import calendar. Then run setup again.");
    }
    return null;
}
/**
 * Step 0 of a run: the feeds onto the import calendar. Errors other than a
 * stop (time, writes, throttling) are logged and the sync still runs.
 */
function importStep_(ctx, result, ledgers) {
    const tally = newTally_(imp_().calendarName);
    result.tallies.push(tally);
    try {
        const role = accessRole_(imp_().calendarId);
        if (!hasWriteAccess_(role)) {
            tally.skipped = `Access is "${role}"; this account must own the import calendar.`;
            return;
        }
        const win = dayWindow_(imp_().daysBack, imp_().daysAhead);
        const unreadable = new Set();
        const desired = new Map();
        for (const feed of imp_().feeds) {
            const srcKey = srcKey_(feed.url);
            let items;
            try {
                if (typeof ICAL === "undefined")
                    throw new Error("ical.js is not in this project.");
                items = readFeed_(feed, fetchIcs_(feed.url), win);
            }
            catch (err) {
                unreadable.add(srcKey);
                const fix = isPermissionError_(err) ? ` ${PERMISSION_FIX}` : "";
                console.warn(`${feed.label}: not read this run, so nothing it produced is removed. ${errorText_(err)}${fix}`);
                continue;
            }
            const placeholders = (imp_().hiddenTitles || []).map((t) => t.trim().toLowerCase());
            for (const item of items) {
                if (desired.has(item.key))
                    continue;
                // No title, or one that only stands in for it (a link that hides details often writes "Busy"):
                // marked, so each account's copy gets its own busyTitle.
                const hidden = !item.title || placeholders.indexOf(item.title.trim().toLowerCase()) !== -1;
                const resource = {
                    summary: hidden ? imp_().fallbackTitle : item.title,
                    start: item.start,
                    end: item.end,
                    transparency: item.transparent ? "transparent" : "opaque",
                    visibility: "default",
                    reminders: { useDefault: false, overrides: [] },
                };
                if (item.location)
                    resource.location = item.location;
                if (item.description)
                    resource.description = item.description;
                const shared = { [FEED_LABEL_PROP]: feed.label };
                if (hidden)
                    shared[NO_TITLE_PROP] = "1";
                desired.set(item.key, stamp_(resource, "import", item.key, srcKey, IMPORT_PROP, shared));
            }
        }
        const id = imp_().calendarId;
        const ours = listEvents_(id, padded_(win), [`${IMPORT_PROP.marker}=1`]);
        reconcile_(id, ours, "import", desired, win, unreadable, ledgerFor_(ledgers, id), ctx, tally, IMPORT_PROP);
    }
    catch (err) {
        if (err instanceof StopRun)
            throw err;
        tally.skipped = `The import failed this run (${errorText_(err)}); the sync still runs.`;
    }
}
function fetchIcs_(url) {
    const response = UrlFetchApp.fetch(url.replace(/^webcal:/i, "https:"), { muteHttpExceptions: true, followRedirects: true });
    const code = response.getResponseCode();
    if (code !== 200)
        throw new Error(`HTTP ${code}. The link may have been deleted or rotated.`);
    const text = response.getContentText();
    if (text.indexOf("BEGIN:VCALENDAR") === -1)
        throw new Error("The response is not an ICS feed.");
    return text;
}
/** Events in one ICS feed, with repeating events expanded and overrides applied. */
function readFeed_(feed, ics, win) {
    const calendar = new ICAL.Component(ICAL.parse(ics));
    for (const vtz of calendar.getAllSubcomponents("vtimezone")) {
        try {
            const zone = new ICAL.Timezone(vtz);
            if (!ICAL.TimezoneService.has(zone.tzid))
                ICAL.TimezoneService.register(zone.tzid, zone);
        }
        catch (err) {
            console.warn(`${feed.label}: could not register a VTIMEZONE: ${errorText_(err)}`);
        }
    }
    // RECURRENCE-ID components override one instance each. ical.js applies them
    // only when they are passed to the parent event, so collect them first.
    const exceptions = new Map();
    const masters = [];
    for (const vevent of calendar.getAllSubcomponents("vevent")) {
        const uid = String(vevent.getFirstPropertyValue("uid") || "");
        if (!uid)
            continue;
        if (vevent.getFirstPropertyValue("recurrence-id")) {
            const list = exceptions.get(uid) || [];
            list.push(vevent);
            exceptions.set(uid, list);
        }
        else {
            masters.push(vevent);
        }
    }
    const out = [];
    const unresolved = new Set();
    const minMs = win.min.getTime();
    const maxMs = win.max.getTime();
    const emit = (uid, component, startT, endT, recurrence) => {
        if (String(component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED")
            return;
        const startDate = icalToDate_(startT, propertyTzid_(component, "dtstart"), unresolved);
        const endDate = icalToDate_(endT, propertyTzid_(component, "dtend") || propertyTzid_(component, "dtstart"), unresolved);
        if (endDate.getTime() <= minMs || startDate.getTime() >= maxMs)
            return;
        const allDay = startT.isDate === true;
        const text = (name) => String(component.getFirstPropertyValue(name) || "") || undefined;
        out.push({
            key: keyOf_(uid, recurrence),
            start: allDay ? { date: ymd_(startT) } : { dateTime: startDate.toISOString() },
            end: allDay ? { date: ymd_(endT) } : { dateTime: endDate.toISOString() },
            startMs: startDate.getTime(),
            endMs: endDate.getTime(),
            transparent: String(component.getFirstPropertyValue("transp") || "").toUpperCase() === "TRANSPARENT",
            title: text("summary"),
            location: text("location"),
            description: text("description"),
        });
    };
    for (const vevent of masters) {
        const uid = String(vevent.getFirstPropertyValue("uid"));
        try {
            const event = new ICAL.Event(vevent, { exceptions: exceptions.get(uid) || [] });
            if (!event.isRecurring()) {
                emit(uid, event.component, event.startDate, event.endDate, "");
                continue;
            }
            const iterator = event.iterator();
            let next;
            let iterations = 0;
            while ((next = iterator.next())) {
                if (++iterations > imp_().maxIterations) {
                    console.warn(`${feed.label}: a repeating event hit maxIterations (${imp_().maxIterations}); later instances dropped. UID ${uid}`);
                    break;
                }
                const details = event.getOccurrenceDetails(next);
                const at = icalToDate_(details.startDate, propertyTzid_(details.item.component, "dtstart"), unresolved);
                if (at.getTime() >= maxMs)
                    break;
                const original = details.recurrenceId || next;
                const token = original.isDate
                    ? ymd_(original)
                    : String(icalToDate_(original, propertyTzid_(vevent, "dtstart"), unresolved).getTime());
                emit(uid, details.item.component, details.startDate, details.endDate, token);
            }
        }
        catch (err) {
            console.error(`${feed.label}: could not expand an event: ${errorText_(err)}`);
        }
    }
    if (unresolved.size > 0) {
        console.warn(`${feed.label}: no VTIMEZONE for ${Array.from(unresolved).join(", ")}; used the platform's time zone data.`);
    }
    return out;
}
/**
 * ical.js falls back to floating time when a TZID has no VTIMEZONE in the feed,
 * which shifts the event by the zone offset. Re-anchor the wall clock against
 * the platform's time zone data instead. Two passes settle DST boundaries.
 */
function icalToDate_(time, tzid, unresolved) {
    if (time.isDate)
        return new Date(time.year, time.month - 1, time.day);
    const floating = !time.zone || time.zone.tzid === "floating";
    if (!floating || !tzid)
        return time.toJSDate();
    unresolved.add(tzid);
    const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second || 0);
    let ts = wall;
    for (let i = 0; i < 2; i++)
        ts = wall - zoneOffsetMinutes_(new Date(ts), tzid) * 60000;
    return new Date(ts);
}
function zoneOffsetMinutes_(date, tzid) {
    const z = Utilities.formatDate(date, tzid, "Z");
    const sign = z.charAt(0) === "-" ? -1 : 1;
    return sign * (Number(z.substr(1, 2)) * 60 + Number(z.substr(3, 2)));
}
function propertyTzid_(component, name) {
    try {
        const property = component.getFirstProperty(name);
        return property ? property.getParameter("tzid") || null : null;
    }
    catch (err) {
        return null;
    }
}
function ymd_(t) {
    return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}
function validateImport_() {
    const c = imp_();
    checkId_(c.calendarId, c.calendarName || "ICAL_IMPORT");
    if (!c.calendarName)
        throw new Error("ICAL_IMPORT needs a calendarName.");
    if (!/^[^\s\]]+$/.test(c.label || ""))
        throw new Error("ICAL_IMPORT.label must be one word, such as ical.");
    if (c.label === OWN.label)
        throw new Error("ICAL_IMPORT.label must differ from OWN.label.");
    const norm = (id) => id.trim().toLowerCase();
    if ([OWN.main, OWN.mirror].map(norm).indexOf(norm(c.calendarId)) !== -1) {
        throw new Error("ICAL_IMPORT.calendarId must be its own calendar, not the main calendar or the mirror.");
    }
    if (c.feeds.length === 0)
        throw new Error("ICAL_IMPORT.feeds is empty.");
    const labels = new Set();
    const urls = new Set();
    for (const f of c.feeds) {
        if (!f.label)
            throw new Error("Every feed needs a label.");
        if (labels.has(f.label))
            throw new Error(`Feed label used twice: ${f.label}`);
        if (/[\[\]]/.test(f.label))
            throw new Error(`${f.label}: a feed label cannot contain [ or ].`);
        labels.add(f.label);
        if (!/^(https|webcal):\/\//i.test(f.url || ""))
            throw new Error(`${f.label}: fill in the feed link.`);
        if (urls.has(f.url))
            throw new Error(`${f.label}: the same link is listed twice.`);
        urls.add(f.url);
    }
    if (c.daysBack < 0 || c.daysAhead < 1)
        throw new Error("ICAL_IMPORT: daysBack must be 0 or more and daysAhead 1 or more.");
    if (!c.fallbackTitle)
        throw new Error("ICAL_IMPORT.fallbackTitle cannot be empty.");
    if (c.fallbackTitle === SETTINGS.busyTitle || SETTINGS.ignoreTitles.indexOf(c.fallbackTitle) !== -1) {
        throw new Error("ICAL_IMPORT.fallbackTitle must differ from busyTitle and ignoreTitles, or its events are skipped.");
    }
}

/* ------------------------------------------------------------------------- *
 * Shared core: Calendar API access, pacing, retries, stamping, reconciling,
 * and the record of what was written. Identical in both syncs.
 * ------------------------------------------------------------------------- */
class StopRun extends Error {
    constructor(reason, message) {
        super(message);
        this.reason = reason;
    }
}
const LEDGER_PREFIX = "ledger:";
const LEDGER_CHUNK = 8000;
/** Lookups of the script's own events reach this far past the window, so an
 * all-day event near the edge in another time zone is found, not recreated. */
const PAD_DAYS = 2;
/* ---- Calendar API ------------------------------------------------------- */
function api_() {
    if (typeof Calendar === "undefined" || !Calendar) {
        throw new Error("Calendar advanced service is not enabled. Add it in appsscript.json (Project Settings, Show appsscript.json manifest file in editor).");
    }
    return Calendar;
}
/** The OAuth scopes the script needs, as Google lists them when one is missing. */
const PERMISSION_ERROR = /do not have permission to call|required permissions?:|authorization is required/i;
/** True when an error means a permission was not granted, rather than a bad link or calendar. */
function isPermissionError_(err) {
    return PERMISSION_ERROR.test(errorText_(err));
}
/** What to do when a permission is missing. */
const PERMISSION_FIX = "This project is missing a permission. Run setup from the editor and, when Google asks, tick Select all (or every " +
    "box) before Continue. If no prompt appears: myaccount.google.com/connections, select this project, Delete all " +
    "connections, then run setup again.";
/**
 * Ends the run with Google's permission prompt if a scope this account needs was not granted. Google's
 * granular consent lets you untick some; without this, the first call needing one fails mid-run. Asks only
 * for what is used: fetching URLs only where the iCal import is on.
 */
function requireScopes_(fetchesUrls) {
    const app = ScriptApp;
    if (typeof app.requireScopes !== "function" || !app.AuthMode)
        return;
    const scopes = [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/script.scriptapp",
        "https://www.googleapis.com/auth/userinfo.email",
    ];
    if (fetchesUrls)
        scopes.push("https://www.googleapis.com/auth/script.external_request");
    app.requireScopes(app.AuthMode.FULL, scopes);
}
/** This account's access to a calendar, adding it to the calendar list if it was shared but not yet added. */
function accessRole_(calendarId) {
    try {
        return withRetry_(() => api_().CalendarList.get(calendarId)).accessRole || "unknown";
    }
    catch (err) {
        if (err instanceof StopRun)
            throw err;
        withRetry_(() => api_().CalendarList.insert({ id: calendarId }));
        return withRetry_(() => api_().CalendarList.get(calendarId)).accessRole || "unknown";
    }
}
function hasWriteAccess_(role) {
    return role === "owner" || role === "writer";
}
const LIST_FIELDS = "nextPageToken,items(id,iCalUID,status,eventType,transparency,visibility,start,end," +
    "originalStartTime,summary,description,location,hangoutLink,conferenceData(entryPoints(entryPointType,uri))," +
    "attendees(email,responseStatus),extendedProperties)";
function listEvents_(calendarId, win, privateProps = []) {
    const events = [];
    let pageToken;
    do {
        const params = { singleEvents: true, showDeleted: false, maxResults: 2500, fields: LIST_FIELDS };
        if (win) {
            params.timeMin = win.min.toISOString();
            params.timeMax = win.max.toISOString();
        }
        if (privateProps.length)
            params.privateExtendedProperty = privateProps;
        if (pageToken)
            params.pageToken = pageToken;
        const page = withRetry_(() => api_().Events.list(calendarId, params));
        events.push(...(page.items || []));
        pageToken = page.nextPageToken;
    } while (pageToken);
    return events;
}
/** First range asked of Freebusy.query at once. Google refuses long ranges ("The requested time range is too long") without documenting the limit, so on that error the range is halved and asked again. */
const FREEBUSY_CHUNK_DAYS = 28;
/**
 * Busy periods only, for a calendar shared at "See only free/busy". Google leaves out free events. Asked in
 * chunks, and periods that touch or overlap across chunk edges joined again, so the result does not depend on
 * where the chunks fall.
 */
function readFreeBusy_(calendarId, win) {
    const spans = [];
    let stepMs = FREEBUSY_CHUNK_DAYS * 86400000;
    let from = win.min.getTime();
    const end = win.max.getTime();
    while (from < end) {
        const to = Math.min(from + stepMs, end);
        let response;
        try {
            response = withRetry_(() => api_().Freebusy.query({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: calendarId }] }));
        }
        catch (err) {
            if (err instanceof StopRun || !/time range is too long|timeRangeTooLong/i.test(errorText_(err)) || stepMs <= 86400000)
                throw err;
            stepMs = Math.max(86400000, Math.floor(stepMs / 2));
            continue;
        }
        const calendars = (response.calendars || {});
        const entry = calendars[calendarId];
        if (!entry)
            throw new Error("No free/busy data returned.");
        if (entry.errors && entry.errors.length)
            throw new Error(`Free/busy error: ${entry.errors.map((e) => e.reason).join(", ")}`);
        for (const p of entry.busy || [])
            spans.push([Date.parse(String(p.start)), Date.parse(String(p.end))]);
        from = to;
    }
    spans.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, b] of spans) {
        const last = merged[merged.length - 1];
        if (last && a <= last[1])
            last[1] = Math.max(last[1], b);
        else
            merged.push([a, b]);
    }
    return merged.map(([a, b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString() }));
}
function insertEvent_(calendarId, resource) {
    api_().Events.insert(resource, calendarId, { sendUpdates: "none" });
}
function updateEvent_(calendarId, eventId, resource) {
    api_().Events.update(resource, calendarId, eventId, { sendUpdates: "none" });
}
function removeEvent_(calendarId, eventId) {
    try {
        api_().Events.remove(calendarId, eventId, { sendUpdates: "none" });
    }
    catch (err) {
        if (/not found|404|410|deleted/i.test(errorText_(err)))
            return;
        throw err;
    }
}
const SHARE_ROLES = { "free/busy": "freeBusyReader", details: "reader" };
/** The option Google Calendar shows for each level. */
const SHARE_LABELS = {
    "free/busy": "See only free/busy (hide details)",
    details: "See event details",
};
/**
 * Create a calendar the first time only. Its id is kept in Script Properties,
 * so running again before the id is pasted into config.gs finds the same one.
 */
function createCalendarOnce_(propKey, name) {
    const store = PropertiesService.getScriptProperties();
    const known = store.getProperty(propKey);
    if (known) {
        try {
            withRetry_(() => api_().Calendars.get(known));
            return { id: known, created: false };
        }
        catch (err) {
            if (err instanceof StopRun)
                throw err;
            // Deleted since: create it again.
        }
    }
    const calendar = withRetry_(() => api_().Calendars.insert({ summary: name, timeZone: Session.getScriptTimeZone() }));
    store.setProperty(propKey, calendar.id);
    return { id: calendar.id, created: true };
}
/** Share a calendar as configured. Adds or changes access; never removes it. Returns problems. */
function applyShares_(calendarId, name, shares) {
    var _a;
    const problems = [];
    const existing = new Map();
    for (const rule of withRetry_(() => api_().Acl.list(calendarId)).items || []) {
        if (((_a = rule.scope) === null || _a === void 0 ? void 0 : _a.type) === "user" && rule.scope.value)
            existing.set(rule.scope.value.toLowerCase(), rule);
    }
    for (const email of Object.keys(shares)) {
        const level = shares[email];
        if (isPlaceholder_(email)) {
            problems.push(`Fill in the email address in place of "${email}".`);
            continue;
        }
        const role = SHARE_ROLES[level];
        if (!role) {
            problems.push(`${email}: the level must be "free/busy" or "details".`);
            continue;
        }
        const rule = existing.get(email.toLowerCase());
        if (rule && rule.role === role) {
            console.log(`${email}: already shared at ${level}`);
            continue;
        }
        try {
            if (rule)
                withRetry_(() => api_().Acl.patch({ role }, calendarId, rule.id));
            else
                withRetry_(() => api_().Acl.insert({ role, scope: { type: "user", value: email } }, calendarId, { sendNotifications: true }));
            console.log(`${email}: shared at ${level}. Google emails them an invitation; they click "Add this calendar".`);
        }
        catch (err) {
            if (err instanceof StopRun)
                throw err;
            problems.push(`${email}: could not share at ${level} (${errorText_(err)}). An admin may limit sharing. Share it by hand: ` +
                `Google Calendar, Settings and sharing, "${name}", Share with specific people or groups, Add people, ` +
                `${email}, "${SHARE_LABELS[level]}" or the closest option offered, Send.`);
        }
    }
    return problems;
}
/** This account's email address, for telling others whom to share with. */
/** True for an empty value or one still holding a placeholder from config.gs, such as <OWN_MIRROR_EMAIL>. */
function isPlaceholder_(value) {
    const v = (value || "").trim();
    return !v || /^paste_/i.test(v) || /<[A-Z0-9_]+>/.test(v);
}
function me_() {
    try {
        return Session.getEffectiveUser().getEmail() || "this account's email address";
    }
    catch (err) {
        return "this account's email address";
    }
}
/** This account's access to a calendar, or null when it cannot reach it. */
function roleOrNull_(calendarId) {
    try {
        return accessRole_(calendarId);
    }
    catch (err) {
        if (err instanceof StopRun)
            throw err;
        return null;
    }
}
function triggerInstalled_(handler) {
    return ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === handler);
}
/* ---- Finding sources by tag ------------------------------------------- */
/**
 * Mirrors and import calendars carry this line in their description, so each
 * account's calendar sync can find them once they are shared with it.
 */
const SOURCE_TAG_PATTERN = /\[calsync (mirror|import)=([^\s\]]+) owner=([^\s\]]+)\]/;
function sourceTag_(kind, label, owner) {
    return `[calsync ${kind}=${label} owner=${owner}]`;
}
function parseSourceTag_(description) {
    const m = (description || "").match(SOURCE_TAG_PATTERN);
    return m ? { kind: m[1], label: m[2], owner: m[3].toLowerCase() } : null;
}
/** Make sure a calendar this account owns carries the tag, keeping any other description text. */
function ensureSourceTag_(calendarId, kind, label) {
    const tag = sourceTag_(kind, label, me_());
    const current = withRetry_(() => api_().Calendars.get(calendarId)).description || "";
    if (current.indexOf(tag) !== -1)
        return;
    const rest = current.replace(SOURCE_TAG_PATTERN, "").trim();
    const intro = "Filled by the calendar sync. Do not edit its events or remove this line:";
    const description = [rest.replace(intro, "").trim(), intro, tag].filter((s) => s).join("\n");
    withRetry_(() => api_().Calendars.patch({ description }, calendarId));
}
/** Every calendar in this account's calendar list, including hidden ones. */
function calendarList_() {
    const out = [];
    let pageToken;
    do {
        const params = { showHidden: true, maxResults: 250 };
        if (pageToken)
            params.pageToken = pageToken;
        const page = withRetry_(() => api_().CalendarList.list(params));
        out.push(...(page.items || []));
        pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
}
/** The next thing to do, after a function you run by hand. */
function next_(message) {
    console.log(`NEXT: ${message}`);
}
function reportProblems_(problems) {
    console.error(`${problems.length} problem(s):`);
    problems.forEach((p) => console.error(`  ${p}`));
}
/* ---- Pacing, retries, limits ------------------------------------------- */
function newContext_(dryRun) {
    return { dryRun, started: Date.now(), writes: 0 };
}
function write_(ctx, op) {
    if (ctx.dryRun) {
        ctx.writes++;
        return;
    }
    if (Date.now() - ctx.started > SETTINGS.maxRuntimeMs)
        throw new StopRun("time", "out of time");
    if (ctx.writes >= SETTINGS.maxWritesPerRun)
        throw new StopRun("writes", `write limit (${SETTINGS.maxWritesPerRun})`);
    withRetry_(op);
    ctx.writes++;
    if (SETTINGS.pacingMs > 0)
        Utilities.sleep(SETTINGS.pacingMs);
}
/** Retries short-term rate limits; stops the run on Google's longer write throttle. */
function withRetry_(op) {
    for (let attempt = 0;; attempt++) {
        try {
            return op();
        }
        catch (err) {
            const text = errorText_(err);
            if (/too many calendars or calendar events|usage limits exceeded/i.test(text)) {
                throw new StopRun("throttled", "Google is throttling calendar writes");
            }
            const transient = /rate ?limit|429|backend error|503|500|internal error|service invoked too many times in a short time/i.test(text);
            if (!transient || attempt >= SETTINGS.maxRetries)
                throw err;
            Utilities.sleep(SETTINGS.backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
        }
    }
}
/** Run with the script lock, so a manual run and a trigger never overlap. */
function runLocked_(run) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(0)) {
        console.log("Another run is in progress; skipping. The next run picks the work up.");
        return null;
    }
    try {
        return run();
    }
    finally {
        lock.releaseLock();
    }
}
/* ---- Stamping and reconciling ------------------------------------------ */
/** Add the hidden stamps. The hash covers only what the script writes, so hand edits survive until the source changes. */
/** Shared property naming the feed an imported event came from, so every account can show it. */
const FEED_LABEL_PROP = "calsync_feed";
/** Shared property marking an imported event whose feed hid its title: copies of it get busyTitle. */
const NO_TITLE_PROP = "calsync_notitle";
function stamp_(resource, kind, key, srcKey, props = PROP, extraShared = {}) {
    const hash = md5Hex_(JSON.stringify([kind, srcKey, resource, extraShared])).slice(0, 16);
    resource.extendedProperties = {
        private: {
            [props.marker]: "1",
            [props.kind]: kind,
            [props.key]: key,
            [props.src]: srcKey,
            [props.hash]: hash,
        },
        shared: Object.assign({ [props.origin]: key }, extraShared),
    };
    return { hash, srcKey, resource };
}
function isOurs_(ev, props = PROP) {
    var _a, _b;
    return ((_b = (_a = ev.extendedProperties) === null || _a === void 0 ? void 0 : _a.private) === null || _b === void 0 ? void 0 : _b[props.marker]) === "1";
}
/**
 * Make the calendar hold exactly the desired events of one kind: create what
 * is missing, update what changed, delete extras and orphans.
 *
 * ledger: when given, an event written before and now missing was deleted by
 * hand and stays deleted. Pass null to always restore.
 */
function reconcile_(calId, ours, kind, desired, win, unreadable, ledger, ctx, tally, props = PROP) {
    var _a;
    const existing = new Map();
    for (const ev of ours) {
        const p = ((_a = ev.extendedProperties) === null || _a === void 0 ? void 0 : _a.private) || {};
        if (p[props.kind] !== kind)
            continue;
        const key = p[props.key] || `nokey:${ev.id}`;
        const list = existing.get(key) || [];
        list.push(ev);
        existing.set(key, list);
    }
    desired.forEach((want, key) => {
        var _a, _b, _c, _d;
        const short = ledgerKey_(key);
        const have = existing.get(key) || [];
        if (have.length === 0) {
            if (ledger && ledger.has(short)) {
                tally.keptDeleted++;
                return;
            }
            write_(ctx, () => insertEvent_(calId, want.resource));
            if (ledger)
                ledger.set(short, want.srcKey.slice(0, 8));
            tally.created++;
            return;
        }
        const keep = have[0];
        const keepSrc = ((_b = (_a = keep.extendedProperties) === null || _a === void 0 ? void 0 : _a.private) === null || _b === void 0 ? void 0 : _b[props.src]) || "";
        if (ledger)
            ledger.set(short, (unreadable.has(keepSrc) ? keepSrc : want.srcKey).slice(0, 8));
        if (((_d = (_c = keep.extendedProperties) === null || _c === void 0 ? void 0 : _c.private) === null || _d === void 0 ? void 0 : _d[props.hash]) === want.hash || unreadable.has(keepSrc)) {
            // Unchanged, or written from a source not read this run.
            tally.unchanged++;
        }
        else {
            write_(ctx, () => updateEvent_(calId, keep.id, want.resource));
            tally.updated++;
        }
        // Same key twice: two runs overlapped. Keep one.
        for (const extra of have.slice(1)) {
            write_(ctx, () => removeEvent_(calId, extra.id));
            tally.deleted++;
        }
    });
    existing.forEach((have, key) => {
        var _a, _b;
        if (desired.has(key))
            return;
        for (const ev of have) {
            const src = (_b = (_a = ev.extendedProperties) === null || _a === void 0 ? void 0 : _a.private) === null || _b === void 0 ? void 0 : _b[props.src];
            // Its source was not read this run, so its absence proves nothing.
            if (src && unreadable.has(src))
                continue;
            // Only in the padding, outside the window: leave it.
            if (!overlapsMs_(toMs_(ev.start), toMs_(ev.end), win))
                continue;
            write_(ctx, () => removeEvent_(calId, ev.id));
            if (ledger)
                ledger.delete(ledgerKey_(key));
            tally.deleted++;
        }
    });
    if (!ledger)
        return;
    // Forget what is neither wanted nor present, unless its source was not read.
    const unreadableShort = new Set(Array.from(unreadable).map((s) => s.slice(0, 8)));
    const desiredShort = new Set(Array.from(desired.keys()).map(ledgerKey_));
    const existingShort = new Set(Array.from(existing.keys()).map(ledgerKey_));
    ledger.forEach((src, short) => {
        if (desiredShort.has(short) || existingShort.has(short) || unreadableShort.has(src))
            return;
        ledger.delete(short);
    });
}
function loadLedgers_() {
    const all = PropertiesService.getScriptProperties().getProperties();
    const chunks = new Map();
    Object.keys(all)
        .filter((k) => k.indexOf(LEDGER_PREFIX) === 0)
        .sort()
        .forEach((k) => {
        const calKey = k.slice(LEDGER_PREFIX.length).split(":")[0];
        const list = chunks.get(calKey) || [];
        list.push(all[k]);
        chunks.set(calKey, list);
    });
    const ledgers = new Map();
    chunks.forEach((parts, calKey) => {
        const map = new Map();
        parts
            .join(",")
            .split(",")
            .filter((e) => e)
            .forEach((entry) => {
            const [short, src] = entry.split(".");
            map.set(short, src || "");
        });
        ledgers.set(calKey, map);
    });
    return ledgers;
}
function ledgerFor_(ledgers, calendarId) {
    const calKey = srcKey_(calendarId);
    let map = ledgers.get(calKey);
    if (!map) {
        map = new Map();
        ledgers.set(calKey, map);
    }
    return map;
}
function saveLedgers_(ledgers) {
    const store = PropertiesService.getScriptProperties();
    const old = Object.keys(store.getProperties()).filter((k) => k.indexOf(LEDGER_PREFIX) === 0);
    const next = {};
    ledgers.forEach((map, calKey) => {
        let chunk = "";
        let n = 0;
        map.forEach((src, short) => {
            const entry = `${short}.${src}`;
            if (chunk.length + entry.length + 1 > LEDGER_CHUNK) {
                next[`${LEDGER_PREFIX}${calKey}:${String(n++).padStart(3, "0")}`] = chunk;
                chunk = "";
            }
            chunk = chunk ? `${chunk},${entry}` : entry;
        });
        if (chunk)
            next[`${LEDGER_PREFIX}${calKey}:${String(n).padStart(3, "0")}`] = chunk;
    });
    store.setProperties(next, false);
    for (const k of old)
        if (!(k in next))
            store.deleteProperty(k);
}
function clearLedgers_() {
    const store = PropertiesService.getScriptProperties();
    for (const k of Object.keys(store.getProperties())) {
        if (k.indexOf(LEDGER_PREFIX) === 0)
            store.deleteProperty(k);
    }
}
function ledgerKey_(key) {
    return key.slice(0, 12);
}
/* ---- Events ------------------------------------------------------------- */
/** Real, not cancelled, not declined by this calendar's owner, and a kind of event worth copying. */
function isCopyable_(ev, calendarId) {
    if (ev.status === "cancelled")
        return false;
    const type = String(ev.eventType || "default");
    if (type === "workingLocation" || type === "birthday")
        return false;
    if (responseOf_(ev, calendarId) === "declined")
        return false;
    return true;
}
/** The calendar owner's response, by email; `self` would mean the account running the script. */
function responseOf_(ev, calendarId) {
    const id = calendarId.toLowerCase();
    const me = (ev.attendees || []).find((a) => (a.email || "").toLowerCase() === id);
    return me === null || me === void 0 ? void 0 : me.responseStatus;
}
/** Same meeting, same key, from Google or from a feed: the iCalUID plus the original start of one instance. */
function keyOf_(uid, recurrence) {
    return md5Hex_(`${uid}|${recurrence}`);
}
function googleKey_(ev) {
    var _a, _b;
    const shared = (_b = (_a = ev.extendedProperties) === null || _a === void 0 ? void 0 : _a.shared) === null || _b === void 0 ? void 0 : _b[PROP.origin];
    if (shared)
        return shared;
    return keyOf_(ev.iCalUID || ev.id || "", recurrenceToken_(ev.originalStartTime));
}
function recurrenceToken_(t) {
    if (!t)
        return "";
    if (t.date)
        return t.date;
    if (t.dateTime)
        return String(Date.parse(t.dateTime));
    return "";
}
/** The description plus the video-call link, which Google keeps outside the description. */
function withJoinLink_(description, ev) {
    var _a, _b, _c;
    const link = ev.hangoutLink || ((_c = (_b = (_a = ev.conferenceData) === null || _a === void 0 ? void 0 : _a.entryPoints) === null || _b === void 0 ? void 0 : _b.find((p) => p.entryPointType === "video")) === null || _c === void 0 ? void 0 : _c.uri);
    return [description, link ? `Join: ${link}` : ""].filter((s) => s).join("\n\n");
}
/* ---- Time --------------------------------------------------------------- */
function timeOf_(t) {
    if (!t)
        throw new Error("Event has no start or end");
    if (t.date)
        return { date: t.date };
    const out = { dateTime: t.dateTime };
    if (t.timeZone)
        out.timeZone = t.timeZone;
    return out;
}
function toMs_(t) {
    if (t === null || t === void 0 ? void 0 : t.dateTime)
        return Date.parse(t.dateTime);
    if (t === null || t === void 0 ? void 0 : t.date) {
        const [y, m, d] = t.date.split("-").map(Number);
        return new Date(y, m - 1, d).getTime();
    }
    return NaN;
}
function overlapsMs_(startMs, endMs, win) {
    return startMs < win.max.getTime() && endMs > win.min.getTime();
}
function dayWindow_(back, ahead) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return { min: addDays_(today, -back), max: addDays_(today, ahead) };
}
function padded_(win) {
    return { min: addDays_(win.min, -PAD_DAYS), max: addDays_(win.max, PAD_DAYS) };
}
function addDays_(d, days) {
    return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}
/* ---- Small helpers ------------------------------------------------------ */
function srcKey_(id) {
    return md5Hex_(id.trim().toLowerCase()).slice(0, 16);
}
function md5Hex_(text) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8);
    return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}
function errorText_(err) {
    return err instanceof Error ? err.message : String(err);
}
function newTally_(label) {
    return { label, created: 0, updated: 0, deleted: 0, unchanged: 0, keptDeleted: 0 };
}
function checkId_(id, what) {
    const norm = (id || "").trim().toLowerCase();
    if (isPlaceholder_(id))
        throw new Error(`${what}: fill in the calendar id.`);
    if (norm === "primary")
        throw new Error(`${what}: use the full calendar id, not "primary".`);
}
function checkCommonSettings_() {
    if ([1, 5, 10, 15, 30].indexOf(SETTINGS.syncEveryMinutes) === -1) {
        throw new Error("syncEveryMinutes must be 1, 5, 10, 15 or 30.");
    }
}
function installTrigger_(handler) {
    removeTriggers_([handler]);
    ScriptApp.newTrigger(handler).timeBased().everyMinutes(SETTINGS.syncEveryMinutes).create();
    console.log(`${handler}: every ${SETTINGS.syncEveryMinutes} min`);
}
function removeTriggers_(handlers) {
    let removed = 0;
    for (const trigger of ScriptApp.getProjectTriggers()) {
        if (handlers.indexOf(trigger.getHandlerFunction()) === -1)
            continue;
        ScriptApp.deleteTrigger(trigger);
        removed++;
    }
    console.log(`Removed ${removed} trigger(s).`);
    return removed;
}
function runSafely_(dryRun, body) {
    const ctx = newContext_(dryRun);
    const result = { dryRun, stopped: false, writes: 0, tallies: [] };
    const ledgers = loadLedgers_();
    try {
        body(ctx, result, ledgers);
    }
    catch (err) {
        if (!(err instanceof StopRun))
            throw err;
        result.stopped = true;
        result.reason = err.message;
        console.warn(`Stopped: ${err.message}. The next run continues.`);
    }
    finally {
        if (!dryRun)
            saveLedgers_(ledgers);
    }
    result.writes = ctx.writes;
    const verb = dryRun ? "would" : "did";
    for (const t of result.tallies) {
        if (t.skipped) {
            console.log(`${t.label}: skipped. ${t.skipped}`);
            continue;
        }
        const kept = t.keptDeleted ? `; ${t.keptDeleted} deleted by hand stay deleted` : "";
        console.log(`${t.label}: ${verb} create ${t.created}, update ${t.updated}, delete ${t.deleted}; ${t.unchanged} unchanged${kept}`);
    }
    return result;
}
function onlyDeletes_(result) {
    const sum = (f) => result.tallies.reduce((n, t) => n + f(t), 0);
    return sum((t) => t.deleted) > 0 && sum((t) => t.created + t.updated + t.unchanged) === 0;
}
