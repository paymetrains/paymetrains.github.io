import { NSW_PUBLIC_HOLIDAYS } from "./public-holidays.js";

const RELINQUISHMENT_MINUTES = 240;
const SICK_LEAVE_CODES = ["SL", "SL_REL", "REL", "SIF", "INJ"];

function parseRoster(pdf, type) {
  const parsedPages = pdf.pages.map((page) => parseRosterPage(page, type));
  const rows = [];

  for (const page of parsedPages) {
    rows.push(...page.rows);
  }

  const dates = parsedPages.find((page) => page.dates.length >= 14)?.dates ?? [];
  const lines = new Map();

  for (const row of rows) {
    if (!row.line) continue;
    lines.set(row.line, row);
  }

  return {
    source: type,
    fileName: pdf.fileName,
    dates,
    pages: parsedPages,
    rows,
    lines,
    jobDictionary: type === "master" ? buildJobDictionary(rows) : null,
  };
}

function parseRosterPage(page, type) {
  const dateItems = findDateRow(page.items);
  const dates = dateItems.slice(0, 14).map((item) => parseDate(item.str));
  const columns = buildColumns(dateItems, page.width);
  const firstColumnLeft = columns[0]?.left ?? page.width * 0.18;
  const lineItems = findLineItems(page.items, firstColumnLeft, dateItems);
  const rowBands = buildRowBands(lineItems, dateItems, page.height);

  const rows = rowBands.map((band) => {
    const cells = columns.map((column, dayIndex) => {
      const cellItems = page.items.filter(
        (item) =>
          item.x >= column.left &&
          item.x < column.right &&
          item.y <= band.top &&
          item.y > band.bottom
      );
      const cell = parseCell(joinItems(cellItems), dayIndex);
      if (cell.start && cellItems.find(item => /^\d{1,2}:\d{2}/.test(item.str))?.struckOut)
        cell.crossedOut = true;
      return cell;
    });

    const leftItems = page.items.filter(
      (item) =>
        item.x > band.lineX + 6 &&
        item.x < firstColumnLeft - 4 &&
        item.y <= band.top &&
        item.y > band.bottom
    );

    const crewText = type === "fortnight" ? joinItems(leftItems.filter(item => !item.struckOut)) : "";
    return {
      source: type,
      line: band.line,
      employeeName: parseEmployeeName(crewText),
      seconded: /\bSecP?\s+open\b/i.test(crewText),
      cells,
    };
  });

  return {
    pageNumber: page.pageNumber,
    dates,
    rows,
  };
}

function findDateRow(items) {
  const candidates = [];

  for (const item of items) {
    const matches = item.str.match(/\d{2}\/\d{2}\/\d{4}/g);
    if (!matches) continue;
    for (let index = 0; index < matches.length; index++) {
      candidates.push({
        str: matches[index],
        x: item.x + index * 42,
        y: item.y,
      });
    }
  }

  if (!candidates.length) {
    throw new Error("Could not find roster date row in one PDF page.");
  }

  const groups = groupByY(candidates, 8);
  const best = groups
    .sort((a, b) => b.items.length - a.items.length || b.y - a.y)[0]
    .items.sort((a, b) => a.x - b.x);

  if (best.length >= 14) {
    return best.slice(0, 14);
  }

  const pageDate = best[best.length - 1]?.str;
  if (!pageDate) {
    throw new Error("Could not infer roster dates.");
  }

  const end = parseDate(pageDate);
  const start = addDays(end, -13);
  return Array.from({ length: 14 }, (_, index) => ({
    str: formatDisplayDate(addDays(start, index)),
    x: best[0].x + index * 48,
    y: best[0].y,
  }));
}

function buildColumns(dateItems, pageWidth) {
  const sorted = dateItems.slice(0, 14).sort((a, b) => a.x - b.x);
  if (sorted.length < 14) {
    throw new Error("Could not build 14 roster columns.");
  }

  const starts = sorted.map((item) => item.x);
  const gaps = [];
  for (let i = 1; i < starts.length; i++) {
    gaps.push(starts[i] - starts[i - 1]);
  }
  const medianGap = median(gaps);
  const margin = Math.max(2, medianGap * 0.06);

  return starts.map((start, index) => {
    const left = Math.max(0, start - margin);
    const right =
      index === starts.length - 1
        ? Math.min(pageWidth + medianGap, start + medianGap - margin)
        : starts[index + 1] - margin;
    return { dayIndex: index, left, right, center: (left + right) / 2 };
  });
}

function findLineItems(items, firstColumnLeft, dateItems) {
  const dateY = median(dateItems.map((item) => item.y));
  const maxLineX = Math.min(firstColumnLeft, Math.max(52, firstColumnLeft * 0.42));

  const raw = items
    .filter(
      (item) =>
        /^\d{1,3}$/.test(item.str) &&
        item.x < maxLineX &&
        item.y < dateY - 4
    )
    .map((item) => ({
      line: Number(item.str),
      x: item.x,
      y: item.y,
    }))
    .filter((item) => item.line > 0);

  const byLineAndY = new Map();
  for (const item of raw) {
    const key = `${item.line}:${Math.round(item.y)}`;
    byLineAndY.set(key, item);
  }

  return [...byLineAndY.values()].sort((a, b) => b.y - a.y || a.line - b.line);
}

function buildRowBands(lineItems, dateItems, pageHeight) {
  if (!lineItems.length) return [];

  const dateY = median(dateItems.map((item) => item.y));
  const rows = lineItems.slice().sort((a, b) => b.y - a.y);
  const bands = [];

  for (let i = 0; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i - 1];
    const next = rows[i + 1];
    const estimatedGap = next ? current.y - next.y : previous ? previous.y - current.y : 42;
    const top = previous ? (previous.y + current.y) / 2 : Math.min(dateY - 6, current.y + estimatedGap * 0.62);
    const bottom = next ? (current.y + next.y) / 2 : Math.max(0, current.y - estimatedGap * 0.7);

    bands.push({
      line: current.line,
      lineX: current.x,
      top: Math.min(pageHeight, top),
      bottom,
    });
  }

  return bands;
}

function parseCell(text, dayIndex) {
  const compact = normalizeCellText(text);
  const timeRange = compact.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  const afterTimes = timeRange ? compact.slice(timeRange.index + timeRange[0].length).trim() : "";
  const duty = afterTimes.replace(/^L(?:\s+|$)/i, "").replace(/^\d{1,2}:\d{2}W\s*/i, "");
  const jobMatch = timeRange
    ? duty.match(/^(\d+[A-Z]*|[A-Z]+[A-Z0-9]*\d[A-Z0-9]*|SBY|RR)(?:\(i\))?(?=\s|$|\()/i)
    : compact.match(/\b([5-8]\d{3})(?:\(i\))?\b/);
  const durationMatch = compact.match(/\b(\d{1,2}):(\d{2})W\b/);
  const fCodeMatch = compact.match(/\bF\d+\b/);
  const swapPattern = /\s*\(\s*WS\s+(\d+)\s*\)/gi;
  const swapLines = Array.from(compact.matchAll(swapPattern), ([, line]) => line);
  const upper = compact.toUpperCase();
  const leaveCodes = extractLeaveCodes(upper);

  let status = "BLANK";
  if (timeRange) status = "WORK";
  else if (/\bHOL\b/.test(upper)) status = "HOL";
  else if (/\bADO\b/.test(upper)) status = "ADO";
  else if (/\bNTA\b/.test(upper)) status = "NTA";
  else if (/\b(?:OFF|RDO|DFD)\b/.test(upper)) status = "OFF";
  else if (leaveCodes.has("AL")) status = "AL";
  else if (SICK_LEAVE_CODES.some(code => leaveCodes.has(code))) status = "SL";
  else if (leaveCodes.has("LWOP")) status = "LWOP";
  else if (leaveCodes.has("LSL")) status = "LSL";
  else if (leaveCodes.has("JURY")) status = "JURY";
  else if (leaveCodes.has("SEC")) status = "SEC";
  else if (leaveCodes.has("PH")) status = "PH";

  return {
    dayIndex,
    rawText: compact,
    status,
    start: timeRange ? toHHMM(timeRange[1], timeRange[2]) : "",
    finish: timeRange ? toHHMM(timeRange[3], timeRange[4]) : "",
    jobNumber: jobMatch ? jobMatch[1] : "",
    jobLabel: jobMatch?.[1] || duty.replace(swapPattern, "").replace(/\bF\d+\s*$/i, "").trim(),
    swapLines,
    mileageOver209Candidate: jobMatch ? new RegExp(`\\b${jobMatch[1]}\\(i\\)`).test(compact) : false,
    duration: durationMatch ? toHHMM(durationMatch[1], durationMatch[2]) : "",
    fCode: fCodeMatch ? fCodeMatch[0] : "",
    leaveCodes: [...leaveCodes],
  };
}

function extractLeaveCodes(upperText) {
  const codes = new Set();
  if (/\bSL\s*REL\b|\(SL\s*REL/.test(upperText)) codes.add("SL_REL");
  if (/\bREL\s+REL\b|\(\s*REL\s*\)/.test(upperText)) codes.add("REL");
  if (/\(\s*SIF\b/.test(upperText)) codes.add("SIF");
  if (/(?:^|\()\s*INJ\b/.test(upperText)) codes.add("INJ");
  if (/(?:^|\()\s*(?:LWOP|MAT\s+L)\b/.test(upperText)) codes.add("LWOP");
  if (/(?:^|\()\s*LSL\b/.test(upperText)) codes.add("LSL");
  if (/\bSL\b|\(SL/.test(upperText)) codes.add("SL");
  if (/\bAL\b|\(AL|\(\s*LVE\s+PURCHASED\b/.test(upperText)) codes.add("AL");
  if (/\(\s*JURY\s+(?:DTY|DUTY)\b/.test(upperText)) codes.add("JURY");
  if (/\(\s*SECP?\b/.test(upperText)) codes.add("SEC");
  if (/\bPH\b|\(PH/.test(upperText)) codes.add("PH");
  return codes;
}

function buildJobDictionary(rows) {
  const jobs = {};
  const conflicts = [];

  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.jobNumber || !cell.start || !cell.finish) continue;
      const existing = jobs[cell.jobNumber];
      const occurrence = {
        line: row.line,
        dayIndex: cell.dayIndex,
        start: cell.start,
        finish: cell.finish,
        duration: cell.duration,
        fCode: cell.fCode,
        mileageOver209Candidate: cell.mileageOver209Candidate,
      };

      if (!existing) {
        jobs[cell.jobNumber] = {
          jobNumber: cell.jobNumber,
          start: cell.start,
          finish: cell.finish,
          duration: cell.duration,
          fCode: cell.fCode,
          mileageOver209Candidate: cell.mileageOver209Candidate,
          occurrences: [occurrence],
          conflict: false,
        };
        continue;
      }

      existing.occurrences.push(occurrence);
      existing.mileageOver209Candidate =
        existing.mileageOver209Candidate || cell.mileageOver209Candidate;

      if (existing.start !== cell.start || existing.finish !== cell.finish) {
        existing.conflict = true;
        conflicts.push({
          jobNumber: cell.jobNumber,
          first: `${existing.start}-${existing.finish}`,
          seen: `${cell.start}-${cell.finish}`,
          line: row.line,
          dayIndex: cell.dayIndex,
        });
      }
    }
  }

  return { jobs, conflicts };
}

function analyseRosters(master, fortnight, selectedRows = fortnight.rows) {
  const payRows = [];
  const analysisRows = [];
  const flags = [];
  const overtimeRows = [];
  const employees = new Set();
  const currentLines = new Map(fortnight.rows.map(row => [row.line, row]));

  for (const fortnightRow of selectedRows) {
    if (!fortnightRow.line || fortnightRow.seconded) continue;
    if (fortnightRow.employeeName) employees.add(fortnightRow.employeeName);

    const masterRow = master.lines.get(fortnightRow.line);
    const rowComparisons = [];
    const rowPayRows = [];

    for (let dayIndex = 0; dayIndex < 14; dayIndex++) {
      const actualCell = fortnightRow.cells[dayIndex] ?? parseCell("", dayIndex);
      const masterCell = masterRow?.cells[dayIndex] ?? parseCell("", dayIndex);
      const date = fortnight.dates[dayIndex] ? toIsoDate(fortnight.dates[dayIndex]) : "";
      const swapPartners = Array.from(new Set((actualCell.swapLines || []).map(Number)), line => {
        const current = currentLines.get(line)?.cells[dayIndex];
        return {
          line,
          reciprocal: line !== fortnightRow.line && Boolean(current?.swapLines?.some(ref => Number(ref) === fortnightRow.line)),
          original: shiftSnapshot(master.lines.get(line)?.cells[dayIndex]),
          current: shiftSnapshot(current),
        };
      });
      const comparison = compareCell({
        employeeName: fortnightRow.employeeName,
        line: fortnightRow.line,
        date,
        dayIndex,
        actualCell,
        masterCell,
        swapPartners,
        jobDictionary: master.jobDictionary,
        diagramData: master.diagramData,
      });

      rowComparisons.push(comparison);
      rowPayRows.push(comparison.payRow);

      for (const flag of comparison.flags) {
        flags.push({
          employeeName: fortnightRow.employeeName,
          line: fortnightRow.line,
          date,
          flag,
        });
      }
    }

    const rosterCounts = markExtraDayOvertime(rowPayRows, masterRow);
    for (const flag of getRosterCountFlags(rosterCounts)) {
      flags.push({
        employeeName: fortnightRow.employeeName,
        line: fortnightRow.line,
        date: "",
        flag,
      });
    }

    analysisRows.push(...rowComparisons);
    payRows.push(...rowPayRows);
    overtimeRows.push(...rowPayRows.filter((row) => row.extraDayOvertime));
  }

  for (const conflict of master.jobDictionary.conflicts) {
    flags.push({
      employeeName: "",
      line: conflict.line,
      date: "",
      flag: `job_conflict:${conflict.jobNumber}:${conflict.first}:${conflict.seen}`,
    });
  }

  const mileageRows = payRows.filter((row) => row.mileageOver209Candidate);

  return {
    generatedAt: new Date().toISOString(),
    assumptions: [
      "Fortnight line number is compared with master line number.",
      "A WS marker uses the referenced line's original times when the job matches. Other jobs use the diagram data or master job dictionary where available.",
      "Non-4-digit jobs use actual start/finish as rostered start/finish.",
      "OFF, ADO and NTA export as blank pay-app rows.",
      "SL and SL REL export as SICK only when the baseline has work.",
      "AL exports as HOL when the baseline has work.",
      "NSW statewide public holidays are auto-marked as PH.",
      "NSW public holidays live in public-holidays.js and can be updated without touching parser logic.",
      "OFF and ADO comparisons are fortnight-wide counts; the exact day position does not matter.",
      "A worked shift on a master OFF, RDO, DFD or ADO day with no WS marker is marked WOBOD.",
      "The extra shift list compares counts with the master and does not establish WOBOD eligibility.",
      "Mileage jobs over 209km are flagged for checking only; mileage pay is not auto-applied.",
    ],
    master: {
      fileName: master.fileName,
      rows: master.rows.length,
      jobs: Object.keys(master.jobDictionary.jobs).length,
      jobConflicts: master.jobDictionary.conflicts,
    },
    fortnight: {
      fileName: fortnight.fileName,
      rows: fortnight.rows.length,
      dates: fortnight.dates.map(toIsoDate),
    },
    summary: {
      employees: employees.size,
      payRows: payRows.length,
      overtimeRows: overtimeRows.length,
      flags: flags.length,
      mileageRows: mileageRows.length,
    },
    rows: analysisRows,
    payRows,
    flags,
    overtimeRows,
    mileageRows,
  };
}

function markExtraDayOvertime(payRows, masterRow) {
  const roster = getMasterRosterStats(masterRow);
  const actualOffRows = payRows.filter((row) => row.changeType === "off");
  const actualAdoRows = payRows.filter((row) => row.changeType === "ado");
  const workRows = payRows.filter((row) => row.status === "work");
  const extraShiftCount = Math.max(0, workRows.length - roster.workShiftLimit);
  const rosterCounts = {
    hasMasterRow: roster.hasMasterRow,
    rosterType: roster.type,
    rosteredShiftLimit: roster.workShiftLimit,
    masterOffDays: roster.offDays,
    masterAdoDays: roster.adoDays,
    actualOffDays: actualOffRows.length,
    actualAdoDays: actualAdoRows.length,
    actualWorkDays: workRows.length,
    extraShiftCount,
    offCountMismatch: actualOffRows.length !== roster.offDays,
    adoCountMismatch: actualAdoRows.length !== roster.adoDays,
  };
  let workedShiftCount = 0;
  const extraStartIndex = Math.max(0, workRows.length - extraShiftCount);

  for (const row of payRows) {
    row.rosterType = rosterCounts.rosterType;
    row.rosteredShiftLimit = rosterCounts.rosteredShiftLimit;
    row.masterOffDays = rosterCounts.masterOffDays;
    row.masterAdoDays = rosterCounts.masterAdoDays;
    row.actualOffDays = rosterCounts.actualOffDays;
    row.actualAdoDays = rosterCounts.actualAdoDays;
    row.actualWorkDays = rosterCounts.actualWorkDays;
    row.offCountMismatch = rosterCounts.offCountMismatch;
    row.adoCountMismatch = rosterCounts.adoCountMismatch;
    row.extraDayOvertime = false;
    row.workShiftNumber = "";

    if (row.status !== "work") continue;

    workedShiftCount += 1;
    row.workShiftNumber = workedShiftCount;

    if (workedShiftCount > extraStartIndex) {
      row.extraDayOvertime = true;
    }
  }

  return rosterCounts;
}

function getRosterCountFlags(rosterCounts) {
  if (!rosterCounts.hasMasterRow) return ["missing_master_line"];

  const flags = [];
  if (rosterCounts.offCountMismatch) {
    flags.push(`off_count_mismatch:${rosterCounts.actualOffDays}/${rosterCounts.masterOffDays}`);
  }
  if (rosterCounts.adoCountMismatch) {
    flags.push(`ado_count_mismatch:${rosterCounts.actualAdoDays}/${rosterCounts.masterAdoDays}`);
  }
  return flags;
}

function getMasterRosterStats(masterRow) {
  const cells = masterRow?.cells ?? [];
  const workShiftLimit = cells.filter(isWorkCell).length || 10;
  const offDays = cells.filter((cell) => cell.status === "OFF").length;
  const adoDays = cells.filter((cell) => cell.status === "ADO").length;

  return {
    hasMasterRow: Boolean(masterRow),
    type: adoDays > 0 || workShiftLimit <= 9 ? "short" : "long",
    workShiftLimit,
    offDays,
    adoDays,
  };
}

function shiftSnapshot(cell) {
  if (!cell) return null;
  return {
    status: cell.crossedOut ? "CROSSED_OUT" : cell.status,
    jobNumber: cell.jobNumber,
    jobLabel: cell.jobLabel,
    start: cell.start,
    finish: cell.finish,
    duration: cell.duration,
  };
}

function compareCell({
  employeeName,
  line,
  date,
  dayIndex,
  actualCell,
  masterCell,
  swapPartners,
  jobDictionary,
  diagramData,
}) {
  const flags = [];
  const publicHolidayName = NSW_PUBLIC_HOLIDAYS[date] || "";
  const ph = Boolean(publicHolidayName) || actualCell.status === "HOL";
  const leaveCodes = new Set(actualCell.leaveCodes);
  const timedRelinquishment = (leaveCodes.has("REL") || leaveCodes.has("SL_REL")) &&
    actualCell.status === "WORK" && !actualCell.crossedOut;
  const relinquishmentWorked = timedRelinquishment ? shiftDurationMinutes(actualCell.start, actualCell.finish) : null;
  const partialSick = relinquishmentWorked !== null && relinquishmentWorked >= RELINQUISHMENT_MINUTES;
  const sick = SICK_LEAVE_CODES.some(code => leaveCodes.has(code)) && !partialSick;
  const timedDuty = actualCell.status === "WORK" && !actualCell.crossedOut && (!sick || timedRelinquishment) &&
    !["AL", "JURY", "SEC", "PH", "LSL", "LWOP"].some(code => leaveCodes.has(code));
  const matchingPartners = timedDuty && actualCell.jobNumber
    ? swapPartners.filter(partner => partner.line !== line && isWorkCell(partner.original) &&
        partner.original.jobNumber === actualCell.jobNumber)
    : [];
  const assignedPartner = matchingPartners.length === 1 ? matchingPartners[0] : null;
  const dictionaryJob = Object.hasOwn(jobDictionary.jobs, actualCell.jobNumber) ? jobDictionary.jobs[actualCell.jobNumber] : null;
  const baseline = getBaseline(actualCell, masterCell, dictionaryJob, flags, diagramData, dayIndex, timedDuty, assignedPartner?.original);
  const swapAssignment = baseline.source === "swap_master_line" ? assignedPartner : null;
  const scheduledCell = swapAssignment?.original || masterCell;
  const customDuty = baseline.source === "custom_duty";
  const hasRelinquishmentSchedule = timedRelinquishment &&
    ["master_line_day", "swap_master_line", "diagram_data", "job_dictionary"].includes(baseline.source) &&
    shiftDurationMinutes(baseline.start, baseline.finish) !== null;
  const mileageOver209Candidate = Boolean(
    actualCell.jobNumber &&
      (actualCell.mileageOver209Candidate || (!customDuty && dictionaryJob?.mileageOver209Candidate))
  );
  const baselineHasWork = Boolean(baseline.start && baseline.finish);
  let status = "blank";
  let changeType = "blank";
  let rosteredStart = "";
  let rosteredFinish = "";
  let actualStart = "";
  let actualFinish = "";
  let timeWorked = "";
  let workedMinutes = 0;
  let liftUpMinutes = 0;
  let laybackMinutes = 0;
  let buildupMinutes = 0;
  let payableMinutes = 0;

  const leaveStart = actualCell.crossedOut ? actualCell.start : baseline.start;
  const leaveFinish = actualCell.crossedOut ? actualCell.finish : baseline.finish;

  if (actualCell.status === "OFF" || actualCell.status === "ADO" || actualCell.status === "NTA") {
    status = "blank";
    changeType = actualCell.status.toLowerCase();
  } else if (leaveCodes.has("JURY") || leaveCodes.has("SEC")) {
    status = leaveCodes.has("JURY") ? "jury" : "seconded";
    changeType = status;
  } else if (sick) {
    if (baselineHasWork || actualCell.crossedOut || ["REL", "SIF", "INJ"].some(code => leaveCodes.has(code))) {
      status = "sick";
      changeType = leaveCodes.has("SL_REL") || leaveCodes.has("REL") ? "sick_relief" : "sick";
      rosteredStart = timedRelinquishment && !hasRelinquishmentSchedule ? "" : leaveStart;
      rosteredFinish = timedRelinquishment && !hasRelinquishmentSchedule ? "" : leaveFinish;
      actualStart = "SICK";
      if (!rosteredStart || !rosteredFinish) flags.push("confirm_sick_leave_hours");
    } else {
      status = "blank";
      changeType = "sick_on_day_off";
    }
  } else if (leaveCodes.has("AL")) {
    if (baselineHasWork || actualCell.crossedOut || /\(\s*LVE\s+PURCHASED\b/i.test(actualCell.rawText)) {
      status = "hol";
      changeType = "annual_leave_as_hol";
      rosteredStart = "HOL";
    } else {
      status = "blank";
      changeType = "annual_leave_on_day_off";
    }
  } else if (actualCell.status === "HOL") {
    status = "hol";
    changeType = "hol";
    rosteredStart = "HOL";
  } else if (leaveCodes.has("PH")) {
    status = "ph-taken";
    changeType = "ph-taken";
  } else if (leaveCodes.has("LSL") || leaveCodes.has("LWOP")) {
    status = leaveCodes.has("LSL") ? "lsl" : "unpaid";
    changeType = status;
    if (status === "unpaid") {
      rosteredStart = actualCell.start || leaveStart;
      rosteredFinish = actualCell.finish || leaveFinish;
    }
  } else if (actualCell.crossedOut) {
    status = "unknown";
    changeType = "crossed_out_shift";
    rosteredStart = actualCell.start;
    rosteredFinish = actualCell.finish;
    flags.push("crossed_out_shift");
  } else if (actualCell.status === "WORK") {
    status = "work";
    if (partialSick) flags.push("part_day_sick_relief");
    rosteredStart = baseline.start || actualCell.start;
    rosteredFinish = baseline.finish || actualCell.finish;
    actualStart = actualCell.start;
    actualFinish = actualCell.finish;

    if (!baseline.start || !baseline.finish) {
      flags.push("missing_baseline_used_actual_times");
    }

    const calc = calculatePayableMinutes(rosteredStart, rosteredFinish, actualStart, actualFinish);
    workedMinutes = calc.workedMinutes;
    liftUpMinutes = partialSick ? 0 : calc.liftUpMinutes;
    laybackMinutes = partialSick ? 0 : calc.laybackMinutes;
    buildupMinutes = partialSick ? 0 : calc.buildupMinutes;
    payableMinutes = partialSick ? workedMinutes : calc.payableMinutes;
    timeWorked = minutesToHHMM(workedMinutes);
    changeType = customDuty ? "custom_duty" : partialSick ? "partial_sick" : classifyWorkChange(actualCell, scheduledCell, baseline, calc);
  } else if (baselineHasWork && ph) {
    status = "blank";
    changeType = "public_holiday_not_worked";
  }

  if (mileageOver209Candidate) {
    flags.push("mileage_over_209_candidate");
  }

  const overtimeMinutes = Math.max(0, payableMinutes - 480);
  const wobod =
    status === "work" &&
    ["OFF", "ADO"].includes(masterCell.status) &&
    swapPartners.length === 0;
  const originalDiagram = !customDuty && (!swapPartners.length || swapAssignment) && isWorkCell(scheduledCell)
    ? scheduledCell : null;

  const payRow = {
    employeeName,
    line,
    date,
    day: dayNameFromIso(date),
    dayIndex,
    rosteredStart,
    actualStart,
    rosteredFinish,
    actualFinish,
    timeWorked,
    ph,
    publicHolidayName,
    accruePh: false,
    wobod,
    callout: false,
    extraKm: "",
    status,
    changeType,
    timedRelinquishment,
    hasRelinquishmentSchedule,
    leaveRosteredStart: changeType === "annual_leave_as_hol" ? leaveStart : "",
    leaveRosteredFinish: changeType === "annual_leave_as_hol" ? leaveFinish : "",
    originalStart: originalDiagram?.start || "",
    originalFinish: originalDiagram?.finish || "",
    rosteredKm: baseline.rosteredKm,
    rosteredOff: ["OFF", "ADO", "NTA"].includes(scheduledCell.status) ? true : isWorkCell(scheduledCell) ? false : undefined,
    jobNumber: actualCell.jobNumber,
    masterJobNumber: masterCell.jobNumber,
    swapLines: actualCell.swapLines || [],
    workSwap: swapPartners.length ? {
      original: shiftSnapshot(masterCell),
      partners: swapPartners,
      assignedLine: swapAssignment?.line ?? null,
    } : null,
    mileageOver209Candidate,
    workedMinutes,
    liftUpMinutes,
    laybackMinutes,
    buildupMinutes,
    payableMinutes,
    overtimeMinutes,
    flags,
  };

  return {
    employeeName,
    line,
    date,
    dayIndex,
    master: masterCell,
    actual: actualCell,
    baseline,
    payRow,
    flags,
  };
}

const DIAGRAM_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function findDiagram(diagramData, job) {
  const key = job.replace(/^0+(?=\d+$)/, "").toUpperCase();
  return [job, key].map(id => Object.hasOwn(diagramData, id) ? diagramData[id] : null).find(Boolean);
}

function referenceDiagram(diagram, job, dayIndex) {
  if (!diagram) return null;
  const day = DIAGRAM_DAYS[dayIndex % 7];
  const kmByDay = diagram.kmByDay || {};
  const matchesDay = diagram.dayPattern.split(",").some(pattern => {
    const [first, last = first] = pattern.split("-").map(name => DIAGRAM_DAYS.indexOf(name.trim()));
    return first <= dayIndex % 7 && dayIndex % 7 <= last;
  });
  if (!matchesDay && !Object.hasOwn(kmByDay, day)) return null;
  return {
    source: "diagram_data",
    jobNumber: job,
    start: diagram.signOn.replace(":", ""),
    finish: diagram.offDuty.replace(":", ""),
    duration: minutesToHHMM(Math.round(diagram.rosteredHrs * 60)),
    rosteredKm: kmByDay[day] ?? diagram.rosteredKm,
  };
}

function getBaseline(actualCell, masterCell, dictionaryJob, flags, diagramData, dayIndex, timedDuty, swapMasterCell) {
  const jobNumber = actualCell.jobNumber || masterCell.jobNumber;
  const publishedDiagram = diagramData && actualCell.jobNumber && findDiagram(diagramData, actualCell.jobNumber);
  const standbyAssignment = swapMasterCell || masterCell;
  if (timedDuty && actualCell.jobNumber === "SBY" && isWorkCell(standbyAssignment) &&
      (!actualCell.swapLines?.length || standbyAssignment.jobNumber === "SBY")) {
    return {
      source: swapMasterCell ? "swap_master_line" : "master_line_day",
      jobNumber: actualCell.jobNumber,
      start: standbyAssignment.start,
      finish: standbyAssignment.finish,
      duration: standbyAssignment.duration,
    };
  }
  if (timedDuty && !(diagramData ? publishedDiagram : dictionaryJob)) {
    return {
      source: "custom_duty",
      jobNumber: actualCell.jobNumber,
      start: actualCell.start,
      finish: actualCell.finish,
      duration: actualCell.duration,
    };
  }
  if (diagramData || swapMasterCell) {
    const diagramEntry = actualCell.jobNumber ? publishedDiagram : diagramData && jobNumber && findDiagram(diagramData, jobNumber);
    const diagram = referenceDiagram(diagramEntry, jobNumber, dayIndex);
    const assignment = swapMasterCell || masterCell;
    if (isWorkCell(assignment) && jobNumber === assignment.jobNumber) {
      return {
        source: swapMasterCell ? "swap_master_line" : "master_line_day",
        jobNumber,
        start: assignment.start,
        finish: assignment.finish,
        duration: assignment.duration,
        rosteredKm: diagram?.start === assignment.start && diagram.finish === assignment.finish
          ? diagram.rosteredKm : undefined,
      };
    }
    if (diagram && actualCell.jobNumber) return diagram;
  }
  if (actualCell.jobNumber) {
    const job = dictionaryJob;
    if (job && !job.conflict) {
      return {
        source: "job_dictionary",
        jobNumber: job.jobNumber,
        start: job.start,
        finish: job.finish,
        duration: job.duration,
      };
    }
    if (job?.conflict) {
      flags.push(`job_conflict:${actualCell.jobNumber}`);
    } else if (timedDuty) {
      flags.push(`diagram_times_unverified:${actualCell.jobNumber}`);
    }
    return {
      source: "actual_fallback",
      jobNumber: actualCell.jobNumber,
      start: actualCell.start,
      finish: actualCell.finish,
      duration: "",
    };
  }

  if (isWorkCell(masterCell)) {
    return {
      source: "master_line_day",
      jobNumber: masterCell.jobNumber,
      start: masterCell.start,
      finish: masterCell.finish,
      duration: masterCell.duration,
    };
  }

  if (actualCell.status === "WORK") {
    return {
      source: "actual_non_standard",
      jobNumber: "",
      start: actualCell.start,
      finish: actualCell.finish,
      duration: "",
    };
  }

  return {
    source: "none",
    jobNumber: "",
    start: "",
    finish: "",
    duration: "",
  };
}

function calculatePayableMinutes(rosteredStart, rosteredFinish, actualStart, actualFinish) {
  const rosteredStartMinutes = parseHHMM(rosteredStart);
  const rosteredFinishMinutes = finishAfterStart(
    parseHHMM(rosteredFinish),
    rosteredStartMinutes
  );
  const actualStartMinutes = alignToReference(parseHHMM(actualStart), rosteredStartMinutes);
  const actualFinishMinutes = finishAfterStart(parseHHMM(actualFinish), actualStartMinutes);
  const workedMinutes = actualFinishMinutes - actualStartMinutes;

  let liftUpMinutes = 0;
  let laybackMinutes = 0;
  let buildupMinutes = 0;

  if (
    actualStartMinutes < rosteredStartMinutes &&
    actualFinishMinutes < rosteredFinishMinutes
  ) {
    liftUpMinutes = rosteredFinishMinutes - actualFinishMinutes;
  } else if (
    actualStartMinutes > rosteredStartMinutes &&
    actualFinishMinutes > rosteredFinishMinutes
  ) {
    laybackMinutes = actualStartMinutes - rosteredStartMinutes;
  } else if (
    actualStartMinutes >= rosteredStartMinutes &&
    actualFinishMinutes <= rosteredFinishMinutes &&
    (actualStartMinutes !== rosteredStartMinutes ||
      actualFinishMinutes !== rosteredFinishMinutes)
  ) {
    buildupMinutes =
      actualStartMinutes -
      rosteredStartMinutes +
      (rosteredFinishMinutes - actualFinishMinutes);
  }

  return {
    workedMinutes,
    liftUpMinutes,
    laybackMinutes,
    buildupMinutes,
    payableMinutes:
      workedMinutes + liftUpMinutes + laybackMinutes + buildupMinutes,
  };
}

function classifyWorkChange(actualCell, masterCell, baseline, calc) {
  if (!isWorkCell(masterCell)) return "added_shift";
  if (actualCell.jobNumber && masterCell.jobNumber && actualCell.jobNumber !== masterCell.jobNumber) {
    if (calc.liftUpMinutes || calc.laybackMinutes || calc.buildupMinutes) {
      return "swapped_job_changed_time";
    }
    return "swapped_job";
  }
  if (calc.liftUpMinutes) return "lift_up";
  if (calc.laybackMinutes) return "layback";
  if (calc.buildupMinutes) return "buildup";
  if (baseline.start !== actualCell.start || baseline.finish !== actualCell.finish) {
    return "changed_time";
  }
  return "same";
}

function isWorkCell(cell) {
  return cell?.status === "WORK" && Boolean(cell.start && cell.finish);
}

function joinItems(items) {
  const sorted = items
    .slice()
    .sort((a, b) => Math.round(b.y) - Math.round(a.y) || a.x - b.x);
  const lines = [];

  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (!current || Math.abs(current.y - item.y) > 3) {
      lines.push({ y: item.y, parts: [item.str] });
    } else {
      current.parts.push(item.str);
    }
  }

  return lines.map((line) => line.parts.join(" ")).join(" ");
}

function normalizeCellText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function parseEmployeeName(text) {
  const cleaned = normalizeCellText(text)
    .replace(/\bSec\b.*$/i, "")
    .replace(/\bNQ STAR\b/gi, "")
    .trim();
  const withoutNotes = cleaned.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const commaName = withoutNotes.match(/[A-Z][A-Za-z' -]+,\s*[A-Z][A-Za-z' -]+/);
  return commaName ? commaName[0].trim() : withoutNotes;
}

function groupByY(items, tolerance) {
  const groups = [];
  for (const item of items.slice().sort((a, b) => b.y - a.y)) {
    const group = groups.find((entry) => Math.abs(entry.y - item.y) <= tolerance);
    if (group) {
      group.items.push(item);
      group.y = median(group.items.map((entry) => entry.y));
    } else {
      groups.push({ y: item.y, items: [item] });
    }
  }
  return groups;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseDate(value) {
  const match = value.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) throw new Error(`Bad date: ${value}`);
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatDateForDisplay(isoDate) {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function formatDisplayDate(date) {
  return [
    String(date.getDate()).padStart(2, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    date.getFullYear(),
  ].join("/");
}

function dayNameFromIso(isoDate) {
  if (!isoDate) return "";
  return ["sun", "mon", "tues", "wed", "thur", "fri", "sat"][
    new Date(`${isoDate}T00:00:00`).getDay()
  ];
}

function toHHMM(hours, minutes) {
  return `${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
}

function parseHHMM(value) {
  const match = String(value).match(/^(\d{2})(\d{2})$/);
  if (!match) throw new Error(`Bad time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function shiftDurationMinutes(start, finish) {
  const clock = /^(?:[01]\d|2[0-3])[0-5]\d$/;
  if (!clock.test(start || "") || !clock.test(finish || "") || start === finish) return null;
  return (parseHHMM(finish) - parseHHMM(start) + 1440) % 1440;
}

function finishAfterStart(finishMinutes, startMinutes) {
  let result = finishMinutes;
  while (result <= startMinutes) result += 1440;
  return result;
}

function alignToReference(minutes, referenceMinutes) {
  const candidates = [minutes - 1440, minutes, minutes + 1440];
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - referenceMinutes) < Math.abs(best - referenceMinutes)
      ? candidate
      : best
  );
}

function minutesToHHMM(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}${String(mins).padStart(2, "0")}`;
}

function minutesToUnitText(minutes) {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatRange(start, finish) {
  if (start === "HOL") return "HOL";
  if (start === "SICK") return "SICK";
  if (!start && !finish) return "";
  return `${start || ""}-${finish || ""}`;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { parseRoster, parseCell, analyseRosters, buildJobDictionary, markExtraDayOvertime, getMasterRosterStats, toIsoDate, addDays, parseHHMM, minutesToHHMM, shiftDurationMinutes, RELINQUISHMENT_MINUTES };
