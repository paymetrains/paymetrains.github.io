// Sydney Trains and NSW TrainLink Enterprise Agreement 2025, clauses 140.4 and 140.7.
const StandaloneOvertime = {
  rate(day, shiftNumber) {
    if (day === "sat") return 2;
    if (day === "sun") return 2.5;
    if (shiftNumber <= 2) return 1.5;
    if (shiftNumber <= 4) return 2;
    throw new Error("Check the rate for this weekday overtime shift. The 2025 EA specifies weekday rates for the first four standalone overtime shifts.");
  },

  pay(row, baseRate, { details, units, rates, amounts }) {
    const hours = Number(row.timeWorkedInUnits);
    let total = 0;
    const lines = [
      [`Standalone overtime @ ${row.standaloneOvertimeRate * 100}%`, row.standaloneOvertimeRate],
      ["WOBOD @ 50%", 0.5],
    ];

    for (const [label, multiplier] of lines) {
      const hourlyRate = baseRate * multiplier;
      const amount = Math.round(hours * hourlyRate * 100) / 100;
      details.innerText += `${label}:\n`;
      units.innerText += `${hours.toFixed(2)}\n`;
      rates.innerText += `${hourlyRate.toFixed(2)}\n`;
      amounts.innerText += `${amount.toFixed(2)}\n`;
      total += amount;
    }
    return total;
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = StandaloneOvertime;
}
