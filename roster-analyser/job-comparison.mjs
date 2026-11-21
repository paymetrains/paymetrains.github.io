import { hydrateReferenceMaster } from "./master-store.mjs";
import { buildRosterJobReference } from "./roster-job-reference.mjs";
import { compareAsyJobs } from "./job-comparison-model.mjs";

const $ = id => document.getElementById(id);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = value => value == null ? "Not calculated" : Number(value).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const clock = value => value ? `${value.slice(0, 2)}:${value.slice(2)}` : "";
const km = value => value == null ? "Unknown km" : `${value.toLocaleString("en-AU", { maximumFractionDigits: 3 })} km`;
const updateGrades = window.PayEngine.bindRatePreset($("job-grade"), $("job-rate"));
const references = {};
let results = [];
let resultRole;

function recommendation(row) {
  if (row.issue) return "Comparison incomplete";
  if (row.recommendation === "incomplete") return row.defunctGain > 0
    ? `Defunct adds at least ${money(row.defunctGain)} · time only` : "Kilometre comparison incomplete";
  if (row.recommendation === "defunct") return `Defunct claim adds ${money(row.defunctGain)}`;
  if (row.recommendation === "current") return "Claim against current diagram is better";
  return "Same pay · keep current diagram";
}

function changeRole() {
  const role = $("job-role").value;
  updateGrades(role);
  $("job-grade").value = role === "driver" ? "Driver Thereafter" : "Guard Thereafter";
  $("job-grade").dispatchEvent(new Event("change"));
  $("job-sort").value = role === "driver" ? "km" : "pay";
  $("job-search").value = "";
  $("job-day").value = "all";
  $("job-sort").querySelector('option[value="km"]').disabled = role !== "driver";
  $("job-results").hidden = true;
}

async function json(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error("Could not load the ASY references. Refresh and try again.");
  return response.json();
}

async function load(role) {
  if (!references[role]) {
    const [current, old] = await Promise.all([json(`./data/masters/bundled/auburn-${role}.json`), json(`./data/scenarios/auburn-${role}-defunct.json`)]);
    const master = hydrateReferenceMaster(current);
    const defunct = hydrateReferenceMaster(old);
    master.rosterJobReference = buildRosterJobReference(master);
    defunct.rosterJobReference = buildRosterJobReference(defunct);
    references[role] = { master, defunct };
  }
  return references[role];
}

function render() {
  const query = $("job-search").value.trim().toUpperCase();
  const selectedDay = $("job-day").value;
  const sort = $("job-sort").value;
  const rows = results.filter(row => row.job.includes(query) && (selectedDay === "all" || row.days.includes(selectedDay)))
    .sort((a, b) => (sort === "km" ? (b.extraKm ?? -1) - (a.extraKm ?? -1) : sort === "pay" ? (b.extraPay ?? -1) - (a.extraPay ?? -1) : 0) || a.job.localeCompare(b.job, "en", { numeric: true }));
  $("job-count").textContent = `${rows.length} job/day comparisons shown. Open a job for its references and claims.`;
  $("job-list").innerHTML = rows.map(row => `<details class="job-result"><summary>
      <span><strong>Job ${escape(row.job)}</strong><small>${escape(row.days.join(", "))}</small></span>
      <span class="job-km">${resultRole === "driver" ? `${row.extraKm == null ? "Kilometres unavailable" : `${km(row.extraKm)} extra`}<small>Current ${km(row.kilometres?.currentKm)} · Defunct ${km(row.kilometres?.defunctKm)}</small>` : row.claims.map(claim => `${escape(claim.label)}${claim.minutes ? ` ${claim.minutes} min` : ""}`).join(" · ") || "No additional time claim"}</span>
      <span class="job-gain ${row.recommendation === "incomplete" ? "reference-missing" : row.recommendation === "tie" ? "claim-tie" : ""}"><strong>${recommendation(row)}</strong></span>
    </summary><div class="job-reference-pair">
      <div><h2>Defunct · reference</h2><p>${row.reference ? `${clock(row.reference.start)}–${clock(row.reference.finish)}` : "No unique times"}</p>${resultRole === "driver" ? `<p>${km(row.kilometres?.defunctKm)}</p>` : ""}<p>Claim value<br><strong>${money(row.defunctClaimPay)}${row.completeKm ? "" : " (time only)"}</strong></p><p class="hint">${row.referenceSource}</p></div>
      <div><h2>Current · worked</h2><p>${row.worked ? `${clock(row.worked.start)}–${clock(row.worked.finish)}` : "No unique times"}</p>${resultRole === "driver" ? `<p>${km(row.kilometres?.currentKm)}</p>` : ""}<p>Claim value<br><strong>${money(row.currentClaimPay)}</strong></p><p class="hint">${row.workedSource}</p></div>
    </div><ul class="job-claim-details">
      ${row.issue ? `<li class="reference-missing">${escape(row.issue)}</li>` : `<li>Claim against current diagram: ${money(row.currentClaimPay)}. Claim against defunct diagram: ${money(row.defunctClaimPay)}${row.completeKm ? "" : " (time only)"}.</li>
      ${row.claims.map(claim => `<li>${escape(claim.label)}${claim.minutes ? `: ${claim.minutes} minutes` : ""} against defunct job ${escape(row.job)}.</li>`).join("")}
      ${resultRole === "driver" ? `<li>${row.extraKm == null ? "Missing distance: kilometre pay is not included." : `${km(row.extraKm)} above the defunct job. Additional kilometre pay in the winning calculation: ${money(row.kilometrePay)}.`}</li>` : ""}`}
    </ul></details>`).join("") || '<p class="hint">No matching jobs.</p>';
}

$("comparison-form").onsubmit = async event => {
  event.preventDefault();
  $("job-run").disabled = true;
  $("job-status").textContent = "Comparing current jobs against their defunct references…";
  try {
    const role = $("job-role").value;
    const data = await load(role);
    results = compareAsyJobs({ ...data, engine: window.PayEngine, role, rate: Number($("job-rate").value), start: $("job-week").value });
    resultRole = role;
    $("job-summary").textContent = `${new Set(results.map(row => row.job)).size} current ${role} jobs · ${results.filter(row => row.extraPay > 0).length} job/day comparisons with extra pay · ${results.filter(row => row.issue).length} need a time reference${role === "driver" ? ` · ${results.filter(row => !row.completeKm).length} have incomplete kilometre data` : ""}.`;
    $("job-results").hidden = false;
    render();
    $("job-status").textContent = "Comparison complete. Current diagrams are always the worked jobs.";
  } catch (error) { $("job-results").hidden = true; $("job-status").textContent = error.message; }
  finally { $("job-run").disabled = false; }
};
$("job-role").onchange = changeRole;
$("comparison-form").addEventListener("input", () => {
  $("job-results").hidden = true;
  $("job-status").textContent = "Settings changed. Compare jobs to refresh the results.";
});
$("job-grade").addEventListener("change", () => { $("job-custom-rate").hidden = Boolean($("job-grade").value); });
for (const id of ["job-search", "job-day", "job-sort"]) $(id).addEventListener(id === "job-search" ? "input" : "change", render);
const today = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date()) + "T12:00:00Z");
today.setUTCDate(today.getUTCDate() - today.getUTCDay());
$("job-week").value = today.toISOString().slice(0, 10);
changeRole();
load("driver").then(() => { $("job-status").textContent = "ASY references ready. Choose your settings and compare jobs."; }).catch(error => { $("job-status").textContent = error.message; });
