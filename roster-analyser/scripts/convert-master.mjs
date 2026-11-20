// Owner-only publishing tool. User uploads never call this command.
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readPdf } from "../pdf-reader.mjs";
import { parseRoster } from "../roster-core.mjs";
import { serialiseMaster } from "../master-store.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    'node scripts/convert-master.mjs --input "master.pdf" --depot auburn --depot-name "Auburn Stabling Yard" --role guard --from 2026-11-01 [--to 2026-11-14] [--label "November master"]',
  );
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error("Arguments must be --name value pairs. Use --help.");
  options[args[i].slice(2)] = args[i + 1];
}
if (
  !options.input ||
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.depot || "") ||
  !["guard", "driver"].includes(options.role) ||
  !options.from
) {
  throw new Error(
    "Supply --input, --depot (lowercase slug), --role guard|driver, and --from YYYY-MM-DD.",
  );
}
const directory = fileURLToPath(new URL("../data/masters/", import.meta.url));
const manifestPath = resolve(directory, "index.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const input = resolve(options.input);
const bytes = await readFile(input);
const parsed = parseRoster(
  await readPdf({
    name: basename(input),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }),
  "master",
);
const master = serialiseMaster(parsed, {
  depot: options.depot,
  role: options.role,
  effectiveFrom: options.from,
  effectiveTo: options.to || null,
  label: options.label || `${options.role} master`,
});
const overlaps = manifest.masters.filter(
  (entry) =>
    entry.depot === master.depot &&
    entry.role === master.role &&
    (!entry.effectiveTo || entry.effectiveTo >= master.effectiveFrom) &&
    (!master.effectiveTo || master.effectiveTo >= entry.effectiveFrom),
);
if (overlaps.length)
  throw new Error(
    "This effective range overlaps a published master. Correct the catalogue dates before publishing.",
  );
const fileName = `${master.depot}-${master.role}-${master.effectiveFrom}.json`;
const output = resolve(directory, fileName);
if (!manifest.depots.some((depot) => depot.id === master.depot)) {
  if (!options["depot-name"])
    throw new Error("A new depot also needs --depot-name.");
  manifest.depots.push({ id: master.depot, name: options["depot-name"] });
}
manifest.masters.push({
  depot: master.depot,
  role: master.role,
  effectiveFrom: master.effectiveFrom,
  effectiveTo: master.effectiveTo,
  label: master.label,
  path: fileName,
});
await mkdir(dirname(output), { recursive: true });
// Exclusive creation prevents accidental replacement of an existing published master.
await writeFile(output, JSON.stringify(master, null, 2) + "\n", { flag: "wx" });
const pending = manifestPath + `.pending-${process.pid}`;
try {
  await writeFile(pending, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  await rename(pending, manifestPath);
} catch (error) {
  await rm(output);
  await rm(pending, { force: true });
  throw error;
}
console.log(`Published ${master.rows.length} lines to ${output}`);
console.log(
  `Updated ${manifestPath}. Verify depot, role, effective dates, and extracted values before deployment.`,
);
