(() => {
  const STORAGE_KEY = "rosterAnalyserPayPayload";

  const payload = readPayload();
  if (!payload) return;

  fillCalculator(payload);

  function readPayload() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      return null;
    }
  }

  function fillCalculator(payload) {
    const rows = Array.from(document.querySelectorAll("#timesheet .payRow"));
    const sortedRows = (payload.rows || [])
      .slice()
      .sort((a, b) => Number(a.dayIndex) - Number(b.dayIndex));

    clearCalculator(rows);
    const period = document.getElementById("payPeriodStart");
    if (period && sortedRows[0]?.date) {
      period.value = sortedRows[0].date;
      period.dispatchEvent(new Event("change"));
    }
    setFortnightType(payload, sortedRows);
    setBanner(payload, sortedRows);

    for (let index = 0; index < rows.length; index += 1) {
      fillTimesheetRow(rows[index], sortedRows[index], payload.version === 2);
    }
  }

  function clearCalculator(rows) {
    for (const row of rows) {
      clearRosterFlags(row);
      for (const input of row.querySelectorAll("input")) {
        if (input.type === "checkbox") {
          input.checked = false;
        } else {
          input.value = "";
        }
      }
    }

    for (const row of document.querySelectorAll(".dataRow")) {
      for (const cell of Array.from(row.querySelectorAll("td")).slice(1)) {
        cell.textContent = "";
      }
    }

    for (const id of ["payDetails", "unitDetails", "rateDetails", "amountDetails"]) {
      const element = document.getElementById(id);
      if (element) element.textContent = "";
    }
  }

  function setFortnightType(payload, rows) {
    const rosterType =
      payload.rosterType ||
      rows.find((row) => row.rosterType)?.rosterType ||
      (rows.find((row) => Number(row.rosteredShiftLimit))?.rosteredShiftLimit <= 9
        ? "short"
        : "long");
    const radio = document.getElementById(rosterType === "short" ? "short" : "long");
    if (radio) radio.checked = true;
  }

  function setBanner(payload, rows) {
    const banner = document.getElementById("rosterImportBanner");
    if (!banner) return;

    const title = document.getElementById("rosterImportTitle");
    const detail = document.getElementById("rosterImportDetail");
    const firstDate = rows[0]?.date || "";
    const lastDate = rows[rows.length - 1]?.date || "";
    const mileageCandidates =
      Number(payload.mileageCandidates) ||
      rows.filter((row) => row.mileageOver209Candidate).length;

    banner.hidden = false;
    title.textContent = `${payload.employeeName || "Selected employee"} - line ${payload.line}`;
    detail.textContent = `${formatDate(firstDate)} to ${formatDate(lastDate)} filled from roster analyser${
      mileageCandidates ? `, ${mileageCandidates} mileage check${mileageCandidates === 1 ? "" : "s"}` : ""
    }`;
  }

  function fillTimesheetRow(rowElement, row, importWobod) {
    if (!row) return;

    rowElement.classList.toggle("roster-mileage-candidate", Boolean(row.mileageOver209Candidate));
    const inputs = rowElement.querySelectorAll("input");
    const rosteredStart = row.rosteredStart || "";
    const actualStart = row.actualStart || "";
    const rosteredFinish = row.rosteredFinish || "";
    const actualFinish = row.actualFinish || "";

    if (row.status === "work") {
      setValue(inputs[0], rosteredStart);
      setValue(inputs[1], actualStart);
      setValue(inputs[2], rosteredFinish);
      setValue(inputs[3], actualFinish);
      setValue(inputs[10], row.timeWorked || "");
    } else if (row.status === "sick") {
      setValue(inputs[0], rosteredStart);
      setValue(inputs[1], "SICK");
      setValue(inputs[2], rosteredFinish);
    } else if (row.changeType === "annual_leave_as_hol") {
      setValue(inputs[0], /^\d{4}$/.test(rosteredStart) ? rosteredStart : "");
      setValue(inputs[1], "AL");
      setValue(inputs[2], rosteredFinish);
    } else if (row.status === "jury" || row.status === "seconded") {
      setValue(inputs[1], row.status === "jury" ? "JURY" : "SEC");
    } else if (row.status === "ph-taken") {
      setValue(inputs[1], "PH");
    } else if (row.status === "lsl" || row.status === "unpaid") {
      setValue(inputs[0], rosteredStart);
      setValue(inputs[1], row.status === "lsl" ? "LSL" : "LWOP");
      setValue(inputs[2], rosteredFinish);
    } else if (row.status === "hol") {
      setValue(inputs[0], "HOL");
    }

    setChecked(inputs[5], row.ph);
    setChecked(inputs[6], row.accruePh);
    setChecked(inputs[7], importWobod && row.wobod);
    setValue(inputs[9], row.extraKm || "");
    markMileageCandidate(inputs[4], row);
  }

  function clearRosterFlags(rowElement) {
    rowElement.classList.remove("roster-mileage-candidate");

    const inputs = rowElement.querySelectorAll("input");
    clearMileageCandidate(inputs[4]);
  }

  function setValue(input, value) {
    if (!input) return;
    input.value = value || "";
  }

  function setChecked(input, value) {
    if (!input) return;
    input.checked = Boolean(value);
  }

  function markMileageCandidate(input, row) {
    if (!input || !row?.mileageOver209Candidate) return;
    input.classList.add("input-caution");
    input.placeholder = "check";
    input.title = `Job ${row.jobNumber || ""} is marked over 209km. Only enter the 209km passed time if mileage should be paid.`;
  }

  function clearMileageCandidate(input) {
    if (!input) return;
    input.classList.remove("input-caution");
    input.removeAttribute("placeholder");
    input.removeAttribute("title");
  }

  function formatDate(isoDate) {
    if (!isoDate) return "";
    const [year, month, day] = isoDate.split("-");
    return `${day}-${month}-${year}`;
  }
})();
