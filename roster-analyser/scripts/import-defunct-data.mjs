import { readFile, writeFile, readdir, mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Import locally supplied/downloaded JSON only. No credentials or remote requests are used.
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(process.argv[2] || "tmp/defunct-data-import");
const output = resolve(app, "data/scenarios");
const read = async path => JSON.parse(await readFile(path, "utf8"));
const held = await read(resolve(input, "defunct-held.json"));
const manifest = await read(resolve(input, "manifest.json"));
const progress = await read(resolve(input, "progress.json"));
const files = await readdir(input);
const retrievedAt = progress.retrievedAt;
const clock = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const length = (start, finish) => {
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const diff = minutes(finish) - minutes(start);
  return (diff > 0 ? diff : diff + 1440) / 60;
};
const catalogue = { schemaVersion: 1, retrievedAt, source: "https://wobod.me", masters: [], missingMasters: [], diagramImportStatus: "partial", importStopped: progress.stopped };
await mkdir(output, { recursive: true });
const backup = resolve(app, "../archive/defunct-reference-before-import");
await mkdir(backup, { recursive: true });
for (const role of ["driver", "guard"]) {
  const name = `auburn-${role}-defunct.json`;
  try { await copyFile(resolve(output, name), resolve(backup, name), 1); }
  catch (error) { if (!["EEXIST", "ENOENT"].includes(error.code)) throw error; }
}
for (const depot of manifest.depots) for (const role of held[depot.id] || []) {
  const id = depot.id.replaceAll("_", "-");
  const stem = `${id}-${role}`;
  const name = `${stem}-defunct.json`;
  if (!files.includes(`${stem}-master.json`)) {
    catalogue.missingMasters.push({ depot: id, role });
    continue;
  }
  const raw = await read(resolve(input, `${stem}-master.json`));
  const masterRoster = {};
  for (const [line, cells] of Object.entries(raw)) {
    if (!/^[1-9]\d*$/.test(line) || !Array.isArray(cells) || cells.length !== 14) throw new Error(`${stem}: invalid line ${line}`);
    masterRoster[line] = cells.map(cell => {
      const job = String(cell.job || "");
      if (!cell.start && !cell.finish) return { job: job === "NR" ? "OFF" : job, ...(job === "NR" ? { sourceJob: job } : {}) };
      if (!clock(cell.start) || !clock(cell.finish)) throw new Error(`${stem}: invalid time on line ${line}`);
      return { job, start: cell.start, finish: cell.finish };
    });
  }
  const lookup = files.includes(`${stem}-diagrams.json`) ? await read(resolve(input, `${stem}-diagrams.json`)) : { km: {}, times: {}, notCounted: {}, flagged: {}, rosteredStandby: [] };
  const diagramData = {};
  for (const [job, times] of Object.entries(lookup.times || {})) {
    if (!Array.isArray(times) || !clock(times[0]) || !clock(times[1])) throw new Error(`${stem}: invalid diagram ${job}`);
    const notCounted = lookup.notCounted?.[job];
    const hasKm = Object.hasOwn(lookup.km || {}, job) && !notCounted;
    const km = hasKm ? lookup.km[job] : null;
    if (hasKm && (typeof km !== "number" || !Number.isFinite(km) || km < 0)) throw new Error(`${stem}: invalid kilometres for ${job}`);
    diagramData[job] = {
      dayPattern: "Sun-Sat", dayPatternSource: "not-specified-by-source",
      signOn: times[0], offDuty: times[1], rosteredHrs: length(times[0], times[1]),
      ...(hasKm ? { rosteredKm: km } : {}),
      kilometresStatus: notCounted ? "not-counted" : hasKm ? "known" : "unavailable",
      ...(notCounted ? { kilometresReason: notCounted } : {}),
      sourceFlag: lookup.flagged?.[job] || null,
      rosteredStandby: (lookup.rosteredStandby || []).includes(job),
      referenceSource: "imported-defunct-diagram",
    };
  }
  const record = progress.datasets.find(item => item.depot === id && item.role === role);
  const manualName = `${stem}-manual-kilometres.json`;
  const manual = await read(resolve(output, manualName)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const kilometreData = {};
  for (const [job, km] of Object.entries(manual?.kilometres || {})) {
    if (typeof km !== "number" || !Number.isFinite(km) || km < 0) throw new Error(`${stem}: invalid manual kilometres for ${job}`);
    kilometreData[job] = { rosteredKm: km, kilometresStatus: "known", referenceSource: "owner-supplied", providedOn: manual.providedOn };
  }
  const photoName = `${stem}-photo-diagrams.json`;
  const photos = await read(resolve(output, photoName)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const photoEntries = Object.entries(photos?.diagrams || {});
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const printedMinutes = value => {
    if (typeof value !== "string" || !/^\d{1,2}:[0-5]\d$/.test(value)) throw new Error(`${stem}: invalid printed clock ${value}`);
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const normalClock = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  if (photos && (photos.schemaVersion !== 1 || photos.depot !== id || photos.role !== role)) throw new Error(`${stem}: invalid photo reference`);
  for (const [job, photo] of photoEntries) {
    const start = printedMinutes(photo.signOn), finish = printedMinutes(photo.signOff), duration = printedMinutes(photo.duration);
    if (!/^\d+$/.test(job) || start >= 1440 || duration <= 0 || duration >= 1440 || finish - start !== duration ||
        typeof photo.rosteredKm !== "number" || !Number.isFinite(photo.rosteredKm) || photo.rosteredKm < 0 || !photo.sourcePhoto)
      throw new Error(`${stem}: invalid photographed diagram ${job}`);
    if (!photo.days || !photo.days.split(",").every(pattern => {
      const [first, last = first] = pattern.split("-").map(day => weekdayNames.indexOf(day));
      return first >= 0 && last >= first;
    })) throw new Error(`${stem}: invalid photographed operating days for ${job}`);
    diagramData[job] = { ...diagramData[job], dayPattern: photo.days, dayPatternSource: "owner-photo",
      signOn: normalClock(start), offDuty: normalClock(finish), offDutyDayOffset: Math.floor(finish / 1440),
      rosteredHrs: duration / 60, rosteredKm: photo.rosteredKm, kilometresStatus: "known",
      referenceSource: "owner-supplied-photo", sourcePhoto: photo.sourcePhoto, providedOn: photos.providedOn,
      printedSignOn: photo.signOn, printedSignOff: photo.signOff, printedDuration: photo.duration,
      ...(photo.marker ? { sourceMarker: photo.marker } : {}),
    };
    delete diagramData[job].kilometresReason;
    // Newer photographic evidence supersedes the earlier manual/source lookup.
    kilometreData[job] = { rosteredKm: photo.rosteredKm, kilometresStatus: "known", referenceSource: "owner-supplied-photo", providedOn: photos.providedOn, sourcePhoto: photo.sourcePhoto };
  }
  const numericJobs = new Set([...Object.values(masterRoster).flat().map(cell => cell.job.replace(/\(i\)$/i, "")), ...Object.keys(diagramData)].filter(job => /^\d+$/.test(job)));
  const missingNumericKilometres = [...numericJobs].filter(job => typeof (kilometreData[job]?.rosteredKm ?? diagramData[job]?.rosteredKm) !== "number");
  const coverage = {
    status: record?.diagramsComplete ? "complete-for-requested-jobs" : Object.keys(diagramData).length ? "partial" : "not-downloaded",
    requestedJobs: record?.requestedJobs ?? null, queriedJobs: record?.loadedJobs ?? 0,
    diagramTimes: Object.keys(diagramData).length,
    kilometreEntries: new Set([...Object.keys(diagramData).filter(job => diagramData[job].kilometresStatus === "known"), ...Object.keys(kilometreData)]).size,
    ...(manual ? { manualKilometreEntries: Object.keys(manual.kilometres).length } : {}),
    ...(photos ? { photoDiagrams: photoEntries.length, numericJobs: numericJobs.size, missingNumericKilometres, numericKilometresComplete: missingNumericKilometres.length === 0,
      importedDiagramTimes: Object.keys(lookup.times || {}).length, sourceNotCountedEntries: Object.keys(lookup.notCounted || {}).length } : {}),
    notCountedEntries: Object.entries(diagramData).filter(([job, diagram]) => diagram.kilometresStatus === "not-counted" && !kilometreData[job]).length,
  };
  const value = {
    schemaVersion: 1, source: "bundled", depot: id, role,
    label: `${depot.label} defunct ${role} master`, fileName: `${depot.label} defunct ${role} master (imported reference)`,
    provenance: { source: "https://wobod.me", masterUrl: `https://wobod.me/defunct/${depot.id}/${role}.json`, diagramEndpoint: "https://wobod.me/api/defunct/diagrams", retrievedAt,
      ...(photos ? { diagramPhotos: { reference: photos.reference, providedOn: photos.providedOn, files: [...new Set(photoEntries.map(([,photo]) => photo.sourcePhoto))] } } : {}) },
    diagramCoverage: coverage,
    ...(id === "penrith" && role === "guard" ? { lineAliases: { "229": "301", "230": "302" } } : {}),
    masterRoster, diagramData, ...(manual ? { kilometreData } : {}),
  };
  // Auburn's owner-supplied PDFs remain the line-assignment baseline. Imported
  // diagrams supplement them; they do not replace those master roster cells.
  if (id === "auburn") {
    const original = await read(resolve(backup, name));
    value.masterRoster = original.masterRoster;
    value.label = original.label;
    value.fileName = original.fileName;
    value.provenance.masterReference = { source: "owner-supplied", fileName: original.fileName };
  }
  await writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n");
  catalogue.masters.push({ depot: id, role, path: name, lines: Object.keys(masterRoster).length, diagramCoverage: coverage });
}
await writeFile(resolve(output, "index.json"), JSON.stringify(catalogue, null, 2) + "\n");
console.log(JSON.stringify({ masters: catalogue.masters.length, lines: catalogue.masters.reduce((sum, item) => sum + item.lines, 0), diagrams: catalogue.masters.reduce((sum, item) => sum + item.diagramCoverage.diagramTimes, 0), kilometreEntries: catalogue.masters.reduce((sum, item) => sum + item.diagramCoverage.kilometreEntries, 0), missingMasters: catalogue.missingMasters }, null, 2));
