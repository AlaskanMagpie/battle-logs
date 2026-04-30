/**
 * Dev-time GLB optimization (same stack as https://optimizeglb.com/ — gltf-transform).
 *
 * Uses Draco mesh compression + WebP textures so output loads with the game's existing
 * GLTFLoader + DRACOLoader (see src/render/glbPool.ts). Skips Meshopt GPU compression
 * (would require MeshoptDecoder wiring in Three.js).
 *
 * Usage:
 *   node scripts/optimize-glb.mjs <file.glb> [more.glb ...]
 *   node scripts/optimize-glb.mjs --dir incoming
 *   node scripts/optimize-glb.mjs --dir public/assets/units --overwrite
 *
 * Env:
 *   GLTF_TEXTURE_SIZE=2048   max texture dimension (default 2048)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function gltfTransformBin() {
  const isWin = process.platform === "win32";
  const p = path.join(repoRoot, "node_modules", ".bin", isWin ? "gltf-transform.cmd" : "gltf-transform");
  if (!fs.existsSync(p)) {
    console.error("Missing gltf-transform CLI. Run: npm install");
    process.exit(1);
  }
  return p;
}

function walkGlbs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walkGlbs(full));
    else if (st.isFile() && name.toLowerCase().endsWith(".glb")) out.push(full);
  }
  return out;
}

function runOptimize(inputPath, outputPath) {
  const bin = gltfTransformBin();
  const textureSize = process.env.GLTF_TEXTURE_SIZE || "2048";
  const args = [
    "optimize",
    inputPath,
    outputPath,
    "--compress",
    "draco",
    "--texture-compress",
    "webp",
    "--texture-size",
    String(textureSize),
  ];
  const r = spawnSync(bin, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    process.exit(r.status ?? 1);
  }
}

const argv = process.argv.slice(2);
if (!argv.length) {
  console.log(`Usage:
  node scripts/optimize-glb.mjs <file.glb> [...]
  node scripts/optimize-glb.mjs --dir incoming
  node scripts/optimize-glb.mjs --dir public/assets/units --overwrite
`);
  process.exit(1);
}

let overwrite = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--overwrite") overwrite = true;
  else if (a === "--dir") {
    const d = argv[++i];
    if (!d) {
      console.error("--dir needs a path");
      process.exit(1);
    }
    files.push(...walkGlbs(path.isAbsolute(d) ? d : path.join(repoRoot, d)));
  } else if (!a.startsWith("--")) {
    files.push(path.isAbsolute(a) ? a : path.join(repoRoot, a));
  }
}

const unique = [...new Set(files)].filter((f) => fs.existsSync(f));
if (!unique.length) {
  console.error("No .glb files matched.");
  process.exit(1);
}

for (const inputPath of unique) {
  const before = fs.statSync(inputPath).size;
  if (overwrite) {
    const tmp = `${inputPath}.tmp-opt.glb`;
    runOptimize(inputPath, tmp);
    fs.renameSync(tmp, inputPath);
    const after = fs.statSync(inputPath).size;
    console.log(
      `[optimize-glb] ${path.relative(repoRoot, inputPath)} (in place) ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`,
    );
  } else {
    const outPath = inputPath.replace(/\.glb$/i, ".optimized.glb");
    runOptimize(inputPath, outPath);
    const after = fs.statSync(outPath).size;
    console.log(
      `[optimize-glb] ${path.relative(repoRoot, inputPath)} -> ${path.relative(repoRoot, outPath)} ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`,
    );
  }
}
