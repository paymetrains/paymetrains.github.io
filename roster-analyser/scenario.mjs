import { readPdf } from "./pdf-reader.mjs";
import { parseRoster, toIsoDate, buildJobDictionary, shiftDurationMinutes } from "./roster-core.mjs";
import { hydrateMaster, hydrateReferenceMaster, selectMaster } from "./master-store.mjs";
import { calculateScenarioLine, activeScenarioRows } from "./scenario-model.mjs";
import { STATUS_LABELS, blankFortnight } from "./fortnight-model.mjs";
import { buildRosterJobReference } from "./roster-job-reference.mjs";
import { scenarioCsv, scenarioTimesheetCsv, timeClaimReference } from "./scenario-export.mjs";
import { scenarioWorkbook } from "./scenario-xlsx.mjs";
import { timesheetEntries } from "./scenario-timesheet.mjs";
import { kilometreClaimText } from "./scenario-kilometres.mjs";
import { timesheetPdf } from "./scenario-pdf.mjs";

const $ = id => document.getElementById(id);
const money = value => Number(value).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const time = value => value ? `${value.slice(0, 2)}:${value.slice(2)}` : "";
const dateLabel = date => new Date(`${date}T12:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
const updateGrades = window.PayEngine.bindRatePreset($("scenario-grade"), $("scenario-rate"));
let catalogue;
let report;
let referenceVersion = 0;
let referenceDownloadUrl;
let resultView = "roster";
let resultPeriod = "full";
let defunctCatalogue;
let calculationContext = null;
let kilometresByLine = {};

function kilometreCoverage(coverage = {}) {
  return coverage.numericKilometresComplete
    ? `All ${coverage.numericJobs} numbered defunct jobs have kilometre data. Generic standby times use the master line.`
    : `${coverage.kilometreEntries || 0} defunct kilometre records available; coverage is ${coverage.status || "unknown"}.`;
}

function visibleDates(dates) {
  return resultPeriod === "full" ? dates : resultPeriod === "week1" ? dates.slice(0, 7) : dates.slice(7, 14);
}

async function json(path) {
  const response = await fetch(new URL(path, import.meta.url), { cache: "no-cache" });
  if (!response.ok) throw new Error("A bundled roster could not be loaded. Upload a master in Comparison settings.");
  return response.json();
}

function updateSelection() {
  const role = $("scenario-role").value;
  updateGrades(role);
  $("scenario-grade").value = role === "guard" ? "Guard Thereafter" : "Driver Thereafter";
  $("scenario-grade").dispatchEvent(new Event("change"));
  const selected = defunctCatalogue?.masters.find(item => item.depot === $("scenario-depot").value && item.role === role);
  $("scenario-master-info").textContent = selected
    ? `Current and defunct masters are included. ${role === "driver" ? `${kilometreCoverage(selected.diagramCoverage)} Rostered and actual kilometres default to the current job diagram and can be edited.` : ""}`
    : "The current master is included. Upload this depot's defunct master in Comparison settings.";
  $("scenario-existing").value = "";
  $("scenario-defunct").value = "";
  previewReference();
}

async function bundledDefunct(depot, role) {
  const entry = defunctCatalogue?.masters.find(item => item.depot === depot && item.role === role);
  if (!entry || !/^[a-z-]+-(?:driver|guard)-defunct\.json$/.test(entry.path)) return null;
  return hydrateReferenceMaster(await json(`./data/scenarios/${entry.path}`));
}

async function previewReference() {
  const version = ++referenceVersion;
  $("scenario-reference-info").textContent = "Reading defunct job reference…";
  $("scenario-reference-table").innerHTML = "";
  $("scenario-reference-download").hidden = true;
  if (referenceDownloadUrl) URL.revokeObjectURL(referenceDownloadUrl);
  try {
    const file = $("scenario-defunct").files[0];
    let master;
    if (file) master = await uploadedMaster(file);
    else master = await bundledDefunct($("scenario-depot").value, $("scenario-role").value);
    if (!master) {
      $("scenario-reference-info").textContent = "Upload a defunct master to build its job reference.";
      return;
    }
    if (version !== referenceVersion) return;
    const reference = buildRosterJobReference(master);
    const jobs = Object.values(reference.jobs);
    const conflicts = jobs.filter(job => job.conflictingWeekdays.length);
    const imported = Object.entries(master.diagramData || {});
    const coverageText = $("scenario-role").value === "guard"
      ? "Guard comparison times come from the defunct master roster; diagram kilometres are not used."
      : `${imported.length} diagram time records. ${kilometreCoverage(master.diagramCoverage)} ${master.diagramCoverage?.photoDiagrams || 0} diagrams verified from owner photos.`;
    $("scenario-reference-info").textContent = `${jobs.length} job labels observed in ${reference.sourceFile}. ${coverageText} ${conflicts.length ? conflicts.map(job => job.job).join(", ") + " has line-specific times in the master." : ""}`;
    $("scenario-reference-table").innerHTML = `<table><caption>Imported diagrams and times observed in the defunct master</caption><thead><tr><th scope="col">Job</th><th scope="col">Start</th><th scope="col">Finish</th><th scope="col">Length</th><th scope="col">Km</th><th scope="col">Source</th></tr></thead><tbody>${imported.map(([job, diagram]) => `<tr><th scope="row">${escape(job)}<small>${escape(diagram.dayPattern)}</small></th><td>${escape(diagram.signOn)}</td><td>${escape(diagram.offDuty)}</td><td>${durationText(Math.round(diagram.rosteredHrs * 60))}</td><td>${typeof diagram.rosteredKm === "number" ? diagram.rosteredKm : escape(diagram.kilometresStatus || "Unknown")}</td><td>${diagram.referenceSource === "owner-supplied-photo" ? "Owner photo" : "Imported diagram"}${diagram.sourceFlag ? ` · ${escape(diagram.sourceFlag)}` : ""}</td></tr>`).join("")}${jobs.flatMap(job => job.variants.map(variant => `<tr><th scope="row">${escape(job.job)}<small>${escape(variant.weekdays.join(", "))}</small></th><td>${time(variant.start)}</td><td>${time(variant.finish)}</td><td>${durationText(variant.durationMinutes)}</td><td>Unknown</td><td>Master roster · inferred</td></tr>`)).join("")}</tbody></table>`;
    referenceDownloadUrl = URL.createObjectURL(new Blob([JSON.stringify({ ...reference, importedDiagrams: master.diagramData || {}, diagramCoverage: master.diagramCoverage || null }, null, 2)], { type: "application/json" }));
    $("scenario-reference-download").href = referenceDownloadUrl;
    $("scenario-reference-download").download = `defunct-${$("scenario-role").value}-job-reference.json`;
    $("scenario-reference-download").hidden = false;
  } catch (error) {
    if (version === referenceVersion) $("scenario-reference-info").textContent = error.message;
  }
}

async function uploadedMaster(file) {
  const raw = await readPdf(file);
  // Some draft PDFs merge the line heading with the first Sunday date.
  for (const page of raw.pages) {
    const header = page.items.find(item => /^Line\s+\d{1,2}\/\d{1,2}\/\d{4}$/.test(item.str));
    const sunday = page.items.find(item => item.str === "SUN");
    if (header && sunday) {
      header.str = header.str.replace(/^Line\s+/, "");
      header.x = sunday.x;
    }
  }
  const master = parseRoster(raw, "master");
  if (!master.rows.length || !master.rows.some(row => row.cells.some(cell => cell.status === "WORK")))
    throw new Error(`${file.name} has no recognised master roster shifts.`);
  master.jobDictionary = buildJobDictionary(master.rows);
  const headerText = raw.pages[0]?.text || "";
  const role = /\bGuards?\b/i.test(headerText) ? "guard" : /\bDrivers?\b/i.test(headerText) ? "driver" : null;
  if (role && role !== $("scenario-role").value)
    throw new Error(`${file.name} is a ${role} master. Check the selected role.`);
  return master;
}

async function loadMasters(current, depot, role) {
  const existingFile = $("scenario-existing").files[0];
  const defunctFile = $("scenario-defunct").files[0];
  let master;
  if (existingFile) master = await uploadedMaster(existingFile);
  else {
    const dated = selectMaster(catalogue.masters, depot, role, toIsoDate(current.dates[0]), toIsoDate(current.dates[13]));
    const entry = dated || catalogue.referenceMasters.find(item => item.depot === depot && item.role === role);
    if (!entry) throw new Error("Upload the existing master for this depot and role.");
    const base = new URL("./data/masters/", import.meta.url);
    const target = new URL(entry.path, base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new Error("Invalid master catalogue path.");
    const value = await json(target.href);
    master = dated ? hydrateMaster(value) : hydrateReferenceMaster(value);
  }
  if (!master.diagramData) {
    const diagrams = catalogue.referenceMasters.find(item => item.depot === depot && item.role === role);
    if (diagrams) master.diagramData = (await json(`./data/masters/${diagrams.path}`)).diagramData;
  }
  let defunct;
  if (defunctFile) defunct = await uploadedMaster(defunctFile);
  else defunct = await bundledDefunct(depot, role);
  if (!defunct) throw new Error("Upload the defunct master for this depot and role in Comparison settings.");
  defunct.rosterJobReference = buildRosterJobReference(defunct);
  return { master, defunct };
}

function shiftText(shift) {
  if (!shift) return "Line missing";
  if (!shift.start) return shift.job || shift.status || "No shift";
  return `Job ${shift.job || "Custom"} · ${time(shift.start)}–${time(shift.finish)}`;
}

function durationText(minutes) {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function shiftMarkup(shift, swapped = false) {
  if (!shift) return '<span class="hint">Line missing</span>';
  if (!shift.start) return `<span class="roster-status">${escape(shift.job || shift.status || "No shift")}</span>`;
  return `<strong>Job ${escape(shift.job || "Custom")}${swapped ? ' <span class="swap-label">(swapped)</span>' : ""}</strong><span>${time(shift.start)}–${time(shift.finish)}</span><small>${durationText(shiftDurationMinutes(shift.start, shift.finish))}</small>`;
}

function uploadedMarkup(day) {
  const shift = day.status === "work" ? shiftMarkup(day.worked, day.swapped) : `<span class="roster-status">${escape(STATUS_LABELS[day.status] || day.status)}</span>`;
  return shift + (day.swapped ? `<small>WS ${escape(day.swapLines.join(", "))}</small>` : "") +
    (day.wobod ? '<small class="roster-wobod">WOBOD</small>' : "");
}

function isHigherComparison(day, source) {
  return day.comparisons[source].amount > day.comparisons[source === "existing" ? "defunct" : "existing"].amount;
}

function masterMarkup(day, source) {
    const item = day.comparisons[source];
    const wins = isHigherComparison(day, source);
    const assignment = day[source];
    let basis = "";
    if (day.status === "work") {
      if (item.basis.source === "Worked roster") basis = "Custom duty · actual times";
      else if (source === "defunct" && assignment && ["OFF", "ADO"].includes(assignment.status) && !item.basis.source.includes("Defunct master job reference")) basis = `${assignment.status} · actual shift value`;
      else if (day.swapped || shiftText(item.basis) !== shiftText(assignment) || item.basis.source.includes("master job reference"))
        basis = `Against ${shiftText(item.basis)}${item.basis.source.includes("master job reference") ? " · job reference" : ""}`;
    }
    return `<div class="master-comparison"><div class="master-shift">${shiftMarkup(assignment)}</div><div class="master-value"><strong>${money(item.amount)}</strong>${wins ? "<small>Higher</small>" : ""}</div></div>${basis ? `<small class="master-basis">${escape(basis)}</small>` : ""}`;
}

function claimsMarkup(day) {
  const items = day.workedOnlyClaims.map(claim => {
    const label = claim.label.replace(/^Scheduled OT/, "Overtime").replace(/^Standalone overtime/, "WOBOD pay");
    return `<div class="pay-entry"><span>${escape(label)}${claim.minutes ? `<small>${durationText(claim.minutes)}</small>` : ""}</span><strong>${money(window.PayEngine.lineAmount(claim))}</strong></div>`;
  }).join("");
  const timeClaims = day.separateTimeClaims.map(claim => `<div class="pay-entry time-claim"><span>${escape(claim.label)} claim${claim.minutes ? `<small>${durationText(claim.minutes)}</small>` : ""}<small class="claim-reference">Against ${escape(timeClaimReference(claim, day.comparison))}</small></span><strong>${money(claim.amount)}</strong></div>`).join("");
  const kilometres = day.kilometres?.additionalPay ? `<div class="pay-entry time-claim"><span>Extra kilometre comparison<small>${escape(kilometreClaimText(day))}</small></span><strong>${money(day.kilometres.additionalPay)}</strong></div>` : "";
  return (items || '<p class="hint">No paid claim</p>') + timeClaims + kilometres +
    (day.wobod ? `<p class="scenario-note">WOBOD triggered by ${escape(day.wobodSources.join(" and "))} OFF/ADO.</p>` : "");
}

function breakdownMarkup(day) {
  return claimsMarkup(day) +
    `<p class="scenario-pay-total">Extra ${money(day.difference)}</p>` +
    (day.largeChange ? `<p class="scenario-note">Starts over 12 hours apart. ${report.alignment === "same-date" ? "Both starts use this roster date." : "Time credits for that comparison are excluded."}</p>` : "") +
    (day.status === "work" ? `<details class="comparison-alternatives"><summary>Comparisons tested</summary>${day.alternatives.map(item => `<p class="hint">${escape(item.source)} · ${escape(shiftText(item))} · ${escape(item.amendment)} · ${money(item.pay)}</p>`).join("")}</details>` : "");
}

function rosterMarkup(line, dates = visibleDates(line.dates)) {
  const sourceRows = [
    ["Existing master", day => masterMarkup(day, "existing"), "existing"],
    ["Defunct master", day => masterMarkup(day, "defunct"), "defunct"],
    ["Uploaded roster", uploadedMarkup],
    ["Daily breakdown", breakdownMarkup, null, "daily-breakdown"],
  ];
  return `<div class="roster-scroll" tabindex="0" role="region" aria-label="Line ${line.line} roster comparison, scroll to compare dates">
    <table class="roster-grid" style="--roster-days:${dates.length}"><caption class="visually-hidden">Line ${line.line} · existing master, defunct master, uploaded roster and daily claims</caption>
      <thead><tr><th scope="col">Line ${line.line}</th>${dates.map(day => `<th scope="col">${escape(dateLabel(day.date))}</th>`).join("")}</tr></thead>
      <tbody>${sourceRows.map(([label, cell, source, kind]) => `<tr><th scope="row">${label}</th>${dates.map(day => `<td class="${[kind, source && isHigherComparison(day, source) ? "comparison-higher" : ""].filter(Boolean).join(" ")}">${cell(day)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
}

function dayMarkup(day) {
  return `<section class="scenario-day"><h4>${escape(dateLabel(day.date))} · ${escape(STATUS_LABELS[day.status] || day.status)}</h4>
    ${day.status === "work" ? `<p>Uploaded · ${escape(shiftText(day.worked))}${day.swapped ? ` <span class="swap-label">(swapped)</span> · WS ${escape(day.swapLines.join(", "))}` : ""} · ${durationText(day.worked.minutes)}</p>` : ""}
    ${["existing", "defunct"].map(source => `<div class="daily-master${isHigherComparison(day, source) ? " comparison-higher" : ""}"><p class="hint">${source === "existing" ? "Existing" : "Defunct"} master</p>${masterMarkup(day, source)}</div>`).join("")}
    ${breakdownMarkup(day)}</section>`;
}

function timesheetMarkup(line, dates = visibleDates(line.dates)) {
  return `<div class="roster-scroll timesheet-scroll" tabindex="0" role="region" aria-label="Line ${line.line} timesheet summary, scroll to see all columns">
    <table class="timesheet-summary"><caption class="visually-hidden">Line ${line.line} timesheet claims</caption>
      <thead><tr>${["Date", "Job number", "Rostered start", "Actual start", "Rostered finish", "Actual finish", "Claims", "Job length"].map(label => `<th scope="col">${label}</th>`).join("")}</tr></thead>
      <tbody>${timesheetEntries(line, dates).map(row => `<tr><th scope="row">${escape(dateLabel(row.date))}</th><td>${escape(row.job)}${row.swapped ? ` <span class="swap-label">WS ${escape(row.swapLines.join(", "))}</span>` : ""}</td>
        <td>${row.rosteredStart || "—"}</td><td>${row.actualStart || "—"}</td><td>${row.rosteredFinish || "—"}</td><td>${row.actualFinish || "—"}</td>
        <td class="timesheet-claims">${row.claims.length ? row.claims.map(note => `<p>${escape(note)}</p>`).join("") : '<span class="hint">—</span>'}</td><td>${row.minutes == null ? "—" : durationText(row.minutes)}</td></tr>`).join("")}</tbody>
    </table></div><p class="hint">Rostered times: current master line for unswapped shifts; worked job's current reference for swapped shifts. MR comments give the defunct comparison. Job length is actual work only.</p>`;
}

function kilometreEditor(line) {
  return `<details class="scenario-kilometre-editor"><summary>Rostered and actual kilometres</summary>
    <p class="hint">Current job distances are prefilled when known. Edit either value. Defunct comparisons keep their own reference distances, including eligible RR diagrams at 0 km. Blank means unknown.</p>
    ${line.dates.filter(day => day.status === "work").map(day => `<fieldset><legend>${escape(dateLabel(day.date))} · ${escape(day.worked.job || "Custom")}</legend><div class="field-pair">
      ${["rosteredKm", "actualKm"].map(field => `<label>${field === "rosteredKm" ? "Rostered kilometres" : "Actual kilometres"}<input type="number" min="0" max="1000" step="0.001" inputmode="decimal" data-km-line="${line.line}" data-km-date="${day.date}" data-km-field="${field}" value="${day.kilometres?.[field] ?? ""}"></label>`).join("")}
      </div><p class="hint">Defunct reference ${escape(day.kilometres?.referenceJob || day.worked.job || "")}: ${day.kilometres?.defunctKm ?? "unknown"} km</p></fieldset>`).join("")}</details>`;
}

function renderLineDetail(element) {
  const target = element.querySelector(".scenario-line-detail");
  if (!element.open || target.childElementCount) return;
  const line = report.lines.find(item => item.line === Number(element.dataset.line));
  target.innerHTML = line.notes.map(note => `<p class="scenario-note">${escape(note)}</p>`).join("") +
    (resultView === "roster" ? rosterMarkup(line) : resultView === "timesheet" ? timesheetMarkup(line) : `<div class="scenario-day-list">${visibleDates(line.dates).map(dayMarkup).join("")}</div>`) +
    (resultPeriod !== "full" ? `<p class="scenario-pay-total">Week ${resultPeriod === "week1" ? "1" : "2"} daily extra ${money(visibleDates(line.dates).reduce((sum, day) => sum + day.difference, 0))}</p>` : "") +
    `<p class="scenario-pay-total">Fortnight daily extra ${money(line.dates.reduce((sum, day) => sum + day.difference, 0))} · Fortnight adjustment difference ${money(line.adjustmentDifference)} · Fortnight total extra ${money(line.difference)}</p>` +
    (report.role === "driver" ? kilometreEditor(line) : "");
}

function filteredLines() {
  const query = $("scenario-filter").value.toLowerCase().replace(/^line\s*/, "").trim();
  return report.lines.filter(line => String(line.line).includes(query));
}

function spreadsheetLines() {
  const query = $("scenario-filter").value.toLowerCase().replace(/^line\s*/, "").trim();
  const results = new Map(report.lines.map(line => [line.line, line]));
  return (report.rosterLines || report.lines.map(line => ({ line: line.line, hasNormalJobs: line.dates?.some(day => day.status === "work" && /^(?:\d+|SBY|FREELANCE)$/i.test(day.worked.job)) })))
    .filter(line => String(line.line).includes(query))
    .map(line => !line.hasNormalJobs || !results.has(line.line) ? { line: line.line, blank: true } : results.get(line.line));
}

function periodLabel() {
  return resultPeriod === "full" ? "Full fortnight" : resultPeriod === "week1" ? "Week 1" : "Week 2";
}

function renderLines() {
  if (!report) return;
  const dates = visibleDates(report.dates);
  $("scenario-period-dates").textContent = `${periodLabel()} · ${dateLabel(dates[0])}–${dateLabel(dates.at(-1))}`;
  const lines = filteredLines();
  const excelLines = spreadsheetLines();
  $("scenario-export-scope").textContent = `PDF/CSV: ${lines.length} ${lines.length === 1 ? "line" : "lines"} · Excel: ${excelLines.length} line numbers (${excelLines.filter(line => line.blank).length} blank) · ${periodLabel()} · ${dateLabel(dates[0])}–${dateLabel(dates.at(-1))}`;
  for (const id of ["scenario-pdf", "scenario-csv"]) $(id).disabled = !lines.length;
  $("scenario-xlsx").disabled = !spreadsheetLines().length;
  $("scenario-export-status").textContent = "";
  const openLines = new Set([...$("scenario-lines").querySelectorAll("details[data-line][open]")].map(element => Number(element.dataset.line)));
  $("scenario-lines").innerHTML = lines.map(line => {
    if (line.error) return `<details class="scenario-line"><summary><span>Line ${line.line}</span><strong>Check entry</strong></summary><p class="scenario-note">${escape(line.error)}</p></details>`;
    return `<details class="scenario-line" data-line="${line.line}" ${openLines.has(line.line) ? "open" : ""}>
      <summary><span>Line ${line.line}</span><span><strong class="scenario-extra">${money(line.difference)} extra</strong><small>Scenario gross ${money(line.maximum)}</small></span></summary>
      <div class="scenario-line-detail"></div>
    </details>`;
  }).join("");
  for (const element of $("scenario-lines").querySelectorAll("[data-line]")) {
    element.addEventListener("toggle", () => renderLineDetail(element));
    renderLineDetail(element);
  }
}

$("scenario-form").onsubmit = async event => {
  event.preventDefault();
  if (!catalogue) return;
  $("scenario-results").hidden = true;
  report = null;
  calculationContext = null;
  kilometresByLine = {};
  $("scenario-status").className = "";
  const controls = [...$("scenario-form").querySelectorAll("input, select, button")];
  controls.forEach(control => { control.disabled = true; });
  $("scenario-form").setAttribute("aria-busy", "true");
  try {
    const depot = $("scenario-depot").value;
    const role = $("scenario-role").value;
    const rate = Number($("scenario-rate").value);
    const alignment = $("scenario-alignment").value;
    const weekdayOvertimeAfterFourth = Number($("scenario-later-rate").value);
    $("scenario-status").textContent = "Reading fortnight roster…";
    const raw = await readPdf($("scenario-current").files[0], { detectStrikes: true });
    const current = parseRoster(raw, "fortnight");
    if (current.dates.length !== 14) throw new Error("The current roster needs a recognised 14-day date heading.");
    const expected = blankFortnight(toIsoDate(current.dates[0])).map(row => row.date);
    if (current.pages.some(page => page.dates.length !== 14 || page.dates.some((date, index) => toIsoDate(date) !== expected[index])))
      throw new Error("Choose one consecutive Sunday-to-Saturday fortnight across all pages.");
    const header = raw.pages[0]?.text || "";
    const detectedRole = /\bGuards?\s+Rosters?\b/i.test(header) ? "guard" : /\bDrivers?\s+Rosters?\b/i.test(header) ? "driver" : null;
    if (detectedRole && detectedRole !== role) throw new Error(`This is a ${detectedRole} roster. Check the role selection.`);
    const detectedDepot = header.match(/Depot:\s*(.*?)(?:\s+Layer:|\s+Fortnight ending)/i)?.[1];
    const selectedDepot = catalogue.depots.find(item => item.id === depot)?.name;
    const normalise = text => text.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (detectedDepot && selectedDepot && normalise(detectedDepot) !== normalise(selectedDepot))
      throw new Error(`This roster is for ${detectedDepot.trim()}. Check the selected depot.`);
    const unique = new Set(current.rows.map(row => row.line));
    if (unique.size !== current.rows.length) throw new Error("The fortnight PDF repeats line numbers. Choose one depot and role.");
    const { master, defunct } = await loadMasters(current, depot, role);
    calculationContext = { engine: window.PayEngine, master, defunct, current, role, rate, alignment, weekdayOvertimeAfterFourth };
    const named = activeScenarioRows(master, current);
    if (!named.length) throw new Error("No named, active crew lines were found in this roster.");
    report = { generatedAt: new Date().toISOString(), depot, role, rate, alignment, weekdayOvertimeAfterFourth,
      current: raw.fileName, existingMaster: master.fileName || "Bundled existing master", defunctMaster: defunct.fileName || "Bundled defunct master", diagramCoverage: defunct.diagramCoverage || null, kilometreAssumption: role === "driver" ? "editable-rostered-and-actual-kilometres" : null,
      dates: current.dates.map(toIsoDate), skippedInactive: current.rows.filter(row => row.employeeName.trim()).length - named.length,
      rosterLines: current.rows.map(row => ({ line: row.line, hasNormalJobs: row.cells.some(cell => cell.status === "WORK" && /^(?:\d+|SBY|FREELANCE)$/i.test(cell.jobNumber)) })).sort((a, b) => a.line - b.line), lines: [] };
    for (const [index, row] of named.entries()) {
      $("scenario-status").textContent = `Calculating line ${row.line} · ${index + 1} of ${named.length}…`;
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        if (!master.lines.has(row.line) || !defunct.lines.has(row.line)) throw new Error("This line is missing from one of the masters.");
        const { employeeName, ...line } = calculateScenarioLine({ engine: window.PayEngine, master, defunct, current, line: row.line, rate, role, alignment, weekdayOvertimeAfterFourth });
        report.lines.push(line);
      } catch (error) {
        const date = error.message.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
        const index = report.dates.indexOf(date);
        const rawText = index >= 0 ? row.cells[index]?.rawText : "";
        report.lines.push({ line: row.line, error: error.message + (rawText ? ` Entry: ${rawText}` : "") });
      }
    }
    report.lines.sort((a, b) => a.line - b.line);
    const priced = report.lines.filter(line => !line.error);
    $("scenario-context").textContent = `${dateLabel(report.dates[0])}–${dateLabel(report.dates[13])} · ${role === "guard" ? "Guard" : "Driver"} · ${money(rate)}/hour. Fifth and later weekday WOBOD rate assumed at ${weekdayOvertimeAfterFourth * 100}% plus 50% on worked time. ${alignment === "same-date" ? "Time comparisons use the same roster date." : "Time credits are excluded for starts over 12 hours apart."}${role === "driver" ? " Rostered and actual kilometres default to the current job diagram; entered values override these defaults. Missing kilometre data remain unknown." : ""}`;
    $("scenario-total").textContent = `${priced.length} lines calculated · ${money(priced.reduce((sum, line) => sum + line.difference, 0))} total extra${priced.length !== named.length ? ` · ${named.length - priced.length} lines need an entry checked` : ""}${report.skippedInactive ? ` · ${report.skippedInactive} seconded lines excluded` : ""}`;
    $("scenario-filter").value = "";
    renderLines();
    $("scenario-results").hidden = false;
    $("scenario-status").textContent = "Comparison complete. Open a line for its dated claims and comparison jobs.";
    $("scenario-results-title").focus({ preventScroll: true });
    $("scenario-results").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    report = null;
    $("scenario-status").className = "error";
    $("scenario-status").textContent = error.message;
  } finally {
    controls.forEach(control => { control.disabled = false; });
    $("scenario-form").setAttribute("aria-busy", "false");
  }
};
$("scenario-filter").oninput = renderLines;
$("scenario-lines").addEventListener("change", event => {
  const input = event.target.closest("[data-km-line]");
  if (!input || !report || !calculationContext) return;
  if (!input.checkValidity()) { input.reportValidity(); return; }
  const line = Number(input.dataset.kmLine);
  const editorOpen = input.closest("details")?.open;
  const date = input.dataset.kmDate;
  const fields = input.closest("fieldset").querySelectorAll("[data-km-field]");
  const values = Object.fromEntries([...fields].map(field => [field.dataset.kmField, field.value]));
  const kilometres = { ...kilometresByLine[line], [date]: values };
  try {
    const { employeeName, ...result } = calculateScenarioLine({ ...calculationContext, line, kilometresByDate: kilometres });
    kilometresByLine[line] = kilometres;
    report.lines[report.lines.findIndex(item => item.line === line)] = result;
    renderLines();
    if (editorOpen) $("scenario-lines").querySelector(`details[data-line="${line}"] .scenario-kilometre-editor`).open = true;
    const priced = report.lines.filter(item => !item.error);
    const unpriced = report.lines.length - priced.length;
    $("scenario-total").textContent = `${priced.length} lines calculated · ${money(priced.reduce((sum, item) => sum + item.difference, 0))} total extra${unpriced ? ` · ${unpriced} lines not priced` : ""}${report.skippedInactive ? ` · ${report.skippedInactive} seconded lines excluded` : ""}`;
    $("scenario-status").textContent = `Line ${line} recalculated with rostered and actual kilometres.`;
  } catch (error) { $("scenario-status").textContent = error.message; }
});
for (const button of document.querySelectorAll("[data-result-period]")) button.onclick = () => {
  resultPeriod = button.dataset.resultPeriod;
  for (const item of document.querySelectorAll("[data-result-period]")) item.setAttribute("aria-pressed", String(item === button));
  renderLines();
};
for (const button of document.querySelectorAll("[data-result-view]")) button.onclick = () => {
  resultView = button.dataset.resultView;
  for (const item of document.querySelectorAll("[data-result-view]")) item.setAttribute("aria-pressed", String(item === button));
  $("roster-scroll-hint").hidden = resultView !== "roster";
  renderLines();
};
$("scenario-role").onchange = updateSelection;
$("scenario-depot").onchange = updateSelection;
$("scenario-defunct").onchange = previewReference;
$("scenario-grade").addEventListener("change", () => { $("scenario-custom-rate").hidden = Boolean($("scenario-grade").value); });
$("scenario-form").addEventListener("change", () => { report = null; $("scenario-results").hidden = true; $("scenario-status").textContent = ""; });
$("scenario-xlsx").onclick = async () => {
  if (!report) return;
  const source = report;
  const lines = spreadsheetLines();
  const period = resultPeriod;
  const view = resultView;
  if (!lines.length) return;
  const button = $("scenario-xlsx");
  button.disabled = true;
  $("scenario-export-status").textContent = "Preparing roster spreadsheet…";
  try {
    const buffer = await scenarioWorkbook(source, lines, period, window.PayEngine.lineAmount, view);
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${view === "timesheet" ? "timesheet" : "roster"}-scenario-${source.role}-${source.dates[0]}-${period}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("scenario-export-status").textContent = `Spreadsheet exported · ${lines.length} line numbers · ${lines.filter(line => line.blank).length} blank lines.`;
  } catch (error) {
    $("scenario-export-status").textContent = `Excel export failed: ${error.message}`;
  } finally {
    button.disabled = !report || !spreadsheetLines().length;
  }
};
$("scenario-csv").onclick = () => {
  if (!report || !filteredLines().length) return;
  const csv = resultView === "timesheet" ? scenarioTimesheetCsv(filteredLines(), visibleDates) : scenarioCsv(filteredLines(), visibleDates, window.PayEngine.lineAmount);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${resultView === "timesheet" ? "timesheet" : "roster"}-scenario-${report.role}-${report.dates[0]}-${resultPeriod}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("scenario-pdf").onclick = async () => {
  if (!report || !filteredLines().length) return;
  if (resultView === "timesheet") {
    const button = $("scenario-pdf");
    button.disabled = true;
    $("scenario-export-status").textContent = "Preparing landscape timesheet PDF…";
    try {
      const source = report;
      const lines = filteredLines();
      const period = resultPeriod;
      const blob = await timesheetPdf(source, lines, period);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `timesheet-scenario-${source.role}-${source.dates[0]}-${period}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $("scenario-export-status").textContent = `Landscape timesheet PDF exported · ${lines.length} lines.`;
    } catch (error) {
      $("scenario-export-status").textContent = error.message;
    } finally {
      button.disabled = false;
    }
    return;
  }
  const sections = filteredLines().flatMap(line => {
    if (line.error) return [`<section class="print-line"><h1>Line ${line.line}</h1><p>${escape(line.error)}</p></section>`];
    const periods = resultView === "timesheet" && resultPeriod === "full"
      ? [{ label: "Full fortnight", dates: line.dates }]
      : (resultPeriod === "full" ? [0, 1] : [resultPeriod === "week1" ? 0 : 1]).map(week => ({ label: `Week ${week + 1}`, dates: line.dates.slice(week * 7, week * 7 + 7) }));
    return periods.map(({ label, dates }) => {
      return `<section class="print-line${resultView === "timesheet" ? " print-timesheet" : ""}${dates.some(day => day.kilometres?.claimedExtraKm) ? " print-with-kilometres" : ""}"><h1>${resultView === "timesheet" ? "Timesheet summary" : "Roster scenario"} · Line ${line.line} · ${label}</h1>
        <p class="print-context">${escape(report.current)} · ${escape(report.role)} · ${money(report.rate)}/hour · ${escape(dateLabel(dates[0].date))}–${escape(dateLabel(dates.at(-1).date))}<br>Current: ${escape(report.existingMaster)} · Defunct: ${escape(report.defunctMaster)}<br>${report.alignment === "same-date" ? "Time comparisons use the same roster date." : "Time credits excluded for starts over 12 hours apart."} Fifth and later weekday WOBOD: ${report.weekdayOvertimeAfterFourth * 100}% plus 50% on worked time.${report.role === "driver" ? `<br>Rostered and actual kilometres default to the current job diagram; entered values override these defaults. Defunct diagram coverage: ${escape(report.diagramCoverage?.status || "unknown")}; missing distances remain unknown.` : ""}</p>
        ${resultView === "timesheet" ? timesheetMarkup(line, dates) : rosterMarkup(line, dates)}
        <p class="print-totals"><strong>${label === "Full fortnight" ? "Fortnight" : label} daily extra ${money(dates.reduce((sum, day) => sum + day.difference, 0))}</strong><br>Fortnight baseline ${money(line.baseline)} · Fortnight scenario gross ${money(line.maximum)} · Fortnight adjustment difference ${money(line.adjustmentDifference)} · <strong>Fortnight total extra ${money(line.difference)}</strong></p>
        <p class="print-context">${resultView === "timesheet" ? "MR marks a defunct-roster claim. Job length is actual work only." : "Green marks the higher daily comparison. Actual work and separate time claims are shown separately."} Unofficial train crew pay calculator.</p></section>`;
    });
  }).join("");
  document.getElementById("scenario-print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.id = "scenario-print-frame";
  frame.title = "Scenario PDF export";
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;";
  frame.onload = async () => {
    await frame.contentDocument.fonts.ready;
    frame.contentWindow.addEventListener("afterprint", () => frame.remove(), { once: true });
    frame.contentWindow.focus();
    frame.contentWindow.print();
  };
  const style = path => `<link rel="stylesheet" href="${new URL(path, import.meta.url).href}">`;
  frame.srcdoc = `<!doctype html><html lang="en-AU" data-theme="light"><head><meta charset="utf-8"><title>Roster scenario ${report.dates[0]} ${resultPeriod}</title>${style("./scenario.css")}${style("./scenario-print.css")}</head><body>${sections}</body></html>`;
  document.body.append(frame);
};
$("scenario-download").onclick = () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `roster-scenario-${report.role}-${report.dates[0]}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
try {
  [catalogue, defunctCatalogue] = await Promise.all([json("./data/masters/index.json"), json("./data/scenarios/index.json")]);
  $("scenario-depot").innerHTML = catalogue.depots.map(depot => `<option value="${escape(depot.id)}">${escape(depot.name)}</option>`).join("");
  updateSelection();
} catch (error) {
  $("scenario-status").textContent = error.message;
}
