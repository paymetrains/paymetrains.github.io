const distance = value => Math.round((value + Number.EPSILON) * 1000) / 1000;

export function scenarioKilometres(row, currentDiagram, defunctDiagram, role) {
  if (role !== "driver" || row.status !== "work") return null;
  const enteredExtraKm = row.extraKm === "" || row.extraKm == null ? 0 : Number(row.extraKm);
  if (!Number.isFinite(enteredExtraKm) || enteredExtraKm < 0 || enteredExtraKm > 1000)
    throw new Error(`${row.date}: enter extra kilometres from 0 to 1000.`);
  const known = diagram => typeof diagram?.rosteredKm === "number" && Number.isFinite(diagram.rosteredKm) && diagram.rosteredKm >= 0;
  // Owner-confirmed: RR (Review Roads), SBY and SBYASY (Standby) have zero diagram kilometres.
  // This distance rule does not supply or change any shift times.
  const zeroDistanceDuty = ["RR", "SBY", "SBYASY"].includes(String(row.jobNumber || "").trim().toUpperCase());
  const currentKm = zeroDistanceDuty ? 0 : known(currentDiagram) ? currentDiagram.rosteredKm : null;
  const defunctKm = zeroDistanceDuty ? 0 : known(defunctDiagram) ? defunctDiagram.rosteredKm : null;
  return {
    job: row.jobNumber, currentKm, defunctKm, enteredExtraKm,
    assumedActualKm: currentKm === null ? null : distance(currentKm + enteredExtraKm),
    assumption: currentKm === null ? null : "current-diagram-plus-entered-extras",
    defunctFlag: defunctDiagram?.sourceFlag || null,
    defunctKilometresStatus: zeroDistanceDuty ? "known" : defunctDiagram?.kilometresStatus || "unavailable",
  };
}

export function kilometreOptions(options, kilometres) {
  if (!kilometres || kilometres.assumedActualKm === null || kilometres.defunctKm === null) return options;
  const extraKm = distance(Math.max(0, kilometres.assumedActualKm - kilometres.defunctKm));
  if (extraKm <= kilometres.enteredExtraKm) return options;
  return options.flatMap(option => [option, {
    row: { ...option.row, extraKm },
    basis: { ...option.basis, kilometreReference: { source: "Defunct diagram", job: kilometres.job, rosteredKm: kilometres.defunctKm, actualKm: kilometres.assumedActualKm, extraKm } },
  }]);
}

export function kilometreClaimText(day) {
  const value = day.kilometres;
  if (!value || !value.claimedExtraKm) return "";
  const amount = `${value.claimedExtraKm} km`;
  return value.reference === "defunct"
    ? `Extra km ${amount} MR - Defunct ${value.job} (${value.defunctKm} km)`
    : `Extra km ${amount}`;
}
