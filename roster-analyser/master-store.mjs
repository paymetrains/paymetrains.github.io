import { buildJobDictionary, parseCell } from "./roster-core.mjs";

export function serialiseMaster(parsed, metadata) {
  const rows = parsed.rows.map(({ line, cells }) => ({ line, cells }));
  return validateMaster({
    schemaVersion: 1,
    ...metadata,
    fileName: parsed.fileName,
    rows,
  });
}

export function validateMaster(value) {
  if (
    value?.schemaVersion !== 1 ||
    !value.depot ||
    !["guard", "driver"].includes(value.role)
  ) {
    throw new Error(
      "This master JSON has an unsupported format, depot, or role.",
    );
  }
  for (const key of ["effectiveFrom", "effectiveTo"]) {
    if (value[key] && !isIsoDate(value[key]))
      throw new Error(`Invalid master ${key}.`);
  }
  if (
    !value.effectiveFrom ||
    (value.effectiveTo && value.effectiveTo < value.effectiveFrom)
  ) {
    throw new Error("The master needs a valid effective date range.");
  }
  if (!Array.isArray(value.rows) || !value.rows.length)
    throw new Error("The master has no roster lines.");
  const lines = new Set();
  const statuses = new Set([
    "WORK",
    "HOL",
    "ADO",
    "NTA",
    "OFF",
    "AL",
    "SL",
    "LSL",
    "LWOP",
    "PH",
    "BLANK",
  ]);
  for (const row of value.rows) {
    if (
      !Number.isInteger(row.line) ||
      row.line <= 0 ||
      lines.has(row.line) ||
      row.cells?.length !== 14
    ) {
      throw new Error(
        "Master lines must be unique numbers with 14 daily cells.",
      );
    }
    lines.add(row.line);
    row.cells.forEach((cell, index) => {
      if (
        !cell ||
        cell.dayIndex !== index ||
        !statuses.has(cell.status) ||
        !Array.isArray(cell.leaveCodes)
      ) {
        throw new Error(`Invalid cell on master line ${row.line}.`);
      }
      if (
        cell.status === "WORK" &&
        (!isClock(cell.start) || !isClock(cell.finish))
      ) {
        throw new Error(`Invalid work times on master line ${row.line}.`);
      }
    });
  }
  if (
    !value.rows.some((row) => row.cells.some((cell) => cell.status === "WORK"))
  ) {
    throw new Error("The master has no recognised work shifts.");
  }
  return value;
}

export function hydrateMaster(value) {
  validateMaster(value);
  return buildMaster(value, value.rows);
}

export function hydrateReferenceMaster(value) {
  if (value?.schemaVersion !== 1 || !value.depot ||
      !["guard", "driver"].includes(value.role) || !value.masterRoster || !value.diagramData) {
    throw new Error("This Bundled reference has an unsupported format.");
  }
  const rows = Object.entries(value.masterRoster).map(([line, days]) => {
    if (!/^[1-9]\d*$/.test(line) || !Array.isArray(days) || days.length !== 14)
      throw new Error(`Invalid bundled master roster line ${line}.`);
    const cells = days.map(({ job, start, finish }, dayIndex) => {
      const cell = parseCell(start && finish ? `${start} - ${finish} ${job}` : job, dayIndex);
      if (start || finish) {
        if (!isClock(cell.start) || !isClock(cell.finish))
          throw new Error(`Invalid bundled work times on line ${line}.`);
        cell.jobNumber = job.replace(/\(i\)$/i, "");
        cell.mileageOver209Candidate = /\(i\)$/i.test(job);
      }
      return cell;
    });
    return { line: Number(line), cells };
  });
  if (!rows.length) throw new Error("The Bundled reference has no roster lines.");
  return buildMaster(value, rows);
}

function buildMaster(value, savedRows) {
  const rows = savedRows.map((row) => ({
    ...row,
    source: "master",
    employeeName: "",
  }));
  return {
    ...value,
    source: value.masterRoster && value.diagramData ? "bundled" : "master",
    rows,
    lines: new Map(rows.map((row) => [row.line, row])),
    dates: [],
    pages: [],
    jobDictionary: buildJobDictionary(rows),
  };
}

export function selectMaster(entries, depot, role, start, end) {
  const matches = entries.filter(
    (entry) =>
      entry.depot === depot &&
      entry.role === role &&
      entry.effectiveFrom <= start &&
      (!entry.effectiveTo || entry.effectiveTo >= end),
  );
  if (matches.length > 1)
    throw new Error(
      "More than one master covers this fortnight. Upload the correct master for this session.",
    );
  return matches[0] || null;
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function isClock(value) {
  return /^(?:[01]\d|2[0-3])[0-5]\d$/.test(value || "");
}
