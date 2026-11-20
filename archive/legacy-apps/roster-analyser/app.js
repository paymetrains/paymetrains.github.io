import { readPdf } from "./pdf-reader.mjs";
import { parseRoster, analyseRosters } from "./roster-core.mjs";

const masterInput = document.getElementById("masterFile");
const fortnightInput = document.getElementById("fortnightFile");
const analyseButton = document.getElementById("analyseButton");
const downloadJsonButton = document.getElementById("downloadJsonButton");
const downloadCsvButton = document.getElementById("downloadCsvButton");
const statusEl = document.getElementById("status");
const previewBody = document.getElementById("previewBody");
const previewSearch = document.getElementById("previewSearch");
const fillCalculatorButton = document.getElementById("fillCalculatorButton");
const calculatorStatus = document.getElementById("calculatorStatus");
const payCalculatorFrame = document.getElementById("payCalculatorFrame");

let lastResult = null;
let currentPreviewRows = [];
const PAY_CALCULATOR_STORAGE_KEY = "rosterAnalyserPayPayload";

analyseButton.addEventListener("click", async () => {
  if (!masterInput.files[0] || !fortnightInput.files[0]) {
    setStatus("Load both PDFs first.", "error");
    return;
  }

  setBusy(true);
  setStatus("Reading PDFs...");

  try {
    const [masterPdf, fortnightPdf] = await Promise.all([
      readPdf(masterInput.files[0]),
      readPdf(fortnightInput.files[0], { detectStrikes: true }),
    ]);

    setStatus("Parsing rosters...");
    const master = parseRoster(masterPdf, "master");
    const fortnight = parseRoster(fortnightPdf, "fortnight");
    const result = analyseRosters(master, fortnight);

    lastResult = result;
    renderResult(result);
    setStatus(
      `Analysed ${result.summary.employees} employees, ${result.summary.payRows} pay rows, ${result.summary.overtimeRows} shifts above the master count.`,
      "ok"
    );
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
});

downloadJsonButton.addEventListener("click", () => {
  if (!lastResult) return;
  download(
    "roster-analysis.json",
    JSON.stringify(lastResult, null, 2),
    "application/json"
  );
});

downloadCsvButton.addEventListener("click", () => {
  if (!lastResult) return;
  download("pay-app-import.csv", toCsv(lastResult.payRows), "text/csv");
});

previewSearch.addEventListener("input", () => {
  renderPreviewTable(currentPreviewRows, previewSearch.value);
  updateCalculatorSelectionStatus();
});

fillCalculatorButton.addEventListener("click", () => {
  sendFilteredRowsToCalculator();
});

function renderResult(result) {
  document.getElementById("summaryEmployees").textContent = result.summary.employees;
  document.getElementById("summaryRows").textContent = result.summary.payRows;
  document.getElementById("summaryOt").textContent = result.summary.overtimeRows;
  document.getElementById("summaryFlags").textContent = result.summary.flags;
  document.getElementById("summaryMileage").textContent = result.summary.mileageRows;
  document.getElementById("overtimeCount").textContent = result.overtimeRows.length;
  document.getElementById("flagCount").textContent = result.flags.length;
  document.getElementById("mileageCount").textContent = result.mileageRows.length;

  renderList(
    document.getElementById("overtimeList"),
    result.overtimeRows.slice(0, 80).map((row) => ({
      title: `${row.employeeName || "Unknown"} - ${formatDateForDisplay(row.date)} - above master count`,
      detail: `Line ${row.line}, ${row.rosterType} line, ${row.workShiftNumber}/${row.rosteredShiftLimit} worked, OFF ${row.actualOffDays}/${row.masterOffDays}, ADO ${row.actualAdoDays}/${row.masterAdoDays}, ${row.changeType}`,
    })),
    "No shifts above the master count."
  );

  renderList(
    document.getElementById("flagList"),
    result.flags.slice(0, 100).map((row) => ({
      title: row.flag,
      detail: `${row.employeeName || "Master roster"} ${formatDateForDisplay(row.date) || ""} line ${row.line || ""}`,
    })),
    "No flags."
  );

  renderList(
    document.getElementById("mileageList"),
    result.mileageRows.slice(0, 100).map((row) => ({
      title: `${row.employeeName || "Unknown"} - ${formatDateForDisplay(row.date)}`,
      detail: `Line ${row.line}, job ${row.jobNumber || "unknown"}, ${formatRange(row.actualStart, row.actualFinish)}. Check 209km passed time before paying mileage.`,
    })),
    "No mileage jobs over 209km detected."
  );

  currentPreviewRows = result.payRows;
  renderPreviewTable(currentPreviewRows, previewSearch.value);
  updateCalculatorSelectionStatus();

  downloadJsonButton.disabled = false;
  downloadCsvButton.disabled = false;
}

function renderPreviewTable(allRows, query) {
  const filteredRows = filterPreviewRows(allRows, query);
  document.getElementById("previewCount").textContent = filteredRows.length;
  const rows = filteredRows.slice(0, 300);
  previewBody.innerHTML = "";

  if (!allRows.length) {
    previewBody.innerHTML = `<tr><td colspan="8" class="muted">No export rows.</td></tr>`;
    return;
  }

  if (!rows.length) {
    previewBody.innerHTML = `<tr><td colspan="8" class="muted">No rows match this search.</td></tr>`;
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.mileageOver209Candidate) tr.classList.add("preview-row-mileage");
    tr.innerHTML = `
      <td>${escapeHtml(row.employeeName)}</td>
      <td class="mono">${row.line}</td>
      <td class="mono">${formatDateForDisplay(row.date)}</td>
      <td class="mono">${formatRange(row.rosteredStart, row.rosteredFinish)}</td>
      <td class="mono">${formatRange(row.actualStart, row.actualFinish)}</td>
      <td class="mono">${row.timeWorked}</td>
      <td>${escapeHtml(row.status)} / ${escapeHtml(row.changeType)}</td>
      <td class="${row.mileageOver209Candidate ? "mileage" : "flag"}">${escapeHtml(row.flags.join(", "))}</td>
    `;
    previewBody.appendChild(tr);
  }
}

function filterPreviewRows(rows, query) {
  const term = query.trim().toLowerCase();
  if (!term) return rows;
  const lineTerm = term.replace(/^line\s+/, "").trim();
  const isLineSearch = /^\d+$/.test(lineTerm);

  return rows.filter((row) => {
    const name = String(row.employeeName || "").toLowerCase();
    const line = String(row.line || "");
    if (isLineSearch) return line === lineTerm;
    return name.includes(term);
  });
}

function updateCalculatorSelectionStatus() {
  if (!lastResult) {
    fillCalculatorButton.disabled = true;
    calculatorStatus.textContent = "Analyse a roster first.";
    return;
  }

  const selection = getCalculatorSelection();
  fillCalculatorButton.disabled = Boolean(selection.error);
  calculatorStatus.textContent = selection.error
    ? selection.error
    : `${selection.employeeName} line ${selection.line}: 14 rows ready.`;
}

function sendFilteredRowsToCalculator() {
  const selection = getCalculatorSelection();
  if (selection.error) {
    calculatorStatus.textContent = selection.error;
    return;
  }

  const payload = {
    version: 2,
    generatedAt: new Date().toISOString(),
    employeeName: selection.employeeName,
    line: selection.line,
    rosterType: selection.rosterType,
    mileageCandidates: selection.rows.filter((row) => row.mileageOver209Candidate).length,
    rows: selection.rows.map(toPayCalculatorImportRow),
  };

  localStorage.setItem(PAY_CALCULATOR_STORAGE_KEY, JSON.stringify(payload));
  payCalculatorFrame.src = `./pay-calculator.html?import=${Date.now()}`;
  calculatorStatus.textContent = `Filled calculator for ${selection.employeeName} line ${selection.line}.`;
}

function getCalculatorSelection() {
  const rows = filterPreviewRows(currentPreviewRows, previewSearch.value);
  if (!rows.length) {
    return { error: "Filter to one employee or line first." };
  }

  const groups = new Map();
  for (const row of rows) {
    const key = `${row.employeeName || "Unknown"}|${row.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  if (groups.size !== 1) {
    return { error: "Filter must match exactly one employee/line." };
  }

  const selectedRows = Array.from(groups.values())[0]
    .slice()
    .sort((a, b) => Number(a.dayIndex) - Number(b.dayIndex));

  if (selectedRows.length !== 14) {
    return { error: `Selected line has ${selectedRows.length} rows, expected 14.` };
  }
  if (selectedRows.some(row => row.status === "unknown" ||
      row.flags.some(flag => ["part_day_sick_relief", "confirm_sick_leave_hours"].includes(flag)))) {
    return { error: "This line has shifts that need review in the fortnight calculator." };
  }

  const firstRow = selectedRows[0];
  return {
    employeeName: firstRow.employeeName || "Unknown",
    line: firstRow.line,
    rosterType: firstRow.rosterType || (firstRow.rosteredShiftLimit <= 9 ? "short" : "long"),
    rows: selectedRows,
  };
}

function toPayCalculatorImportRow(row) {
  return {
    employeeName: row.employeeName,
    line: row.line,
    date: row.date,
    day: row.day,
    dayIndex: row.dayIndex,
    rosteredStart: row.leaveRosteredStart || row.rosteredStart,
    actualStart: row.actualStart,
    rosteredFinish: row.leaveRosteredFinish || row.rosteredFinish,
    actualFinish: row.actualFinish,
    timeWorked: row.timeWorked,
    ph: row.ph,
    accruePh: row.accruePh,
    publicHolidayName: row.publicHolidayName,
    wobod: row.wobod,
    callout: row.callout,
    extraKm: row.extraKm,
    status: row.status,
    changeType: row.changeType,
    rosterType: row.rosterType,
    rosteredShiftLimit: row.rosteredShiftLimit,
    workShiftNumber: row.workShiftNumber,
    actualWorkDays: row.actualWorkDays,
    extraDayOvertime: row.extraDayOvertime,
    jobNumber: row.jobNumber,
    masterJobNumber: row.masterJobNumber,
    mileageOver209Candidate: row.mileageOver209Candidate,
    flags: row.flags,
  };
}

function renderList(container, rows, emptyText) {
  container.innerHTML = "";
  container.classList.toggle("empty", rows.length === 0);
  if (!rows.length) {
    container.textContent = emptyText;
    return;
  }

  for (const row of rows) {
    const div = document.createElement("div");
    div.className = "list-row";
    div.innerHTML = `<strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.detail)}</span>`;
    container.appendChild(div);
  }
}

function toCsv(rows) {
  const headers = [
    "employee",
    "line",
    "date",
    "day",
    "rosteredStart",
    "actualStart",
    "rosteredFinish",
    "actualFinish",
    "totalWorked",
    "ph",
    "accruePH",
    "wobod",
    "callout",
    "extraKm",
    "mileageOver209Candidate",
    "publicHolidayName",
    "status",
    "changeType",
    "jobNumber",
    "masterJobNumber",
    "rosterType",
    "rosteredShiftLimit",
    "masterOffDays",
    "masterAdoDays",
    "actualOffDays",
    "actualAdoDays",
    "actualWorkDays",
    "offCountMismatch",
    "adoCountMismatch",
    "workShiftNumber",
    "extraDayOvertime",
    "liftUpMinutes",
    "laybackMinutes",
    "buildupMinutes",
    "payableMinutes",
    "overtimeMinutes",
    "flags",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const value =
            header === "employee"
              ? row.employeeName
              : header === "totalWorked"
                ? row.timeWorked
                : header === "accruePH"
                  ? row.accruePh
                  : header === "flags"
                    ? row.flags.join(";")
                    : row[header];
          return csvEscape(value);
        })
        .join(",")
    );
  }
  return lines.join("\r\n");
}

function setBusy(isBusy) {
  analyseButton.disabled = isBusy;
  analyseButton.textContent = isBusy ? "Analysing..." : "Analyse";
}

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
}

function download(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function joinItems(items) {
  const sorted = items
    .slice()
    .sort((a, b) => Math.round(b.y) - Math.round(a.y) || a.x - b.x);
  const lines = [];

  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (!current || Math.abs(current.y - item.y) > 3) {
      lines.push({ y: item.y, parts: [item.str] });
    } else {
      current.parts.push(item.str);
    }
  }

  return lines.map((line) => line.parts.join(" ")).join(" ");
}

function normalizeCellText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function parseEmployeeName(text) {
  const cleaned = normalizeCellText(text)
    .replace(/\bSec\b.*$/i, "")
    .replace(/\bNQ STAR\b/gi, "")
    .trim();
  const withoutNotes = cleaned.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const commaName = withoutNotes.match(/[A-Z][A-Za-z' -]+,\s*[A-Z][A-Za-z' -]+/);
  return commaName ? commaName[0].trim() : withoutNotes;
}

function groupByY(items, tolerance) {
  const groups = [];
  for (const item of items.slice().sort((a, b) => b.y - a.y)) {
    const group = groups.find((entry) => Math.abs(entry.y - item.y) <= tolerance);
    if (group) {
      group.items.push(item);
      group.y = median(group.items.map((entry) => entry.y));
    } else {
      groups.push({ y: item.y, items: [item] });
    }
  }
  return groups;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseDate(value) {
  const match = value.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) throw new Error(`Bad date: ${value}`);
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatDateForDisplay(isoDate) {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function formatDisplayDate(date) {
  return [
    String(date.getDate()).padStart(2, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    date.getFullYear(),
  ].join("/");
}

function dayNameFromIso(isoDate) {
  if (!isoDate) return "";
  return ["sun", "mon", "tues", "wed", "thur", "fri", "sat"][
    new Date(`${isoDate}T00:00:00`).getDay()
  ];
}

function toHHMM(hours, minutes) {
  return `${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
}

function parseHHMM(value) {
  const match = String(value).match(/^(\d{2})(\d{2})$/);
  if (!match) throw new Error(`Bad time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function finishAfterStart(finishMinutes, startMinutes) {
  let result = finishMinutes;
  while (result <= startMinutes) result += 1440;
  return result;
}

function alignToReference(minutes, referenceMinutes) {
  const candidates = [minutes - 1440, minutes, minutes + 1440];
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - referenceMinutes) < Math.abs(best - referenceMinutes)
      ? candidate
      : best
  );
}

function minutesToHHMM(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}${String(mins).padStart(2, "0")}`;
}

function minutesToUnitText(minutes) {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatRange(start, finish) {
  if (start === "HOL") return "HOL";
  if (start === "SICK") return "SICK";
  if (!start && !finish) return "";
  return `${start || ""}-${finish || ""}`;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
