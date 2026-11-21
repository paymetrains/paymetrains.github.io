const jobKey = job => String(job || "").trim().toUpperCase().replace(/\(I\)$/, "");

// Review Roads is a diagram reference, including numbered RR1/RR2 variants.
// Zero distance does not remove its rostered times or prevent extra-km claims.
export const isReviewRoads = job => /^RR\d*$/.test(jobKey(job));

export function isZeroKilometreDuty(job, reviewRoadsReference = false) {
  const key = jobKey(job);
  return (reviewRoadsReference && isReviewRoads(key)) || ["SBY", "SBYASY"].includes(key) || /^SBDASY\d*$/.test(key);
}

export function kilometreValue(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1000)
    throw new Error("Kilometres must be between 0 and 1000.");
  return number;
}

export function extraKilometres(actual, rostered) {
  return actual === null || rostered === null ? 0 : Math.round((Math.max(0, actual - rostered) + Number.EPSILON) * 1000) / 1000;
}
