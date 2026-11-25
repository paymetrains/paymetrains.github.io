# Mobile fortnight calculator

Run from this directory:

```powershell
npm start
```

Open **http://127.0.0.1:4173/**. The main app is `index.html`; the old `fortnight.html` URL redirects there. It supports PDF import or completely manual entry, one-week shift lists, inline editing, the shared pay engine, and a downloadable JSON pay summary. The defunct master roster scenario remains linked in the footer. Use `npm test` for the engine and flow-model checks. No npm dependencies need installing.

GitHub Pages uses `.github/workflows/pages.yml` to deploy only this directory at **https://paymetrains.github.io/**. The main page stays at `/index.html`, and the scenario is `/Defunct-master-scenario.html`. The nested `roster-analyser/` folder contains redirects for previously published URLs.

Legacy calculator interfaces, the original analyser UI, and old OCR/conversion work are preserved in `../archive/legacy-apps/`, outside this server's document root. Publish only this `roster-analyser/` directory; do not publish the workspace root, archive, attachments, backups, or generated reports. Shared calculation and parser modules remain here because both active apps use them.

## Normal roster time claims

The normal calculator applies the same time comparison to guards and drivers. Both starts use the listed roster date; each finish rolls into the next day if needed. Lift-up adds the missed finish minutes after work when both ends move earlier. Lay-back adds the missed start minutes before work when both ends move later. Build-up fills the missing time at either end when the worked shift fits inside the rostered shift. A shift covering its full rostered span gets no time credit. Credits count once towards payable hours and overtime, not towards actual worked minutes or the WOBOD bonus.

Comparisons use the worked job, not the job given away in a swap. A numbered job with no unique master or diagram times is flagged for review. Custom duties default to their own times unless separate rostered times are supplied. Leave and timed sick relief do not generate an additional time claim. This is a time-based estimate; the PDF does not establish why an amendment was made or when it was posted.

## Master roster scenario

`ASY-job-comparison.html` checks each current ASY guard or driver job against the same job's defunct reference, with weekday variants and optional sorting by extra kilometres or pay. It defaults to numerical job order. Current diagrams are always the worked jobs. It uses an ordinary non-public-holiday reference week internally, so no date entry is required. It uses the same engine for daily time/diagram-value claims and driver kilometre credits, marks missing data explicitly, and excludes line-based WOBOD and fortnight guarantee adjustments. Guards use the defunct master for their reference times.

Timesheet PDF export generates A4 landscape pages directly, with a 277 mm table spanning the printable width, wrapped comments and a reserved job-length column. It uses locally bundled jsPDF 4.2.1 and AutoTable 5.0.9, so no external PDF service is involved. The full-fortnight view keeps 14 days together with adaptive text sizing. Roster comparison exports continue to use the browser print dialog.

Review Roads diagrams (RR, RR1, RR2 and other numbered RR variants) have a confirmed zero-kilometre baseline in both calculators when a timed diagram reference is present on the selected master roster. The job label alone does not create that reference. Known RR/SBY zero distances remain known even when their times vary by master line; only the time comparison then needs a specific line. Normal driver imports and edited job references retain the master times, while entered extra kilometres remain payable. Zero kilometres do not make a diagram unclaimable.

For drivers, an unswapped job replacing Review Roads on the defunct master line can claim its assumed actual kilometres against that zero-kilometre baseline. This is a separate candidate from the worked job's own defunct diagram distance. The kilometre comment identifies the RR job when that candidate wins; swapped shifts do not gain this defunct-line comparison.

Defunct references are indexed in `data/scenarios/index.json`. The current snapshot includes 24 depot/role master rosters. Auburn's owner-supplied guard and driver master assignments are preserved; imported data supplement their job references. Other included depots use imported defunct master assignments. Waterfall driver/guard masters remain unavailable in this snapshot and require a temporary upload.

The ASY driver lookup contains all 149 numbered diagrams verified against six owner-supplied November 2026 photographs: 47 Monday–Thursday, 46 Friday, 28 Saturday and 28 Sunday. Every numbered job has known times and distance. The photo source is saved in `data/scenarios/auburn-driver-photo-diagrams.json`, including operating days, printed overnight clocks, duration, distance, source image filename and uninterpreted M markers. Job 2007 finishes at 09:52 in the photo; that corrects the earlier 10:05 lookup. Generic RR/SBY still require master-line times when their job label has multiple schedules. Original source lookup coverage remains recorded as partial. Other depots currently use times inferred from their master rosters, without imported diagram kilometre values. Unknown distance is never treated as zero. Each data file retains provenance, retrieval time, coverage, source flags and standby/not-counted markers. `scripts/import-defunct-data.mjs <download-directory>` validates and normalises locally downloaded JSON; it does not log in or make remote requests. No sign-on credentials are saved with the app.

Imported defunct diagram times take priority over inferred same-job reference times, while the master line's job and times remain separate comparison candidates. Driver rostered and actual distances default to the current worked job's diagram kilometres. Both fields can be edited; current extra kilometres are calculated as the positive difference between actual and rostered distance. Each time candidate can also be tested against the same job's defunct kilometre reference; the higher daily amount is selected. Driver distances can be edited in each line's Rostered and actual kilometres disclosure. Defunct comparisons retain their own distance references and use the entered actual distance. Unknown distances stay blank rather than becoming zero. Kilometre gains are shown separately from time claims, including in timesheet, CSV, Excel and PDF exports. Guard kilometre pay is unaffected.

Open **http://127.0.0.1:4173/Defunct-master-scenario.html** to compare every named crew line in a fortnight PDF with the existing and defunct masters. Auburn's supplied final-draft guard and driver masters are bundled under `data/scenarios/`. Temporary PDF overrides are available for either master.

Open a result line in Roster rows view to compare four aligned rows across all 14 dates: existing master, defunct master, uploaded roster and daily breakdown. Date headings and source labels stay visible while scrolling. Daily list provides a vertical view of the same data. Both views show the two master amounts, actual job duration, separate time claims and WOBOD eligibility. Result labels and downloaded comparisons use line numbers only.

The scenario always tests the current and defunct line/day assignments and the current job reference. Comparison settings optionally enable the worked job's own defunct diagram and defunct time/kilometre claims on swapped shifts; both options default off. A separate "Preserve WOBOD on work-for-work swaps" option defaults on. A swapped shift retains current/defunct OFF or ADO eligibility only when both sides were already working. Swaps that move booked-off days, and swaps whose original work status is unknown, cannot create WOBOD. Current-master assignments provide the initial indication; they do not prove the actual pre-swap roster. Each line has a "Swap types and WOBOD eligibility" editor to confirm work-for-work, a day-off move or unknown status for each swapped date. Confirmations survive kilometre edits and are recorded in JSON/CSV exports. Disabling preservation excludes all swapped WOBOD. Unswapped eligibility and the separate defunct time/kilometre switches are unchanged. Timesheet comments use WOBOD MR only when the defunct master alone establishes eligibility; when both masters show book-off, the comment is simply WOBOD. Swapped-day time credits require the same job. Custom timed duties retain their actual times unless the job is identified in the defunct reference. Timed SBY and Freelance duties count as worked shifts, can compare against their own line's current and defunct assignments, and retain the same-job restriction when swapped. Freelance sector/training descriptions remain in the source text. Lines containing Freelance shifts are included in Excel exports. Each day selects the highest comparison amount, and the fortnight total includes the resulting guarantee adjustment.

`roster-job-reference.mjs` collates the selected defunct master by job number, preserving time variants, observed weekdays, actual job duration and source line/day occurrences. The bundled Auburn guard snapshot is also saved in `data/scenarios/auburn-guard-defunct-jobs.json`. The app rebuilds the reference from the selected master, including temporary uploads. The Defunct job reference disclosure lists all jobs and downloads its JSON. A generic SBY job has several conflicting schedules, so its times stay attached to the relevant line and day. A job with different weekday variants is used only when the worked weekday identifies one variant.

Both shift starts use their listed roster date. Shifts finishing after midnight end on the next day. This avoids the earlier nearest-day alignment issue on morning standby versus evening work. Starts more than 12 hours apart are marked in the results, with an optional setting to exclude those time credits. Fifth and later weekday WOBOD shifts default to an explicit 200% scenario assumption plus the normal 50% worked-time component. That multiplier can be changed in Comparison settings. CIL is modeled as eight hours of paid accrued leave and is noted on each affected line. Unrecognised entries or missing master lines produce a visible per-line error.

## Sick leave

For both roles, a full day of sick leave pays eight hours at base rate and counts as eight hours lost for the guarantee, regardless of the rostered shift length. Under four hours worked before relinquishing is a full sick day; from four hours worked, only the unworked scheduled remainder is sick leave. A day off on the roster does not create sick pay.

## Data connections and privacy

This is a static application. The included development server serves HTML, JavaScript, and approved master JSON using GET/HEAD. It rejects POST and does not receive roster files. PDF.js is bundled locally (version 4.10.38, Apache-2.0); PDF extraction, master comparison, and pay calculation run on the user's device. No LLM or external API is involved.

- `data/masters/index.json`: catalogue endpoint, listing depots and master versions.
- `data/masters/<depot>-<role>-<effectiveFrom>.json`: published master data.
- `master-store.mjs`: validation, effective-date matching, and lookup-map restoration.
- `pdf-reader.mjs` / `roster-core.mjs`: shared extraction and comparison code, also used by the original analyser.
- `fortnight-model.mjs`: review data, validation, and mapping to the existing calculator fields.
- `PayEngine.calculateWithBreakdown(...)`: shared pay calculations with captured breakdown output.

User-selected current PDFs, temporary master PDFs, and their parsed data stay in memory. They are not placed in localStorage, sessionStorage, IndexedDB, the catalogue, or a server upload. Refreshing clears them. A requested pay-summary download contains only the selected employee's review rows and calculation output, not the master. A master file selected in the browser is never published by the owner conversion command.

## Publishing supplied masters

The catalogue lists dated owner-supplied masters and bundled masters separately. The app uses a temporary upload first, then a matching dated master, then the bundled master for the selected depot and role. Manual entry is also available.

The 26 bundled reference files under `data/masters/bundled/` are local snapshots with a retrieval date. `masterRoster` contains each line's daily job assignments and `diagramData` contains job times, day patterns and rostered kilometres. The source does not specify the effective dates of these snapshots.

Owner command, run from this directory:

```powershell
npm run convert-master -- --input "C:/rosters/approved-master.pdf" --depot auburn --depot-name "Auburn Stabling Yard" --role guard --from 2026-11-01 --to 2026-11-14 --label "November guard master"
```

Use `--role driver` for driver masters. `--depot` is a lowercase slug; a new depot requires `--depot-name`. `--from` is required. `--to` is optional for an ongoing version. Use the dates when the master applies, not automatically its printed fortnight dates. The command writes parsed JSON and registers it in the catalogue; it does not copy or retain the original PDF. Verify extracted data before deploying the updated directory.

Published ranges for one depot/role must not overlap. When replacing an ongoing version, first set its `effectiveTo` in **both** its JSON and catalogue to the day before the new version starts. Masters must cover the entire requested fortnight. Missing, ambiguous, or unavailable masters offer a temporary upload or manual entry. Deployment can use any static web host; no database or server-side upload endpoint is needed.

Master JSON schema:

```json
{
  "schemaVersion": 1,
  "depot": "auburn",
  "role": "guard",
  "effectiveFrom": "2026-11-01",
  "effectiveTo": "2026-11-14",
  "label": "November guard master",
  "fileName": "approved-master.pdf",
  "rows": [{ "line": 10, "cells": ["14 parsed cell objects"] }]
}
```

The `cells` array uses the parser's full cell objects with `dayIndex`, `rawText`, `status`, `start`, `finish`, `jobNumber`, `duration`, `fCode`, `leaveCodes`, and `mileageOver209Candidate`. Employee names are excluded from the published master schema. Runtime maps and the job dictionary are rebuilt from these rows rather than serialising JavaScript Maps.

## Calculation and parser boundaries

- Users can select a bundled hourly preset or enter their payslip rate. Schedule 4B allowances follow the fortnight start date. The engine handles calendar-day penalties, standalone and scheduled overtime, leave, the fortnight guarantee and confirmed mileage or diagram claims. Check eligibility and claim details in the shift editor.
- Only current-roster rows with an uncrossed active crew name are selectable. Crossed-out former names and their notes are ignored. Recognised crew-column absence notes (AL, Sec/SecP, Inj, SL and other supported leave codes) exclude that occupant; day-level leave codes do not remove the whole line. The employee selector can be filtered by name or line number.
- Unknown entries and baseline/mileage flags require opening and saving the affected shift. Imported text remains available. The PDF reader detects the thin filled strike bars used by supported roster exports, including the thicker PER1 bars, before resolving replacement names and crew-column absence notes. Underlines and table borders are not treated as crossed-out names.
- Imports tick WOBOD when work appears on a master booked-off day without a work-swap marker. The checkbox can be edited during the fortnight review. WOBOD adds 50% to standalone overtime in the same fortnight's gross estimate, including when the fortnight contains sick leave.
- Times use native device time inputs, stored internally as HHMM. Overnight durations update automatically. Total worked must match start/finish, as required by the existing engine.
- Session edits survive navigation within the flow, including import failure followed by manual entry, but are deliberately not persisted across refreshes.
