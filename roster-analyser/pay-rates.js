const TrainCrewRates = (() => {
  // Signed 2025 EA, Schedules 1B and 4B. Select by pay period commencement (cl 11).
  const periods = [
    { from: "2024-05-01", early: 4.65, afternoon: 4.65, night: 5.47, special: 5.47, meal: 14, leaveCap: 165189 },
    { from: "2025-07-01", early: 4.84, afternoon: 4.84, night: 5.69, special: 5.69, meal: 14.55, leaveCap: 171797 },
    { from: "2026-07-01", early: 5.03, afternoon: 5.03, night: 5.92, special: 5.92, meal: 15.15, leaveCap: 179549 },
    { from: "2027-07-01", early: 5.23, afternoon: 5.23, night: 6.16, special: 6.16, meal: 15.75, leaveCap: 186731 },
  ];

  // Fixed hourly presets, verified 9 November 2026.
  const hourlyRates = {
    "Driver 1 Year Trainee": 47.95921,
    "Driver 1 Year Competent": 48.9,
    "Driver 2nd Year": 51.10789,
    "Driver Thereafter": 52.23026,
    "Driver Trainer": 58.04211,
    "Principal Driver": 60.01184,
    "Guard 1 Year Trainee": 42.88158,
    "Guard 1 Year Completion": 44.23553,
    "Guard 2nd Year": 44.89737,
    "Guard Thereafter": 45.87895,
    "Guard Trainer": 51.76316,
    "Principal Guard": 53.57763,
  };

  function periodIndex(startDate) {
    const date = startDate || new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
    return Math.max(0, periods.findLastIndex(period => period.from <= date));
  }

  return {
    classifications(role) {
      const name = role === "guard" ? "Guard" : "Driver";
      return Object.keys(hourlyRates).filter(classification => classification.includes(name));
    },
    hourlyRate(classification) {
      return Object.hasOwn(hourlyRates, classification) ? hourlyRates[classification] : null;
    },
    forPeriod(startDate) {
      return periods[periodIndex(startDate)];
    },
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TrainCrewRates;
