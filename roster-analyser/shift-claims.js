// Used by the module-based roster importer and the classic browser pay engine.
(() => {
  function minute(time, finish = false) {
    if (time === "2400" && finish) return 1440;
    if (!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(time || "")) return NaN;
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(2));
  }

  function compare(row, alignment = "same-date") {
    const actual = minute(row.actualStart);
    const worked = (minute(row.actualFinish, true) - actual + 1440) % 1440 || 0;
    let scheduled = minute(row.rosteredStart);
    const planned = (minute(row.rosteredFinish, true) - scheduled + 1440) % 1440;
    let credit = null;
    if (worked && planned && !row.timedRelinquishment && (!row.status || row.status === "work")) {
      if (alignment === "nearest") {
        if (scheduled - actual > 720) scheduled -= 1440;
        if (actual - scheduled > 720) scheduled += 1440;
      }
      const lateStart = actual - scheduled;
      const earlyFinish = scheduled + planned - (actual + worked);
      if (lateStart >= 0 && earlyFinish >= 0 && lateStart + earlyFinish > 0)
        credit = { label: "Build-up", before: lateStart, after: earlyFinish, field: "buildupAsUnits" };
      else if (lateStart > 0 && earlyFinish < 0)
        credit = { label: "Lay-back", before: lateStart, after: 0, field: "laybackAsUnits" };
      else if (lateStart < 0 && earlyFinish > 0)
        credit = { label: "Lift-up", before: 0, after: earlyFinish, field: "liftupAsUnits" };
    }
    return { workedMinutes: worked, credit };
  }

  const api = { compare };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.RosterShiftClaims = api;
})();
