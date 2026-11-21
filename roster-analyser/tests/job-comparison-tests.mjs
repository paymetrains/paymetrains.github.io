import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { hydrateReferenceMaster } from "../master-store.mjs";
import { compareJob, compareAsyJobs } from "../job-comparison-model.mjs";

const engine = createRequire(import.meta.url)("../pay-calculator.js");
const worked = { jobNumber: "1", start: "0600", finish: "1400" };
const context = { engine, worked, start: "2026-11-15", day: 1, rate: 50, role: "driver" };
const km = { currentKm: 100, defunctKm: 80 };
const identical = compareJob({ ...context, reference: worked, kilometres: km });
assert.equal(identical.extraKm, 20);
assert.equal(identical.extraPay, 75);
assert.equal(identical.kilometrePay, 75);
assert.equal(identical.recommendation, "defunct");
assert.equal(identical.defunctGain, 75);
assert.equal(identical.defunctClaimPay - identical.currentClaimPay, 75);
assert.equal(identical.claims.length, 0);
const lift = compareJob({ ...context, reference: { jobNumber: "1", start: "0800", finish: "1600" }, kilometres: km });
assert.ok(lift.claims.some(claim => claim.label === "Lift-up" && claim.minutes === 120));
assert.ok(lift.extraPay > identical.extraPay);
const noGain = compareJob({ ...context, reference: worked, kilometres: { currentKm: 80, defunctKm: 100 } });
assert.equal(noGain.extraKm, 0);
assert.equal(noGain.extraPay, 0);
assert.equal(noGain.recommendation, "tie");
const missing = compareJob({ ...context, reference: worked, kilometres: { currentKm: 100, defunctKm: null } });
assert.equal(missing.completeKm, false);
assert.equal(missing.extraKm, null);
assert.equal(missing.extraPay, 0);
assert.equal(missing.recommendation, "incomplete");
const guard = compareJob({ ...context, reference: worked, kilometres: km, role: "guard" });
assert.equal(guard.extraKm, null);
assert.equal(guard.extraPay, 0);
assert.equal(compareJob({ ...context, reference: null, kilometres: km }).bestPay, null);

for (const role of ["driver", "guard"]) {
  const load = path => hydrateReferenceMaster(JSON.parse(readFileSync(new URL(path, import.meta.url))));
  const master = load(`../data/masters/bundled/auburn-${role}.json`);
  const defunct = load(`../data/scenarios/auburn-${role}-defunct.json`);
  const rows = compareAsyJobs({ engine, master, defunct, role, rate: 50, start: "2026-11-15" });
  assert.ok(rows.length > 100);
  assert.ok(rows.every(row => row.extraPay === null || row.extraPay >= 0));
  assert.ok(rows.every(row => row.worked == null || row.worked.jobNumber === row.job));
  if (role === "guard") assert.ok(rows.every(row => row.kilometres === null && row.extraKm === null));
  else {
    const job = rows.find(row => row.job === "4021");
    assert.equal(job.kilometres.currentKm, 166.162);
    assert.equal(job.kilometres.defunctKm, 92.7);
    assert.equal(job.extraKm, 73.462);
    const zeroKmJob = rows.find(row => row.job === "11");
    assert.equal(zeroKmJob.kilometres.defunctKm, 0);
    assert.equal(zeroKmJob.completeKm, true);
    assert.equal(zeroKmJob.extraKm, zeroKmJob.kilometres.currentKm);
    assert.ok(rows.some(row => !row.completeKm));
  }
  console.log(`PASS ASY ${role} comparisons price current jobs only, preserve missing data and exclude line-based WOBOD and guarantee`);
}
console.log("PASS same-job time and kilometre comparisons use the shared engine without reversing worked/reference diagrams");
