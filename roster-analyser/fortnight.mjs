import { readPdf } from "./pdf-reader.mjs";
import { parseRoster, toIsoDate } from "./roster-core.mjs";
import { hydrateMaster, hydrateReferenceMaster, selectMaster } from "./master-store.mjs";
import { breakdownEntries, buildPayslip } from "./payslip.mjs";
import {
  blankFortnight,
  importLine,
  prefillMasterLine,
  clock,
  displayClock,
  durationBetween,
  isTimedRelinquishment,
  relinquishmentStatus,
  validateShift,
  toEngineTable,
  STATUS_LABELS,
  LEAVE_STATUSES,
  FIXED_PAID_STATUSES,
} from "./fortnight-model.mjs";

const $ = (id) => document.getElementById(id);
const updateRatePresets = window.PayEngine.bindRatePreset($("pay-classification"), $("pay-rate"));
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const state = {
  mode: "import",
  screen: "select",
  catalogue: { depots: [], masters: [] },
  current: null,
  override: null,
  rows: [],
  originals: [],
  week: 0,
  editor: null,
  busy: false,
  settingsVersion: 0,
  selectionKey: "",
  employeeName: "",
  line: "",
  result: null,
};
const money = (value) =>
  Number(value).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const niceDate = (iso, options = { day: "numeric", month: "short" }) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-AU", options);
const depotId = () =>
  $("depot").value === "other"
    ? $("other-depot").value.trim()
    : $("depot").value;
const depotName = () =>
  $("depot").value === "other"
    ? $("other-depot").value.trim()
    : $("depot").selectedOptions[0].textContent;

function notice(message = "", error = false) {
  $("notice").textContent = message;
  $("notice").className = error ? "error" : "";
  $("notice").hidden = !message;
}
function setBusy(value, message) {
  state.busy = value;
  $("select-form").setAttribute("aria-busy", String(value));
  for (const input of document.querySelectorAll(
    "#select-form input, #select-form select, #select-form button, .mode-switch button",
  ))
    input.disabled = value;
  $("review-button").textContent = value
    ? "Reading roster…"
    : "Preview roster";
  if (message) notice(message);
}
async function task(callback) {
  if (state.busy) return;
  setBusy(true);
  notice();
  try {
    await callback();
  } catch (error) {
    notice(
      error.message ||
        "Unable to read this roster. You can enter your shifts manually.",
      true,
    );
  } finally {
    setBusy(false);
  }
}
function go(screen) {
  state.screen = screen;
  for (const name of ["select", "review", "result"]) {
    $(`${name}-screen`).hidden = name !== screen;
    if (name === screen) $(`step-${name}`).setAttribute("aria-current", "step");
    else $(`step-${name}`).removeAttribute("aria-current");
  }
  notice();
  $(`${screen}-title`).focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}
function canLeaveEditor() {
  if (state.editor !== null) {
    notice("Save or cancel the open shift before continuing.", true);
    return false;
  }
  return true;
}
function setMode(mode) {
  state.mode = mode;
  $("import-fields").hidden = mode !== "import";
  $("manual-fields").hidden = mode !== "manual";
  $("start-date").required = mode === "manual";
  $("manual-line").required = mode === "import";
  $("import-mode").setAttribute("aria-pressed", String(mode === "import"));
  $("manual-mode").setAttribute("aria-pressed", String(mode === "manual"));
  $("import-mode").hidden = mode === "import";
  $("manual-mode").hidden = mode === "manual";
  notice();
  updateMaster();
}
function masterDescription() {
  const role = $("role").value;
  if (state.override)
    return `Using ${state.override.fileName} for this session only. The supplied master has not been changed.`;
  const entries = state.catalogue.masters.filter(
    (entry) => entry.depot === depotId() && entry.role === role,
  );
  const fallback = bundledReference()
    ? "Using the bundled master. Check that it matches your fortnight."
    : null;
  if (!entries.length)
    return fallback || "No supplied master for this depot and role yet. Upload one for this session, or enter manually.";
  if (state.current) {
    try {
      const entry = datedMaster();
      if (!entry)
        return fallback || "No master covers this entire fortnight. Upload the correct master, or enter manually.";
      return `${entry.label || "Supplied master"} · effective ${niceDate(entry.effectiveFrom)}${entry.effectiveTo ? ` to ${niceDate(entry.effectiveTo)}` : " onwards"}.`;
    } catch (error) {
      return error.message;
    }
  }
  return `${entries.length} supplied master${entries.length === 1 ? "" : "s"} available. The fortnight dates will select the matching version.`;
}
function bundledReference() {
  return state.catalogue.referenceMasters?.find(
    (entry) => entry.depot === depotId() && entry.role === $("role").value,
  );
}
function datedMaster() {
  const dates = state.mode === "manual" || !state.current
    ? blankFortnight($("start-date").value).map(row => row.date)
    : state.current.dates.map(toIsoDate);
  return selectMaster(
    state.catalogue.masters, depotId(), $("role").value,
    dates[0], dates[13],
  );
}
function updateMaster() {
  $("master-info").textContent = masterDescription();
  $("clear-master").hidden = !state.override;
  $("review-button").hidden = state.mode === "import" && !state.current;
  updateManualLines();
}
let manualLoadVersion = 0;
async function updateManualLines() {
  const version = ++manualLoadVersion;
  if (state.mode === "import" && state.current) {
    renderEmployees();
    return;
  }
  const select = $("manual-line");
  const previous = select.value;
  select.innerHTML = `<option value="">${state.mode === "manual" ? "Enter without a line" : "Select your line"}</option>`;
  $("manual-line-info").textContent = "Loading master roster lines…";
  try {
    blankFortnight($("start-date").value);
    if (!state.override && !datedMaster() && !bundledReference()) {
      $("manual-line-info").textContent = state.mode === "manual"
        ? "Upload a master to prefill a line, or enter your shifts yourself."
        : "Upload your roster to find your line.";
      return;
    }
    const master = await loadMaster();
    if (version !== manualLoadVersion) return;
    select.innerHTML += [...master.lines.keys()].sort((a, b) => a - b)
      .map(line => `<option value="${line}">Line ${line}</option>`).join("");
    if (master.lines.has(Number(previous))) select.value = previous;
    $("manual-line-info").textContent = state.mode === "manual"
      ? "Optional. Start with your master shifts, then edit worked times, swaps and leave."
      : "";
  } catch (error) {
    if (version === manualLoadVersion)
      $("manual-line-info").textContent = `${error.message} You can enter without a line.`;
  }
}
function settingsChanged() {
  state.settingsVersion++;
  state.override = null;
  $("master-file").value = "";
  $("manual-line").value = "";
  state.current = null;
  $("current-file").value = "";
  $("current-info").textContent = "";
  $("other-depot-field").hidden = $("depot").value !== "other";
  $("other-depot").required = $("depot").value === "other";
  updatePayGrades();
  updateMaster();
  notice();
}
function renderEmployees() {
  const selected = $("manual-line").value;
  const rows = (state.current?.rows || []).filter(
    (row) =>
      row.employeeName.trim() &&
      !row.seconded,
  );
  $("manual-line").innerHTML =
    '<option value="">Select your line</option>' +
    rows
      .map(
        (row) =>
          `<option value="${row.line}">${escape(`Line ${row.line} · ${row.employeeName}`)}</option>`,
      )
      .join("");
  if (rows.some((row) => String(row.line) === selected))
    $("manual-line").value = selected;
  $("manual-line-info").textContent = "";
}
async function readCurrent() {
  state.current = null;
  $("current-info").textContent = "Reading PDF…";
  const file = $("current-file").files[0];
  if (!file) {
    $("current-info").textContent =
      "Choose a PDF to find your fortnight and employee line.";
    updateMaster();
    return;
  }
  try {
    const raw = await readPdf(file, { detectStrikes: true });
    const parsed = parseRoster(raw, "fortnight");
    const header = raw.pages[0]?.text || "";
    parsed.detectedRole = /\bGuards?\s+Rosters?\b/i.test(header)
      ? "guard"
      : /\bDrivers?\s+Rosters?\b/i.test(header)
        ? "driver"
        : null;
    parsed.detectedDepot =
      header
        .match(/Depot:\s*(.*?)(?:\s+Layer:|\s+Fortnight ending)/i)?.[1]
        ?.trim() || "";
    const named = parsed.rows.filter((row) => row.employeeName.trim());
    const seconded = named.filter((row) => row.seconded).length;
    if (named.length === seconded)
      throw new Error(
        "No named employee lines were found. Try another PDF or enter manually.",
      );
    if (parsed.dates.length !== 14)
      throw new Error("The roster needs a recognised 14-day date heading.");
    const expected = blankFortnight(toIsoDate(parsed.dates[0])).map(
      (row) => row.date,
    );
    if (
      parsed.pages.some((page) =>
        page.dates.some((date, index) => toIsoDate(date) !== expected[index]),
      )
    ) {
      throw new Error(
        "The pages do not share one consecutive Sunday-to-Saturday fortnight. Choose a single fortnight roster.",
      );
    }
    const lines = parsed.rows.map((row) => row.line);
    if (new Set(lines).size !== lines.length)
      throw new Error(
        "The PDF contains repeated line numbers. Choose a roster containing one depot and role.",
      );
    state.current = parsed;
    renderEmployees();
    $("current-info").textContent =
      `${niceDate(expected[0])}–${niceDate(expected[13])} ${parsed.dates[0].getFullYear()} · ${named.length - seconded} eligible lines${seconded ? ` · ${seconded} seconded out` : ""}`;
  } catch (error) {
    $("current-info").textContent =
      "This PDF could not be imported. Try another file or choose Enter manually.";
    throw error;
  } finally {
    updateMaster();
  }
}
async function loadMaster() {
  if (state.override) return state.override;
  const dated = datedMaster();
  const entry = dated || bundledReference();
  if (!entry)
    throw new Error(
      "Upload a master for this depot and role, or choose Enter manually.",
    );
  const base = new URL("./data/masters/", import.meta.url);
  const url = new URL(entry.path, base);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    !url.pathname.endsWith(".json")
  ) {
    throw new Error("The master catalogue contains an invalid JSON path.");
  }
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok)
    throw new Error(
      "The supplied master could not be loaded. Upload a temporary master or enter manually.",
    );
  const value = await response.json();
  const master = dated ? hydrateMaster(value) : hydrateReferenceMaster(value);
  if (
    master.depot !== entry.depot ||
    master.role !== entry.role ||
    (dated && (master.effectiveFrom !== entry.effectiveFrom ||
      (master.effectiveTo || null) !== (entry.effectiveTo || null)))
  )
    throw new Error(
      "The supplied master metadata does not match its catalogue entry.",
    );
  return master;
}
async function startReview() {
  if (!depotId()) throw new Error("Enter your depot name.");
  validatePayGrade();
  const key = JSON.stringify(
    state.mode === "manual"
      ? [
          "manual",
          depotId(),
          $("role").value,
          $("start-date").value,
          $("manual-name").value,
          $("manual-line").value,
          state.settingsVersion,
        ]
      : [
          "import",
          state.settingsVersion,
          $("manual-line").value,
          state.current?.fileName,
          state.override?.fileName,
        ],
  );
  if (state.selectionKey === key && state.rows.length) {
    go("review");
    renderReview();
    return;
  }
  if (state.rows.some((row) => row.edited)) {
    if (
      !window.confirm(
        "Changing the roster selection replaces your current shifts and edits. Continue?",
      )
    )
      return;
  }
  let data;
  if (state.mode === "manual") {
    data = {
      rows: blankFortnight($("start-date").value),
      employeeName: $("manual-name").value.trim(),
      line: "",
      rosterType: "long",
      warnings: [],
      masterSource: null,
    };
    if ($("manual-line").value) {
      const master = await loadMaster();
      data = prefillMasterLine(master, $("manual-line").value, $("start-date").value, $("manual-name").value);
      data.masterSource = master.source === "bundled" ? "bundled" : null;
    }
  } else {
    if (!state.current)
      throw new Error(
        "Upload a current fortnight roster, or choose Enter manually.",
      );
    if (
      state.current.detectedRole &&
      state.current.detectedRole !== $("role").value
    ) {
      throw new Error(
        `This PDF is a ${state.current.detectedRole} roster. Check the role selection or choose another PDF.`,
      );
    }
    const normalise = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      state.current.detectedDepot &&
      normalise(state.current.detectedDepot) !== normalise(depotName())
    ) {
      throw new Error(
        `This PDF is for ${state.current.detectedDepot}. Check the depot selection or choose another PDF.`,
      );
    }
    if (!$("manual-line").value)
      throw new Error("Select your line.");
    const master = await loadMaster();
    data = importLine(master, state.current, $("manual-line").value);
    data.masterSource = master.source === "bundled" ? "bundled" : null;
  }
  Object.assign(state, data, {
    selectionKey: key,
    originals: structuredClone(data.rows),
    week: 0,
    editor: null,
    role: $("role").value,
    depot: depotName(),
    result: null,
  });
  if (!$("roster-type").dataset.userSelected) $("roster-type").value = data.rosterType;
  updatePaySettings();
  go("review");
  renderReview();
}
function renderReview() {
  $("review-person").textContent = state.employeeName
    ? `${state.employeeName}${state.line ? ` · Line ${state.line}` : ""}`
    : state.line ? `Line ${state.line}` : "Your shifts";
  $("review-context").textContent =
    `${state.depot} · ${state.role === "driver" ? "Driver" : "Guard"} · ${niceDate(state.rows[0].date)}–${niceDate(state.rows[13].date)}`;
  $("preview-pay").textContent = `${$("pay-classification").value || "Custom rate"} · ${money($("pay-rate").value)}/hour`;
  $("review-warning").hidden = state.mode !== "import";
  $("review-warning").textContent =
    `${state.masterSource ? "Using the bundled master. Check that it matches your fortnight. " : ""}${state.mode === "manual" ? state.line ? "Shifts start from your master roster. Confirm actual worked times, swaps and leave." : "Enter your worked shifts and leave." : "Check shifts, leave, crossed-out entries and replacement names against your PDF."}${state.warnings?.length ? " Check the fortnight type and days off: counts differ from the master." : ""}`;
  for (const button of document.querySelectorAll("[data-week]"))
    button.setAttribute(
      "aria-pressed",
      String(Number(button.dataset.week) === state.week),
    );
  const start = state.week * 7;
  $("week-dates").textContent =
    `${niceDate(state.rows[start].date)}–${niceDate(state.rows[start + 6].date)}`;
  $("shift-list").innerHTML = state.rows
    .slice(start, start + 7)
    .map((row) => {
      const active = row.dayIndex === state.editor;
      const work = row.status === "work";
      const title = work
        ? `${displayClock(row.actualStart)}–${displayClock(row.actualFinish)}`
        : STATUS_LABELS[row.status];
      const job = work && row.changeType === "custom_duty"
        ? row.jobLabel || "Custom duty"
        : row.jobNumber
        ? `Job ${row.jobNumber}`
        : row.jobLabel ||
          (row.status === "blank" ? "Tap to enter a shift" : "");
      const shiftDetails = [job, ...(row.swapLines || []).map(line => `WS ${line}`)];
      if (work && row.wobod) shiftDetails.push("WOBOD");
      if (row.ph && row.status !== "hol") shiftDetails.push("Public holiday");
      const original = row.workSwap
        ? `<span class="shift-job">Originally ${escape(formatSwapShift(row.workSwap.original))}</span>`
        : "";
      return `<article class="shift ${!work ? "shift-muted" : ""} ${row.edited ? "edited" : ""}" id="shift-${row.dayIndex}">
      <button type="button" class="shift-toggle" data-edit="${row.dayIndex}" aria-expanded="${active}" aria-controls="editor-${row.dayIndex}" aria-label="Edit ${escape(niceDate(row.date))}: ${escape(title)}">
      <span class="shift-date"><strong>${niceDate(row.date, { weekday: "short" })}</strong>${niceDate(row.date)}</span>
      <span><span class="shift-time">${escape(title)}</span><span class="shift-job">${escape(shiftDetails.filter(Boolean).join(" · "))}</span>${original}${!row.reviewed ? '<span class="shift-attention">Needs review</span>' : ""}</span>
      <span class="edit-label">${active ? "Editing" : "Edit"}</span></button>
      <div id="editor-${row.dayIndex}" ${active ? "" : "hidden"}>${active ? editorMarkup(row) : ""}</div></article>`;
    })
    .join("");
  const pending = state.rows.filter((row) => !row.reviewed).length;
  $("review-footer").hidden = state.editor !== null;
  $("review-count").textContent = pending
    ? `${pending} shift${pending === 1 ? "" : "s"} need review. Save each after checking.`
    : `${state.rows.filter((row) => row.status === "work").length} worked shifts · All entries ready for review`;
  if (state.editor !== null) wireEditor();
}
function formatSwapShift(shift) {
  if (!shift || shift.status === "BLANK") return "no roster entry";
  if (shift.status === "CROSSED_OUT") return "crossed out";
  if (shift.status !== "WORK") return shift.status;
  const times = `${displayClock(shift.start)}–${displayClock(shift.finish)}`;
  const job = shift.jobNumber || shift.jobLabel;
  return job ? `${job} · ${times}` : times;
}

function timeField(name, label, value) {
  return `<label>${label}<input type="time" id="${name}" name="${name}" value="${escape(displayClock(value))}" step="60"></label>`;
}
function checkbox(name, label, checked) {
  return `<label class="check-label"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}>${label}</label>`;
}
function numberField(name, label, value) {
  return `<label>${label}<input type="number" name="${name}" min="0" step="any" inputmode="decimal" value="${escape(value)}"></label>`;
}
function selectField(name, label, value, options) {
  return `<label>${label}<select name="${name}">${options.map(([key, text]) =>
    `<option value="${key}" ${String(value ?? "") === key ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
}
function editorMarkup(row) {
  const showRostered = row.status === "cancelled" || LEAVE_STATUSES.includes(row.status) ||
    (row.status === "work" && (row.rosteredStart !== row.actualStart || row.rosteredFinish !== row.actualFinish));
  return `<form id="shift-form" class="shift-editor" novalidate>
    ${row.flags?.length ? `<p class="review-warning">${row.flags.map(escape).join("<br>")}</p>` : ""}
    <label>Status<select name="status">${Object.entries(STATUS_LABELS)
      .map(
        ([value, label]) =>
          `<option value="${value}" ${row.status === value ? "selected" : ""} ${value === "unknown" ? "disabled" : ""}>${label}</option>`,
      )
      .join("")}</select></label>
    <label id="job-field">Job / duty<input name="jobNumber" value="${escape(row.jobNumber || row.jobLabel || "")}" maxlength="100"></label>
    <fieldset id="actual-fields"><legend>Worked times</legend>
      <div class="field-pair">${timeField("actualStart", "Start", row.actualStart)}${timeField("actualFinish", "Finish", row.actualFinish)}</div>
      <p class="hint" id="worked-duration" hidden>Total worked <output for="actualStart actualFinish" id="worked-total"></output></p>
    </fieldset>
    <div id="relinquishment-fields" hidden>
      <p class="hint">Under four hours worked, the full scheduled shift is sick leave. From four hours, only the remainder is sick leave.</p>
      ${row.timedRelinquishment && !row.hasRelinquishmentSchedule ? numberField("relinquishmentShiftHours", "Full scheduled shift (hours)", row.relinquishmentShiftHours) : ""}
    </div>
    <details class="shift-options" id="rostered-fields" ${showRostered ? "open" : ""}>
      <summary id="rostered-summary">Rostered times</summary>
      <div class="field-pair">${timeField("rosteredStart", "Rostered start", row.rosteredStart)}${timeField("rosteredFinish", "Rostered finish", row.rosteredFinish)}</div>
      <p class="hint" id="rostered-default">Leave both blank to use the worked times.</p>
      <div id="leave-extras">${numberField("leaveHours", "Leave hours", row.leaveHours)}</div>
    </details>
    <details class="shift-options" id="pay-adjustments"><summary>Pay adjustments</summary>
      <div id="standalone-overtime-field">${checkbox("wobod", "Worked on a booked-off day (WOBOD)", row.wobod)}</div>
      ${checkbox("ph", "Public holiday", row.ph)}${checkbox("accruePh", "Accrue public holiday", row.accruePh)}
      <div id="annual-loading">${selectField("annualLoading", "Confirmed annual leave loading", row.annualLoading, [["", "None"], ["0.175", "17.5%"], ["0.20", "20%"]])}</div>
      <div id="work-extras">
        ${selectField("amendment", "Confirmed diagram adjustment", row.amendment, [["", "None"], ["compare", "Pay higher value (suburban)"], ["credit", "Approved lift-up, lay-back or build-up credit"]])}
        <fieldset id="original-diagram-fields"><legend>Original diagram for comparison</legend>
          <div class="field-pair">${timeField("originalStart", "Start", row.originalStart)}${timeField("originalFinish", "Finish", row.originalFinish)}</div>
          <p class="hint">Leave both blank to use the rostered times above.</p>
        </fieldset>
        ${selectField("ordinaryMinutes", "Scheduled overtime starts after", row.ordinaryMinutes, [["", "Default · 8 hours"], ["456", "7 hours 36 minutes (confirmed)"],
          ...[540, 600, 660, 720].map((minutes) => [String(minutes), `${minutes / 60} hours (agreed lengthened shift)`])])}
        ${numberField("sickRemainderHours", "Approved part-shift sick leave hours", row.sickRemainderHours)}
        ${timeField("milageTime", "Time 209 km was passed (suburban)", row.milageTime)}
        ${state.role === "driver" ? numberField("extraKm", "Approved extra kilometres (suburban driver)", row.extraKm) : ""}
        ${state.role === "driver" ? checkbox("straightSix", "Qualifying suburban straight six-hour shift", row.straightSix) : ""}
        ${numberField("intercityKm", "Intercity kilometres (including 0 if applicable)", row.intercityKm)}
        ${numberField("unassociatedMinutes", "Intercity unassociated work minutes", row.unassociatedMinutes)}
        <div class="field-pair">${numberField("departureGap", "Sign-on to departure (min)", row.departureGap)}${numberField("arrivalGap", "Arrival to sign-off (min)", row.arrivalGap)}</div>
        ${checkbox("mealClaim", "Confirmed away-from-home-station meal claim", row.mealClaim)}
        ${numberField("travelMinutes", "Approved excess travel minutes (paid at base rate)", row.travelMinutes)}
        ${selectField("picnicClaim", "Confirmed picnic day credit", row.picnicClaim, [["", "None"], ["paid", "Pay"], ["bank", "Accrue"]])}
      </div>
    </details>
    ${row.rawText || row.workSwap || Number.isFinite(row.rosteredKm) ? `<details class="shift-options"><summary>Roster source</summary>
      ${row.workSwap ? `<div class="hint">
        <p>Your original shift was ${escape(formatSwapShift(row.workSwap.original))}.</p>
        ${row.workSwap.partners.map(partner => `<p>Line ${escape(partner.line)} originally had ${escape(formatSwapShift(partner.original))}. The current roster shows ${escape(formatSwapShift(partner.current))}.${partner.reciprocal ? " Both lines record the swap." : ""}</p>`).join("")}
        ${row.workSwap.assignedLine ? `<p>Rostered times come from line ${escape(row.workSwap.assignedLine)}’s original shift.</p>` : ""}
      </div>` : ""}
      ${Number.isFinite(row.rosteredKm) ? `<p class="hint">${escape(row.rosteredKm)} km in the diagram data</p>` : ""}
      ${row.rawText ? `<p class="source-text">${escape(row.rawText)}</p>` : ""}
    </details>` : ""}
    <p class="editor-error" id="editor-error" role="alert" tabindex="-1" hidden></p>
    <button type="button" id="reset-shift" class="text-button">Reset to ${state.mode === "import" ? "imported values" : state.line ? "master shift" : "blank day"}</button>
    <div class="editor-actions"><button type="button" class="secondary" id="cancel-shift">Cancel</button><button class="primary" type="submit">Save shift</button></div>
  </form>`;
}
function wireEditor() {
  const form = $("shift-form");
  const saved = state.rows[state.editor];
  const rosteredFields = $("rostered-fields");
  const error = $("editor-error");
  const formRelinquishment = () => ({
    timedRelinquishment: saved.timedRelinquishment,
    status: form.elements.status.value,
    actualStart: clock(form.elements.actualStart.value),
    actualFinish: clock(form.elements.actualFinish.value),
  });
  const useActualTimes = () => form.elements.status.value === "work" &&
    (saved.changeType === "custom_duty" || (saved.timedRelinquishment && !saved.hasRelinquishmentSchedule));
  const copyActualTimes = () => {
    if (!useActualTimes()) return;
    form.elements.rosteredStart.value = form.elements.actualStart.value;
    form.elements.rosteredFinish.value = form.elements.actualFinish.value;
  };
  const updateFields = () => {
    const entry = formRelinquishment();
    const relinquished = isTimedRelinquishment(entry);
    const status = relinquishmentStatus(entry);
    const work = status === "work";
    const leave = !relinquished && LEAVE_STATUSES.includes(status);
    form.elements.status.value = status;
    copyActualTimes();
    $("job-field").hidden = !work && !relinquished && !["cancelled", "unknown"].includes(status);
    rosteredFields.hidden = useActualTimes() || (relinquished && !saved.hasRelinquishmentSchedule) ||
      !["work", "cancelled", ...LEAVE_STATUSES].includes(status);
    $("rostered-summary").textContent = leave ? "Rostered times and leave hours" : "Rostered times";
    $("rostered-default").hidden = !work || relinquished;
    $("leave-extras").hidden = !leave;
    $("annual-loading").hidden = status !== "annual";
    $("original-diagram-fields").hidden = relinquished || !work || form.elements.amendment.value !== "compare";
    $("actual-fields").hidden = !work && !relinquished;
    const total = entry.actualStart && entry.actualFinish ? durationBetween(entry.actualStart, entry.actualFinish) : "";
    $("worked-total").value = displayClock(total);
    $("worked-duration").hidden = !total;
    $("relinquishment-fields").hidden = !relinquished;
    form.elements.amendment.closest("label").hidden = relinquished;
    form.elements.sickRemainderHours.closest("label").hidden = relinquished;
    $("work-extras").hidden = !work;
    $("standalone-overtime-field").hidden = !work;
  };
  form.elements.status.addEventListener("change", () => {
    updateFields();
    if (!rosteredFields.hidden && form.elements.status.value !== "work") rosteredFields.open = true;
  });
  form.elements.amendment.addEventListener("change", updateFields);
  updateFields();
  for (const name of ["actualStart", "actualFinish"])
    form.elements[name].addEventListener("input", updateFields);
  $("cancel-shift").onclick = () => closeEditor();
  $("reset-shift").onclick = () => {
    const index = state.editor;
    state.rows[index] = structuredClone(state.originals[index]);
    state.result = null;
    renderReview();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    copyActualTimes();
    const index = state.editor;
    const row = { ...state.rows[index] };
    for (const key of ["status", "jobNumber"])
      row[key] = form.elements[key].value.trim();
    if (row.jobNumber !== state.rows[index].jobNumber) delete row.rosteredKm;
    if (useActualTimes()) row.jobLabel = row.jobNumber;
    for (const key of ["extraKm", "amendment", "intercityKm", "unassociatedMinutes", "departureGap",
      "arrivalGap", "sickRemainderHours", "ordinaryMinutes", "picnicClaim", "travelMinutes"])
      row[key] = row.status === "work" ? form.elements[key]?.value.trim() || "" : "";
    row.leaveHours = LEAVE_STATUSES.includes(row.status) ? form.elements.leaveHours.value : "";
    row.annualLoading = row.status === "annual" ? form.elements.annualLoading.value : "";
    row.straightSix = row.status === "work" && Boolean(form.elements.straightSix?.checked);
    row.mealClaim = row.status === "work" && form.elements.mealClaim.checked;
    for (const key of [
      "rosteredStart",
      "rosteredFinish",
      "originalStart",
      "originalFinish",
      "actualStart",
      "actualFinish",
      "milageTime",
    ])
      row[key] = clock(form.elements[key].value);
    row.timeWorked = row.actualStart && row.actualFinish ? durationBetween(row.actualStart, row.actualFinish) : "";
    for (const key of ["ph", "accruePh"])
      row[key] = form.elements[key].checked;
    row.status = relinquishmentStatus(row);
    if (row.status === "work" && !row.rosteredStart && !row.rosteredFinish) {
      row.rosteredStart = row.actualStart;
      row.rosteredFinish = row.actualFinish;
    }
    if (isTimedRelinquishment(row)) {
      row.relinquishmentShiftHours = form.elements.relinquishmentShiftHours?.value || "";
      row.amendment = "";
    }
    row.wobod = row.status === "work" && form.elements.wobod.checked;
    const errors = validateShift(row);
    if (errors.length) {
      error.textContent = errors.join(" ");
      error.hidden = false;
      error.focus();
      return;
    }
    Object.assign(row, { edited: true, reviewed: true });
    state.rows[index] = row;
    state.result = null;
    closeEditor();
  };
}
function closeEditor() {
  const index = state.editor;
  state.editor = null;
  notice();
  renderReview();
  document
    .querySelector(`[data-edit="${index}"]`)
    ?.focus({ preventScroll: true });
}
function calculate() {
  if (!canLeaveEditor()) return;
  try {
    if (
      !Number.isFinite(Number($("pay-rate").value)) ||
      Number($("pay-rate").value) <= 0
    ) {
      go("select");
      $("custom-rate-field").hidden = false;
      $("pay-rate").focus();
      throw new Error("Enter your hourly pay rate, greater than zero.");
    }
    if (!state.rows.some((row) => ["work", "hol", "cancelled", ...LEAVE_STATUSES, ...FIXED_PAID_STATUSES].includes(row.status) || row.ph) &&
        !Number($("pay-other").value))
      throw new Error(
        "Enter at least one worked or leave shift before calculating.",
      );
    const table = toEngineTable(
      state.rows,
      $("pay-rate").value,
      $("roster-type").value,
      {
        role: state.role,
        guaranteeEligible: $("pay-guarantee").checked,
        holidayBalance: $("pay-holiday-balance").value,
        otherPayment: $("pay-other").value,
      },
    );
    const result = window.PayEngine.calculateWithBreakdown(table);
    if (!Number.isFinite(result.grossPay))
      throw new Error(
        "The calculator could not produce a valid total. Check the shift details.",
      );
    state.result = result;
    $("gross-pay").textContent = money(result.grossPay);
    $("result-context").textContent =
      `${$("review-person").textContent} · ${niceDate(state.rows[0].date)}–${niceDate(state.rows[13].date)} · ${money(table.payrate)}/hour`;
    renderBreakdown(result.breakdown);
    renderPayslip(buildPayslip(result, state.rows));
    go("result");
  } catch (error) {
    notice(error.message, true);
  }
}
function renderBreakdown(breakdown) {
  const items = breakdownEntries(breakdown).map((entry) => {
    const detail = entry.label;
    if (!detail || detail === "Details" || detail === "Gross Pay:") return "";
    if (/^(SUN|MON|TUES|WED|THUR|FRI|SAT):/.test(detail))
      return `<h3 class="pay-day">${escape(detail)}</h3>`;
    const units = entry.units;
    const extra = [
      units ? `${units} units` : "",
      entry.rate ? `Rate ${entry.rate}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const amount = entry.amount;
    return `<div class="pay-entry"><span>${escape(detail)}${extra ? `<small>${escape(extra)}</small>` : ""}</span><strong>${escape(amount && Number.isFinite(Number(amount)) ? money(amount) : amount || "")}</strong></div>`;
  });
  $("breakdown").innerHTML = items.join("");
}
function renderPayslip(payslip) {
  const hours = value => Number(value).toLocaleString("en-AU", { maximumFractionDigits: 2 });
  const entry = item => {
    const extra = [item.hours === null ? "" : `${hours(item.hours)} ${Math.abs(item.hours) === 1 ? "hour" : "hours"}`,
      item.rate === null ? "" : `${money(item.rate)}/hour`].filter(Boolean).join(" · ");
    return `<div class="pay-entry"><span>${escape(item.label)}${extra ? `<small>${escape(extra)}</small>` : ""}</span><strong>${item.amount === null ? "" : money(item.amount)}</strong></div>`;
  };
  $("payslip").innerHTML =
    entry({ label: "Normal working", hours: payslip.normalWorking.hours, rate: null, amount: payslip.normalWorking.amount }) +
    payslip.days.map(day => `<h3 class="pay-day">${escape(niceDate(day.date, { weekday: "short", day: "numeric", month: "short" }))}</h3>` +
      (day.claims.length ? day.claims.map(entry).join("") :
        `<p class="hint payslip-day-note">${day.status === "work" ? "Normal working included above. No additional claims." : escape(STATUS_LABELS[day.status] || "No claims")}</p>`)).join("") +
    `<h3 class="pay-day">Fortnight adjustments</h3>` + payslip.adjustments.map(entry).join("") +
    entry({ label: "Gross pay before tax", hours: null, rate: null, amount: payslip.grossPay });
}
function downloadResult() {
  if (!state.result) return;
  const document = {
    generatedAt: new Date().toISOString(),
    employeeName: state.employeeName,
    line: state.line,
    depot: state.depot,
    role: state.role,
    hourlyRate: Number($("pay-rate").value),
    classification: $("pay-classification").value || null,
    rateSource: $("pay-classification").value ? "bundled" : "manual",
    masterSource: state.masterSource,
    guaranteeEligible: $("pay-guarantee").checked,
    openingHolidayBalance: $("pay-holiday-balance").value === "" ? null : Number($("pay-holiday-balance").value),
    otherPayment: Number($("pay-other").value || 0),
    rosterType: $("roster-type").value,
    grossPay: state.result.grossPay,
    currency: "AUD",
    rows: state.rows,
    breakdown: state.result.breakdown,
    payslip: buildPayslip(state.result, state.rows),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(document, null, 2)], { type: "application/json" }),
  );
  const link = window.document.createElement("a");
  link.href = url;
  link.download = `pay-summary-${state.rows[0].date}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("import-mode").onclick = () => setMode("import");
$("manual-mode").onclick = () => setMode("manual");
$("start-date").onchange = updateMaster;
$("depot").onchange = settingsChanged;
$("other-depot").oninput = settingsChanged;
$("role").onchange = settingsChanged;
$("current-file").onchange = () => {
  state.settingsVersion++;
  task(async () => {
    await readCurrent();
    if (state.current) await startReview();
  });
};
$("change-master").onclick = () => {
  $("master-upload").hidden = !$("master-upload").hidden;
  $("change-master").setAttribute(
    "aria-expanded",
    String(!$("master-upload").hidden),
  );
};
$("master-file").onchange = () =>
  task(async () => {
    state.override = null;
    state.settingsVersion++;
    updateMaster();
    const file = $("master-file").files[0];
    if (!file) return;
    try {
      const parsed = parseRoster(await readPdf(file), "master");
      if (
        !parsed.rows.length ||
        (!Object.keys(parsed.jobDictionary.jobs).length &&
          !parsed.rows.some((row) =>
            row.cells.some((cell) => cell.status === "WORK"),
          ))
      ) {
        throw new Error(
          "No work shifts were recognised in this master. Try another PDF or enter manually.",
        );
      }
      state.override = parsed;
      notice(
        "Temporary master ready. It will be cleared when you refresh or change depot or role.",
      );
    } finally {
      updateMaster();
    }
  });
$("clear-master").onclick = () => {
  state.override = null;
  state.settingsVersion++;
  $("master-file").value = "";
  updateMaster();
};
$("select-form").onsubmit = (event) => {
  event.preventDefault();
  task(startReview);
};
$("back-select").onclick = () => {
  if (canLeaveEditor()) go("select");
};
for (const button of document.querySelectorAll("[data-week]"))
  button.onclick = () => {
    if (!canLeaveEditor()) return;
    state.week = Number(button.dataset.week);
    renderReview();
  };
$("shift-list").onclick = (event) => {
  const button = event.target.closest("[data-edit]");
  if (!button) return;
  if (state.editor !== null) {
    notice("Save or cancel the open shift before continuing.", true);
    return;
  }
  state.editor = Number(button.dataset.edit);
  renderReview();
  $("shift-form").elements.status.focus({ preventScroll: true });
  $(`shift-${state.editor}`).scrollIntoView({
    block: "start",
    behavior: "instant",
  });
};
$("calculate").onclick = calculate;
$("back-review").onclick = $("edit-result").onclick = () => {
  go("review");
  renderReview();
};
$("download-result").onclick = downloadResult;
$("pay-classification").addEventListener("change", () => {
  $("custom-rate-field").hidden = $("pay-classification").value !== "";
  updatePaySettings();
});
$("pay-rate").addEventListener("input", updatePaySettings);
$("roster-type").onchange = () => {
  $("roster-type").dataset.userSelected = "true";
  updatePaySettings();
};
$("pay-guarantee").onchange = $("pay-holiday-balance").oninput = $("pay-other").oninput = updatePaySettings;
function updatePaySettings() {
  state.result = null;
  $("pay-settings-summary").textContent =
    Number($("pay-rate").value) > 0
      ? `· ${$("roster-type").value === "short" ? "Short" : "Long"} fortnight`
      : "";
}
function updatePayGrades() {
  updateRatePresets($("role").value);
  if (!$("pay-classification").value && !$("pay-rate").value) {
    const placeholder = new Option("Select pay grade", "choose", true, true);
    placeholder.disabled = true;
    $("pay-classification").prepend(placeholder);
  }
  $("custom-rate-field").hidden = $("pay-classification").value !== "";
  updatePaySettings();
}
function validatePayGrade() {
  if ($("pay-classification").value === "choose") {
    $("pay-classification").focus();
    throw new Error("Select your pay grade.");
  }
  if (!Number.isFinite(Number($("pay-rate").value)) || Number($("pay-rate").value) <= 0) {
    $("custom-rate-field").hidden = false;
    $("pay-rate").focus();
    throw new Error("Enter your hourly pay rate, greater than zero.");
  }
}

const today = new Date();
today.setHours(12, 0, 0, 0);
today.setDate(today.getDate() - today.getDay());
$("start-date").value = toIsoDate(today);
updatePayGrades();
setMode("import");
try {
  const response = await fetch(
    new URL("./data/masters/index.json", import.meta.url),
    { cache: "no-cache" },
  );
  if (!response.ok)
    throw new Error(
      "Master catalogue unavailable. You can upload a temporary master or enter manually.",
    );
  const catalogue = await response.json();
  if (
    catalogue.schemaVersion !== 1 ||
    !Array.isArray(catalogue.depots) ||
    !Array.isArray(catalogue.masters) ||
    (catalogue.referenceMasters !== undefined && !Array.isArray(catalogue.referenceMasters))
  )
    throw new Error("Master catalogue format is invalid.");
  state.catalogue = catalogue;
  $("depot").innerHTML =
    catalogue.depots
      .map(
        (depot) =>
          `<option value="${escape(depot.id)}">${escape(depot.name)}</option>`,
      )
      .join("") + '<option value="other">Other depot</option>';
} catch (error) {
  notice(error.message, true);
}
updateMaster();
