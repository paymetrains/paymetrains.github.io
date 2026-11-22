export function scenarioRules(value = {}) {
  return {
    checkDefunctDiagram: value.checkDefunctDiagram === true,
    allowDefunctSwaps: value.allowDefunctSwaps === true,
    allowSwappedWobod: value.allowSwappedWobod !== false,
  };
}

export function canClaimDefunct(row, rules) {
  return !row.swapLines?.length || rules.allowDefunctSwaps;
}

// WS identifies a partner, not the crew member's complete pre-swap roster.
// Current-master assignments are an initial indication; a confirmed type wins.
export function swapClassification(row, selected = "auto") {
  if (!["auto", "work-for-work", "moves-day-off", "unknown"].includes(selected))
    throw new Error(`${row.date}: choose a recognised swap type.`);
  if (!row.swapLines?.length) return null;
  const originals = [row.workSwap?.original, ...(row.workSwap?.partners || []).map(partner => partner.original)];
  const off = originals.some(cell => ["OFF", "ADO", "NTA"].includes(cell?.status));
  const working = originals.length > 1 && originals.every(cell => cell?.status === "WORK" && cell.start && cell.finish);
  const inferredType = off ? "moves-day-off" : working ? "work-for-work" : "unknown";
  return { type: selected === "auto" ? inferredType : selected, inferredType, selected, source: selected === "auto" ? "current-master-indication" : "user" };
}

export function scenarioRulesText(value = {}) {
  const rules = scenarioRules(value);
  return `Defunct diagram comparison: ${rules.checkDefunctDiagram ? "on" : "off"}; defunct time/km on swaps: ${rules.allowDefunctSwaps ? "on" : "off"}; work-for-work swap WOBOD: ${rules.allowSwappedWobod ? "on" : "off"} (day-off moves excluded).`;
}
