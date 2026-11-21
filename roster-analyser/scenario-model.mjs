import { importLine, toEngineTable } from "./fortnight-model.mjs";
import { breakdownEntries } from "./payslip.mjs";
import { buildRosterJobReference, matchingRosterJob } from "./roster-job-reference.mjs";
import { normaliseJob, shiftDurationMinutes } from "./roster-core.mjs";
import { scenarioKilometres, kilometreOptions } from "./scenario-kilometres.mjs";
import { isReviewRoads, hasReviewRoadsReference } from "./diagram-kilometres.mjs";

const cents = value => Math.round((value + Number.EPSILON) * 100);
const round = value => cents(value) / 100;
const clockMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function wobodSourcesFor(row, index, master, defunct) {
  if (row.status !== "work") return [];
  const off = source => ["OFF", "ADO"].includes(source.lines.get(row.line)?.cells[index]?.status);
  return [off(master) ? "Existing master" : "",
    !row.swapLines?.length && off(defunct) ? "Defunct master" : ""].filter(Boolean);
}

export function activeScenarioRows(master, current) {
  return current.rows.filter(row => {
    if (!row.employeeName.trim() || row.seconded) return false;
    if (!master.lines.has(row.line)) return true;
    const rows = importLine(master, current, row.line).rows;
    const seconded = rows.some(item => item.status === "seconded");
    return !seconded || rows.some(item => !["seconded", "off", "ado", "nta", "blank"].includes(item.status));
  });
}

export function matchingDiagram(master, job, dayIndex) {
  const key = job.replace(/^0+(?=\d+$)/, "").toUpperCase();
  const diagram = master.diagramData?.[job] || master.diagramData?.[key];
  if (!diagram) return null;
  const day = dayIndex % 7;
  const matches = diagram.dayPattern.split(",").some(pattern => {
    const [first, last = first] = pattern.trim().split("-").map(name => days.indexOf(name.trim()));
    return first >= 0 && first <= day && day <= last;
  });
  if (!matches && !Object.hasOwn(diagram.kmByDay || {}, days[day])) return null;
  const km = diagram.kmByDay?.[days[day]] ?? diagram.rosteredKm;
  return { jobNumber: job, start: diagram.signOn.replace(":", ""), finish: diagram.offDuty.replace(":", ""),
    rosteredKm: diagram.kilometresStatus === "not-counted" || typeof km !== "number" || !Number.isFinite(km) ? null : km,
    kilometresStatus: diagram.kilometresStatus || (typeof km === "number" ? "known" : "unavailable"), sourceFlag: diagram.sourceFlag || null };
}

export function matchingKilometres(master, job, dayIndex) {
  const diagram = matchingDiagram(master, job, dayIndex);
  const key = normaliseJob(job);
  const manual = master.kilometreData?.[job] || master.kilometreData?.[key];
  return manual ? { ...diagram, ...manual } : diagram;
}

function dailyTotals(result) {
  const totals = Array(14).fill(0);
  let index = -1;
  let adjustments = false;
  for (const entry of breakdownEntries(result.breakdown)) {
    if (/^(SUN|MON|TUES|WED|THUR|FRI|SAT):/.test(entry.label)) index++;
    if (entry.label === "ADO Adjustment:") adjustments = true;
    if (index >= 0 && !adjustments && entry.amount !== "" && Number.isFinite(Number(entry.amount)))
      totals[index] += cents(Number(entry.amount));
  }
  return totals;
}

function dailyHolidayLines(result) {
  const items = Array.from({ length: 14 }, () => []);
  let index = -1;
  for (const entry of breakdownEntries(result.breakdown)) {
    if (/^(SUN|MON|TUES|WED|THUR|FRI|SAT):/.test(entry.label)) index++;
    if (index < 0 || !(entry.label === "Public Holiday Paid:" || entry.label.startsWith("Public holiday accrued"))) continue;
    items[index].push({ label: entry.label.replace(/:$/, ""), minutes: Math.round(Number(entry.units) * 60), amount: Number(entry.amount || 0) });
  }
  return items;
}

function masterComparison(candidates, source, preferredJob = null) {
  const matches = candidates.filter(option => source === "defunct"
    ? option.basis.source.includes("Defunct master")
    : /Existing master|Diagram data|Worked roster/.test(option.basis.source));
  const available = matches.length ? matches : candidates.filter(option => !option.row.amendment);
  const best = [...available].sort((a, b) => b.paid - a.paid ||
    Number(b.basis.job === preferredJob) - Number(a.basis.job === preferredJob) ||
    Number(a.row.amendment === "compare") - Number(b.row.amendment === "compare"))[0];
  return { amount: best.paid / 100, basis: best.basis, amendment: best.row.amendment || "actual" };
}

function snapshot(cell) {
  if (!cell) return null;
  return { job: cell.jobNumber || cell.status, status: cell.status, start: cell.start || "", finish: cell.finish || "" };
}

function variants(row, basis, settings) {
  const candidate = {
    ...row, rosteredStart: basis.start, rosteredFinish: basis.finish,
    originalStart: basis.start, originalFinish: basis.finish,
    creditAlignment: "same-date",
  };
  const swapped = Boolean(row.swapLines?.length);
  const sameJob = normaliseJob(basis.job) === normaliseJob(row.jobNumber);
  const largeChange = Math.abs(clockMinutes(basis.start) - clockMinutes(row.actualStart)) > 720;
  const allowCredit = (!swapped || sameJob) && !(largeChange && settings.alignment === "exclude-large");
  const result = [{ row: { ...candidate, amendment: "" }, basis }];
  if ((!swapped || sameJob) && !row.wobod)
    result.push({ row: { ...candidate, amendment: "compare" }, basis });
  if (allowCredit) result.push({ row: { ...candidate, amendment: "credit" }, basis });
  return result;
}

function optionsFor(row, index, master, defunct, settings) {
  const currentCell = master.lines.get(row.line)?.cells[index];
  const oldCell = defunct.lines.get(row.line)?.cells[index];
  const diagram = matchingDiagram(master, row.jobNumber, index);
  const existingJob = !diagram && matchingRosterJob(settings.existingJobs, row.jobNumber, index);
  const defunctDiagram = settings.role === "guard" ? null : matchingDiagram(defunct, row.jobNumber, index);
  const defunctJob = !defunctDiagram && matchingRosterJob(settings.defunctJobs, row.jobNumber, index);
  const normalBasis = {
    source: diagram?.start === row.rosteredStart && diagram.finish === row.rosteredFinish ? "Diagram data" : "Worked roster",
    job: row.jobNumber, start: row.rosteredStart, finish: row.rosteredFinish,
  };
  if ((currentCell?.jobNumber === row.jobNumber || ["SBY", "FREELANCE"].includes(row.jobNumber)) && currentCell?.status === "WORK" && currentCell.start === row.rosteredStart && currentCell.finish === row.rosteredFinish)
    Object.assign(normalBasis, { source: "Existing master", job: currentCell.jobNumber });
  if (row.workSwap?.assignedLine) {
    const assigned = master.lines.get(row.workSwap.assignedLine)?.cells[index];
    Object.assign(normalBasis, { source: `Existing master · swapped line ${row.workSwap.assignedLine}`, job: assigned?.jobNumber || row.jobNumber });
  }
  if (row.status !== "work") return [{ row, basis: normalBasis }];
  const timedShiftDuty = ["SBY", "FREELANCE"].includes(row.jobNumber);
  if (row.changeType === "custom_duty" && !diagram && !existingJob && !defunctDiagram && !defunctJob && !timedShiftDuty) return variants(row, normalBasis, settings);
  const bases = [normalBasis];
  if (currentCell?.status === "WORK") bases.push({ source: "Existing master", job: currentCell.jobNumber, start: currentCell.start, finish: currentCell.finish });
  if (oldCell?.status === "WORK") bases.push({ source: "Defunct master", job: oldCell.jobNumber, start: oldCell.start, finish: oldCell.finish });
  if (diagram) bases.push({ source: "Diagram data", job: row.jobNumber, start: diagram.start, finish: diagram.finish });
  if (existingJob) bases.push({ source: "Existing master job reference", job: row.jobNumber, start: existingJob.start, finish: existingJob.finish, referenceOccurrences: existingJob.occurrences });
  if (defunctJob) bases.push({ source: "Defunct master job reference", job: row.jobNumber, start: defunctJob.start, finish: defunctJob.finish, referenceOccurrences: defunctJob.occurrences });
  if (defunctDiagram) bases.push({ source: "Defunct master job reference", job: row.jobNumber, start: defunctDiagram.start, finish: defunctDiagram.finish, referenceKind: "imported-diagram", sourceFlag: defunctDiagram.sourceFlag });
  const unique = new Map();
  for (const basis of bases) {
    if (!basis.start || !basis.finish) continue;
    for (const option of variants(row, basis, settings)) {
      const key = [basis.job, option.row.rosteredStart, option.row.rosteredFinish, option.row.amendment].join("|");
      if (!unique.has(key)) unique.set(key, { ...option, basis: { ...basis, sources: [basis.source] } });
      else {
        const existing = unique.get(key).basis;
        if (!existing.sources.includes(basis.source)) existing.sources.push(basis.source);
        existing.source = existing.sources.join(" + ");
      }
    }
  }
  return kilometreOptions([...unique.values()], row.kilometres);
}

// A lower guarantee contribution can increase the fortnight top-up. Keep every
// undominated combination so the maximum includes that fortnight adjustment.
export function maximiseOptions(options, limit, guaranteeEligible = true) {
  let frontier = [{ paid: 0, guarantee: 0, choices: [] }];
  for (const candidates of options) {
    const states = new Map();
    for (const state of frontier) {
      for (const option of candidates) {
        const guarantee = state.guarantee + option.guarantee;
        const paid = state.paid + option.paid;
        if (!states.has(guarantee) || states.get(guarantee).paid < paid)
          states.set(guarantee, { guarantee, paid, choices: [...state.choices, option] });
      }
    }
    let highestPay = -Infinity;
    frontier = [...states.values()].sort((a, b) => a.guarantee - b.guarantee).filter(state => {
      if (state.paid <= highestPay) return false;
      highestPay = state.paid;
      return true;
    });
  }
  let best;
  for (const state of frontier) {
    const hours = guaranteeEligible ? round(Math.max(0, limit.hours - round(state.guarantee / 120))) : 0;
    const gross = state.paid + cents(round(hours * limit.rate));
    if (!best || gross > best.gross) best = { ...state, gross };
  }
  return best.choices;
}

export function calculateScenarioLine({ engine, master, defunct, current, line, rate, role, alignment = "same-date", weekdayOvertimeAfterFourth = 2, extraKilometres = {}, kilometresByDate = {} }) {
  const imported = importLine(master, current, line);
  const settings = { role, alignment, existingJobs: master.rosterJobReference || buildRosterJobReference(master), defunctJobs: defunct.rosterJobReference || buildRosterJobReference(defunct) };
  const notes = [];
  const rows = imported.rows.map((row, index) => {
    const item = { ...row, reviewed: true, creditAlignment: "same-date" };
    if (role === "driver" && Object.hasOwn(extraKilometres, row.date)) item.extraKm = extraKilometres[row.date];
    if (role === "driver" && Object.hasOwn(kilometresByDate, row.date)) item.kilometreInput = kilometresByDate[row.date];
    if (/^NR\b|Off\s+RosteP/i.test(row.rawText)) {
      item.status = "off";
      notes.push(`${row.date} · ${row.rawText} treated as a day off.`);
    }
    if (/Carers\s*L/i.test(row.rawText)) {
      item.status = "sick";
      item.leaveHours = 8;
      notes.push(`${row.date} · Carer's leave treated as paid sick leave.`);
    }
    if (/\bCIL\b/i.test(row.rawText)) {
      item.status = "ph-taken";
      item.leaveHours = 8;
      notes.push(`${row.date} · CIL modeled as 8 hours of paid accrued leave.`);
    }
    const currentCell = master.lines.get(Number(line))?.cells[index];
    const defunctCell = defunct.lines.get(Number(line))?.cells[index];
    const roadsReference = (cell, jobs) => isReviewRoads(item.jobNumber) && Boolean(
      (cell?.status === "WORK" && cell.start && cell.finish && normaliseJob(cell.jobNumber) === normaliseJob(item.jobNumber)) ||
      hasReviewRoadsReference(jobs, item.jobNumber));
    item.kilometres = role === "driver" ? scenarioKilometres(item, matchingKilometres(master, item.jobNumber, index), matchingKilometres(defunct, item.jobNumber, index), role, defunctCell,
      { current: roadsReference(currentCell, settings.existingJobs), defunct: roadsReference(defunctCell, settings.defunctJobs) }) : null;
    if (item.kilometres) item.extraKm = item.kilometres.enteredExtraKm;
    return item;
  });
  if (!rows.some(row => !["off", "ado", "nta", "blank"].includes(row.status)))
    throw new Error("No worked shifts or paid leave remain on this line. Its normal gross pay needs confirmation.");
  const run = values => engine.calculateWithBreakdown(toEngineTable(values, rate, imported.rosterType, { role, weekdayOvertimeAfterFourth, scenarioComparison: true }));
  // The usual fortnight uses the existing master and its job lookup only.
  const baselineOptions = rows.map((row, index) => row.status === "work"
    ? variants(row, optionsFor(row, index, master, defunct, settings)[0].basis, settings)
    : [{ row, basis: { source: "Existing calculation", job: row.jobNumber } }]);
  const scenarioRows = rows.map((row, index) => ({
    ...row,
    wobod: wobodSourcesFor(row, index, master, defunct).length > 0,
  }));
  const scenarioOptions = scenarioRows.map((row, index) => optionsFor(row, index, master, defunct, settings));

  function optimise(options, seedRows, selectDaily = false) {
    const seed = run(seedRows);
    const limit = imported.rosterType === "long" ? 10 : 9;
    const eligible = new Set();
    let timeLost = 0;
    for (let index = 0; index < 14 && eligible.size < limit; index++) {
      const row = seed.payObj[index];
      if (row.WOBOD || row.excessDayNormal || row.excessDayDouble) continue;
      if (row.RDO && !row.guaranteeHours && !row.timeLostHours) continue;
      eligible.add(index);
      timeLost += row.timeLostHours;
    }
    const priced = options.map((candidates, index) => candidates.map(option => {
      const result = run(seedRows.map((row, day) => day === index ? option.row : row));
      return {
        ...option,
        paid: dailyTotals(result)[index],
        guarantee: eligible.has(index) ? Math.round(result.payObj[index].guaranteeHours * 120) : 0,
      };
    }));
    const chosen = selectDaily
      ? priced.map(candidates => [...candidates].sort((a, b) => b.paid - a.paid || a.guarantee - b.guarantee || Number(a.row.amendment === "compare") - Number(b.row.amendment === "compare"))[0])
      : maximiseOptions(priced, { hours: limit * 8 - round(timeLost), rate }, seed.payObj.guaranteeEligible);
    const result = run(chosen.map(option => option.row));
    return { result, chosen, priced, totals: dailyTotals(result) };
  }
  const baseline = optimise(baselineOptions, rows);
  const maximum = optimise(scenarioOptions, scenarioRows, true);
  const workedOnly = run(scenarioRows.map(row => ({ ...row, amendment: "" })));
  const workedOnlyTotals = dailyTotals(workedOnly);
  const withoutKilometreGain = run(maximum.chosen.map((choice, index) => ({ ...choice.row, extraKm: scenarioRows[index].extraKm })));
  const withoutKilometreTotals = dailyTotals(withoutKilometreGain);
  const workedHolidayLines = dailyHolidayLines(workedOnly);
  const dates = rows.map((row, index) => {
    const original = snapshot(master.lines.get(Number(line))?.cells[index]);
    const old = snapshot(defunct.lines.get(Number(line))?.cells[index]);
    const chosen = maximum.chosen[index];
    const pay = maximum.result.payObj[index];
    const wobodSources = wobodSourcesFor(row, index, master, defunct);
    const largeChange = row.status === "work" && [original, old].some(cell => cell?.start && Math.abs(clockMinutes(cell.start) - clockMinutes(row.actualStart)) > 720);
    const timeCredit = pay.lines.find(item => /^(Lift-up|Lay-back|Build-up) included in shift pay$/.test(item.label));
    const claimDifference = (withoutKilometreTotals[index] - workedOnlyTotals[index]) / 100;
    const kilometreDifference = (maximum.totals[index] - withoutKilometreTotals[index]) / 100;
    const separateTimeClaims = [];
    const claimComparison = { source: chosen.basis.source, sources: chosen.basis.sources || [chosen.basis.source], job: chosen.basis.job, start: chosen.basis.start, finish: chosen.basis.finish };
    if (timeCredit) separateTimeClaims.push({ label: timeCredit.label.replace(" included in shift pay", ""), minutes: timeCredit.minutes, amount: claimDifference, comparison: claimComparison });
    else if (claimDifference) separateTimeClaims.push({ label: "Original job value claim", amount: claimDifference, comparison: claimComparison });
    const currentJob = row.status === "work" ? matchingDiagram(master, row.jobNumber, index) || matchingRosterJob(settings.existingJobs, row.jobNumber, index) : null;
    const swapAssignment = row.workSwap?.assignedLine ? master.lines.get(row.workSwap.assignedLine)?.cells[index] : null;
    const currentJobReference = currentJob ? { job: row.jobNumber, start: currentJob.start, finish: currentJob.finish }
      : swapAssignment?.jobNumber === row.jobNumber && swapAssignment.status === "WORK" ? { job: row.jobNumber, start: swapAssignment.start, finish: swapAssignment.finish }
      : { job: row.jobNumber, start: row.actualStart, finish: row.actualFinish };
    return {
      date: row.date, status: row.status,
      worked: { job: row.jobNumber, start: row.actualStart, finish: row.actualFinish, minutes: row.actualStart && row.actualFinish ? shiftDurationMinutes(row.actualStart, row.actualFinish) : null, rawText: row.rawText },
      rostered: { job: row.jobNumber, start: row.rosteredStart, finish: row.rosteredFinish },
      currentJobReference,
      kilometres: row.kilometres ? { ...row.kilometres,
        defunctKm: chosen.basis.kilometreReference?.rosteredKm ?? row.kilometres.defunctKm,
        defunctKilometresStatus: chosen.basis.kilometreReference ? "known" : row.kilometres.defunctKilometresStatus,
        referenceJob: chosen.basis.kilometreReference?.job || row.kilometres.job,
        claimedExtraKm: pay.lines.some(item => /^Extra kilometre time included/.test(item.label)) ? Number(chosen.row.extraKm || 0) : 0,
        reference: chosen.basis.kilometreReference ? "defunct" : "current", additionalPay: kilometreDifference } : null,
      existing: original, defunct: old, comparison: chosen.basis,
      comparisons: {
        defunct: masterComparison(maximum.priced[index], "defunct", row.swapLines?.length ? row.jobNumber : null),
        existing: masterComparison(maximum.priced[index], "existing", row.swapLines?.length ? row.jobNumber : null),
      },
      amendment: chosen.row.amendment || "actual",
      claims: pay.lines.filter(item => item.amount !== 0 || /included|applied/.test(item.label)),
      workedOnlyPay: workedOnlyTotals[index] / 100,
      workedOnlyClaims: [...workedOnly.payObj[index].lines.filter(item => item.amount !== 0), ...workedHolidayLines[index]],
      separateTimeClaims,
      wobod: pay.WOBOD, wobodSources: pay.WOBOD ? wobodSources : [],
      swapped: Boolean(row.swapLines?.length),
      swapLines: row.swapLines || [],
      baselinePay: baseline.totals[index] / 100,
      scenarioPay: maximum.totals[index] / 100,
      difference: (maximum.totals[index] - baseline.totals[index]) / 100,
      largeChange,
      alternatives: maximum.priced[index].map(option => ({ ...option.basis, amendment: option.row.amendment || "actual", pay: option.paid / 100 })),
    };
  });
  const dailyDifference = dates.reduce((sum, day) => sum + cents(day.difference), 0);
  const difference = round(maximum.result.grossPay - baseline.result.grossPay);
  return {
    line: Number(line), employeeName: imported.employeeName, rosterType: imported.rosterType,
    baseline: baseline.result.grossPay, maximum: maximum.result.grossPay, difference,
    adjustmentDifference: (cents(difference) - dailyDifference) / 100,
    dates, notes,
  };
}
