import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const defaultIncoming = path.join(repoRoot, "incoming");
const unitsDir = path.join(repoRoot, "public", "assets", "units");

const args = process.argv.slice(2).filter((a) => a !== "--optimize");
const optimizeBeforeImport = process.argv.includes("--optimize");
const sourceRoot = path.resolve(args[0] ?? defaultIncoming);

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

function gltfTransformBin() {
  const isWin = process.platform === "win32";
  const p = path.join(repoRoot, "node_modules", ".bin", isWin ? "gltf-transform.cmd" : "gltf-transform");
  return fs.existsSync(p) ? p : null;
}

/** Draco + WebP — matches runtime loaders in src/render/glbPool.ts (no Meshopt). */
function optimizeToTemp(srcPath) {
  const bin = gltfTransformBin();
  if (!bin) {
    console.error("[import-meshy] --optimize requires @gltf-transform/cli (npm install).");
    process.exit(1);
  }
  const tmp = path.join(os.tmpdir(), `meshy-import-${process.pid}-${Math.random().toString(36).slice(2)}.glb`);
  const textureSize = process.env.GLTF_TEXTURE_SIZE || "2048";
  const r = spawnSync(
    bin,
    [
      "optimize",
      srcPath,
      tmp,
      "--compress",
      "draco",
      "--texture-compress",
      "webp",
      "--texture-size",
      String(textureSize),
    ],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (r.status !== 0) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    process.exit(r.status ?? 1);
  }
  return tmp;
}

fs.mkdirSync(unitsDir, { recursive: true });
const glbs = walk(sourceRoot);
if (!glbs.length) {
  console.log(`No GLB files found under ${sourceRoot}`);
  process.exit(0);
}

const copied = [];
for (const src of glbs) {
  let copyFrom = src;
  let tmpOpt = null;
  if (optimizeBeforeImport) {
    tmpOpt = optimizeToTemp(src);
    copyFrom = tmpOpt;
  }
  try {
    const destName = uniqueDest(destinationName(src));
    const dest = path.join(unitsDir, destName);
    fs.copyFileSync(copyFrom, dest);
    copied.push({ src, destName });
  } finally {
    if (tmpOpt && fs.existsSync(tmpOpt)) fs.unlinkSync(tmpOpt);
  }
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
