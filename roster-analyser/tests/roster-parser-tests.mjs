import assert from "node:assert/strict";
import { parseRoster, toIsoDate } from "../roster-core.mjs";
import { markStruckText } from "../pdf-reader.mjs";
import { activeScenarioRows } from "../scenario-model.mjs";
import { hydrateReferenceMaster } from "../master-store.mjs";
import { importLine } from "../fortnight-model.mjs";

// The real PER1 export has a 49.92-point column gap. The old 48-point
// fallback split times across dates after missing single-digit headings.
function rosterPage(start, format) {
  const dates = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(`${start}T12:00:00`);
    date.setDate(date.getDate() + index);
    return date;
  });
  const item = (str, x, y) => ({ str, x, y, width: 36, height: 6 });
  const items = [item("1", 28, 470), item("Example crew", 48, 470),
    item(`Fortnight ending ${format(dates.at(-1))}`, 615, 550),
    item("Printed 25/11/2026 1:54:47 PM", 28, 20)];
  dates.forEach((date, index) => {
    const x = 114.96 + index * 49.92;
    items.push(item(format(date), x, 520));
    if (index === 6 || index === 7 || index === 12 || index === 13) items.push(item("OFF", x + 3, 470));
    else {
      items.push(item("01:35 - 09:57", x + 3, 477));
      items.push(item(`${5001 + index} F69`, x + 3, 469));
    }
  });
  return { dates, page: { pageNumber: 1, width: 841.92, height: 595.32, items } };
}

const master = hydrateReferenceMaster({ schemaVersion: 1, depot: "auburn", role: "driver", diagramData: {},
  masterRoster: { 1: Array.from({ length: 14 }, () => ({ job: "5010", start: "01:35", finish: "09:57" })) } });
const OPS = { transform: 1, constructPath: 2, fill: 3 };
function strikeOperators(bars) {
  const fnArray = [OPS.transform], argsArray = [[1, 0, 0, -1, 0, 600]];
  for (const { x, y, width, thickness } of bars) {
    fnArray.push(OPS.constructPath, OPS.fill);
    argsArray.push([[0, 1, 2, 3, 4], null, [x, 600 - y - thickness, x + width, 600 - y]], []);
  }
  return { fnArray, argsArray };
}
function crewPage(items) {
  const { page } = rosterPage("2026-11-29", date => `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`);
  page.items = page.items.filter(item => item.str !== "Example crew");
  page.items.push(...items);
  return page;
}
function parseCrew(page) { return parseRoster({ fileName: "replacement-crew.pdf", pages: [page] }, "fortnight"); }
const crew = (str, y) => ({ str, x: 48, y, width: 50, height: 6 });

for (const thickness of [0.24, 0.36]) for (const note of ["(SecP open)", "(Sec 20/02/2027)", "(AL 05/12/2026)", "(Inj open)"]) {
  const active = crew("Current, Crew", 485), old = crew("Previous, Crew", 477), oldNote = crew(note, 469);
  const page = crewPage([active, old, oldNote]);
  markStruckText(page.items, strikeOperators([old, oldNote].map(item => ({ ...item, y: item.y + 1.2, thickness }))), OPS);
  assert.equal(active.struckOut, undefined);
  assert.equal(old.struckOut, true);
  assert.equal(oldNote.struckOut, true);
  const parsed = parseCrew(page), row = parsed.rows[0];
  assert.equal(row.employeeName, "Current, Crew");
  assert.equal(row.seconded, false);
  assert.equal(row.crewUnavailable, false);
  assert.deepEqual(activeScenarioRows(master, parsed).map(row => row.line), [1]);
  assert.equal(importLine(master, parsed, 1).rows.length, 14);
}
console.log("PASS both strike-bar widths remove old crew names and their Sec/AL/injury notes without excluding the active replacement");

for (const note of ["AL 05/12/2026", "Sec open", "SecP open", "Sec 20/02/2027", "Inj open", "SL", "LSL", "LWOP", "MAT L", "PH"]) {
  const parsed = parseCrew(crewPage([crew(`Current, Crew (${note})`, 477)]));
  assert.equal(parsed.rows[0].crewUnavailable, true);
  assert.deepEqual(activeScenarioRows(master, parsed), []);
  assert.throws(() => importLine(master, parsed, 1), /seconded out|name column/);
}
const absent = crew("Previous, Crew", 477);
const crossedPage = crewPage([absent]);
markStruckText(crossedPage.items, strikeOperators([{ ...absent, y: absent.y + 1.2, thickness: 0.36 }]), OPS);
assert.deepEqual(activeScenarioRows(master, parseCrew(crossedPage)), []);
assert.deepEqual(activeScenarioRows(master, parseCrew(crewPage([]))), []);
console.log("PASS unavailable notes on the current name, crossed-out-only names and unnamed lines are excluded");

const underlined = crew("Current, Crew (NQ STAR)", 477);
const underlinePage = crewPage([underlined]);
markStruckText(underlinePage.items, strikeOperators([
  { ...underlined, y: 476, thickness: 0.36 }, // underline
  { ...underlined, y: 478.2, thickness: 6 }, // highlight
  { x: 28, width: 790, y: 450, thickness: 0.36 }, // table border
]), OPS);
assert.equal(underlined.struckOut, undefined);
assert.equal(parseCrew(underlinePage).rows[0].crewUnavailable, false);
const dayLeavePage = crewPage([crew("Current, Crew", 485)]);
dayLeavePage.items.push({ str: "(AL)", x: 118, y: 460, width: 15, height: 6 });
const dayLeave = parseCrew(dayLeavePage);
assert.equal(dayLeave.rows[0].crewUnavailable, false);
assert.equal(activeScenarioRows(master, dayLeave).length, 1);
assert.equal(importLine(master, dayLeave, 1).rows[0].status, "annual");
console.log("PASS underlines, highlights, table borders and day-level leave do not remove an active crew line");

const padded = date => `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
const unpadded = date => `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
for (const start of ["2026-11-29", "2026-02-01"]) {
  let expected;
  for (const [label, format] of [
    ["padded", padded], ["unpadded", unpadded],
    ["mixed", date => date.getDate() % 2 ? padded(date) : unpadded(date)],
  ]) {
    const { dates, page } = rosterPage(start, format);
    for (const source of ["fortnight", "master"]) {
      const result = parseRoster({ fileName: "date-layout.pdf", pages: [page] }, source);
      assert.deepEqual(result.dates.map(toIsoDate), dates.map(toIsoDate));
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].line, 1);
      const cells = result.rows[0].cells.map(cell => ({ status: cell.status, job: cell.jobNumber, start: cell.start, finish: cell.finish }));
      assert.equal(cells.length, 14);
      cells.forEach((cell, index) => {
        assert.deepEqual(cell, [6, 7, 12, 13].includes(index)
          ? { status: "OFF", job: "", start: "", finish: "" }
          : { status: "WORK", job: String(5001 + index), start: "0135", finish: "0957" });
      });
      if (expected) assert.deepEqual(cells, expected);
      expected = cells;
    }
    console.log(`PASS ${label} date headings from ${start} preserve actual columns, all 14 dates, jobs and complete time ranges`);
  }
}
