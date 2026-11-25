import { analyseRosters, toIsoDate, rosterShiftMinutes, shiftDurationMinutes, RELINQUISHMENT_MINUTES } from "./roster-core.mjs";
import { NSW_PUBLIC_HOLIDAYS } from "./public-holidays.js";
import { kilometreValue, extraKilometres } from "./diagram-kilometres.mjs";
import { isIsoDate } from "./master-store.mjs";

export const DAYS = ["sun", "mon", "tues", "wed", "thur", "fri", "sat"];
export const STATUS_LABELS = {
  work: "Worked",
  off: "OFF",
  ado: "ADO",
  nta: "NTA",
  blank: "Not entered",
  sick: "Sick leave",
  hol: "Public holiday not worked",
  annual: "Annual leave",
  jury: "Jury duty",
  seconded: "Seconded duty",
  lsl: "Long service leave",
  "lsl-half": "Long service leave (half pay)",
  "lsl-double": "Long service leave (double pay)",
  unpaid: "Approved unpaid leave",
  unapproved: "Unapproved absence",
  "ph-taken": "Accrued public holiday taken",
  "picnic-off": "Picnic day taken",
  cancelled: "Eligible cancelled diagram",
  unknown: "Needs review",
};

export const LEAVE_STATUSES = ["sick", "annual", "lsl", "lsl-half", "lsl-double", "unpaid", "unapproved", "ph-taken", "picnic-off"];
export const FIXED_PAID_STATUSES = ["jury", "seconded"];
export const FULL_SICK_HOURS = 8;
const REVIEW_MESSAGES = {
  part_day_sick_relief: "Enter the full scheduled shift duration to calculate the sick leave remainder.",
  crossed_out_shift: "The PDF crosses out this shift. Choose the correct status before calculating.",
  confirm_sick_workday: "Check that this was a shift to be worked, not a day off.",
};

export function blankFortnight(start) {
  if (!isIsoDate(start) || new Date(`${start}T12:00:00`).getDay() !== 0) {
    throw new Error("Choose the Sunday that starts your fortnight.");
  }
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(`${start}T12:00:00`);
    date.setDate(date.getDate() + index);
    const iso = toIsoDate(date);
    return {
      dayIndex: index,
      date: iso,
      status: "blank",
      jobNumber: "",
      rosteredStart: "",
      rosteredFinish: "",
      actualStart: "",
      actualFinish: "",
      timeWorked: "",
      milageTime: "",
      ph: Boolean(NSW_PUBLIC_HOLIDAYS[iso]),
      publicHolidayName: NSW_PUBLIC_HOLIDAYS[iso] || "",
      accruePh: false,
      wobod: false,
      extraKm: "",
      rawText: "",
      flags: [],
      reviewed: true,
      edited: false,
    };
  });
}

export function importLine(master, current, line) {
  const sourceRow = current.rows.find(
    (row) => row.line === Number(line) && row.employeeName.trim(),
  );
  if (!sourceRow) throw new Error("Choose a named employee line.");
  if (sourceRow.seconded) throw new Error("This crew member is seconded out of train crew pay.");
  if (sourceRow.crewUnavailable) throw new Error(`This crew member is marked ${sourceRow.crewLeave || "unavailable"} in the name column. Choose the active replacement line.`);
  const result = analyseRosters(master, current, [sourceRow]);
  const missingLine = !master.lines.has(sourceRow.line);
  const rows = result.payRows.map((pay, index) => {
    const cell = sourceRow.cells[index];
    const unknown = cell.status === "BLANK" && Boolean(cell.rawText);
    let status = ["OFF", "ADO", "NTA"].includes(cell.status)
      ? cell.status.toLowerCase()
      : pay.status;
    if (pay.changeType === "annual_leave_as_hol") status = "annual";
    if (unknown) status = "unknown";
    const flags = pay.flags
      .filter(flag => flag !== "part_day_sick_relief" || !pay.hasRelinquishmentSchedule)
      .map((flag) => /^(?:diagram_times_unverified|job_conflict):/.test(flag)
        ? `No unique rostered times for job ${cell.jobNumber}. Check its rostered start and finish.`
        : REVIEW_MESSAGES[flag] || flag);
    if (unknown)
      flags.push(
        "Unrecognised roster entry. Choose its status and confirm its times.",
      );
    if (missingLine)
      flags.push(
        "This line is missing from the master. Confirm the rostered times.",
      );
    if (pay.mileageOver209Candidate)
      flags.push("Mileage marker found. Check the mileage fields.");
    return {
      ...pay,
      status,
      ...(status === "sick" ? { leaveHours: FULL_SICK_HOURS } : {}),
      rosteredStart: pay.leaveRosteredStart || (/^\d{4}$/.test(pay.rosteredStart) ? pay.rosteredStart : ""),
      rosteredFinish: pay.leaveRosteredFinish || pay.rosteredFinish,
      actualStart: pay.timedRelinquishment ? cell.start : /^\d{4}$/.test(pay.actualStart) ? pay.actualStart : "",
      actualFinish: pay.timedRelinquishment ? cell.finish : pay.actualFinish,
      timeWorked: pay.timedRelinquishment ? durationBetween(cell.start, cell.finish) : pay.timeWorked,
      rawText: cell.rawText,
      sourceStatus: cell.status,
      jobNumber: cell.jobNumber || "",
      jobLabel: cell.jobLabel || cell.jobNumber || "",
      milageTime: "",
      flags,
      reviewed: flags.length === 0,
      edited: false,
    };
  });
  return {
    rows,
    employeeName: sourceRow.employeeName,
    line: sourceRow.line,
    rosterType: rows[0].rosterType,
    warnings: result.flags
      .filter((flag) => !flag.date)
      .map((flag) => flag.flag),
  };
}

export function prefillMasterLine(master, line, start, employeeName = "") {
  const dates = blankFortnight(start).map(row => new Date(`${row.date}T12:00:00`));
  const masterRow = master.lines.get(Number(line));
  if (!masterRow) throw new Error("This line is missing from the selected master roster.");
  const data = importLine(master, {
    dates,
    rows: [{ ...masterRow, employeeName: "Manual entry" }],
  }, line);
  data.employeeName = employeeName.trim();
  data.rows = data.rows.map((row, index) => row.status === "work" ? {
    ...row,
    rosteredStart: masterRow.cells[index].start,
    rosteredFinish: masterRow.cells[index].finish,
    actualStart: masterRow.cells[index].start,
    actualFinish: masterRow.cells[index].finish,
    timeWorked: durationBetween(masterRow.cells[index].start, masterRow.cells[index].finish),
    changeType: "master_line_day",
  } : row);
  return data;
}

export function clock(value) {
  return String(value || "").replace(":", "");
}
export function displayClock(value) {
  return /^\d{4}$/.test(value || "")
    ? `${value.slice(0, 2)}:${value.slice(2)}`
    : "";
}
export function durationBetween(start, finish) {
  const a = Number(start.slice(0, 2)) * 60 + Number(start.slice(2));
  const b = Number(finish.slice(0, 2)) * 60 + Number(finish.slice(2));
  const minutes = (b - a + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;
}

export function isTimedRelinquishment(row) {
  return row.timedRelinquishment && (row.status === "work" || row.status === "sick");
}

export function relinquishmentStatus(row) {
  if (!isTimedRelinquishment(row)) return row.status;
  const minutes = shiftDurationMinutes(row.actualStart, row.actualFinish);
  if (minutes === null) return row.status;
  return minutes >= RELINQUISHMENT_MINUTES ? "work" : "sick";
}

function relinquishmentShiftMinutes(row) {
  if (row.hasRelinquishmentSchedule)
    return shiftDurationMinutes(row.rosteredStart, row.rosteredFinish);
  const hours = Number(row.relinquishmentShiftHours);
  const minutes = Math.round(hours * 60);
  return Number.isFinite(hours) && hours <= 24 && minutes > 0 ? minutes : null;
}

export function validateShift(row) {
  const errors = [];
  const valid = (value) => /^(?:[01]\d|2[0-3])[0-5]\d$/.test(value || "");
  const relinquished = isTimedRelinquishment(row);
  if (relinquished) {
    row = { ...row, status: relinquishmentStatus(row) };
    const worked = shiftDurationMinutes(row.actualStart, row.actualFinish);
    const fullShift = relinquishmentShiftMinutes(row);
    if (worked === null)
      errors.push("Enter the start and finish of the time worked before relinquishing.");
    if (row.status === "work" && fullShift === null)
      errors.push("Enter the full scheduled shift duration or its rostered times.");
    else if (row.status === "work" && !row.hasRelinquishmentSchedule && worked !== null && fullShift < worked)
      errors.push("The full scheduled shift cannot be shorter than the time worked.");
  }
  if (!STATUS_LABELS[row.status] || row.status === "unknown")
    errors.push("Choose a recognised shift status.");
  if (["work", "cancelled"].includes(row.status) ||
      (row.status !== "sick" && LEAVE_STATUSES.includes(row.status) && (row.rosteredStart || row.rosteredFinish))) {
    if (!valid(row.rosteredStart) || !valid(row.rosteredFinish))
      errors.push("Enter valid rostered start and finish times.");
    else if (row.rosteredStart === row.rosteredFinish)
      errors.push("Rostered start and finish must differ.");
  }
  if (row.status === "work") {
    if (!valid(row.actualStart) || !valid(row.actualFinish))
      errors.push("Enter valid actual start and finish times.");
    else if (row.actualStart === row.actualFinish)
      errors.push("Actual start and finish must differ.");
    else if (
      row.timeWorked !== durationBetween(row.actualStart, row.actualFinish)
    ) {
      errors.push("Total worked must match the actual start and finish times.");
    }
    if (row.milageTime && !valid(row.milageTime))
      errors.push("Enter a valid time when 209 km was passed.");
    if (valid(row.milageTime) && valid(row.actualStart) && valid(row.actualFinish)) {
      const passed = durationBetween(row.actualStart, row.milageTime);
      if (passed === "0000" || passed > durationBetween(row.actualStart, row.actualFinish))
        errors.push("The 209 km time must fall within the worked shift.");
    }
    for (const [field, label, limit] of [
      ["extraKm", "Extra kilometres", 1000],
      ["rosteredKm", "Rostered kilometres", 1000],
      ["actualKm", "Actual kilometres", 1000],
      ["intercityKm", "Intercity kilometres", 643.999],
      ["unassociatedMinutes", "Unassociated work minutes", 1440],
      ["departureGap", "Sign-on to departure minutes", 1440],
      ["arrivalGap", "Arrival to sign-off minutes", 1440],
      ["sickRemainderHours", "Sick leave remainder hours", 24],
      ["travelMinutes", "Excess travel minutes", 1440],
    ]) {
      if (row[field] != null && row[field] !== "" &&
          (!Number.isFinite(Number(row[field])) || Number(row[field]) < 0 || Number(row[field]) > limit))
        errors.push(`${label} must be between 0 and ${limit}.`);
    }
    if (row.intercityKm && (row.milageTime || Number(row.extraKm) || row.straightSix || row.amendment === "compare"))
      errors.push("Intercity distance and suburban pay adjustments must be entered separately.");
    if (!row.intercityKm && [row.unassociatedMinutes, row.departureGap, row.arrivalGap].some(Number))
      errors.push("Enter the Intercity distance for distance-related time credits.");
    if (row.amendment === "compare" && (row.originalStart || row.originalFinish) &&
        (!valid(row.originalStart) || !valid(row.originalFinish) || row.originalStart === row.originalFinish))
      errors.push("Enter both original diagram times and ensure they differ.");
    if (row.mealClaim && (row.timeWorked <= "1000" || row.timeWorked > "1600"))
      errors.push("The away-from-home-station meal claim requires more than 10 and up to 16 hours.");
    if (!relinquished && row.sickRemainderHours && valid(row.actualStart) && valid(row.actualFinish) &&
        valid(row.rosteredStart) && valid(row.rosteredFinish)) {
      const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
      const shiftLimit = row.changeType === "custom_duty"
        ? 24 * 60
        : minutes(durationBetween(row.rosteredStart, row.rosteredFinish));
      if (Number(row.sickRemainderHours) * 60 + minutes(durationBetween(row.actualStart, row.actualFinish)) > shiftLimit)
        errors.push("Worked time and the sick leave remainder must fit the rostered shift.");
    }
  }
  if (row.status !== "sick" && LEAVE_STATUSES.includes(row.status) && row.leaveHours != null && row.leaveHours !== "" &&
      (!Number.isFinite(Number(row.leaveHours)) || Number(row.leaveHours) <= 0 || Number(row.leaveHours) > 24))
    errors.push("Paid or unpaid leave hours must be greater than 0 and at most 24.");
  if (row.accruePh && !row.ph && row.status !== "hol")
    errors.push("Accrue public holiday requires Public holiday.");
  return errors;
}

export function toEngineTable(rows, payrate, rosterType, settings = {}) {
  if (!Number.isFinite(Number(payrate)) || Number(payrate) <= 0)
    throw new Error("Enter your hourly pay rate, greater than zero.");
  if (!["long", "short"].includes(rosterType))
    throw new Error("Choose a long or short fortnight.");
  if (rows.length !== 14) throw new Error("A fortnight must contain 14 days.");
  const previousDay = new Date(`${rows[0].date}T12:00:00`);
  previousDay.setDate(previousDay.getDate() - 1);
  const nextDay = new Date(`${rows[13].date}T12:00:00`);
  nextDay.setDate(nextDay.getDate() + 1);
  const table = {
    ...settings,
    startDate: rows[0].date,
    nextDayPH: Boolean(NSW_PUBLIC_HOLIDAYS[toIsoDate(nextDay)]),
    previousDayPH: Boolean(NSW_PUBLIC_HOLIDAYS[toIsoDate(previousDay)]),
    payrate: Number(payrate),
    longFortnight: rosterType === "long",
  };
  rows.forEach((savedRow, index) => {
    const row = { ...savedRow, status: relinquishmentStatus(savedRow) };
    const errors = validateShift(row);
    if (errors.length || !row.reviewed)
      throw new Error(
        `${row.date}: ${errors[0] || "Review this shift before calculating."}`,
      );
    const item = { ...(settings.scenarioComparison ? row : withAutomaticTimeClaim(row)), day: DAYS[index % 7] };
    if (!settings.scenarioComparison && settings.role === "driver" && Object.hasOwn(row, "actualKm"))
      item.extraKm = extraKilometres(kilometreValue(row.actualKm), kilometreValue(row.rosteredKm));
    item.RDO = ["off", "ado", "nta", "blank"].includes(row.status);
    item.sick = row.status === "sick";
    item.hol = row.status === "hol";
    item.wobod = row.status === "work" && Boolean(row.wobod);
    if (item.hol) item.ph = true;
    item.leaveType = [...LEAVE_STATUSES, ...FIXED_PAID_STATUSES, "cancelled"].includes(row.status) ? row.status : "";
    if (item.sick) item.leaveHours = FULL_SICK_HOURS;
    item.leaveMinutes = item.leaveType && item.leaveHours ? Number(item.leaveHours) * 60 : undefined;
    item.annualLoading = item.leaveType === "annual" ? Number(row.annualLoading || 0) : 0;
    item.sickRemainderMinutes = row.status === "work" ? Number(row.sickRemainderHours || 0) * 60 : 0;
    if (isTimedRelinquishment(row)) {
      item.amendment = "";
      if (row.status === "work") item.sickRemainderMinutes = Math.max(0,
        relinquishmentShiftMinutes(row) - shiftDurationMinutes(row.actualStart, row.actualFinish));
    }
    item.ordinaryMinutes = row.status === "work" && row.ordinaryMinutes ? Number(row.ordinaryMinutes) : undefined;
    item.travelMinutes = row.status === "work" ? Number(row.travelMinutes || 0) : 0;
    table[index] = item;
  });
  return table;
}

export function withAutomaticTimeClaim(row) {
  const times = rosterShiftMinutes(row);
  let changeType = row.changeType;
  if (row.status === "work" && ["same", "changed_time", "lift_up", "layback", "buildup"].includes(changeType))
    changeType = times.liftUpMinutes ? "lift_up" : times.laybackMinutes ? "layback" : times.buildupMinutes ? "buildup" :
      row.rosteredStart === row.actualStart && row.rosteredFinish === row.actualFinish ? "same" : "changed_time";
  return { ...row, ...times, changeType, creditAlignment: "same-date",
    amendment: times.payableMinutes > times.workedMinutes ? "credit" : "" };
}
