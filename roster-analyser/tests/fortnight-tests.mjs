import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseCell } from "../roster-core.mjs";
import { buildPayslip } from "../payslip.mjs";
import {
  hydrateMaster,
  hydrateReferenceMaster,
  serialiseMaster,
  selectMaster,
} from "../master-store.mjs";
import {
  blankFortnight,
  importLine,
  prefillMasterLine,
  durationBetween,
  validateShift,
  toEngineTable,
} from "../fortnight-model.mjs";
const engine = createRequire(import.meta.url)("../pay-calculator.js");
function test(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}
const metadata = {
  depot: "auburn",
  role: "guard",
  effectiveFrom: "2026-11-01",
  effectiveTo: "2026-11-14",
};
const work = (index) => parseCell("06:00 - 14:00 5018 F10", index);
const row = {
  line: 10,
  cells: Array.from({ length: 14 }, (_, i) =>
    i < 10 ? work(i) : parseCell("OFF", i),
  ),
};
const saved = serialiseMaster(
  { rows: [row], fileName: "master.pdf" },
  metadata,
);
const master = hydrateMaster(JSON.parse(JSON.stringify(saved)));
const dates = blankFortnight("2026-11-01").map(
  (row) => new Date(`${row.date}T12:00:00`),
);
const current = {
  fileName: "current.pdf",
  dates,
  rows: [
    {
      ...row,
      employeeName: "Lau, Steven",
      cells: row.cells.map((cell) => ({ ...cell })),
    },
  ],
};

test("manual line prefilling uses the chosen master's times and retains the original baseline when edited", () => {
  const standbyMaster = hydrateReferenceMaster({
    schemaVersion: 1, source: "bundled", depot: "auburn", role: "driver",
    masterRoster: {
      202: Array.from({ length: 14 }, (_, index) => index < 9
        ? { job: "SBY", start: "03:00", finish: "11:00" }
        : { job: index === 9 ? "ADO" : "OFF" }),
    },
    diagramData: {},
  });
  const data = prefillMasterLine(standbyMaster, "202", "2026-11-15", " Example ");
  assert.equal(data.line, 202);
  assert.equal(data.employeeName, "Example");
  assert.equal(data.rosterType, "short");
  assert.equal(data.rows[0].date, "2026-11-15");
  assert.equal(data.rows[13].date, "2026-11-28");
  assert.equal(data.rows[0].jobNumber, "SBY");
  assert.equal(data.rows[0].rosteredStart, "0300");
  assert.equal(data.rows[0].actualStart, "0300");
  assert.equal(data.rows[0].changeType, "master_line_day");
  assert.deepEqual(data.rows.slice(9).map(row => row.status), ["ado", "off", "off", "off", "off"]);
  assert.ok(data.rows.every(row => !row.wobod));
  const originals = structuredClone(data.rows);
  data.rows[1].actualStart = "0400";
  data.rows[1].actualFinish = "1200";
  data.rows[1].amendment = "credit";
  assert.equal(data.rows[1].rosteredStart, "0300");
  const pay = engine.buildPayObject(toEngineTable(data.rows, 50, data.rosterType));
  assert.ok(pay[1].lines.some(item => item.label === "Lay-back included in shift pay"));
  assert.equal(originals[1].actualStart, "0300");
  assert.throws(() => prefillMasterLine(standbyMaster, "999", "2026-11-15"), /missing/);
  assert.throws(() => prefillMasterLine(standbyMaster, "202", "2026-11-16"), /Sunday/);
  const uploaded = prefillMasterLine(master, "10", "2026-11-15");
  assert.equal(uploaded.rows[0].rosteredStart, "0600");
  assert.equal(uploaded.employeeName, "");
});

test("payslip groups ordinary pay and keeps dated claims and adjustments equal to gross", () => {
  const rows = blankFortnight("2026-11-15").map(row => ({ ...row, status: "off" }));
  for (const index of [0, 1, 2, 3, 4]) {
    Object.assign(rows[index], {
      status: "work", rosteredStart: "0300", rosteredFinish: "1100",
      actualStart: "0400", actualFinish: "1300", timeWorked: "0900",
      amendment: "credit",
    });
  }
  rows[2].wobod = true;
  rows[3].ph = true;
  rows[3].accruePh = true;
  Object.assign(rows[5], { status: "annual", leaveHours: 8, annualLoading: 17.5 });
  Object.assign(rows[8], { status: "sick", leaveHours: 8 });
  const result = engine.calculateWithBreakdown(toEngineTable(rows, 52.23026, "short", {
    role: "driver", holidayBalance: 94, otherPayment: 12.34,
  }));
  const payslip = buildPayslip(result, rows);
  assert.deepEqual(payslip.days.map(day => day.date), rows.map(row => row.date));
  assert.ok(payslip.normalWorking.amount > 0);
  assert.ok(payslip.days[0].claims.some(item => item.label.includes("Sunday loading")));
  assert.ok(payslip.days[2].claims.some(item => item.label === "WOBOD @ 50%"));
  assert.ok(payslip.days[3].claims.some(item => item.label === "Public Holiday Paid" && item.amount > 0));
  assert.ok(payslip.days[5].claims.some(item => item.label === "Annual leave"));
  assert.ok(payslip.days[8].claims.some(item => item.label === "Sick leave"));
  assert.deepEqual(payslip.days[13].claims, []);
  const allClaims = payslip.days.flatMap(day => day.claims);
  assert.ok(allClaims.some(item => item.label === "Lay-back included in shift pay" && item.amount === null));
  assert.ok(allClaims.every(item => !["Ordinary hours", "Public holiday worked"].includes(item.label)));
  assert.ok(payslip.adjustments.some(item => item.label === "Guarantee"));
  assert.ok(payslip.adjustments.some(item => item.label === "ADO Adjustment"));
  assert.ok(payslip.adjustments.some(item => item.label === "Other confirmed pay" && item.amount === 12.34));
  const cents = [...allClaims, ...payslip.adjustments].reduce(
    (sum, item) => sum + Math.round((item.amount || 0) * 100),
    Math.round(payslip.normalWorking.amount * 100),
  );
  assert.equal(cents, Math.round(result.grossPay * 100));
});

test("work swaps use the referenced line's scheduled shift with or without a matching marker", () => {
  const original = { job: "5018", start: "06:00", finish: "14:00" };
  const other = { job: "5020", start: "08:00", finish: "16:00" };
  const swapMaster = hydrateReferenceMaster({
    schemaVersion: 1, source: "bundled", depot: "auburn", role: "guard",
    masterRoster: {
      10: Array.from({ length: 14 }, (_, i) => i === 2 ? { job: "OFF" } : original),
      25: Array.from({ length: 14 }, () => other),
    },
    diagramData: {
      5018: { dayPattern: "Mon-Thu", signOn: "06:00", offDuty: "14:00", rosteredHrs: 8 },
      5020: { dayPattern: "Mon-Thu", signOn: "07:00", offDuty: "15:00", rosteredHrs: 8 },
    },
  });
  const roster = structuredClone(current);
  roster.rows[0].cells[1] = parseCell("08:00 - 16:00 5020 (WS 25)", 1);
  const otherLine = { line: 25, cells: [...roster.rows[0].cells] };
  otherLine.cells[1] = parseCell("06:00 - 14:00 5018 (WS 10)", 1);
  roster.rows.push(otherLine);
  const paired = importLine(swapMaster, roster, 10).rows[1];
  assert.equal(paired.workSwap.original.jobNumber, "5018");
  assert.equal(paired.workSwap.partners[0].current.jobNumber, "5018");
  assert.equal(paired.workSwap.assignedLine, 25);
  assert.equal(paired.rosteredStart, "0800");
  assert.equal(paired.reviewed, true);

  roster.rows[0].cells[1] = parseCell("08:00 - 16:01 5020 (WS 25)", 1);
  roster.rows[0].cells[2] = parseCell("08:00 - 16:00 5020 (WS 25)", 2);
  roster.rows.pop();
  const oneWay = importLine(swapMaster, roster, 10).rows[1];
  assert.equal(oneWay.workSwap.partners[0].reciprocal, false);
  assert.equal(oneWay.workSwap.assignedLine, 25);
  assert.equal(oneWay.rosteredStart, "0800");
  assert.equal(oneWay.originalFinish, "1600");
  assert.equal(oneWay.actualFinish, "1601");
  assert.equal(oneWay.reviewed, true);
  const swappedOff = importLine(swapMaster, roster, 10).rows[2];
  assert.equal(swappedOff.workSwap.original.status, "OFF");
  assert.equal(swappedOff.wobod, false);
  assert.equal(swappedOff.reviewed, true);

  roster.rows[0].cells[2] = parseCell("07:00 - 15:00 5020 (WS 99)", 2);
  const missingPartner = importLine(swapMaster, roster, 10).rows[2];
  assert.equal(missingPartner.rosteredStart, "0700");
  assert.equal(missingPartner.wobod, false);
  assert.equal(missingPartner.reviewed, true);
});

test("manual dates must be a real Sunday; midnight crossings retain correct duration", () => {
  assert.throws(() => blankFortnight("2026-11-02"), /Sunday/);
  assert.throws(() => blankFortnight("2026-02-30"), /Sunday/);
  assert.equal(blankFortnight("2026-11-01").at(-1).date, "2026-11-14");
  assert.equal(durationBetween("2200", "0630"), "0830");
});
test("master JSON round trip rebuilds lookup maps and job dictionary", () => {
  assert.equal(master.lines.get(10).cells.length, 14);
  assert.equal(master.jobDictionary.jobs["5018"].start, "0600");
  assert.equal(saved.rows[0].employeeName, undefined);
  assert.throws(() => hydrateMaster({ ...saved, rows: [row, row] }), /unique/);
});
test("catalogue matches depot, role and the whole effective range; ambiguous versions fail", () => {
  assert.equal(
    selectMaster([metadata], "auburn", "guard", "2026-11-01", "2026-11-14"),
    metadata,
  );
  assert.equal(
    selectMaster([metadata], "auburn", "driver", "2026-11-01", "2026-11-14"),
    null,
  );
  assert.equal(
    selectMaster([metadata], "auburn", "guard", "2026-11-01", "2026-11-15"),
    null,
  );
  assert.throws(
    () =>
      selectMaster(
        [metadata, metadata],
        "auburn",
        "guard",
        "2026-11-01",
        "2026-11-14",
      ),
    /More than one/,
  );
});
test("only a named employee can be imported; unknown codes must be resolved", () => {
  assert.throws(
    () =>
      importLine(
        master,
        { ...current, rows: [{ ...row, employeeName: "" }] },
        10,
      ),
    /named/,
  );
  const modified = structuredClone(current);
  modified.rows[0].cells[2] = parseCell("(Unlisted code)", 2);
  const imported = importLine(master, modified, 10);
  assert.equal(imported.rows[2].status, "unknown");
  assert.equal(imported.rows[2].reviewed, false);
  assert.throws(
    () => toEngineTable(imported.rows, 50, "long"),
    /recognised/,
  );
});
test("imported and manually entered identical shifts use identical existing pay calculations", () => {
  const imported = importLine(master, current, 10).rows;
  const manual = blankFortnight("2026-11-01");
  for (let i = 0; i < 10; i++)
    Object.assign(manual[i], {
      status: "work",
      rosteredStart: "0600",
      rosteredFinish: "1400",
      actualStart: "0600",
      actualFinish: "1400",
      timeWorked: "0800",
    });
  const a = engine.calculateWithBreakdown(
    toEngineTable(imported, 50, "long"),
  );
  const b = engine.calculate(toEngineTable(manual, 50, "long"));
  assert.equal(a.grossPay, b.grossPay);
  assert.ok(a.breakdown.details.includes("Gross Pay:"));
  assert.ok(a.breakdown.amounts.includes(a.grossPay.toFixed(2)));
});
test("ordinary time changes can be calculated directly or claimed as diagram adjustments", () => {
  const modified = structuredClone(current);
  modified.rows[0].cells[1] = parseCell("05:30 - 13:30 5018", 1);
  modified.rows[0].cells[2] = parseCell("07:00 - 16:00 5018", 2);
  const { rows } = importLine(master, modified, 10);
  assert.deepEqual([rows[1].rosteredStart, rows[1].rosteredFinish], ["0600", "1400"]);
  assert.deepEqual([rows[1].actualStart, rows[1].actualFinish], ["0530", "1330"]);
  assert.ok(rows.slice(1, 3).every(row => row.reviewed && row.flags.length === 0));
  const ordinary = engine.buildPayObject(toEngineTable(rows, 50, "long"));
  assert.equal(ordinary[2].lines.find(line => line.label === "Scheduled OT @ 150%").minutes, 60);
  rows[1].amendment = rows[2].amendment = "credit";
  const claimed = engine.buildPayObject(toEngineTable(rows, 50, "long"));
  assert.equal(claimed[1].lines.find(line => line.label === "Lift-up included in shift pay").minutes, 30);
  assert.equal(claimed[2].lines.find(line => line.label === "Lay-back included in shift pay").minutes, 60);
});
test("unswapped booked-off work imports as WOBOD regardless of shift count", () => {
  const modified = structuredClone(current);
  modified.rows[0].cells[0] = parseCell("(SL)", 0);
  modified.rows[0].cells[10] = work(10);
  const dutyFreeMaster = structuredClone(saved);
  dutyFreeMaster.rows[0].cells[10] = parseCell("DFD", 10);
  const { rows } = importLine(hydrateMaster(dutyFreeMaster), modified, 10);
  assert.equal(rows[0].status, "sick");
  assert.equal(rows[10].extraDayOvertime, false);
  assert.equal(rows[10].wobod, true);
  assert.equal(rows[10].reviewed, true);
  const table = toEngineTable(rows, 50, "long");
  assert.equal(table[10].wobod, true);
  assert.equal(engine.buildPayObject(table)[10].standaloneOvertimeRate, 1.5);
  rows[10].wobod = false;
  assert.equal(toEngineTable(rows, 50, "long")[10].wobod, false);
});
test("invalid times, unresolved reviews and inconsistent durations cannot reach engine", () => {
  const rows = blankFortnight("2026-11-01");
  Object.assign(rows[0], {
    status: "work",
    rosteredStart: "0600",
    rosteredFinish: "1400",
    actualStart: "0600",
    actualFinish: "1400",
    timeWorked: "0700",
  });
  assert.throws(() => toEngineTable(rows, 50, "long"), /Total worked/);
  rows[0].timeWorked = "0800";
  rows[0].reviewed = false;
  assert.throws(() => toEngineTable(rows, 50, "long"), /Review/);
  rows[0].reviewed = true;
  rows[0].actualStart = "2500";
  assert.ok(
    validateShift(rows[0]).some((error) => error.includes("valid actual")),
  );
  assert.throws(() => toEngineTable(rows, 0, "long"), /hourly/);
});

test("annual roster codes keep rostered times and part-shift sick codes preserve work", () => {
  const modified = structuredClone(current);
  modified.rows[0].cells[1] = parseCell("(AL)", 1);
  modified.rows[0].cells[2] = parseCell("06:00 - 10:00 5018 (SL REL)", 2);
  const { rows } = importLine(master, modified, 10);
  assert.equal(rows[1].status, "annual");
  assert.equal(rows[1].ph, false);
  assert.equal(rows[1].rosteredStart, "0600");
  assert.equal(rows[1].rosteredFinish, "1400");
  assert.equal(rows[2].status, "work");
  assert.equal(rows[2].timeWorked, "0400");
  assert.equal(rows[2].reviewed, true);
  const table = toEngineTable(rows, 50, "long", { role: "guard" });
  const payObj = engine.buildPayObject(table);
  assert.equal(payObj[1].lines[0].label, "Annual leave");
  assert.equal(payObj[2].lines[1].label, "Sick leave · remainder of shift");
});

test("the fortnight boundary carries the next calendar holiday into a Saturday shift", () => {
  const rows = blankFortnight("2027-04-11");
  Object.assign(rows[13], {
    status: "work", rosteredStart: "2200", rosteredFinish: "0600",
    actualStart: "2200", actualFinish: "0600", timeWorked: "0800",
  });
  const table = toEngineTable(rows, 50, "long");
  assert.equal(table.nextDayPH, true);
  const payObj = engine.buildPayObject(table);
  assert.equal(payObj[13].lines.find(line => line.label === "Public holiday worked").minutes, 360);
});

test("Bundled reference uses master line assignments and shows matching diagram kilometres", () => {
  const days = Array.from({ length: 14 }, () => ({ job: "OFF", start: null, finish: null }));
  days[1] = { job: "11", start: "02:33", finish: "10:24" };
  const reference = hydrateReferenceMaster({
    schemaVersion: 1, source: "bundled", depot: "auburn", role: "driver",
    masterRoster: { 10: days },
    diagramData: {
      11: { dayPattern: "Mon-Thu", signOn: "02:33", offDuty: "10:24", rosteredHrs: 7.85, rosteredKm: 100 },
      12: { dayPattern: "Wed", signOn: "07:00", offDuty: "15:00", rosteredHrs: 8, rosteredKm: 110 },
    },
  });
  const modified = structuredClone(current);
  modified.rows[0].cells[1] = parseCell("02:33 - 10:30 11", 1);
  modified.rows[0].cells[3] = parseCell("07:00 - 15:00 12", 3);
  const { rows } = importLine(reference, modified, 10);
  assert.equal(reference.source, "bundled");
  assert.equal(rows[1].rosteredFinish, "1024");
  assert.equal(rows[1].actualFinish, "1030");
  assert.equal(rows[1].rosteredKm, 100);
  assert.equal(rows[3].rosteredKm, 110);
  assert.equal(rows[3].wobod, true);
});

test("confirmed roster codes preserve days off, split relinquishment, and price fixed paid duties", () => {
  const modified = structuredClone(current);
  const [line] = modified.rows;
  line.cells[1] = parseCell("(SiF)", 1);
  line.cells[2] = parseCell("OFF(SiF)", 2);
  line.cells[3] = parseCell("(REL REL)", 3);
  line.cells[4] = parseCell("06:00 - 10:00 5018 (10:00 REL REL)", 4);
  line.cells[5] = { ...parseCell("06:00 - 14:00 5018 (LVE Purchased) F0", 5), crossedOut: true };
  line.cells[6] = parseCell("(Jury Dty)", 6);
  line.cells[7] = { ...parseCell("06:00 - 14:00 5018 (Sec NIF)", 7), crossedOut: true };
  const { rows } = importLine(master, modified, 10);
  assert.deepEqual(rows.slice(1, 8).map(row => row.status),
    ["sick", "off", "sick", "work", "annual", "jury", "seconded"]);
  assert.equal(rows[4].timeWorked, "0400");
  assert.deepEqual(validateShift(rows[4]), []);
  const payObj = engine.buildPayObject(toEngineTable(rows, 50, "long"));
  assert.equal(payObj[5].lines[0].label, "Annual leave");
  assert.deepEqual(payObj[6].lines, [{ label: "Jury duty", minutes: 480, rate: 50 }]);
  assert.deepEqual(payObj[7].lines, [{ label: "Seconded duty", minutes: 480, rate: 50 }]);
  line.seconded = true;
  assert.throws(() => importLine(master, modified, 10), /seconded out/);
});

test("custom timed duties use their own times while known diagrams keep their planned times", () => {
  const masterRoster = { 10: Array.from({ length: 14 }, (_, index) =>
    index === 3 ? { job: "OFF", start: null, finish: null } :
      { job: index === 2 ? "SBY" : "5018", start: "06:00", finish: "14:00" }) };
  const reference = hydrateReferenceMaster({
    schemaVersion: 1, source: "bundled", depot: "auburn", role: "guard", masterRoster,
    diagramData: { 5018: { dayPattern: "Mon-Thu", signOn: "06:00", offDuty: "14:00", rosteredHrs: 8 } },
  });
  const modified = structuredClone(current);
  const [line] = modified.rows;
  line.cells[0] = parseCell("19:00 - 03:52L EXG01 F67", 0);
  line.cells[1] = parseCell("08:00 - 16:00 Training F67", 1);
  line.cells[2] = parseCell("08:00 - 16:00 SBY F67", 2);
  line.cells[3] = parseCell("08:00 - 16:00 Meeting F67", 3);
  line.cells[4] = parseCell("07:00 - 15:00 5018 F67", 4);
  const { rows } = importLine(reference, modified, 10);
  assert.deepEqual(rows.slice(0, 4).map(row => [row.jobLabel, row.rosteredStart, row.rosteredFinish, row.changeType]), [
    ["EXG01", "1900", "0352", "custom_duty"],
    ["Training", "0800", "1600", "custom_duty"],
    ["SBY", "0600", "1400", "layback"],
    ["Meeting", "0800", "1600", "custom_duty"],
  ]);
  assert.equal(rows[0].originalStart, "");
  assert.equal(rows[0].reviewed, true);
  assert.equal(rows[3].wobod, true);
  assert.equal(rows[4].rosteredStart, "0600");
  assert.equal(rows[4].actualStart, "0700");
});

test("relinquishment pays the full shift under four hours and splits pay at four hours", () => {
  const night = parseCell("22:00 - 06:00 5018", 1);
  const nightMaster = hydrateMaster(serialiseMaster({ rows: [{
    line: 10, cells: Array.from({ length: 14 }, (_, dayIndex) => ({ ...night, dayIndex })),
  }] }, metadata));
  const modified = structuredClone(current);
  const [line] = modified.rows;
  line.cells = line.cells.map((_, index) => ({ ...night, dayIndex: index }));
  line.cells[1] = parseCell("22:00 - 01:59 5018 (REL REL)", 1);
  line.cells[2] = parseCell("22:00 - 02:00 5018 (SL REL)", 2);
  line.cells[3] = parseCell("22:00 - 04:21 5018 (REL REL)", 3);
  line.cells[4] = parseCell("22:00 - 01:00 EXG01 (REL REL)", 4);
  const { rows } = importLine(nightMaster, modified, 10);
  assert.equal(rows[1].status, "sick");
  assert.equal(rows[1].actualFinish, "0159");
  assert.equal(rows[2].status, "work");
  assert.throws(() => toEngineTable(rows, 50, "long"), /full scheduled shift/);
  Object.assign(rows[4], { relinquishmentShiftHours: "8.5", reviewed: true });
  const table = toEngineTable(rows, 50, "long");
  assert.equal(table[1].leaveMinutes, 480);
  assert.equal(table[2].sickRemainderMinutes, 240);
  assert.equal(table[3].sickRemainderMinutes, 99);
  assert.equal(table[4].leaveMinutes, 510);
  const payObj = engine.buildPayObject(table);
  assert.deepEqual(payObj[1].lines, [{ label: "Sick leave", minutes: 480, rate: 50 }]);
  assert.ok(payObj[2].lines.some(line => line.label === "Ordinary hours" && line.minutes === 240));
  assert.ok(payObj[2].lines.some(line => line.label === "Sick leave · remainder of shift" && line.minutes === 240));
  Object.assign(rows[2], { actualFinish: "0159", timeWorked: "0359" });
  assert.equal(toEngineTable(rows, 50, "long")[2].leaveMinutes, 480);
});

test("PH roster leave draws down the holiday bank without creating a public holiday", () => {
  const modified = structuredClone(current);
  const [line] = modified.rows;
  line.cells[1] = parseCell("(PH)", 1);
  line.cells[2] = parseCell("OFF(PH)", 2);
  line.cells[3] = parseCell("06:00 - 14:00 5018 (PH)", 3);
  const { rows } = importLine(master, modified, 10);
  assert.deepEqual(rows.slice(1, 4).map(row => [row.status, row.ph]),
    [["ph-taken", false], ["off", false], ["ph-taken", false]]);
  Object.assign(rows[4], { status: "off", ph: true, accruePh: true });
  const { payObj, breakdown } = engine.calculateWithBreakdown(
    toEngineTable(rows, 50, "long", { holidayBalance: 96 }),
  );
  assert.deepEqual(payObj[1].lines, [{ label: "Accrued public holiday taken", minutes: 480, rate: 50 }]);
  assert.equal(payObj[1].holidayTaken, 480);
  assert.equal(payObj[3].holidayTaken, 480);
  assert.match(breakdown.details, /Public holiday accrued/);
  assert.doesNotMatch(breakdown.details, /Public Holiday Paid|Public holiday loading/);
});

test("injury, maternity, unpaid and long service roster leave use the confirmed pay treatment", () => {
  const modified = structuredClone(current);
  const [line] = modified.rows;
  line.cells[1] = { ...parseCell("06:00 - 13:30 5018 (Inj)", 1), crossedOut: true };
  line.cells[2] = { ...parseCell("06:00 - 13:30 5018 (Mat L)", 2), crossedOut: true };
  line.cells[3] = parseCell("(LWOP)", 3);
  line.cells[4] = { ...parseCell("06:00 - 13:30 5018 (LSL)", 4), crossedOut: true };
  line.cells[5] = parseCell("OFF(LSL)", 5);
  const { rows } = importLine(master, modified, 10);
  assert.deepEqual(rows.slice(1, 6).map(row => row.status), ["sick", "unpaid", "unpaid", "lsl", "off"]);
  const payObj = engine.buildPayObject(toEngineTable(rows, 50, "long", { holidayBalance: 40 }));
  assert.deepEqual(payObj[1].lines, [{ label: "Sick leave", minutes: 450, rate: 50 }]);
  assert.equal(payObj[2].timeLostHours, 7.5);
  assert.equal(payObj[3].timeLostHours, 8);
  assert.deepEqual(payObj[2].lines, []);
  assert.deepEqual(payObj[4].lines, [{ label: "Long service leave", minutes: 480, rate: 50 }]);
  assert.equal(payObj[4].holidayTaken, undefined);
});
