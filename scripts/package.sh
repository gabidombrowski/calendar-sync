#!/bin/sh
# Builds release/calendar-sync-kit.zip: the Apps Script files plus the Word setup guide.
set -e
cd "$(dirname "$0")/.."
rm -rf release
mkdir -p release/calendar-sync-kit
cp apps-script/appsscript.json apps-script/calendar-sync.gs apps-script/config.gs \
   apps-script/cleanup.gs apps-script/ical.js.gs docs/setup-guide.docx release/calendar-sync-kit/
(cd release && zip -q -r -X calendar-sync-kit.zip calendar-sync-kit)
echo "Wrote release/calendar-sync-kit.zip"
