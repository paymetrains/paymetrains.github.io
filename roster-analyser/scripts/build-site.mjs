import { readdir, readFile, writeFile, mkdtemp, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = await readdir(app, { withFileTypes: true });
const files = entries.filter(entry => entry.isFile() && [".html", ".js", ".mjs", ".css", ".svg"].includes(extname(entry.name))).map(entry => entry.name).sort();
const contents = await Promise.all(files.map(async name => [name, await readFile(join(app, name), "utf8")]));
const hash = createHash("sha256");
for (const [name, text] of contents) hash.update(name).update(text);
const version = hash.digest("hex").slice(0, 16);
const destination = await mkdtemp(join(tmpdir(), "roster-pay-site-"));
for (const [name, text] of contents) {
  const output = [".html", ".js", ".mjs"].includes(extname(name))
    ? text.replace(/(["'])(\.\/[^"'\s]+?\.(?:m?js|css))(?:\?[^"'\s]*)?\1/g, (_, quote, asset) => `${quote}${asset}?v=${version}${quote}`)
    : text;
  await writeFile(join(destination, name), output);
}
for (const name of ["data", "vendor", "roster-analyser"]) await cp(join(app, name), join(destination, name), { recursive: true });
// GitHub Actions consumes this output; the directory contains only runtime files.
console.log(`directory=${destination}`);
