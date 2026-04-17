import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const unitsDir = path.join(__dirname, "..", "public", "assets", "units");

const files = fs
  .readdirSync(unitsDir)
  .filter((f) => f.endsWith(".glb"))
  .sort();

const out = path.join(unitsDir, "manifest.json");
fs.writeFileSync(out, `${JSON.stringify({ files }, null, 2)}\n`, "utf8");
console.log(`Wrote ${out} (${files.length} GLB)`);
