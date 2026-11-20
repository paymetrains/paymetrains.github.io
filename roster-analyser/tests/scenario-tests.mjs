import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseCell } from "../roster-core.mjs";
import { hydrateReferenceMaster } from "../master-store.mjs";
import { blankFortnight, toEngineTable } from "../fortnight-model.mjs";
import { calculateScenarioLine, maximiseOptions } from "../scenario-model.mjs";
import { buildRosterJobReference, matchingRosterJob } from "../roster-job-reference.mjs";
import { claimMinutes, timesheetEntries } from "../scenario-timesheet.mjs";
import { scenarioTimesheetCsv } from "../scenario-export.mjs";

const engine = createRequire(import.meta.url)("../pay-calculator.js");
const job = (number, start = "06:00", finish = "14:00") => ({ job: String(number), start, finish });
function fixture() {
  const assignments = Array.from({ length: 14 }, () => job(1));
  assignments[5] = { job: "OFF" };
  const master = hydrateReferenceMaster({
    schemaVersion: 1, source: "bundled", depot: "auburn", role: "driver",
    masterRoster: { 10: assignments, 20: Array.from({ length: 14 }, () => job(3, "08:00", "16:00")) },
    diagramData: {
      1: { dayPattern: "Sun-Sat", signOn: "06:00", offDuty: "14:00", rosteredHrs: 8 },
      3: { dayPattern: "Sun-Sat", signOn: "07:00", offDuty: "15:00", rosteredHrs: 8 },
    },
  });
  const defunctDays = Array.from({ length: 14 }, () => job(2, "04:00", "12:00"));
  defunctDays[0] = { job: "OFF" };
  defunctDays[3] = job(2, "06:00", "16:00");
  const defunct = hydrateReferenceMaster({ schemaVersion: 1, source: "bundled", depot: "auburn", role: "driver", masterRoster: { 10: defunctDays }, diagramData: {} });
  const cells = Array.from({ length: 14 }, (_, index) => parseCell("06:00 - 14:00 1", index));
  cells[2] = parseCell("08:00 - 16:00 3 (WS 20)", 2);
  cells[3] = parseCell("05:00 - 13:00 1", 3);
  cells[4] = parseCell("10:00 - 18:00 EXG01", 4);
  cells[5] = parseCell("08:00 - 16:00 3 (WS 20)", 5);
  const current = {
    dates: blankFortnight("2026-11-15").map(row => new Date(`${row.date}T12:00:00`)),
    rows: [{ line: 10, employeeName: "Example crew", cells }],
  };
  return { engine, master, defunct, current, line: 10, rate: 50, role: "driver" };
}

const result = calculateScenarioLine(fixture());
assert.ok(result.dates[0].wobod);
assert.deepEqual(result.dates[0].wobodSources, ["Defunct master"]);
assert.equal(result.dates[1].comparison.source, "Defunct master");
assert.equal(result.dates[1].comparison.job, "2");
assert.equal(result.dates[2].comparison.source, "Diagram data");
assert.equal(result.dates[2].comparison.job, "3");
assert.ok(result.dates[2].claims.some(claim => claim.label === "Lay-back included in shift pay" && claim.minutes === 60));
assert.ok(result.dates[2].alternatives.filter(item => item.amendment !== "actual").every(item => item.job === "3"));
assert.equal(result.dates[3].comparison.source, "Defunct master");
assert.ok(result.dates[3].claims.some(claim => claim.label === "Lift-up included in shift pay" && claim.minutes === 180));
assert.equal(result.dates[4].comparison.source, "Worked roster");
assert.ok(result.dates[4].claims.every(claim => !/included in shift pay/.test(claim.label)));
assert.ok(result.dates[5].wobod);
assert.deepEqual(result.dates[5].wobodSources, ["Existing master"]);
assert.equal(Math.round((result.dates.reduce((sum, day) => sum + day.difference, 0) + result.adjustmentDifference) * 100), Math.round(result.difference * 100));
console.log("PASS scenario traces both-master WOBOD and same-job swap claims to their comparison jobs");

const swapOffFixture = fixture();
swapOffFixture.defunct.lines.get(10).cells[2] = parseCell("OFF", 2);
swapOffFixture.defunct.lines.get(10).cells[5] = parseCell("OFF", 5);
const swapOffResult = calculateScenarioLine(swapOffFixture);
assert.equal(swapOffResult.dates[2].wobod, false);
assert.deepEqual(swapOffResult.dates[2].wobodSources, []);
assert.equal(swapOffResult.dates[5].wobod, true);
assert.deepEqual(swapOffResult.dates[5].wobodSources, ["Existing master"]);
assert.equal(timesheetEntries(swapOffResult)[5].claims[0], "WOBOD");
assert.equal(swapOffResult.dates[0].wobod, true);
assert.deepEqual(swapOffResult.dates[0].wobodSources, ["Defunct master"]);
console.log("PASS swaps ignore defunct book-off WOBOD while preserving current book-off WOBOD and unswapped defunct claims");

for (const day of result.dates) {
  assert.equal(day.worked.minutes, 480);
  assert.equal(day.scenarioPay, Math.max(day.comparisons.defunct.amount, day.comparisons.existing.amount));
  const worked = day.workedOnlyClaims.reduce((sum, claim) => sum + Math.round(engine.lineAmount(claim) * 100), 0);
  const credits = day.separateTimeClaims.reduce((sum, claim) => sum + Math.round(claim.amount * 100), 0);
  assert.equal(worked + credits, Math.round(day.scenarioPay * 100));
  assert.ok(day.workedOnlyClaims.every(claim => !/included in shift pay/.test(claim.label)));
}
assert.ok(result.dates[3].separateTimeClaims.some(claim => claim.label === "Lift-up" && claim.minutes === 180));
for (const day of result.dates) for (const claim of day.separateTimeClaims) {
  assert.equal(claim.comparison.source, day.comparison.source);
  assert.equal(claim.comparison.job, day.comparison.job);
  assert.equal(claim.comparison.start, day.comparison.start);
  assert.equal(claim.comparison.finish, day.comparison.finish);
  assert.deepEqual(claim.comparison.sources, day.comparison.sources || [day.comparison.source]);
}
console.log("PASS separate time claims retain their selected master or diagram, job and comparison times");
assert.deepEqual(result.dates[2].swapLines, ["20"]);
console.log("PASS roster-view data separates actual job length and time claims, and reconciles both master comparisons");

const summary = timesheetEntries(result);
assert.equal(summary[0].claims[0], "WOBOD MR- Book-OFF day on Defunct roster");
assert.equal(summary[5].claims[0], "WOBOD");
const bothOffFixture = fixture();
bothOffFixture.current.rows[0].cells[5] = parseCell("08:00 - 16:00 3", 5);
bothOffFixture.defunct.lines.get(10).cells[5] = parseCell("OFF", 5);
const bothOffResult = calculateScenarioLine(bothOffFixture);
assert.deepEqual(bothOffResult.dates[5].wobodSources, ["Existing master", "Defunct master"]);
assert.equal(timesheetEntries(bothOffResult)[5].claims[0], "WOBOD");
assert.equal(summary[3].rosteredStart, "06:00");
assert.equal(summary[3].rosteredFinish, "14:00");
assert.equal(summary[3].actualStart, "05:00");
assert.equal(summary[3].actualFinish, "13:00");
assert.equal(summary[3].minutes, 480);
assert.ok(summary[3].claims.includes('Lift Up 3\'00" MR - Defunct 2 06:00–16:00'));
assert.ok(summary[2].claims.includes('Layback 1\'00"'));
assert.equal(summary[2].rosteredStart, "07:00");
assert.equal(summary[2].rosteredFinish, "15:00");
assert.equal(summary[2].actualStart, "08:00");
assert.equal(summary[2].actualFinish, "16:00");
assert.equal(summary[5].rosteredStart, "07:00");
assert.equal(summary[5].rosteredFinish, "15:00");
const absentSummary = timesheetEntries({ ...result, dates: [{ ...result.dates[1], status: "off" }] })[0];
assert.equal(absentSummary.rosteredStart, "06:00");
assert.equal(absentSummary.rosteredFinish, "14:00");
assert.equal(absentSummary.actualStart, "");
assert.equal(claimMinutes(5), '5"');
assert.equal(claimMinutes(87), '1\'27"');
const summaryCsv = scenarioTimesheetCsv([result], dates => dates.slice(0, 7));
assert.ok(summaryCsv.includes('"Rostered start","Actual start","Rostered finish","Actual finish"'));
assert.ok(summaryCsv.includes('WOBOD MR- Book-OFF day on Defunct roster'));
assert.ok(!summaryCsv.includes("Example crew"));
console.log("PASS timesheet summary keeps current rostered times separate from defunct claims and actual job length");

const holidayFixture = fixture();
holidayFixture.current.dates = blankFortnight("2026-12-27").map(row => new Date(`${row.date}T12:00:00`));
const holidayView = calculateScenarioLine(holidayFixture);
const holidayDay = holidayView.dates[1];
assert.ok(holidayDay.workedOnlyClaims.some(claim => claim.label === "Public Holiday Paid"));
const holidayWorked = holidayDay.workedOnlyClaims.reduce((sum, claim) => sum + Math.round(engine.lineAmount(claim) * 100), 0);
const holidayCredits = holidayDay.separateTimeClaims.reduce((sum, claim) => sum + Math.round(claim.amount * 100), 0);
assert.equal(holidayWorked + holidayCredits, Math.round(holidayDay.scenarioPay * 100));
console.log("PASS roster-view claims include public-holiday payments added by the pay renderer");

const equivalentClaim = fixture();
equivalentClaim.defunct.rows[0].cells[6] = parseCell("06:00 - 14:04 1", 6);
const equivalentResult = calculateScenarioLine(equivalentClaim);
assert.equal(equivalentResult.dates[6].amendment, "credit");
assert.ok(equivalentResult.dates[6].claims.some(claim => claim.label === "Build-up included in shift pay" && claim.minutes === 4));
assert.ok(timesheetEntries(equivalentResult)[6].claims.some(note => note.startsWith('Build Up 4" MR - Defunct 1 ')));
console.log("PASS equal-value original-diagram and time-credit options retain the specific time claim");

const referenceFixture = fixture();
const extraCells = Array.from({ length: 14 }, (_, index) => parseCell("OFF", index));
extraCells[2] = parseCell("06:00 - 14:00 3", 2);
extraCells[4] = parseCell("08:00 - 16:00 99", 4);
const extraLine = { line: 30, cells: extraCells };
referenceFixture.defunct.rows.push(extraLine);
referenceFixture.defunct.lines.set(30, extraLine);
referenceFixture.current.rows[0].cells[4] = parseCell("10:00 - 18:00 99 (WS 30)", 4);
const withReference = calculateScenarioLine(referenceFixture);
assert.ok(withReference.dates[2].comparison.source.includes("Defunct master job reference"));
assert.equal(withReference.dates[2].comparison.job, "3");
assert.deepEqual(withReference.dates[2].comparison.referenceOccurrences, [{ line: 30, dayIndex: 2 }]);
assert.ok(withReference.dates[2].claims.some(claim => claim.label === "Lay-back included in shift pay" && claim.minutes === 120));
assert.equal(withReference.dates[4].comparison.job, "99");
assert.ok(withReference.dates[4].comparison.source.includes("Defunct master job reference"));
assert.ok(withReference.dates[4].claims.some(claim => claim.label === "Lay-back included in shift pay" && claim.minutes === 120));
for (const day of withReference.dates) assert.equal(day.scenarioPay, Math.max(...day.alternatives.map(item => item.pay)));
console.log("PASS defunct same-job lookups work across lines, on swaps and for jobs missing from current diagrams");
assert.equal(timesheetEntries(withReference)[2].rosteredStart, "07:00");
assert.equal(timesheetEntries(withReference)[2].rosteredFinish, "15:00");
assert.equal(timesheetEntries(withReference)[4].rosteredStart, "10:00");
assert.equal(timesheetEntries(withReference)[4].rosteredFinish, "18:00");
console.log("PASS swapped summary uses the current job reference even when a defunct claim wins, and never substitutes defunct times");

const existingReference = fixture();
const existingCells = Array.from({ length: 14 }, (_, index) => parseCell("OFF", index));
existingCells[4] = parseCell("08:00 - 16:00 99", 4);
const existingLine = { line: 30, cells: existingCells };
existingReference.master.rows.push(existingLine);
existingReference.master.lines.set(30, existingLine);
existingReference.current.rows[0].cells[4] = parseCell("10:00 - 18:00 99 (WS 30)", 4);
const existingLookup = calculateScenarioLine(existingReference).dates[4];
assert.ok(existingLookup.alternatives.some(item => item.source.includes("Existing master job reference") && item.job === "99" && item.amendment === "credit"));
assert.ok(existingLookup.separateTimeClaims.some(claim => claim.label === "Lay-back" && claim.minutes === 120));
console.log("PASS existing master supplies same-job reference times when diagram data is missing");

const earlyStart = fixture();
earlyStart.master.diagramData["3"] = { dayPattern: "Sun-Sat", signOn: "02:44", offDuty: "10:34", rosteredHrs: 7.833333 };
earlyStart.master.lines.get(20).cells[3] = parseCell("02:44 - 10:34 3", 3);
earlyStart.defunct.rows[0].cells[3] = parseCell("02:55 - 10:25 3", 3);
earlyStart.current.rows[0].cells[3] = parseCell("02:39 - 10:34 3 (WS 20)", 3);
const earlyDay = calculateScenarioLine(earlyStart).dates[3];
assert.ok(earlyDay.alternatives.some(item => item.job === "3" && item.start === "0244" && item.amendment === "credit"));
assert.ok(earlyDay.alternatives.some(item => item.job === "3" && item.start === "0255" && item.amendment === "credit"));
assert.equal(earlyDay.separateTimeClaims.length, 0);
assert.equal(earlyDay.worked.minutes, 475);
assert.equal(earlyDay.comparisons.existing.basis.job, "3");
assert.equal(earlyDay.comparisons.existing.basis.start, "0244");
assert.equal(earlyDay.comparisons.defunct.basis.job, "3");
assert.equal(earlyDay.comparisons.defunct.basis.start, "0255");
console.log("PASS earlier starts with the same or later finish are tested against both same-job references without inventing lift-up time");

const ambiguousMaster = hydrateReferenceMaster({
  schemaVersion: 1, source: "bundled", depot: "auburn", role: "guard", diagramData: {},
  masterRoster: {
    10: Array.from({ length: 14 }, () => job("SBY", "06:00", "14:00")),
    20: Array.from({ length: 14 }, () => job("SBY", "04:00", "12:00")),
  },
});
const standbyReference = buildRosterJobReference(ambiguousMaster);
assert.equal(matchingRosterJob(standbyReference, "SBY", 1), null);
assert.equal(standbyReference.jobs.SBY.variants.length, 2);
assert.equal(standbyReference.jobs.SBY.conflictingWeekdays.length, 7);
const standbyCurrent = {
  dates: referenceFixture.current.dates,
  rows: [{ line: 10, employeeName: "Example crew", cells: Array.from({ length: 14 }, (_, index) => parseCell("08:00 - 16:00 SBY", index)) }],
};
const standby = calculateScenarioLine({ engine, master: ambiguousMaster, defunct: ambiguousMaster, current: standbyCurrent, line: 10, rate: 50, role: "guard" });
assert.ok(standby.dates.every(day => day.alternatives.every(item => item.start !== "0400")));
assert.ok(standby.dates.every(day => day.comparison.start === "0600"));
assert.ok(standby.dates.every(day => day.claims.some(claim => claim.label === "Lay-back included in shift pay" && claim.minutes === 120)));
console.log("PASS ambiguous generic standby jobs keep their own line schedules");

const standbyInsteadOfDiagram = fixture();
standbyInsteadOfDiagram.role = "guard";
standbyInsteadOfDiagram.rate = 45.87895;
standbyInsteadOfDiagram.master.lines.get(10).cells[5] = parseCell("17:07 - 02:06 6038", 5);
standbyInsteadOfDiagram.defunct.lines.get(10).cells[5] = parseCell("16:59 - 01:39 6038", 5);
standbyInsteadOfDiagram.current.rows[0].cells[5] = parseCell("17:07 - 02:06L SBY F59", 5);
const standbyDay = calculateScenarioLine(standbyInsteadOfDiagram).dates[5];
assert.equal(standbyDay.worked.job, "SBY");
assert.equal(standbyDay.worked.minutes, 539);
assert.ok(standbyDay.separateTimeClaims.some(claim => claim.label === "Lay-back" && claim.minutes === 8 && claim.comparison.source.includes("Defunct master") && claim.comparison.job === "6038"));
assert.ok(standbyDay.difference > 0);
assert.equal(standbyDay.wobod, false);
console.log("PASS timed SBY replacing a numbered shift can claim eight minutes of lay-back across midnight against its defunct line");

for (const [start, finish, label] of [["04:00", "12:00", "Lift-up"], ["08:00", "16:00", "Lay-back"], ["08:00", "14:00", "Build-up"]]) {
  const timedStandby = fixture();
  timedStandby.master.lines.get(10).cells[1] = parseCell("06:00 - 14:00 1", 1);
  timedStandby.defunct.lines.get(10).cells[1] = parseCell("06:00 - 14:00 2", 1);
  timedStandby.current.rows[0].cells[1] = parseCell(`${start} - ${finish} SBY`, 1);
  const day = calculateScenarioLine(timedStandby).dates[1];
  assert.ok(day.separateTimeClaims.some(claim => claim.label === label && claim.minutes === 120));
}
console.log("PASS timed SBY supports lift-up, lay-back and build-up against its own master line");

const swappedStandby = fixture();
swappedStandby.current.rows[0].cells[2] = parseCell("10:00 - 18:00 SBY (WS 20)", 2);
const swappedStandbyDay = calculateScenarioLine(swappedStandby).dates[2];
assert.equal(swappedStandbyDay.separateTimeClaims.length, 0);
assert.ok(swappedStandbyDay.alternatives.filter(item => item.amendment !== "actual").every(item => item.job === "SBY"));
console.log("PASS swapped SBY retains the same-job restriction for time claims");

const weekdayMaster = {
  fileName: "example.pdf", rows: [{ line: 1, cells: [
    parseCell("06:00 - 14:00 0007", 1), parseCell("07:00 - 15:00 7", 2),
    parseCell("08:00 - 16:00 8(i)", 3),
  ] }],
};
const weekdays = buildRosterJobReference(weekdayMaster);
assert.equal(matchingRosterJob(weekdays, "0007", 8).start, "0600");
assert.equal(matchingRosterJob(weekdays, "7", 2).start, "0700");
assert.equal(matchingRosterJob(weekdays, "7", 4), null);
assert.equal(matchingRosterJob(weekdays, "8(i)", 0).start, "0800");
assert.equal(weekdays.jobs["7"].variants[0].occurrences[0].line, 1);
console.log("PASS reference preserves weekday variants, normalises job numbers and records source positions");

const options = [
  [{ paid: 10000, guarantee: 960 }, { paid: 12000, guarantee: 1440 }],
  [{ paid: 9000, guarantee: 480 }, { paid: 13000, guarantee: 1440 }],
  [{ paid: 8000, guarantee: 960 }, { paid: 10000, guarantee: 1200 }],
];
for (const rate of [15, 50, 100]) {
  const chosen = maximiseOptions(options, { hours: 30, rate });
  const value = choices => {
    const paid = choices.reduce((sum, item) => sum + item.paid, 0);
    const worked = Math.round(choices.reduce((sum, item) => sum + item.guarantee, 0) / 120 * 100) / 100;
    const hours = Math.round(Math.max(0, 30 - worked) * 100) / 100;
    return paid + Math.round(hours * rate * 100);
  };
  const all = options[0].flatMap(a => options[1].flatMap(b => options[2].map(c => [a, b, c])));
  assert.equal(value(chosen), Math.max(...all.map(value)));
}
console.log("PASS scenario maximum matches exhaustive combinations including guarantee top-ups");

const rows = blankFortnight("2026-11-15").map(row => ({ ...row, status: "off" }));
Object.assign(rows[0], { status: "work", rosteredStart: "0400", rosteredFinish: "1200", actualStart: "1700", actualFinish: "0100", timeWorked: "0800", amendment: "credit", creditAlignment: "same-date" });
const dated = engine.buildPayObject(toEngineTable(rows, 50, "short"));
assert.ok(dated[0].lines.some(claim => claim.label === "Lay-back included in shift pay" && claim.minutes === 780));
assert.ok(dated[0].lines.every(claim => claim.label !== "Lift-up included in shift pay"));
delete rows[0].creditAlignment;
const legacy = engine.buildPayObject(toEngineTable(rows, 50, "short"));
assert.ok(legacy[0].lines.some(claim => claim.label === "Lift-up included in shift pay"));
console.log("PASS explicit scenario dates prevent the early-standby next-day alignment error");

for (let index = 0; index < 5; index++) Object.assign(rows[index], { status: "work", rosteredStart: "0600", rosteredFinish: "1400", actualStart: "0600", actualFinish: "1400", timeWorked: "0800", wobod: true, amendment: "" });
assert.throws(() => engine.buildPayObject(toEngineTable(rows, 50, "short")), /first four/);
const assumed = engine.buildPayObject(toEngineTable(rows, 50, "short", { weekdayOvertimeAfterFourth: 2 }));
assert.equal(assumed[4].standaloneOvertimeRate, 2);
assert.throws(() => engine.buildPayObject(toEngineTable(rows, 50, "short")), /first four/);
console.log("PASS later-weekday WOBOD assumption is explicit and confined to the scenario run");
