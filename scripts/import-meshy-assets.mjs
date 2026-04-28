import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const defaultIncoming = path.join(repoRoot, "incoming");
const unitsDir = path.join(repoRoot, "public", "assets", "units");
const sourceRoot = path.resolve(process.argv[2] ?? defaultIncoming);

function sanitizeName(name) {
  return name
    .replace(/\.glb$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".glb")) out.push(full);
  }
  return out;
}

function destinationName(file) {
  const parsed = path.parse(file);
  const parent = path.basename(parsed.dir);
  const raw =
    /^meshy(_ai)?(_model)?$/i.test(parsed.name) || /^model$/i.test(parsed.name) || /^scene$/i.test(parsed.name)
      ? parent
      : parsed.name;
  const safe = sanitizeName(raw);
  return `${safe || sanitizeName(parent) || "unit_import"}.glb`;
}

function uniqueDest(baseName) {
  let candidate = baseName;
  let i = 2;
  while (fs.existsSync(path.join(unitsDir, candidate))) {
    const parsed = path.parse(baseName);
    candidate = `${parsed.name}_${i}${parsed.ext}`;
    i++;
  }
  return candidate;
}

fs.mkdirSync(unitsDir, { recursive: true });
const glbs = walk(sourceRoot);
if (!glbs.length) {
  console.log(`No GLB files found under ${sourceRoot}`);
  process.exit(0);
}

const copied = [];
for (const src of glbs) {
  const destName = uniqueDest(destinationName(src));
  const dest = path.join(unitsDir, destName);
  fs.copyFileSync(src, dest);
  copied.push({ src, destName });
}

console.log(`Imported ${copied.length} GLB file(s):`);
for (const c of copied) console.log(`- ${path.relative(repoRoot, c.src)} -> public/assets/units/${c.destName}`);

const sync = spawnSync(process.execPath, [path.join(__dirname, "sync-unit-manifest.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (sync.status !== 0) process.exit(sync.status ?? 1);

const fixScript = path.join(__dirname, "fix-ext-texture-webp.mjs");
if (fs.existsSync(fixScript)) {
  const fix = spawnSync(process.execPath, [fixScript, unitsDir], { cwd: repoRoot, stdio: "inherit" });
  if (fix.status !== 0 && fix.status != null) {
    console.warn(
      `[import-meshy] fix-ext-texture-webp exited with code ${fix.status} (GLBs may still need manual repair)`,
    );
  }
} else {
  console.warn("[import-meshy] fix-ext-texture-webp.mjs not found, skipped");
}
