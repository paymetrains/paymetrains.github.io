import { STATUS_LABELS } from "./fortnight-model.mjs";
import { kilometreClaimText } from "./scenario-kilometres.mjs";

const clock = value => value ? `${value.slice(0, 2)}:${value.slice(2)}` : "";

export function claimMinutes(minutes) {
  return minutes < 60 ? `${minutes}"` : `${Math.floor(minutes / 60)}'${String(minutes % 60).padStart(2, "0")}"`;
}

export function timesheetClaims(day) {
  const notes = [];
  if (day.wobod) {
    const defunct = day.wobodSources.includes("Defunct master") && !day.wobodSources.includes("Existing master");
    notes.push(defunct
      ? "WOBOD MR- Book-OFF day on Defunct roster"
      : "WOBOD");
  }
  for (const claim of day.separateTimeClaims) {
    const comparison = claim.comparison || day.comparison;
    const sources = comparison.sources || [comparison.source];
    const defunct = sources.some(source => source?.includes("Defunct"));
    const label = { "Lift-up": "Lift Up", "Lay-back": "Layback", "Build-up": "Build Up" }[claim.label] || claim.label;
    const claimText = `${label}${claim.minutes ? ` ${claimMinutes(claim.minutes)}` : ""}`;
    notes.push(defunct ? `${claimText} MR - Defunct ${comparison.job || "Custom"} ${clock(comparison.start)}–${clock(comparison.finish)}` : claimText);
  }
  const kilometres = kilometreClaimText(day);
  if (kilometres) notes.push(kilometres);
  return notes;
}

export function timesheetEntries(line, dates = line.dates) {
  return dates.map(day => {
    const working = day.status === "work";
    // Swaps use the worked job's current reference; other days use this line's assignment.
    const currentDiagram = day.alternatives?.find(item => item.job === day.worked.job && item.source.includes("Diagram data"));
    const jobReference = day.currentJobReference || currentDiagram ||
      (day.comparisons.existing.basis.job === day.worked.job ? day.comparisons.existing.basis : day.rostered?.job === day.worked.job ? day.rostered : day.worked);
    const rostered = day.swapped && working ? jobReference : day.existing || {};
    return {
      date: day.date,
      job: working ? day.worked.job || "Custom" : STATUS_LABELS[day.status] || day.status,
      rosteredStart: clock(rostered.start),
      actualStart: working ? clock(day.worked.start) : "",
      rosteredFinish: clock(rostered.finish),
      actualFinish: working ? clock(day.worked.finish) : "",
      claims: timesheetClaims(day),
      minutes: working ? day.worked.minutes : null,
      swapped: day.swapped,
      swapLines: day.swapLines,
    };
  });
}
