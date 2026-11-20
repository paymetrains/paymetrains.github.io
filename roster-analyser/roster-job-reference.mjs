const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const normaliseJob = job => String(job || "").replace(/\(i\)$/i, "").replace(/^0+(?=\d+$)/, "").toUpperCase();

export function buildRosterJobReference(master) {
  const jobs = {};
  for (const row of master.rows) {
    for (const cell of row.cells) {
      if (cell.status !== "WORK" || !cell.jobNumber || !cell.start || !cell.finish) continue;
      const number = normaliseJob(cell.jobNumber);
      const job = jobs[number] ||= { job: number, variants: [] };
      let variant = job.variants.find(item => item.start === cell.start && item.finish === cell.finish);
      if (!variant) {
        variant = { start: cell.start, finish: cell.finish, durationMinutes: shiftDurationMinutes(cell.start, cell.finish), weekdays: [], occurrences: [] };
        job.variants.push(variant);
      }
      const weekday = WEEKDAYS[cell.dayIndex % 7];
      if (!variant.weekdays.includes(weekday)) variant.weekdays.push(weekday);
      variant.occurrences.push({ line: row.line, dayIndex: cell.dayIndex });
    }
  }
  for (const job of Object.values(jobs)) {
    job.variants.sort((a, b) => a.start.localeCompare(b.start) || a.finish.localeCompare(b.finish));
    for (const variant of job.variants) variant.weekdays.sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    job.conflictingWeekdays = WEEKDAYS.filter(day => job.variants.filter(variant => variant.weekdays.includes(day)).length > 1);
  }
  return {
    schemaVersion: 1,
    source: "defunct-master-roster",
    sourceFile: master.fileName || master.label || "Uploaded defunct master",
    depot: master.depot || null,
    role: master.role || null,
    jobs: Object.fromEntries(Object.entries(jobs).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))),
  };
}

export function matchingRosterJob(reference, job, dayIndex) {
  const entry = reference.jobs[normaliseJob(job)];
  if (!entry) return null;
  const weekday = WEEKDAYS[dayIndex % 7];
  const matches = entry.variants.filter(variant => variant.weekdays.includes(weekday));
  // One observed time range identifies the job even if this weekday was not
  // assigned in the master. Multiple ranges require a unique weekday match.
  const variant = entry.variants.length === 1 ? entry.variants[0] : matches.length === 1 ? matches[0] : null;
  if (!variant) return null;
  return { jobNumber: entry.job, start: variant.start, finish: variant.finish, occurrences: variant.occurrences };
}
import { shiftDurationMinutes } from "./roster-core.mjs";

