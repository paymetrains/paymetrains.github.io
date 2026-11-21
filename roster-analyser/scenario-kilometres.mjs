import { isReviewRoads, isZeroKilometreDuty, kilometreValue, extraKilometres } from "./diagram-kilometres.mjs";

const distance = value => Math.round((value + Number.EPSILON) * 1000) / 1000;

export function scenarioKilometres(row, currentDiagram, defunctDiagram, role, defunctLine = null, reviewRoadsReferences = {}) {
  if (role !== "driver" || row.status !== "work") return null;
  const enteredExtraKm = row.extraKm === "" || row.extraKm == null ? 0 : Number(row.extraKm);
  if (!Number.isFinite(enteredExtraKm) || enteredExtraKm < 0 || enteredExtraKm > 1000)
    throw new Error(`${row.date}: enter extra kilometres from 0 to 1000.`);
  const known = diagram => typeof diagram?.rosteredKm === "number" && Number.isFinite(diagram.rosteredKm) && diagram.rosteredKm >= 0;
  // Owner-confirmed: RR (Review Roads), SBY, SBYASY and SBDASY standby jobs have zero diagram kilometres.
  // This distance rule does not supply or change any shift times.
  const job = String(row.jobNumber || "").trim().toUpperCase();
  const currentZero = isZeroKilometreDuty(job, reviewRoadsReferences.current);
  const defunctZero = isZeroKilometreDuty(job, reviewRoadsReferences.defunct);
  const diagramKm = currentZero ? 0 : known(currentDiagram) ? currentDiagram.rosteredKm : null;
  const input = row.kilometreInput;
  const currentKm = input && Object.hasOwn(input, "rosteredKm") ? kilometreValue(input.rosteredKm) : diagramKm;
  const defunctKm = defunctZero ? 0 : known(defunctDiagram) ? defunctDiagram.rosteredKm : null;
  const actualKm = input && Object.hasOwn(input, "actualKm") ? kilometreValue(input.actualKm) : diagramKm === null ? null : distance(diagramKm + enteredExtraKm);
  const baselineExtraKm = input ? extraKilometres(actualKm, currentKm) : enteredExtraKm;
  return {
    job: row.jobNumber, currentKm, diagramKm, rosteredKm: currentKm, actualKm, defunctKm, enteredExtraKm: baselineExtraKm,
    assumedActualKm: actualKm,
    assumption: input && Object.hasOwn(input, "actualKm") ? "user-entered-actual-kilometres" : actualKm === null ? null : "current-diagram-default",
    defunctFlag: defunctDiagram?.sourceFlag || null,
    defunctKilometresStatus: defunctZero ? "known" : defunctDiagram?.kilometresStatus || "unavailable",
    // An unswapped job can also claim against its defunct line's RR duty.
    // Keep this separate from the worked job's own defunct diagram distance.
    defunctLineReference: !row.swapLines?.length && defunctLine?.status === "WORK" &&
      defunctLine.start && defunctLine.finish && isReviewRoads(defunctLine.jobNumber)
      ? { source: "Defunct master", job: defunctLine.jobNumber, rosteredKm: 0 } : null,
  };
}

export function kilometreOptions(options, kilometres) {
  if (!kilometres || kilometres.assumedActualKm === null) return options;
  return options.flatMap(option => {
    const references = kilometres.defunctKm === null ? [] : [
      { source: "Defunct diagram", job: kilometres.job, rosteredKm: kilometres.defunctKm },
    ];
    const line = kilometres.defunctLineReference;
    if (line && option.basis.job === line.job && option.basis.source.includes("Defunct master") && kilometres.job !== line.job)
      references.push(line);
    return [option, ...references.flatMap(reference => {
      const extraKm = distance(Math.max(0, kilometres.assumedActualKm - reference.rosteredKm));
      if (extraKm <= kilometres.enteredExtraKm) return [];
      return [{ row: { ...option.row, extraKm },
        basis: { ...option.basis, kilometreReference: { ...reference, actualKm: kilometres.assumedActualKm, extraKm } },
      }];
    })];
  });
}

export function kilometreClaimText(day) {
  const value = day.kilometres;
  if (!value || !value.claimedExtraKm) return "";
  const amount = `${value.claimedExtraKm} km`;
  return value.reference === "defunct"
    ? `Extra km ${amount} MR - Defunct ${value.referenceJob || value.job} (${value.defunctKm} km)`
    : `Extra km ${amount}`;
}
