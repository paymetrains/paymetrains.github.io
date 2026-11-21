const jobKey = job => String(job || "").trim().toUpperCase().replace(/\(I\)$/, "");

// Review Roads is a diagram reference, including numbered RR1/RR2 variants.
// Zero distance does not remove its rostered times or prevent extra-km claims.
export const isReviewRoads = job => /^RR\d*$/.test(jobKey(job));

export function isZeroKilometreDuty(job, reviewRoadsReference = false) {
  const key = jobKey(job);
  return (reviewRoadsReference && isReviewRoads(key)) || ["SBY", "SBYASY"].includes(key) || /^SBDASY\d*$/.test(key);
}
