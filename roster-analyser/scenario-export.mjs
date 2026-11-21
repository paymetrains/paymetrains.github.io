import { timesheetEntries } from "./scenario-timesheet.mjs";

// Quote every field and neutralise spreadsheet formulas in imported labels.
function csvField(value) {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const amount = value => Number(value || 0).toFixed(2);
const time = value => value ? `${value.slice(0, 2)}:${value.slice(2)}` : "";

export function timeClaimReference(claim, fallback) {
  const comparison = claim.comparison || fallback;
  if (!comparison) return "";
  const sources = [...new Set((comparison.sources || [comparison.source]).filter(Boolean).map(source =>
    source === "Diagram data" ? "Existing diagram" : source.replace("Defunct master job reference", "Defunct diagram").replace("Existing master job reference", "Existing diagram")))];
  return `${sources.join(" + ")} · Job ${comparison.job || "Custom"}${comparison.start && comparison.finish ? ` · ${time(comparison.start)}–${time(comparison.finish)}` : ""}`;
}

export function scenarioCsv(lines, selectDates, lineAmount) {
  const columns = ["Row type", "Line", "Date", "Status", "Uploaded job", "Actual start", "Actual finish", "Actual minutes", "Swapped", "Swap lines", "WOBOD", "WOBOD sources",
    "Existing master job", "Existing master start", "Existing master finish", "Existing comparison job", "Existing comparison start", "Existing comparison finish", "Existing comparison amount",
    "Defunct master job", "Defunct master start", "Defunct master finish", "Defunct comparison job", "Defunct comparison start", "Defunct comparison finish", "Defunct comparison amount",
    "Selected comparison source", "Selected comparison job", "Actual shift pay", "Actual shift items", "Separate time claims", "Daily baseline pay", "Daily scenario pay", "Daily extra",
    "Selected dates extra", "Fortnight baseline pay", "Fortnight scenario gross", "Fortnight adjustment difference", "Fortnight total extra", "Error",
    "Rostered km", "Defunct reference km", "Current extra km", "Actual km", "Claimed extra km", "Kilometre reference", "Additional kilometre pay"];
  const rows = [columns];
  for (const line of lines) {
    if (line.error) {
      const error = Array(columns.length).fill("");
      error[0] = "error"; error[1] = line.line; error[columns.indexOf("Error")] = line.error;
      rows.push(error);
      continue;
    }
    const dates = selectDates(line.dates);
    for (const day of dates) {
      const existing = day.comparisons.existing;
      const defunct = day.comparisons.defunct.disabled ? { basis: {}, amount: null } : day.comparisons.defunct;
      rows.push(["daily", line.line, day.date, day.status, day.worked.job, time(day.worked.start), time(day.worked.finish), day.worked.minutes,
        day.swapped ? "Yes" : "No", day.swapLines.join("; "), day.wobod ? "Yes" : "No", day.wobodSources.join("; "),
        day.existing?.job, time(day.existing?.start), time(day.existing?.finish), existing.basis.job, time(existing.basis.start), time(existing.basis.finish), amount(existing.amount),
        day.defunct?.job, time(day.defunct?.start), time(day.defunct?.finish), defunct.basis.job, time(defunct.basis.start), time(defunct.basis.finish), defunct.amount === null ? "" : amount(defunct.amount),
        day.comparison.source, day.comparison.job, amount(day.workedOnlyPay),
        day.workedOnlyClaims.map(claim => `${claim.label}${claim.minutes ? ` (${claim.minutes} min)` : ""}: ${amount(lineAmount(claim))}`).join("; "),
        day.separateTimeClaims.map(claim => `${claim.label}${claim.minutes ? ` (${claim.minutes} min)` : ""}: ${amount(claim.amount)} · Against ${timeClaimReference(claim, day.comparison)}`).join("; "),
        amount(day.baselinePay), amount(day.scenarioPay), amount(day.difference), "", "", "", "", "", "",
        day.kilometres?.currentKm ?? "", day.kilometres?.defunctKm ?? "", day.kilometres?.enteredExtraKm ?? "", day.kilometres?.assumedActualKm ?? "", day.kilometres?.claimedExtraKm ?? "", day.kilometres?.reference || "", day.kilometres ? amount(day.kilometres.additionalPay) : ""]);
    }
    const summary = Array(columns.length).fill("");
    summary[0] = "line-summary"; summary[1] = line.line;
    summary[columns.indexOf("Selected dates extra")] = amount(dates.reduce((sum, day) => sum + day.difference, 0));
    summary[columns.indexOf("Fortnight baseline pay")] = amount(line.baseline);
    summary[columns.indexOf("Fortnight scenario gross")] = amount(line.maximum);
    summary[columns.indexOf("Fortnight adjustment difference")] = amount(line.adjustmentDifference);
    summary[columns.indexOf("Fortnight total extra")] = amount(line.difference);
    rows.push(summary);
  }
  return "\uFEFF" + rows.map(row => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export function scenarioTimesheetCsv(lines, selectDates) {
  const rows = [["Line", "Date", "Job number", "Rostered start", "Actual start", "Rostered finish", "Actual finish", "Claims", "Job length (minutes)", "Swap lines"]];
  for (const line of lines) {
    if (line.error) { rows.push([line.line, "", "", "", "", "", "", line.error, "", ""]); continue; }
    for (const row of timesheetEntries(line, selectDates(line.dates))) rows.push([
      line.line, row.date, row.job, row.rosteredStart, row.actualStart, row.rosteredFinish, row.actualFinish,
      row.claims.join("\n"), row.minutes, row.swapped ? row.swapLines.join("; ") : "",
    ]);
  }
  return "\uFEFF" + rows.map(row => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}
