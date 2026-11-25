import assert from "node:assert/strict";
import { parseRoster, toIsoDate } from "../roster-core.mjs";

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
