export function breakdownEntries(breakdown) {
  const columns = Object.fromEntries(
    Object.entries(breakdown).map(([key, text]) => [
      key,
      text.split("\n").map(line => line.replace(/\.{2,}/g, "").trim()),
    ]),
  );
  return columns.details.map((label, index) => ({
    label: label === "undefined" ? "" : label,
    units: columns.units[index]?.replace(/:$/, "") || "",
    rate: columns.rates[index] || "",
    amount: columns.amounts[index] || "",
  }));
}

export function buildPayslip(result, rows) {
  const days = rows.map(row => ({ date: row.date, status: row.status, claims: [] }));
  const adjustments = [];
  let dayIndex = -1;
  let normalCents = 0;
  let normalHours = 0;
  let fortnightAdjustment = false;
  for (const entry of breakdownEntries(result.breakdown)) {
    if (!entry.label || entry.label === "Details" || entry.label === "Gross Pay:") continue;
    if (/^(SUN|MON|TUES|WED|THUR|FRI|SAT):/.test(entry.label)) {
      dayIndex++;
      continue;
    }
    const label = entry.label.replace(/:$/, "");
    const item = {
      label,
      hours: entry.units === "" ? null : Number(entry.units),
      rate: entry.rate === "" ? null : Number(entry.rate),
      amount: entry.amount === "" ? null : Number(entry.amount),
    };
    if (label === "Ordinary hours" || label === "Public holiday worked") {
      normalCents += Math.round(item.amount * 100);
      normalHours += item.hours;
      continue;
    }
    if (label === "ADO Adjustment") fortnightAdjustment = true;
    if (fortnightAdjustment) adjustments.push(item);
    else days[dayIndex].claims.push(item);
  }
  return {
    normalWorking: { hours: Math.round(normalHours * 100) / 100, amount: normalCents / 100 },
    days,
    adjustments,
    grossPay: result.grossPay,
  };
}
