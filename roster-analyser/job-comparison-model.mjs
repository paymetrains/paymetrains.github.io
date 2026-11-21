import { blankFortnight, toEngineTable } from "./fortnight-model.mjs";
import { normaliseJob, shiftDurationMinutes } from "./roster-core.mjs";
import { buildRosterJobReference, matchingRosterJob } from "./roster-job-reference.mjs";
import { matchingDiagram, matchingKilometres } from "./scenario-model.mjs";
import { scenarioKilometres } from "./scenario-kilometres.mjs";

export const JOB_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const round = amount => Math.round((amount + Number.EPSILON) * 100) / 100;
const duration = minutes => `${String(Math.floor(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;

function priceJob(engine, start, day, worked, reference, role, rate, amendment, extraKm) {
  const rows = blankFortnight(start).map(row => ({ ...row, status: "off", reviewed: true }));
  rows[day] = { ...rows[day], status: "work", jobNumber: worked.jobNumber,
    rosteredStart: reference.start, rosteredFinish: reference.finish,
    actualStart: worked.start, actualFinish: worked.finish,
    originalStart: reference.start, originalFinish: reference.finish,
    timeWorked: duration(shiftDurationMinutes(worked.start, worked.finish)),
    extraKm, amendment, creditAlignment: "same-date" };
  const table = toEngineTable(rows, rate, "long", { role, scenarioComparison: true });
  const priced = engine.buildPayObject(table)[day];
  return { total: round(priced.lines.reduce((sum, line) => sum + engine.lineAmount(line), 0)), lines: priced.lines };
}

export function compareJob({ engine, start, day, worked, reference, role, rate, kilometres }) {
  const normal = priceJob(engine, start, day, worked, worked, role, rate, "", 0);
  const knownKm = role !== "driver" || (Number.isFinite(kilometres?.currentKm) && Number.isFinite(kilometres?.defunctKm));
  const extraKm = role === "driver" && knownKm ? Math.round(Math.max(0, kilometres.currentKm - kilometres.defunctKm) * 1000) / 1000 : 0;
  if (!reference) return { normalPay: normal.total, bestPay: null, extraPay: null, extraKm: null, kilometrePay: null, completeKm: knownKm, claims: [], issue: "No unique defunct times for this job." };
  const choices = ["", "credit", "compare"].map(amendment => ({ amendment, reference,
    ...priceJob(engine, start, day, worked, reference, role, rate, amendment, extraKm) }));
  choices.push({ amendment: "", reference: worked, ...normal });
  const best = choices.sort((a, b) => b.total - a.total)[0];
  const withoutKm = priceJob(engine, start, day, worked, best.reference, role, rate, best.amendment, 0);
  const claims = best.lines.filter(line => /^(Lift-up|Lay-back|Build-up) included/.test(line.label))
    .map(line => ({ label: line.label.replace(" included in shift pay", ""), minutes: line.minutes }));
  if (best.amendment === "compare" && best.total > normal.total) claims.push({ label: "Original job value", minutes: null });
  return { normalPay: normal.total, bestPay: best.total, extraPay: round(best.total - normal.total),
    extraKm: role === "driver" ? knownKm ? extraKm : null : null,
    kilometrePay: role === "driver" ? round(Math.max(0, best.total - withoutKm.total)) : null,
    completeKm: knownKm, claims, issue: null };
}

export function compareAsyJobs({ engine, master, defunct, role, rate, start }) {
  if (!Number.isFinite(Number(rate)) || Number(rate) <= 0) throw new Error("Enter an hourly rate greater than zero.");
  const dates = blankFortnight(start);
  if (!dates.length || new Date(`${start}T12:00:00Z`).getUTCDay() !== 0) throw new Error("Choose a Sunday for the week start.");
  const currentJobs = buildRosterJobReference(master);
  const defunctJobs = buildRosterJobReference(defunct);
  const jobs = [...new Set([...Object.keys(master.diagramData || {}), ...Object.keys(currentJobs.jobs)].map(normaliseJob))]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const result = [];
  for (const job of jobs) for (let day = 0; day < 7; day++) {
    const published = master.diagramData?.[job];
    const observed = currentJobs.jobs[job]?.variants.some(variant => variant.weekdays.includes(JOB_DAYS[day]));
    if (!published && !observed) continue;
    const worked = published ? matchingDiagram(master, job, day) : matchingRosterJob(currentJobs, job, day);
    if (!worked && published) continue; // Not a running day in the current diagram.
    const importedReference = role === "driver" ? matchingDiagram(defunct, job, day) : null;
    const reference = importedReference || matchingRosterJob(defunctJobs, job, day);
    const kilometres = role === "driver" ? scenarioKilometres({ status: "work", jobNumber: job, extraKm: 0 },
      matchingKilometres(master, job, day), matchingKilometres(defunct, job, day), role, null,
      { current: Boolean(matchingRosterJob(currentJobs, job, day)), defunct: Boolean(matchingRosterJob(defunctJobs, job, day)) }) : null;
    const comparison = worked ? compareJob({ engine, start, day, worked, reference, role, rate, kilometres })
      : { normalPay: null, bestPay: null, extraPay: null, extraKm: null, kilometrePay: null, completeKm: role !== "driver", claims: [], issue: "Current master has multiple times for this job; choose a line in the scenario app." };
    const row = { job, days: [JOB_DAYS[day]], date: dates[day].date, worked, reference,
      workedSource: published ? "Current diagram data" : "Current master roster",
      referenceSource: importedReference ? "Defunct diagram data" : "Defunct master roster", kilometres, ...comparison };
    const key = JSON.stringify({ ...row, days: null, date: null });
    const existing = result.find(item => item.key === key);
    if (existing) existing.days.push(JOB_DAYS[day]);
    else result.push({ ...row, key });
  }
  return result.map(({ key, ...row }) => row);
}
