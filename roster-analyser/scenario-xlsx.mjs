import { STATUS_LABELS } from "./fortnight-model.mjs";
import { shiftDurationMinutes } from "./roster-core.mjs";
import { timeClaimReference } from "./scenario-export.mjs";
import { timesheetEntries } from "./scenario-timesheet.mjs";
import { kilometreClaimText } from "./scenario-kilometres.mjs";

const moneyFormat = '"$"#,##0.00;[Red]("$"#,##0.00)';
const money = value => Number(value).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const time = value => value ? `${value.slice(0, 2)}:${value.slice(2)}` : "";
const duration = minutes => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
const total = values => Math.round((values.reduce((sum, value) => sum + value, 0) + Number.EPSILON) * 100) / 100;
const colour = { ink: "FF18201B", muted: "FF536158", green: "FF21673D", fill: "FFE6F2E8", blue: "FF1759AD", line: "FFC6CEC8", surface: "FFF1F4F1", white: "FFFFFFFF" };
let library;

function loadExcel() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!library) library = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./vendor/exceljs/exceljs.min.js", import.meta.url).href;
    script.onload = () => resolve(window.ExcelJS);
    script.onerror = () => { library = null; script.remove(); reject(new Error("Excel export could not load. Refresh and try again.")); };
    document.head.append(script);
  });
  return library;
}

function shiftText(shift) {
  if (!shift) return "Line missing";
  if (!shift.start) return shift.job || shift.status || "No shift";
  return `Job ${shift.job || "Custom"}\n${time(shift.start)}–${time(shift.finish)}\n${duration(shiftDurationMinutes(shift.start, shift.finish))}`;
}

function referenceText(day, source) {
  const comparison = day.comparisons[source].basis;
  const assignment = day[source];
  if (day.status !== "work") return "";
  if (comparison.source === "Worked roster") return "Custom duty · actual times";
  if (source === "defunct" && ["OFF", "ADO"].includes(assignment?.status) && !comparison.source.includes("Defunct master job reference")) return `${assignment.status} · actual shift value`;
  if (day.swapped || comparison.job !== assignment?.job || comparison.start !== assignment?.start || comparison.finish !== assignment?.finish || comparison.source.includes("master job reference"))
    return `Against Job ${comparison.job || "Custom"} · ${time(comparison.start)}–${time(comparison.finish)}${comparison.source.includes("master job reference") ? " · job reference" : ""}`;
  return "";
}

function rich(lines) {
  return { richText: lines.filter(item => item.text).map((item, index) => ({ text: `${index ? "\n" : ""}${item.text}`, font: { name: "Arial", size: item.size || 10, color: { argb: item.colour || colour.ink }, bold: Boolean(item.bold) } })) };
}

function baseCell(cell) {
  cell.font = { name: "Arial", size: 10, color: { argb: colour.ink } };
  cell.alignment = { vertical: "top", wrapText: true };
  cell.border = { bottom: { style: "hair", color: { argb: colour.line } } };
}

function mergedCell(sheet, row, first, last) {
  sheet.mergeCells(row, first, row, last);
  const cell = sheet.getCell(row, first);
  baseCell(cell);
  return cell;
}

export async function scenarioWorkbook(report, lines, period, lineAmount, view = "roster") {
  const Excel = await loadExcel();
  const workbook = new Excel.Workbook();
  workbook.creator = "Unofficial Pay Calculator";
  workbook.created = new Date(report.generatedAt);
  workbook.calcProperties.fullCalcOnLoad = true;
  const weeks = period === "full" ? [0, 1] : [period === "week1" ? 0 : 1];
  if (view === "timesheet") {
    for (const week of weeks) addTimesheetSheet(workbook, report, lines, week);
    return workbook.xlsx.writeBuffer();
  }
  for (const week of weeks) {
    const dates = report.dates.slice(week * 7, week * 7 + 7);
    const sheet = workbook.addWorksheet(`Week ${week + 1}`, {
      views: [{ state: "frozen", xSplit: 2, ySplit: 6, showGridLines: false, zoomScale: 75 }],
      pageSetup: { paperSize: 8, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:6" },
    });
    sheet.properties.tabColor = { argb: colour.green };
    sheet.getColumn(1).width = 8;
    sheet.getColumn(2).width = 20;
    for (let index = 0; index < 7; index++) {
      sheet.getColumn(3 + index * 2).width = 26;
      sheet.getColumn(4 + index * 2).width = 12;
    }
    for (let column = 17; column <= 20; column++) sheet.getColumn(column).width = 18;
    const title = mergedCell(sheet, 2, 1, 20);
    title.value = `Roster scenario · Week ${week + 1}`;
    title.font = { name: "Arial", size: 15, bold: true, color: { argb: colour.ink } };
    sheet.getRow(2).height = 26;
    mergedCell(sheet, 3, 1, 20).value = `${report.current} · ${report.role} · ${money(report.rate)}/hour · ${dates[0]} to ${dates.at(-1)}`;
    mergedCell(sheet, 4, 1, 20).value = `Existing: ${report.existingMaster}. Defunct: ${report.defunctMaster}. ${report.alignment === "same-date" ? "Time comparisons use the same roster date." : "Time credits excluded for starts over 12 hours apart."} Fifth and later weekday WOBOD: ${report.weekdayOvertimeAfterFourth * 100}% plus 50% on worked time.`;
    mergedCell(sheet, 5, 1, 20).value = "Green: higher comparison. Blue: swapped. Lines without diagram, SBY or Freelance shifts are blank. Amounts are a snapshot of the app calculation.";
    sheet.getRow(3).height = 20;
    sheet.getRow(4).height = 30;
    sheet.getRow(5).height = 20;
    sheet.getCell(6, 1).value = "Line";
    sheet.getCell(6, 2).value = "Source";
    dates.forEach((date, index) => {
      const header = mergedCell(sheet, 6, 3 + index * 2, 4 + index * 2);
      header.value = new Date(`${date}T00:00:00Z`);
      header.numFmt = "ddd, d mmm";
    });
    ["Week daily extra", "Fortnight gross", "Fortnight extra", "Fortnight adjustment difference"].forEach((label, index) => { sheet.getCell(6, 17 + index).value = label; });
    for (let column = 1; column <= 20; column++) {
      const header = sheet.getCell(6, column);
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour.green } };
      header.font = { name: "Arial", size: 10, bold: true, color: { argb: colour.white } };
      header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    }
    sheet.getRow(6).height = 34;
    let row = 7;
    for (const line of lines) {
      if (line.blank) {
        sheet.getCell(row, 1).value = line.line;
        baseCell(sheet.getCell(row, 1));
        sheet.getRow(row++).height = 22;
        continue;
      }
      if (line.error) {
        sheet.getCell(row, 1).value = line.line;
        mergedCell(sheet, row, 2, 16).value = line.error;
        sheet.getRow(row++).height = 35;
        continue;
      }
      const days = line.dates.slice(week * 7, week * 7 + 7);
      const first = row;
      sheet.mergeCells(first, 1, first + 4, 1);
      sheet.getCell(first, 1).value = line.line;
      baseCell(sheet.getCell(first, 1));
      sheet.getCell(first, 1).font = { name: "Arial", size: 11, bold: true };
      const labels = ["Existing master", "Defunct master", "Uploaded roster", "Daily breakdown", "Daily extra"];
      labels.forEach((label, offset) => {
        const cell = sheet.getCell(first + offset, 2);
        baseCell(cell); cell.value = label;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour.surface } };
        cell.font.bold = true;
      });
      sheet.getRow(first + 2).height = days.some(day => day.swapped || day.wobod) ? 68 : 52;
      const masterHeights = [42, 42];
      let claimHeight = 54;
      const extraCells = [];
      days.forEach((day, index) => {
        const column = 3 + index * 2;
        for (const [offset, source] of [[0, "existing"], [1, "defunct"]]) {
          const info = sheet.getCell(first + offset, column);
          const value = sheet.getCell(first + offset, column + 1);
          baseCell(info); baseCell(value);
          info.value = rich([{ text: shiftText(day[source]), bold: true }, { text: referenceText(day, source), size: 9, colour: colour.muted }]);
          const textLines = shiftText(day[source]).split("\n").reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 26)), 0);
          const reference = referenceText(day, source);
          masterHeights[offset] = Math.max(masterHeights[offset], textLines * 13 + (reference ? Math.ceil(reference.length / 28) * 12 : 0) + 8);
          value.value = day.comparisons[source].amount;
          value.numFmt = moneyFormat;
          value.alignment = { vertical: "top", horizontal: "right" };
          const other = source === "existing" ? "defunct" : "existing";
          if (day.comparisons[source].amount > day.comparisons[other].amount) {
            for (const cell of [info, value]) {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour.fill } };
              cell.border = { top: { style: "thin", color: { argb: colour.green } }, bottom: { style: "thin", color: { argb: colour.green } } };
            }
            info.border.left = { style: "thin", color: { argb: colour.green } };
            value.border.right = { style: "thin", color: { argb: colour.green } };
            value.font = { name: "Arial", size: 10, bold: true, color: { argb: colour.green } };
          }
        }
        const uploaded = mergedCell(sheet, first + 2, column, column + 1);
        const working = day.status === "work";
        const jobLabel = working ? `Job ${day.worked.job || "Custom"}` : STATUS_LABELS[day.status] || day.status;
        const uploadParts = [{ text: jobLabel, bold: true }];
        if (day.swapped) uploadParts.push({ text: " (swapped)", font: { name: "Arial", size: 10, bold: true, color: { argb: colour.blue } } });
        if (working) uploadParts.push({ text: `\n${time(day.worked.start)}–${time(day.worked.finish)}\n${duration(day.worked.minutes)}` });
        if (day.swapped) uploadParts.push({ text: `\nWS ${day.swapLines.join(", ")}` });
        if (day.wobod) uploadParts.push({ text: "\nWOBOD", font: { name: "Arial", size: 10, bold: true, color: { argb: colour.green } } });
        uploaded.value = { richText: uploadParts.map(part => ({ ...part, font: part.font || { name: "Arial", size: 10, bold: Boolean(part.bold), color: { argb: colour.ink } } })) };
        const claims = day.workedOnlyClaims.map(claim => ({ text: `${claim.label.replace(/^Scheduled OT/, "Overtime").replace(/^Standalone overtime/, "WOBOD pay")}${claim.minutes ? ` (${duration(claim.minutes)})` : ""}: ${money(lineAmount(claim))}` }));
        claims.push(...day.separateTimeClaims.flatMap(claim => [
          { text: `${claim.label} claim${claim.minutes ? ` (${duration(claim.minutes)})` : ""}: ${money(claim.amount)}`, colour: colour.green, bold: true },
          { text: `Against ${timeClaimReference(claim, day.comparison)}`, size: 9, colour: colour.muted },
        ]));
        if (day.kilometres?.claimedExtraKm) claims.push({ text: `${kilometreClaimText(day)} Additional comparison pay: ${money(day.kilometres.additionalPay)}`, colour: colour.green });
        if (!claims.length) claims.push({ text: "No paid claim", colour: colour.muted });
        if (day.wobod) claims.push({ text: `WOBOD: ${day.wobodSources.join(" and ")} OFF/ADO`, size: 9, colour: colour.muted });
        const details = mergedCell(sheet, first + 3, column, column + 1);
        details.value = rich(claims);
        const wrappedLines = claims.reduce((sum, item) => sum + Math.ceil(item.text.length / 43), 0);
        claimHeight = Math.max(claimHeight, wrappedLines * 14 + 12);
        const extra = mergedCell(sheet, first + 4, column, column + 1);
        extra.value = day.difference; extra.numFmt = moneyFormat;
        extra.font = { name: "Arial", size: 10, bold: true, color: { argb: colour.green } };
        extra.alignment = { horizontal: "right" };
        extraCells.push(extra.address);
      });
      sheet.getRow(first).height = masterHeights[0];
      sheet.getRow(first + 1).height = masterHeights[1];
      sheet.getRow(first + 3).height = Math.min(409, claimHeight);
      sheet.getRow(first + 4).height = 24;
      const weekTotal = sheet.getCell(first, 17);
      weekTotal.value = { formula: `SUM(${extraCells.join(",")})`, result: total(days.map(day => day.difference)) };
      for (const [column, value] of [[18, line.maximum], [19, line.difference], [20, line.adjustmentDifference]]) sheet.getCell(first, column).value = value;
      for (let column = 17; column <= 20; column++) {
        const cell = sheet.getCell(first, column);
        baseCell(cell); cell.numFmt = moneyFormat; cell.font.bold = true;
        cell.alignment = { vertical: "top", horizontal: "right" };
      }
      row += 5;
    }
    sheet.pageSetup.printArea = `A1:T${row - 1}`;
  }
  return workbook.xlsx.writeBuffer();
}

function addTimesheetSheet(workbook, report, lines, week) {
  const sheet = workbook.addWorksheet(`Week ${week + 1}`, {
    views: [{ state: "frozen", xSplit: 2, ySplit: 6, showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:6" },
  });
  [8, 17, 18, 15, 15, 15, 15, 73, 15].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  const title = mergedCell(sheet, 2, 1, 9);
  title.value = `Timesheet summary · Week ${week + 1}`;
  title.font = { name: "Arial", size: 15, bold: true };
  sheet.getRow(2).height = 26;
  mergedCell(sheet, 3, 1, 9).value = `${report.current} · ${report.role} · ${money(report.rate)}/hour`;
  mergedCell(sheet, 4, 1, 9).value = "Rostered times: current master line for unswapped shifts; worked job's current reference for swapped shifts. MR comments give the defunct comparison. Job length is actual work only.";
  mergedCell(sheet, 5, 1, 9).value = `Current: ${report.existingMaster}. Defunct: ${report.defunctMaster}.`;
  sheet.getRow(4).height = 24;
  sheet.getRow(5).height = 24;
  ["Line", "Date", "Job number", "Rostered start", "Actual start", "Rostered finish", "Actual finish", "Claims", "Job length"].forEach((label, index) => {
    const cell = sheet.getCell(6, index + 1);
    cell.value = label;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour.green } };
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: colour.white } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  sheet.getRow(6).height = 32;
  let rowIndex = 7;
  for (const line of lines) {
    if (line.blank || line.error) {
      sheet.getCell(rowIndex, 1).value = line.line;
      if (line.error) sheet.getCell(rowIndex, 8).value = line.error;
      rowIndex++;
      continue;
    }
    for (const row of timesheetEntries(line, line.dates.slice(week * 7, week * 7 + 7))) {
      const values = [line.line, new Date(`${row.date}T00:00:00Z`), `${row.job}${row.swapped ? ` WS ${row.swapLines.join(", ")}` : ""}`,
        row.rosteredStart, row.actualStart, row.rosteredFinish, row.actualFinish,
        row.claims.join("\n"),
        row.minutes == null ? "" : row.minutes / 1440];
      values.forEach((value, index) => {
        const cell = sheet.getCell(rowIndex, index + 1);
        baseCell(cell); cell.value = value;
        if (index === 1) cell.numFmt = "ddd, d mmm yyyy";
        if (index >= 3 && index <= 6 && value) {
          const [hours, minutes] = value.split(":").map(Number);
          cell.value = (hours * 60 + minutes) / 1440;
          cell.numFmt = "hh:mm";
        }
        if (index === 8) cell.numFmt = "[h]:mm";
        if (row.swapped && index === 2) cell.font.color = { argb: colour.blue };
      });
      const wrapped = Math.max(1, ...String(values[7]).split("\n").map(text => Math.ceil(text.length / 70)));
      const count = Math.max(wrapped, String(values[7]).split("\n").reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 70)), 0));
      sheet.getRow(rowIndex++).height = Math.max(30, count * 14 + 8);
    }
  }
  sheet.pageSetup.printArea = `A1:I${rowIndex - 1}`;
}
