import { timesheetEntries } from "./scenario-timesheet.mjs";

const money = value => Number(value).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const date = value => new Date(`${value}T12:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
const duration = minutes => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
let library;

function loadScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(path, import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error("PDF export could not load. Refresh the page and try again.")); };
    document.head.append(script);
  });
}

async function loadPdf() {
  if (!library) library = (async () => {
    if (!window.jspdf?.jsPDF) await loadScript("./vendor/jspdf/jspdf.umd.min.js");
    if (!window.jspdf.jsPDF.API.autoTable) await loadScript("./vendor/jspdf-autotable/jspdf.plugin.autotable.min.js");
    return window.jspdf.jsPDF;
  })().catch(error => { library = null; throw error; });
  return library;
}

// Create actual landscape PDF pages rather than relying on browser print settings.
// Both exports and the on-screen summary share timesheetEntries for claim values.
export async function timesheetPdf(report, lines, period = "full") {
  if (!lines.length) throw new Error("Select a line to export.");
  const JsPdf = await loadPdf();
  const doc = new JsPdf({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  doc.setProperties({ title: "Timesheet summary", author: "Unofficial Pay Calculator" });
  doc.setDisplayMode("fullwidth");
  const margin = 10;
  const width = doc.internal.pageSize.getWidth() - 2 * margin;
  const pageHeight = doc.internal.pageSize.getHeight();
  const label = period === "full" ? "Full fortnight" : period === "week1" ? "Week 1" : "Week 2";
  let first = true;
  for (const line of lines) {
    if (!first) doc.addPage("a4", "landscape");
    first = false;
    const dates = period === "full" ? line.dates : line.dates?.slice(period === "week1" ? 0 : 7, period === "week1" ? 7 : 14);
    const heading = `Timesheet summary - Line ${line.line} - ${label}`;
    const header = () => {
      doc.setFont("helvetica", "bold").setFontSize(14).setTextColor(24, 32, 27);
      doc.text(heading, margin, 15);
      doc.setFont("helvetica", "normal").setFontSize(7.5);
      const context = [
        `${report.current} - ${report.role} - ${money(report.rate)}/hour`,
        `Current: ${report.existingMaster} | Defunct: ${report.defunctMaster}`,
        dates?.length ? `${date(dates[0].date)} - ${date(dates.at(-1).date)} | Rostered times: current master; swapped shifts: current job reference.` : "",
        "MR marks a defunct-roster claim. Job length is actual work only.",
        ...(report.role === "driver" ? ["Actual kilometres assumed from the current job diagram plus entered extras; missing distances remain unknown."] : []),
      ].filter(Boolean);
      const wrapped = context.flatMap(text => doc.splitTextToSize(text, width));
      doc.text(wrapped, margin, 21, { lineHeightFactor: 1.2 });
      return 24 + wrapped.length * 3.2;
    };
    const startY = header();
    if (line.error || line.blank || !dates?.length) {
      doc.text(doc.splitTextToSize(line.error || "No normal jobs on this line.", width), margin, startY);
      continue;
    }
    const rows = timesheetEntries(line, dates);
    const body = rows.map(row => [
      date(row.date), `${row.job}${row.swapped ? ` WS ${row.swapLines.join(", ")}` : ""}`,
      row.rosteredStart || "—", row.actualStart || "—", row.rosteredFinish || "—", row.actualFinish || "—",
      row.claims.join("\n") || "—", row.minutes == null ? "—" : duration(row.minutes),
    ].map(text => text.replace(/[–—]/g, "-")));
    const columnWidths = [25, 28, 19, 19, 19, 19, width - 151, 22];
    const columnStyles = Object.fromEntries(columnWidths.map((cellWidth, index) => [index, { cellWidth }]));
    // Lay out a trial table with the same renderer, including header wrapping.
    // Dense driver comments get a slightly smaller font to keep 14 days together.
    let fontSize = 9;
    const head = [["Date", "Job number", "Rostered start", "Actual start", "Rostered finish", "Actual finish", "Claims / comments", "Job length"]];
    const tableOptions = size => ({
      startY, head, body, margin: { left: margin, right: margin, top: startY, bottom: 26 },
      tableWidth: width, theme: "grid", columnStyles,
      styles: { font: "helvetica", fontSize: size, cellPadding: { top: 1.5, right: 2, bottom: 1.5, left: 2 }, overflow: "linebreak", valign: "top", lineWidth: 0.3, lineColor: [70, 82, 74], textColor: [24, 32, 27] },
      headStyles: { fillColor: [238, 242, 239], textColor: [24, 32, 27], fontStyle: "bold", lineWidth: 0.3 },
      rowPageBreak: "avoid",
    });
    while (fontSize > 7.5) {
      const trial = new JsPdf({ orientation: "landscape", unit: "mm", format: "a4" });
      trial.autoTable(tableOptions(fontSize));
      if (trial.getNumberOfPages() === 1) break;
      fontSize -= 0.25;
    }
    doc.autoTable({
      ...tableOptions(fontSize),
      didParseCell: data => {
        if (data.section === "body" && data.column.index === 1 && rows[data.row.index].swapped) data.cell.styles.textColor = [23, 89, 173];
      },
      willDrawPage: data => { if (data.pageNumber > 1) header(); },
    });
    const bottom = doc.lastAutoTable.finalY + 5;
    doc.setFontSize(8).setFont("helvetica", "bold").setTextColor(24, 32, 27);
    doc.text(`${label} daily extra ${money(dates.reduce((sum, day) => sum + day.difference, 0))}`, margin, bottom);
    doc.setFont("helvetica", "normal").setFontSize(7.5);
    doc.text(`Fortnight baseline ${money(line.baseline)} | Scenario gross ${money(line.maximum)} | Adjustment difference ${money(line.adjustmentDifference)} | Total extra ${money(line.difference)}`, margin, bottom + 4);
    doc.text("Unofficial train crew pay calculator", margin, pageHeight - 9);
  }
  return doc.output("blob");
}
