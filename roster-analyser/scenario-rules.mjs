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

export function scenarioRulesText(value = {}) {
  const rules = scenarioRules(value);
  return `Defunct diagram comparison: ${rules.checkDefunctDiagram ? "on" : "off"}; defunct time/km on swaps: ${rules.allowDefunctSwaps ? "on" : "off"}; swapped defunct book-off WOBOD: ${rules.allowSwappedWobod ? "on" : "off"}.`;
}
