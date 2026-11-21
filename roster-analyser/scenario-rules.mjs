export function scenarioRules(value = {}) {
  return {
    checkDefunctDiagram: value.checkDefunctDiagram === true,
    allowDefunctSwaps: value.allowDefunctSwaps === true,
  };
}

export function canClaimDefunct(row, rules) {
  return !row.swapLines?.length || rules.allowDefunctSwaps;
}

export function scenarioRulesText(value = {}) {
  const rules = scenarioRules(value);
  return `Defunct diagram comparison: ${rules.checkDefunctDiagram ? "on" : "off"}; defunct claims on swaps: ${rules.allowDefunctSwaps ? "on" : "off"}.`;
}
