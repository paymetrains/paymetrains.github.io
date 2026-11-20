const standaloneOvertime = typeof module !== "undefined" && module.exports
  ? require("./standalone-overtime.js")
  : StandaloneOvertime;
const payShiftClaims = typeof module !== "undefined" && module.exports
  ? require("./shift-claims.js")
  : globalThis.RosterShiftClaims;

var payDiv = getCalculatorElement("payDetails");
var unitDiv = getCalculatorElement("unitDetails");
var rateDiv = getCalculatorElement("rateDetails");
var amountDiv = getCalculatorElement("amountDetails");
const trainCrewRates = typeof module !== "undefined" && module.exports
  ? require("./pay-rates.js")
  : TrainCrewRates;
const CLASSIC_DUTY_STATUS = new Map([
  ["jury", "jury"], ["sec", "seconded"], ["ph", "ph-taken"], ["lsl", "lsl"], ["lwop", "unpaid"],
]);

const PayEngine = {
  buildPayObject,
  lineAmount,
  rates: trainCrewRates,
  bindRatePreset,
  calculateWithBreakdown(tableObj) {
    const payObj = buildPayObject(tableObj);
    const targets = createPayOutputTargets();
    const grossPay = withPayOutputTargets(targets, () => calculatePayIntoCurrentTargets(payObj));
    return {
      payObj,
      grossPay,
      breakdown: {
        details: targets.payDiv.innerText,
        units: targets.unitDiv.innerText,
        rates: targets.rateDiv.innerText,
        amounts: targets.amountDiv.innerText,
      },
    };
  },
  calculate(tableObj) {
    const payObj = buildPayObject(tableObj);
    return {
      payObj,
      grossPay: CalculatePay(payObj, { render: false }),
    };
  },
  calculateGrossPay(payObj) {
    return CalculatePay(payObj, { render: false });
  },
  getGuaranteeInputs,
  GuaranteePayment,
  parseTimeToMinutes,
  parseDurationToMinutes,
  isValidClockTime,
  isValidDuration,
  rounded,
};

function getCalculatorElement(id) {
  if (typeof document === "undefined") {
    return createPayOutputTarget();
  }
  return document.getElementById(id) || createPayOutputTarget();
}

function createPayOutputTarget() {
  return { innerText: "" };
}

function bindRatePreset(select, input) {
  function applyRate() {
    input.value = select.selectedOptions[0]?.dataset.rate ?? "";
  }

  select.addEventListener("change", applyRate);
  input.addEventListener("input", () => { select.value = ""; });

  return function updatePresets(role) {
    const previous = select.value;
    select.replaceChildren(new Option("Enter my own rate", ""));
    for (const name of trainCrewRates.classifications(role)) {
      const rate = trainCrewRates.hourlyRate(name);
      const option = new Option(`${name} · $${rate.toFixed(2)}/hr`, name);
      option.dataset.rate = rate;
      select.append(option);
    }
    if (previous) {
      select.value = previous;
      if (select.selectedIndex < 0) select.value = "";
      applyRate();
    }
  };
}

var storeData = () => {
  clearInputErrors();

  const payrate = document.getElementById("payRate").value.trim();
  if (!payrate || !Number.isFinite(Number(payrate))) {
    alert("insert payrate");
    return;
  }

  const selectedFortnight = document.querySelector("input[name=longOrShort]:checked");
  if (!selectedFortnight) {
    alert("pick long or short");
    return;
  }

  const longOrShort = selectedFortnight.value;
  var longFortnight = true;
  if (longOrShort == "short") {
    longFortnight = false;
  }

  const table = document.getElementById("timesheet");
  const rows = table.querySelectorAll(".payRow");
  const validationErrors = validateTimesheetRows(rows);
  if (validationErrors.length) {
    showValidationErrors(validationErrors);
    return;
  }
  const tableObj = {};
  const days = [
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

  tableObj.longFortnight = longFortnight;
  tableObj.payrate = payrate;
  tableObj.startDate = document.getElementById("payPeriodStart")?.value;
  tableObj.role = document.getElementById("payCrewRole")?.value || "driver";
  rows.forEach((row, i) => {
    tableObj[i] = readTimesheetFormRow(row, days[i]);
  });

  try {
    convertInputs(tableObj);
  } catch (error) {
    showValidationErrors([error.message]);
  }
};

function readTimesheetFormRow(row, day) {
  const inputs = getTimesheetInputs(row);
  const rowObj = {
    day,
    rosteredStart: cleanValue(inputs.rosteredStart),
    actualStart: cleanValue(inputs.actualStart),
    amendment: document.getElementById("payDiagramAdjustment")?.value || "",
    rosteredFinish: cleanValue(inputs.rosteredFinish),
    actualFinish: cleanValue(inputs.actualFinish),
    milageTime: cleanValue(inputs.milageTime),
    ph: Boolean(inputs.ph?.checked),
    accruePh: Boolean(inputs.accruePh?.checked),
    wobod: Boolean(inputs.wobod?.checked),
    callout: Boolean(inputs.callout?.checked),
    extraKm: cleanValue(inputs.extraKm),
    timeWorked: cleanValue(inputs.totalWorked),
  };

  if (rowObj.rosteredStart.toLowerCase() === "hol") {
    rowObj.hol = true;
    rowObj.ph = true;
    return rowObj;
  }

  if (rowObj.actualStart.toLowerCase() === "al") {
    rowObj.leaveType = "annual";
    return rowObj;
  }
  const dutyStatus = CLASSIC_DUTY_STATUS.get(rowObj.actualStart.toLowerCase());
  if (dutyStatus) {
    rowObj.leaveType = dutyStatus;
    return rowObj;
  }

  if (!rowObj.rosteredStart) {
    rowObj.RDO = true;
    return rowObj;
  }

  if (rowObj.actualStart.toLowerCase() === "sick") {
    rowObj.sick = true;
    return rowObj;
  }

  return rowObj;
}

function getTimesheetInputs(row) {
  const inputs = row.querySelectorAll("input");
  return {
    rosteredStart: inputs[0],
    actualStart: inputs[1],
    rosteredFinish: inputs[2],
    actualFinish: inputs[3],
    milageTime: inputs[4],
    ph: inputs[5],
    accruePh: inputs[6],
    wobod: inputs[7],
    callout: inputs[8],
    extraKm: inputs[9],
    totalWorked: inputs[10],
  };
}

function validateTimesheetRows(rows) {
  const errors = [];

  rows.forEach((row, index) => {
    const inputs = row.querySelectorAll("input");
    const [
      rosteredStartInput,
      actualStartInput,
      rosteredFinishInput,
      actualFinishInput,
      milageTimeInput,
      phInput,
      accruePhInput,
      wobodInput,
      calloutInput,
      extraKmInput,
      totalWorkedInput,
    ] = inputs;

    const day = row.querySelector("td")?.textContent?.trim() || `row ${index + 1}`;
    const rosteredStart = cleanValue(rosteredStartInput);
    const actualStart = cleanValue(actualStartInput);
    const rosteredFinish = cleanValue(rosteredFinishInput);
    const actualFinish = cleanValue(actualFinishInput);
    const totalWorked = cleanValue(totalWorkedInput);
    const hasPhOnly = phInput?.checked || accruePhInput?.checked;
    const hasWorkSignal = [
      rosteredStart,
      actualStart,
      rosteredFinish,
      actualFinish,
      cleanValue(milageTimeInput),
      cleanValue(extraKmInput),
      totalWorked,
    ].some(Boolean) || wobodInput?.checked || calloutInput?.checked;

    if (!hasWorkSignal || (hasPhOnly && !hasWorkSignal)) return;
    if (rosteredStart.toLowerCase() === "hol") return;
    if (CLASSIC_DUTY_STATUS.has(actualStart.toLowerCase())) return;

    const isAnnual = actualStart.toLowerCase() === "al";
    if (isAnnual && !rosteredStart && !rosteredFinish) return;
    const isSick = actualStart.toLowerCase() === "sick" || isAnnual;
    if (isSick) {
      requireField(rosteredStartInput, day, "rostered sign on", errors);
      requireField(rosteredFinishInput, day, "rostered sign off", errors);
      validateTimeInput(rosteredStartInput, day, "rostered sign on", errors, { allowWords: ["hol"] });
      validateTimeInput(rosteredFinishInput, day, "rostered sign off", errors);
      return;
    }

    const requiredFields = [
      [rosteredStartInput, "rostered sign on"],
      [actualStartInput, "actual sign on"],
      [rosteredFinishInput, "rostered sign off"],
      [actualFinishInput, "actual sign off"],
      [totalWorkedInput, "total worked"],
    ];

    for (const [input, label] of requiredFields) {
      requireField(input, day, label, errors);
    }

    validateTimeInput(rosteredStartInput, day, "rostered sign on", errors);
    validateTimeInput(actualStartInput, day, "actual sign on", errors);
    validateTimeInput(rosteredFinishInput, day, "rostered sign off", errors);
    validateTimeInput(actualFinishInput, day, "actual sign off", errors);
    validateTimeInput(milageTimeInput, day, "209km time", errors, { optional: true });
    validateTimeInput(totalWorkedInput, day, "total worked", errors, { duration: true });

    if (isValidClockTime(rosteredStart) && isValidClockTime(rosteredFinish)) {
      const rosteredStartMinutes = parseTimeToMinutes(rosteredStart);
      const rosteredFinishMinutes = parseTimeToMinutes(rosteredFinish);
      if (rosteredStartMinutes === rosteredFinishMinutes) {
        markInputError(rosteredStartInput);
        markInputError(rosteredFinishInput);
        errors.push(`${day}: rostered sign on and sign off cannot be the same time.`);
      }
    }

    if (
      isValidClockTime(actualStart) &&
      isValidClockTime(actualFinish) &&
      isValidDuration(totalWorked)
    ) {
      const actualStartMinutes = parseTimeToMinutes(actualStart);
      const actualFinishMinutes = parseTimeToMinutes(actualFinish);
      const workedMinutes = parseDurationToMinutes(totalWorked);
      if (actualStartMinutes === actualFinishMinutes) {
        markInputError(actualStartInput);
        markInputError(actualFinishInput);
        errors.push(`${day}: actual sign on and sign off cannot be the same time for a worked shift.`);
      } else {
        const actualDuration =
          actualFinishMinutes >= actualStartMinutes
            ? actualFinishMinutes - actualStartMinutes
            : actualFinishMinutes + 1440 - actualStartMinutes;
        if (workedMinutes !== actualDuration) {
          markInputError(actualStartInput);
          markInputError(actualFinishInput);
          markInputError(totalWorkedInput);
          errors.push(`${day}: total worked must match actual sign on/sign off.`);
        }
      }
    }
  });

  return errors;
}

function requireField(input, day, label, errors) {
  if (cleanValue(input)) return;
  markInputError(input);
  errors.push(`${day}: ${label} is required.`);
}

function validateTimeInput(input, day, label, errors, options = {}) {
  const value = cleanValue(input);
  if (!value && options.optional) return;
  if (!value) return;
  if (options.allowWords?.includes(value.toLowerCase())) return;

  const isValid = options.duration ? isValidDuration(value) : isValidClockTime(value);
  if (!isValid) {
    markInputError(input);
    errors.push(`${day}: ${label} must use HHMM with minutes 00-59.`);
  }
}

function clearInputErrors() {
  document.querySelectorAll(".input-danger").forEach((input) => {
    input.classList.remove("input-danger");
    input.removeAttribute("aria-invalid");
  });

  const status = getValidationStatusElement();
  status.hidden = true;
  status.innerHTML = "";
}

function showValidationErrors(errors) {
  const status = getValidationStatusElement();
  status.hidden = false;
  status.innerHTML = `<strong>Fix highlighted fields before calculating.</strong><ul>${errors
    .slice(0, 8)
    .map((error) => `<li>${escapeHtml(error)}</li>`)
    .join("")}</ul>`;
}

function getValidationStatusElement() {
  let status = document.getElementById("calculatorValidationStatus");
  if (status) return status;

  status = document.createElement("div");
  status.id = "calculatorValidationStatus";
  status.className = "validationStatus";
  const timesheet = document.getElementById("timesheet");
  timesheet.parentNode.insertBefore(status, timesheet);
  return status;
}

function markInputError(input) {
  if (!input) return;
  input.classList.add("input-danger");
  input.setAttribute("aria-invalid", "true");
}

function cleanValue(input) {
  return input?.value?.trim() || "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function convertInputs(tableObj) {
  const payObj = PayEngine.buildPayObject(tableObj);
  CalculatePay(payObj);
  DisplayBreakdown(payObj);
  return payObj;
}

function buildPayObject(table) {
  const payObj = {
    longFortnight: table.longFortnight,
    otherPayment: Number(table.otherPayment || 0),
    payrate: Number(table.payrate),
    guaranteeEligible: table.guaranteeEligible !== false,
    holidayBalance: table.holidayBalance === "" || table.holidayBalance == null ? null : Number(table.holidayBalance),
  };
  if (!Number.isFinite(payObj.payrate) || payObj.payrate <= 0) {
    throw new Error("Enter an hourly rate greater than zero.");
  }
  if (payObj.holidayBalance !== null &&
      (!Number.isFinite(payObj.holidayBalance) || payObj.holidayBalance < 0)) {
    throw new Error("Enter a public holiday bank balance of zero or more.");
  }
  if (!Number.isFinite(payObj.otherPayment)) throw new Error("Enter a valid amount for other pay.");
  const rates = trainCrewRates.forPeriod(table.startDate || table[0]?.date);
  const role = table.role || "driver";
  // Unapproved absences disqualify the guarantee. Approved unpaid leave reduces it.
  if (Array.from({ length: 14 }, (_, index) => table[index]).some(row => row.leaveType === "unapproved"))
    payObj.guaranteeEligible = false;
  let overtimeShiftNumber = 0;
  for (let i = 0; i < 14; i++) {
    const input = table[i];
    const next = table[i + 1];
    const row = {
      ...input,
      PH: Boolean(input.ph || input.hol),
      accruePH: Boolean(input.accruePh),
      nextDayPH: Boolean(next?.ph || next?.hol || (i === 13 && table.nextDayPH)),
      previousDayPH: Boolean(table[i - 1]?.ph || table[i - 1]?.hol || (i === 0 && table.previousDayPH)),
      WOBOD: Boolean(input.wobod && !input.RDO && !input.hol && !input.sick && !input.leaveType && input.timeWorked !== "0000"),
      lines: [],
      guaranteeHours: 0,
      timeLostHours: 0,
      holidayHours: 0,
      weekdayOvertimeAfterFourth: table.weekdayOvertimeAfterFourth,
    };
    payObj[i] = row;
    const ordinaryMinutes = table.ordinaryMinutes || 480;
    if (row.WOBOD) {
      row.overtimeShiftNumber = ++overtimeShiftNumber;
      row.standaloneOvertimeRate = standaloneRate(row.day, row);
    }
    if (row.RDO || row.hol || row.sick || row.leaveType) {
      priceNonWorkingDay(row, payObj.payrate, rates, ordinaryMinutes, role);
    } else {
      priceWorkingDay(row, payObj.payrate, rates, ordinaryMinutes, role);
    }
  }
  return payObj;
}

const PAY_DAYS = ["sun", "mon", "tues", "wed", "thur", "fri", "sat"];

function durationMinutes(start, finish) {
  const from = parseTimeToMinutes(start);
  const to = parseTimeToMinutes(finish, { allow2400: true });
  return (to - from + 1440) % 1440;
}

function scheduledMinutes(row, fallback) {
  return isValidClockTime(row.rosteredStart) && isValidClockTime(row.rosteredFinish, { allow2400: true })
    ? durationMinutes(row.rosteredStart, row.rosteredFinish) || fallback
    : fallback;
}

function moneyRound(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function addPayLine(lines, label, minutes, rate) {
  if (minutes <= 0) return;
  const prior = lines.find(line => line.label === label && line.rate === rate);
  if (prior) prior.minutes += minutes;
  else lines.push({ label, minutes, rate });
}

function lineAmount(line) {
  return line.amount ?? moneyRound(moneyRound(line.minutes / 60) * line.rate);
}

function moneyTotal(lines) {
  return moneyRound(lines.reduce((sum, line) => sum + lineAmount(line), 0));
}

function priceNonWorkingDay(row, rate, rates, ordinaryMinutes, role) {
  const scheduled = scheduledMinutes(row, ordinaryMinutes);
  const leave = row.leaveType || (row.sick ? "sick" : "");
  const minutes = leave === "sick" ? 480 : row.leaveMinutes ?? scheduled;
  if (leave === "jury" || leave === "seconded") {
    addPayLine(row.lines, leave === "jury" ? "Jury duty" : "Seconded duty", 480, rate);
    row.guaranteeHours = 8;
    return;
  }
  if (leave === "cancelled") {
    const original = priceTimeline([{ start: parseTimeToMinutes(row.rosteredStart), minutes: scheduled, actual: true }], row, rate, rates, ordinaryMinutes, role);
    row.lines = original.lines;
    row.lines.push({ label: "Cancelled diagram · original value", amount: 0 });
    row.guaranteeHours = original.guaranteeHours;
    row.holidayHours = row.PH ? ordinaryMinutes : 0;
    return;
  }
  if (row.PH) {
    row.holidayHours = ordinaryMinutes;
    if (row.hol || leave || row.rosteredOff === false) row.guaranteeHours = ordinaryMinutes / 60;
    if (["annual", "lsl", "lsl-half", "lsl-double"].includes(leave))
      row.lines.push({ label: "Public holiday replaces leave on this day", amount: 0 });
    return;
  }
  if (leave === "unpaid" || leave === "unapproved") {
    row.timeLostHours = minutes / 60;
    return;
  }
  if (leave === "sick") {
    addPayLine(row.lines, "Sick leave", minutes, rate);
    row.timeLostHours = minutes / 60;
    return;
  }
  const labels = {
    annual: "Annual leave",
    lsl: "Long service leave",
    "lsl-half": "Long service leave (half pay)",
    "lsl-double": "Long service leave (double pay)",
    "ph-taken": "Accrued public holiday taken",
    "picnic-off": "Picnic day",
  };
  if (!labels[leave]) return;
  const factor = leave === "lsl-half" ? 0.5 : leave === "lsl-double" ? 2 : 1;
  addPayLine(row.lines, labels[leave], minutes, rate * factor);
  row.guaranteeHours = Math.min(1, factor) * minutes / 60;
  row.timeLostHours = Math.max(0, 1 - factor) * minutes / 60;
  if (leave === "annual" && row.annualLoading > 0) {
    const loadingRate = Math.min(rate, rates.leaveCap / (52 * 38)) * row.annualLoading;
    addPayLine(row.lines, "Annual leave loading", minutes, loadingRate);
  }
  if (leave === "ph-taken") row.holidayTaken = minutes;
}

function standaloneRate(day, row) {
  if (day !== "sat" && day !== "sun" && row.overtimeShiftNumber > 4 &&
      Number.isFinite(row.weekdayOvertimeAfterFourth) && row.weekdayOvertimeAfterFourth > 0) {
    return row.weekdayOvertimeAfterFourth;
  }
  return standaloneOvertime.rate(day, row.overtimeShiftNumber);
}

function extraKmMinutes(value) {
  const km = Number(value ?? 0);
  if (!Number.isFinite(km) || km < 0 || km > 1000) throw new Error("Enter extra kilometres between 0 and 1000.");
  if (!km) return 0;
  if (km <= 16.093) return 45;
  // DRAWA mileage scale. Keep the published boundaries through the five-hour band.
  const upperBounds = [24.14, 32.187, 40.234, 48.281, 56.328, 64.375, 72.422, 80.469,
    88.516, 96.563, 104.61, 112.657, 120.704, 128.751, 136.798, 144.845, 152.892];
  const band = upperBounds.findIndex(bound => km <= bound);
  return band >= 0 ? 60 + band * 15 : 300 + Math.ceil((km - 152.892) / 8.046) * 15;
}

function intercityCreditMinutes(row, workedMinutes, ordinaryMinutes) {
  if (row.intercityKm === "" || row.intercityKm == null) return 0;
  const km = Number(row.intercityKm);
  if (!Number.isFinite(km) || km < 0) throw new Error("Enter a valid Intercity distance.");
  const bands = [
    [161, 300], [193, 360], [225, 420], [257, 480], [290, 540], [322, 600],
    [338, 630], [354, 660], [370, 690], [386, 720], [402, 750], [418, 780],
    [435, 810], [451, 840], [467, 870], [483, 900], [499, 930], [515, 960],
    [531, 990], [547, 1020], [563, 1050], [579, 1080], [595, 1110],
    [612, 1140], [628, 1170],
  ];
  if (km >= 644) throw new Error("Confirm the Intercity distance credit for a shift of 644 km or more.");
  const band = bands.findLast(([minimum]) => km >= minimum);
  const timingCredit = km > 257
    ? Math.max(0, Number(row.departureGap || 0) - 40) + Math.max(0, Number(row.arrivalGap || 0) - 40)
    : 0;
  const distanceMinutes = band ? band[1] + Number(row.unassociatedMinutes || 0) + timingCredit : 0;
  return Math.max(0, Math.max(scheduledMinutes(row, ordinaryMinutes), distanceMinutes) - workedMinutes);
}

function priceWorkingDay(row, rate, rates, defaultOrdinaryMinutes, role) {
  const start = parseTimeToMinutes(row.actualStart);
  const worked = durationMinutes(row.actualStart, row.actualFinish);
  if (!worked || parseDurationToMinutes(row.timeWorked) !== worked) {
    throw new Error(`${row.date || row.day}: total worked must match the actual start and finish times.`);
  }
  const ordinary = row.ordinaryMinutes || defaultOrdinaryMinutes;
  const isIntercity = row.intercityKm !== "" && row.intercityKm != null;
  const credit = row.amendment === "credit"
    ? payShiftClaims.compare(row, row.creditAlignment === "same-date" ? "same-date" : "nearest").credit : null;
  const extra = role === "driver" && !isIntercity ? extraKmMinutes(row.extraKm) : 0;
  const spans = [];
  if (credit?.before) spans.push({ start: start - credit.before, minutes: credit.before, actual: false });
  spans.push({ start, minutes: worked, actual: true });
  if (credit?.after || extra) {
    spans.push({ start: start + worked, minutes: (credit?.after || 0) + extra, actual: false });
  }

  let priced = priceTimeline(spans, row, rate, rates, ordinary, role);
  let originalApplied = false;
  if (isIntercity) {
    const minutes = intercityCreditMinutes(row, worked, ordinary);
    addPayLine(priced.lines, "Intercity kilometreage top-up", minutes, rate);
    priced.guaranteeHours += minutes / 60;
  } else if (row.milageTime) {
    add209KmPay(row, priced, start, worked, rate);
  }
  if (row.amendment === "compare" && !isIntercity) {
    const originalStart = parseTimeToMinutes(row.originalStart || row.rosteredStart);
    const originalMinutes = durationMinutes(row.originalStart || row.rosteredStart, row.originalFinish || row.rosteredFinish);
    const original = priceTimeline([{ start: originalStart, minutes: originalMinutes, actual: true }], { ...row, milageTime: "" }, rate, rates, ordinary, role);
    if (moneyTotal(original.lines) > moneyTotal(priced.lines)) {
      priced = original;
      originalApplied = true;
      row.lines.push({ label: "Diagram change · original value applied", amount: 0 });
    } else {
      row.lines.push({ label: "Diagram change · altered value applied", amount: 0 });
    }
  }

  row.lines.push(...priced.lines);
  row.guaranteeHours = priced.guaranteeHours;
  row.totalWorked = moneyRound(priced.paidMinutes / 60);
  row.timeWorkedInUnits = moneyRound(worked / 60);
  if (row.milageTime) row.milage = row.milageTime;
  row.extraKM = extra && !originalApplied ? row.extraKm : "";
  if (credit) {
    const minutes = credit.before + credit.after;
    row[credit.field] = moneyRound(minutes / 60);
    row.lines.push({ label: `${credit.label} included in shift pay`, minutes, amount: 0 });
  }
  if (extra && !originalApplied)
    row.lines.push({ label: "Extra kilometre time included in shift pay", minutes: extra, amount: 0 });

  if (row.WOBOD) addPayLine(row.lines, "WOBOD @ 50%", worked, rate / 2);
  if (row.sickRemainderMinutes > 0) {
    addPayLine(row.lines, "Sick leave · remainder of shift", row.sickRemainderMinutes, rate);
    row.timeLostHours = row.sickRemainderMinutes / 60;
  }
  if (row.mealClaim && worked > 600 && worked <= 960)
    row.lines.push({ label: "Away from home station meal allowance", amount: rates.meal });
  if (row.travelMinutes > 0) addPayLine(row.lines, "Approved excess travel time", row.travelMinutes, rate);
  if (row.picnicClaim === "paid") addPayLine(row.lines, "Picnic day", defaultOrdinaryMinutes, rate);
  if (row.picnicClaim === "bank") row.lines.push({ label: "Picnic day banked", minutes: defaultOrdinaryMinutes, amount: 0 });
  row.holidayHours = row.PH ? defaultOrdinaryMinutes : 0;
}

function isHolidayAt(row, dayOffset) {
  if (dayOffset === 0) return row.PH;
  if (dayOffset === -1) return row.previousDayPH;
  return dayOffset === 1 && row.nextDayPH;
}

function mileageMilestone(row, start, worked) {
  if (!row.milageTime) return null;
  let time = parseTimeToMinutes(row.milageTime);
  if (time < start) time += 1440;
  const elapsed = time - start;
  return elapsed > 0 && elapsed < 480 && elapsed <= worked ? time : null;
}

function priceTimeline(spans, row, rate, rates, ordinary, role = "driver") {
  const lines = [];
  const portions = [];
  const standalone = row.WOBOD;
  const legacyExcess = row.excessDayNormal || row.excessDayDouble;
  const qualifyingSix = row.straightSix && role === "driver" && !standalone && !legacyExcess;
  const limit = qualifyingSix ? 360 : ordinary;
  let paidMinutes = 0;
  let guaranteeHours = 0;
  let loadingMinutes = 0;
  const firstActual = spans.find(span => span.actual);
  const lastActual = spans.findLast(span => span.actual);
  const startDay = PAY_DAYS.indexOf(row.day);
  // Credits count toward overtime. Shift allowances use an ordinary-hours window from actual sign-on.
  const loadingEnd = Math.min(
    firstActual.start + limit,
    mileageMilestone(row, firstActual.start, firstActual.minutes) ?? Infinity,
  );

  for (const span of spans) {
    let start = span.start;
    const finish = start + span.minutes;
    while (start < finish) {
      const dayOffset = Math.floor(start / 1440);
      const day = PAY_DAYS[(startDay + dayOffset + 7) % 7];
      const holiday = isHolidayAt(row, dayOffset);
      const weekend = day === "sat" || day === "sun";
      const untilMidnight = (dayOffset + 1) * 1440 - start;
      let minutes = Math.min(finish - start, untilMidnight);
      let multiplier = 1;
      let ordinaryPortion = false;
      let label;
      if (standalone) {
        multiplier = standaloneRate(day, row);
        if (holiday) multiplier = Math.max(2, multiplier);
        label = `Standalone overtime @ ${multiplier * 100}%`;
      } else if (legacyExcess) {
        const double = holiday || weekend || row.excessDayDouble || paidMinutes >= 660;
        if (!double) minutes = Math.min(minutes, 660 - paidMinutes);
        multiplier = double ? 2 : 1.5;
        label = `Overtime @ ${multiplier * 100}%`;
      } else if (paidMinutes < limit) {
        minutes = Math.min(minutes, limit - paidMinutes);
        ordinaryPortion = true;
        label = holiday ? "Public holiday worked" : "Ordinary hours";
        const premium = holiday ? (weekend ? 1 : 0.5) : day === "sat" ? 0.5 : day === "sun" ? 1 : 0;
        if (premium) {
          const name = holiday ? "Public holiday loading" : day === "sat" ? "Saturday loading" : "Sunday loading";
          addPayLine(lines, `${name} @ ${premium * 100}%`, minutes, rate * premium);
        }
        multiplier += premium;
        guaranteeHours += minutes / 60;
      } else {
        const tierEnd = limit > 480 ? 660 : limit + 180;
        if (holiday || weekend || paidMinutes >= tierEnd) multiplier = 2;
        else {
          multiplier = 1.5;
          minutes = Math.min(minutes, tierEnd - paidMinutes);
        }
        label = `Scheduled OT @ ${multiplier * 100}%`;
        guaranteeHours += minutes * (holiday || weekend ? 1 : multiplier) / 60;
      }
      addPayLine(lines, label, minutes, rate * (ordinaryPortion ? 1 : multiplier));
      if (span.actual) {
        portions.push({ start, minutes, multiplier, ordinaryPortion });
        if (!weekend) loadingMinutes += Math.max(0, Math.min(minutes, loadingEnd - start));
      }
      start += minutes;
      paidMinutes += minutes;
    }
  }

  if (!standalone && !legacyExcess) {
    if (qualifyingSix && paidMinutes >= 360 && Math.min(paidMinutes, limit) < 480) {
      const credit = 480 - Math.min(paidMinutes, limit);
      const premium = row.PH ? (startDay === 0 || startDay === 6 ? 1 : 0.5) : startDay === 0 ? 1 : startDay === 6 ? 0.5 : 0;
      addPayLine(lines, "Straight six-hour shift top-up", credit, rate * (1 + premium));
      guaranteeHours += credit / 60;
    }
    const signOn = ((firstActual.start % 1440) + 1440) % 1440;
    const actualFinish = lastActual.start + lastActual.minutes;
    const ordinaryFinish = Math.min(actualFinish, firstActual.start + limit);
    const band = signOn < 240 || signOn >= 1080 ? "night"
      : signOn >= 240 && signOn <= 330 ? "early"
        : ordinaryFinish > 1080 ? "afternoon" : "";
    const loadingHours = Math.round(loadingMinutes / 60);
    if (band && loadingHours) {
      const label = { night: "Night shift allowance", early: "Early morning shift allowance", afternoon: "Afternoon shift allowance" }[band];
      addPayLine(lines, label, loadingHours * 60, rates[band]);
    }
    const qualifiesSpecial = time => {
      const localMinute = ((time % 1440) + 1440) % 1440;
      const offset = Math.floor(time / 1440);
      const weekday = (startDay + offset + 7) % 7;
      return weekday > 0 && weekday < 6 && localMinute >= 61 && localMinute <= 239;
    };
    if (qualifiesSpecial(firstActual.start) || qualifiesSpecial(actualFinish)) {
      lines.push({ label: "Special sign-on/off loading", amount: rates.special });
    }
  }
  return { lines, portions, guaranteeHours, paidMinutes };
}

function add209KmPay(row, priced, start, worked, rate) {
  const milestone = mileageMilestone(row, start, worked);
  if (milestone === null) return;
  const credit = start + 480 - milestone;

  // The mileage minimum is a separate credit and does not create overtime (EA cl 146.3).
  addPayLine(priced.lines, "209 km minimum top-up", credit, rate);
  priced.guaranteeHours += credit / 60;
  if (row.WOBOD || row.excessDayNormal || row.excessDayDouble) return;
  for (const portion of priced.portions) {
    const minutes = Math.min(portion.start + portion.minutes, start + 480) - Math.max(portion.start, milestone);
    if (minutes > 0 && portion.ordinaryPortion) {
      const premium = Math.min(0.5, Math.max(0, 2 - portion.multiplier));
      if (premium) addPayLine(priced.lines, "209 km premium", minutes, rate * premium);
    }
  }
}

function CalculatePay(payObj, options = {}) {
  const targets = options.render === false ? createPayOutputTargets() : null;
  return withPayOutputTargets(targets, () => calculatePayIntoCurrentTargets(payObj));
}

function createPayOutputTargets() {
  return {
    payDiv: createPayOutputTarget(),
    unitDiv: createPayOutputTarget(),
    rateDiv: createPayOutputTarget(),
    amountDiv: createPayOutputTarget(),
  };
}

function withPayOutputTargets(targets, callback) {
  if (!targets) return callback();
  const previous = { payDiv, unitDiv, rateDiv, amountDiv };
  ({ payDiv, unitDiv, rateDiv, amountDiv } = targets);
  try {
    return callback();
  } finally {
    ({ payDiv, unitDiv, rateDiv, amountDiv } = previous);
  }
}

function writePayLine(label, units = "", rate = "", amount = "") {
  payDiv.innerText += `${label}\n`;
  unitDiv.innerText += `${units}\n`;
  rateDiv.innerText += `${rate}\n`;
  amountDiv.innerText += `${amount}\n`;
}

function calculatePayIntoCurrentTargets(payObj) {
  payDiv.innerText = unitDiv.innerText = rateDiv.innerText = amountDiv.innerText = "";
  writePayLine("Details", "Units", "Rate", "Amounts");
  let gross = 0;
  let balance = payObj.holidayBalance;
  for (let i = 0; i < 14; i++) {
    const row = payObj[i];
    writePayLine();
    writePayLine(`${row.day.toUpperCase()}:${row.RDO && !row.holidayHours ? " DAY OFF" : ""}`);
    const lines = [...row.lines];
    if (row.holidayTaken && balance !== null) balance = Math.max(0, balance - row.holidayTaken / 60);
    if (row.holidayHours) {
      const minutes = row.holidayHours;
      const banked = row.accruePH
        ? balance === null ? minutes : Math.min(minutes, Math.max(0, (96 - balance) * 60))
        : 0;
      if (banked) lines.push({
        label: balance === null ? "Public holiday accrued · balance unverified" : "Public holiday accrued",
        minutes: banked, amount: 0,
      });
      if (balance !== null) balance += banked / 60;
      addPayLine(lines, "Public Holiday Paid", minutes - banked, payObj.payrate);
    }
    for (const line of lines) {
      const amount = lineAmount(line);
      writePayLine(`${line.label}:`, line.minutes == null ? "" : rounded(line.minutes / 60),
        line.rate == null ? "" : rounded(line.rate), amount === 0 && line.rate == null ? "" : rounded(amount));
      gross += amount;
    }
  }
  const adjustment = payObj.longFortnight ? -4 : 4;
  const adjustmentPay = moneyRound(adjustment * payObj.payrate);
  writePayLine();
  writePayLine("ADO Adjustment:", adjustment, rounded(payObj.payrate), rounded(adjustmentPay));
  gross += adjustmentPay + GuaranteePayment(payObj);
  if (payObj.otherPayment) {
    writePayLine("Other confirmed pay:", "", "", rounded(payObj.otherPayment));
    gross += payObj.otherPayment;
  }
  writePayLine();
  writePayLine("Gross Pay:", "", "", rounded(gross));
  return moneyRound(gross);
}

function GuaranteePayment(payObj) {
  if (payObj.guaranteeEligible === false) return 0;
  const limit = payObj.longFortnight ? 10 : 9;
  const { workedHours, timeLostHours } = getGuaranteeInputs(payObj, limit);
  const hours = moneyRound(Math.max(0, limit * 8 - timeLostHours - workedHours));
  if (!hours) return 0;
  const amount = moneyRound(hours * payObj.payrate);
  writePayLine("Guarantee:", rounded(hours), rounded(payObj.payrate), rounded(amount));
  return amount;
}

function getGuaranteeInputs(payObj, limit) {
  let workedHours = 0;
  let timeLostHours = 0;
  let shifts = 0;
  for (let i = 0; i < 14 && shifts < limit; i++) {
    const row = payObj[i];
    if (row.WOBOD || row.excessDayNormal || row.excessDayDouble) continue;
    if (row.RDO && !row.guaranteeHours && !row.timeLostHours) continue;
    workedHours += row.guaranteeHours;
    timeLostHours += row.timeLostHours;
    shifts++;
  }
  return { workedHours: moneyRound(workedHours), timeLostHours: moneyRound(timeLostHours) };
}

function parseTimeToMinutes(time, options = {}) {
  const value = String(time ?? "").trim();
  if (!isValidClockTime(value, options)) {
    throw new Error(`invalid time: ${value}`);
  }

  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  return hours * 60 + minutes;
}

function parseDurationToMinutes(time) {
  const value = String(time ?? "").trim();
  if (!isValidDuration(value)) {
    throw new Error(`invalid duration: ${value}`);
  }

  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  return hours * 60 + minutes;
}

function isValidClockTime(time, options = {}) {
  const value = String(time ?? "").trim();
  if (!/^\d{4}$/.test(value)) return false;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  if (options.allow2400 && value === "2400") return true;
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function isValidDuration(time) {
  const value = String(time ?? "").trim();
  if (!/^\d{4}$/.test(value)) return false;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  return hours >= 0 && hours <= 24 && minutes >= 0 && minutes <= 59 && !(hours === 24 && minutes > 0);
}

function rounded(numberData) {
  const number = Number(numberData);
  if (!Number.isFinite(number)) {
    throw new Error("need a number to round");
  }

  return (Math.round(number * 100) / 100).toFixed(2);
}

function DisplayBreakdown(tableObj) {
  const payTableRows = document.querySelectorAll(".dataRow"); //get all the rows to show data
  // console.log(tableObj);

  for (let i = 0; i < payTableRows.length; i++) {
    const rowCells = payTableRows[i].querySelectorAll("td");
    for (let cellIndex = 1; cellIndex < rowCells.length; cellIndex++) {
      rowCells[cellIndex].innerHTML = "";
    }

    if (tableObj[i].RDO == true) {
      //if the day is an RDO, show its an rdo and skip row
      rowCells[1].innerHTML = "RDO";
      continue;
    }
    if (tableObj[i].sick || tableObj[i].leaveType) {
      rowCells[1].innerHTML = tableObj[i]["rosteredStart"];
      rowCells[2].textContent = tableObj[i].actualStart.toUpperCase();
      rowCells[3].innerHTML = tableObj[i]["rosteredFinish"];
      continue;
    }
    if (tableObj[i].hol == true) {
      rowCells[1].innerHTML = "HOL";
      rowCells[11].innerHTML = tableObj[i]["PH"] ? tableObj[i]["PH"] : "";
      continue;
    }

    rowCells[1].innerHTML = tableObj[i]["rosteredStart"];
    rowCells[2].innerHTML = tableObj[i]["actualStart"];
    rowCells[3].innerHTML = tableObj[i]["rosteredFinish"];
    rowCells[4].innerHTML = tableObj[i]["actualFinish"];
    rowCells[5].innerHTML =
      tableObj[i]["timeWorked"] + " / " + tableObj[i]["timeWorkedInUnits"];
    rowCells[6].innerHTML = tableObj[i]["liftupAsUnits"]
      ? tableObj[i]["liftupAsUnits"]
      : "";
    rowCells[7].innerHTML = tableObj[i]["laybackAsUnits"]
      ? tableObj[i]["laybackAsUnits"]
      : "";
    rowCells[8].innerHTML = tableObj[i]["buildupAsUnits"]
      ? tableObj[i]["buildupAsUnits"]
      : "";
    rowCells[9].innerHTML = tableObj[i]["milage"] ? tableObj[i]["milage"] : "";
    rowCells[10].innerHTML = tableObj[i]["extraKM"]
      ? tableObj[i]["extraKM"]
      : "";
    rowCells[11].innerHTML = tableObj[i]["PH"] ? tableObj[i]["PH"] : "";
    rowCells[12].innerHTML = tableObj[i]["accruePH"]
      ? tableObj[i]["accruePH"]
      : "";
    rowCells[13].innerHTML = tableObj[i]["WOBOD"] ? tableObj[i]["WOBOD"] : "";
    rowCells[14].innerHTML = tableObj[i]["callout"]
      ? tableObj[i]["callout"]
      : "";
    rowCells[15].innerHTML = tableObj[i]["totalWorked"];
  }
}

if (typeof window !== "undefined") {
  window.PayEngine = PayEngine;
  const preset = document.getElementById("payRatePreset");
  if (preset) {
    const role = document.getElementById("payCrewRole");
    const updatePresets = bindRatePreset(preset, document.getElementById("payRate"));
    const update = () => updatePresets(role.value);
    role.addEventListener("change", update);
    update();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = PayEngine;
}
