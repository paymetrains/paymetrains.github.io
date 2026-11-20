import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PayEngine = require("../pay-calculator.js");
const publicHolidayData = await readFile(new URL("../public-holidays.js", import.meta.url), "utf8");

const DAYS = [
  "sun",
  "mon",
  "tues",
  "wed",
  "thur",
  "fri",
  "sat",
  "sun",
  "mon",
  "tues",
  "wed",
  "thur",
  "fri",
  "sat",
];

function createTable({ longFortnight = true, payrate = 50 } = {}) {
  const table = {
    longFortnight,
    payrate,
  };

  DAYS.forEach((day, index) => {
    table[index] = {
      day,
      RDO: true,
      ph: false,
      accruePh: false,
    };
  });

  return table;
}

function setWork(table, index, options = {}) {
  const start = options.start || "0600";
  const finish = options.finish || "1400";
  table[index] = {
    day: DAYS[index],
    rosteredStart: options.rosteredStart || start,
    actualStart: options.actualStart || start,
    rosteredFinish: options.rosteredFinish || finish,
    actualFinish: options.actualFinish || finish,
    milageTime: options.milageTime || "",
    ph: Boolean(options.ph),
    accruePh: Boolean(options.accruePh),
    wobod: Boolean(options.wobod),
    callout: Boolean(options.callout),
    extraKm: options.extraKm || "",
    timeWorked: options.timeWorked || "0800",
    excessDayNormal: Boolean(options.excessDayNormal),
    excessDayDouble: Boolean(options.excessDayDouble),
    mileageOver209Candidate: Boolean(options.mileageOver209Candidate),
  };
}

function setSick(table, index, options = {}) {
  table[index] = {
    day: DAYS[index],
    rosteredStart: options.rosteredStart || "0600",
    rosteredFinish: options.rosteredFinish || "1400",
    actualStart: "SICK",
    ph: Boolean(options.ph),
    accruePh: Boolean(options.accruePh),
    sick: true,
  };
}

function run(name, testFn) {
  try {
    testFn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("NSW public holidays are loaded from editable data module", () => {
  assert.match(publicHolidayData, /"2026-12-25": "Christmas Day"/);
});

run("long fortnight guarantee tops 10 seven-hour shifts by 10 hours", () => {
  const table = createTable({ longFortnight: true, payrate: 50 });
  for (let index = 0; index < 10; index += 1) {
    setWork(table, index, { finish: "1300", timeWorked: "0700" });
  }

  const payObj = PayEngine.buildPayObject(table);
  const inputs = PayEngine.getGuaranteeInputs(payObj, 10);

  assert.equal(inputs.workedHours, 70);
  assert.equal(inputs.timeLostHours, 0);
  assert.equal(PayEngine.GuaranteePayment(payObj), 500);
});

run("short fortnight guarantee tops 9 seven-hour shifts by 9 hours", () => {
  const table = createTable({ longFortnight: false, payrate: 50 });
  for (let index = 0; index < 9; index += 1) {
    setWork(table, index, { finish: "1300", timeWorked: "0700" });
  }

  const payObj = PayEngine.buildPayObject(table);
  const inputs = PayEngine.getGuaranteeInputs(payObj, 9);

  assert.equal(inputs.workedHours, 63);
  assert.equal(inputs.timeLostHours, 0);
  assert.equal(PayEngine.GuaranteePayment(payObj), 450);
});

run("sick day reduces guarantee by time lost", () => {
  const table = createTable({ longFortnight: true, payrate: 50 });
  for (let index = 0; index < 9; index += 1) {
    setWork(table, index);
  }
  setSick(table, 9);

  const payObj = PayEngine.buildPayObject(table);
  const inputs = PayEngine.getGuaranteeInputs(payObj, 10);

  assert.equal(inputs.workedHours, 72);
  assert.equal(inputs.timeLostHours, 8);
  assert.equal(PayEngine.GuaranteePayment(payObj), 0);
});

run("extra-day overtime is skipped for guarantee", () => {
  const table = createTable({ longFortnight: true, payrate: 50 });
  for (let index = 0; index < 10; index += 1) {
    setWork(table, index);
  }
  setWork(table, 10, { excessDayNormal: true });

  const payObj = PayEngine.buildPayObject(table);
  const inputs = PayEngine.getGuaranteeInputs(payObj, 10);

  assert.equal(inputs.workedHours, 80);
  assert.equal(inputs.timeLostHours, 0);
  assert.equal(PayEngine.GuaranteePayment(payObj), 0);
});

run("mileage candidate flag alone does not apply mileage pay", () => {
  const table = createTable({ longFortnight: true, payrate: 50 });
  setWork(table, 1, { mileageOver209Candidate: true });

  const payObj = PayEngine.buildPayObject(table);

  assert.equal(payObj[1].milage, undefined);
  assert.equal(payObj[1].totalWorked, 8);
});

run("pure engine calculation returns finite gross pay", () => {
  const table = createTable({ longFortnight: true, payrate: 50 });
  for (let index = 0; index < 10; index += 1) {
    setWork(table, index);
  }

  const result = PayEngine.calculate(table);

  assert.equal(Number.isFinite(result.grossPay), true);
  assert.equal(result.payObj[0].totalWorked, 8);
});

run("WOBOD is paid with standalone overtime even when another day is sick", () => {
  const table = createTable();
  setSick(table, 1);
  setWork(table, 2, { wobod: true, callout: true });
  const result = PayEngine.calculateWithBreakdown(table);

  assert.equal(result.grossPay, 4600);
  assert.match(result.breakdown.details, /TUES:\s+Standalone overtime @ 150%:\s+WOBOD @ 50%:/);
  assert.doesNotMatch(result.breakdown.details, /Callout|NEXT FORTNIGHT|Ordinary Hours:/i);
  assert.deepEqual(PayEngine.getGuaranteeInputs(result.payObj, 10), { workedHours: 0, timeLostHours: 8 });
});

run("standalone overtime uses weekday tiers and changes at midnight", () => {
  const table = createTable();
  setWork(table, 0, { wobod: true });
  setWork(table, 1, { wobod: true });
  setWork(table, 2, { wobod: true });
  setWork(table, 6, { wobod: true, start: "2200", finish: "0630", timeWorked: "0830" });
  const result = PayEngine.calculateWithBreakdown(table);

  // Fortnight guarantee plus standalone payments of 1200, 800, 1000 and 1225.
  assert.equal(result.grossPay, 8025);
  assert.match(result.breakdown.details, /SAT:\s+Standalone overtime @ 200%:\s+Standalone overtime @ 250%:\s+WOBOD @ 50%:/);
  assert.match(result.breakdown.amounts, /200\.00\n812\.50\n212\.50/);
  assert.doesNotMatch(result.breakdown.details, /Night Shift|Loading @/);
});

run("weekday overtime uses three hours at 150% then 200%, including after midnight", () => {
  const table = createTable();
  Object.assign(table, { startDate: "2026-11-01", guaranteeEligible: false });
  setWork(table, 1, { start: "0600", finish: "1800", timeWorked: "1200" });
  setWork(table, 2, { start: "2200", finish: "0630", timeWorked: "0830" });
  const { payObj } = PayEngine.calculate(table);
  assert.deepEqual(payObj[1].lines.map(({ label, minutes, rate }) => [label, minutes, rate]), [
    ["Ordinary hours", 480, 50],
    ["Scheduled OT @ 150%", 180, 75],
    ["Scheduled OT @ 200%", 60, 100],
  ]);
  assert.deepEqual(payObj[2].lines.find(line => line.label === "Scheduled OT @ 150%"),
    { label: "Scheduled OT @ 150%", minutes: 30, rate: 75 });
});

run("scheduled overtime splits weekday and Saturday portions of the same shift", () => {
  const table = createTable();
  setWork(table, 5, { start: "1500", finish: "0300", timeWorked: "1200" });
  const { lines } = PayEngine.buildPayObject(table)[5];
  assert.equal(lines.find(line => line.label === "Scheduled OT @ 150%").minutes, 60);
  assert.equal(lines.find(line => line.label === "Scheduled OT @ 200%").minutes, 180);
});

run("Sunday lay-back keeps the weekday allowance on actual work as in the Guards Claims Guide", () => {
  const table = createTable();
  Object.assign(table, { startDate: "2026-11-15", role: "guard" });
  setWork(table, 0, {
    rosteredStart: "2000", rosteredFinish: "0430",
    start: "2200", finish: "0630", timeWorked: "0830",
  });
  table[0].amendment = "credit";
  const { lines } = PayEngine.buildPayObject(table)[0];
  assert.equal(lines.find(line => line.label === "Lay-back included in shift pay").minutes, 120);
  assert.equal(lines.find(line => line.label === "Sunday loading @ 100%").minutes, 240);
  assert.equal(lines.find(line => line.label === "Scheduled OT @ 150%").minutes, 150);
  assert.deepEqual(lines.find(line => line.label === "Night shift allowance"),
    { label: "Night shift allowance", minutes: 360, rate: 5.92 });
});

run("public holiday loading replaces weekend loading and excess bank hours are paid", () => {
  const table = createTable();
  Object.assign(table, { holidayBalance: 93, guaranteeEligible: false });
  setWork(table, 6, { start: "2200", finish: "0630", timeWorked: "0830", ph: true, accruePh: true });
  Object.assign(table[7], { ph: true });
  const { payObj, breakdown, grossPay } = PayEngine.calculateWithBreakdown(table);
  assert.equal(grossPay, 1300);
  assert.equal(payObj[6].lines.find(line => line.label === "Public holiday loading @ 100%").minutes, 480);
  assert.doesNotMatch(breakdown.details, /Saturday loading|Sunday loading/);
  assert.match(breakdown.details, /Public holiday accrued:\s+Public Holiday Paid:/);
  assert.match(breakdown.units, /3\.00\n5\.00/);
});

run("weekday public holiday retains eligible shift allowance and pays a separate day", () => {
  const table = createTable();
  Object.assign(table, { startDate: "2026-11-01", guaranteeEligible: false });
  setWork(table, 1, { start: "0500", finish: "1300", ph: true });
  const { grossPay, payObj } = PayEngine.calculate(table);
  assert.equal(grossPay, 840.24);
  assert.equal(payObj[1].lines.find(line => line.label === "Early morning shift allowance").rate, 5.03);
});

run("209 km top-up matches the guard guide and stays outside overtime", () => {
  const table = createTable();
  Object.assign(table, { guaranteeEligible: false, role: "guard" });
  setWork(table, 6, { milageTime: "1330", extraKm: 20 });
  const { payObj, grossPay } = PayEngine.calculate(table);
  assert.equal(grossPay, 437.5);
  const { lines } = payObj[6];
  assert.equal(lines.find(line => line.label === "209 km minimum top-up").minutes, 30);
  assert.equal(lines.find(line => line.label === "209 km premium").minutes, 30);
  assert.ok(lines.every(line => !/Overtime|Scheduled OT|Extra kilometre/.test(line.label)));
});

run("Intercity uses the distance band plus each eligible gap or the higher scheduled floor", () => {
  const table = createTable();
  setWork(table, 1);
  Object.assign(table[1], { intercityKm: 300, unassociatedMinutes: 30, departureGap: 50, arrivalGap: 60 });
  setWork(table, 2, { rosteredStart: "0600", rosteredFinish: "1700" });
  Object.assign(table[2], { intercityKm: 260, departureGap: 30, arrivalGap: 30 });
  const payObj = PayEngine.buildPayObject(table);
  const topup = row => row.lines.find(line => line.label === "Intercity kilometreage top-up").minutes;
  assert.equal(topup(payObj[1]), 120);
  assert.equal(topup(payObj[2]), 180);
});

run("approved diagram comparisons pick the greater dollar value", () => {
  const table = createTable();
  Object.assign(table, { startDate: "2026-11-01", guaranteeEligible: false });
  setWork(table, 1, { start: "0800", finish: "1600" });
  Object.assign(table[1], { amendment: "compare", originalStart: "0500", originalFinish: "1300" });
  const { grossPay, breakdown } = PayEngine.calculateWithBreakdown(table);
  assert.equal(grossPay, 240.24);
  assert.match(breakdown.details, /original value applied/);
  table[1].milageTime = "1500";
  assert.equal(PayEngine.calculate(table).grossPay, 275);
});

run("part-shift sick leave is paid separately and does not erase worked hours", () => {
  const table = createTable();
  setWork(table, 1, { finish: "1000", timeWorked: "0400" });
  table[1].sickRemainderMinutes = 240;
  const { payObj, grossPay } = PayEngine.calculate(table);
  assert.equal(grossPay, 3800);
  assert.deepEqual(PayEngine.getGuaranteeInputs(payObj, 10), { workedHours: 4, timeLostHours: 4 });
  assert.deepEqual(payObj[1].lines.map(line => line.label), ["Ordinary hours", "Sick leave · remainder of shift"]);
});

run("approved unpaid leave reduces guarantee and unapproved absence disqualifies it", () => {
  const table = createTable();
  setWork(table, 1);
  Object.assign(table[2], { RDO: false, leaveType: "unpaid", leaveMinutes: 480 });
  assert.equal(PayEngine.calculate(table).grossPay, 3400);
  table[2].leaveType = "unapproved";
  assert.equal(PayEngine.calculate(table).grossPay, 200);
});

run("hourly presets use the fixed hourly values for each role", () => {
  assert.equal(PayEngine.rates.classifications("driver").length, 6);
  assert.equal(PayEngine.rates.classifications("guard").length, 6);
  assert.equal(PayEngine.rates.hourlyRate("Driver Thereafter"), 52.23026);
  assert.equal(PayEngine.rates.hourlyRate("Guard Thereafter"), 45.87895);
  assert.equal(PayEngine.rates.hourlyRate("Principal Driver Intercity"), null);
});

run("allowances follow pay-period dates and annual leave loading respects the cap", () => {
  assert.equal(PayEngine.rates.forPeriod("2026-06-28").early, 4.84);
  assert.equal(PayEngine.rates.forPeriod("2026-07-12").early, 5.03);
  const table = createTable({ payrate: 100 });
  Object.assign(table, { startDate: "2026-11-01", guaranteeEligible: false });
  Object.assign(table[1], { RDO: false, leaveType: "annual", leaveMinutes: 480, annualLoading: 0.2 });
  Object.assign(table[2], { RDO: false, leaveType: "lsl-half", leaveMinutes: 480 });
  assert.equal(PayEngine.calculate(table).grossPay, 945.38);
});
