import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { bufferForThreeGlbLoader } from "./glbNodeTextureDecode.mjs";

globalThis.self ??= globalThis;
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...args) => {
  if (args.map(String).join(" ").includes("Couldn't load texture blob:nodedata")) return;
  originalWarn(...args);
};
console.error = (...args) => {
  if (args.map(String).join(" ").includes("Couldn't load texture blob:nodedata")) return;
  originalError(...args);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const unitsDir = path.join(__dirname, "..", "public", "assets", "units");
const manifestPath = path.join(unitsDir, "manifest.json");
const loader = new GLTFLoader();

function printUsage() {
  console.log(`Usage:
  node scripts/inspect-unit-glbs.mjs
  node scripts/inspect-unit-glbs.mjs --only <pattern> [--only <pattern2> ...]
  node scripts/inspect-unit-glbs.mjs --profile <animationProfileId>

Patterns (--only): substring match on .glb basename (case-insensitive).
If a pattern contains * or ?, it is a glob matched against the full basename.

Examples:
  npm run assets:inspect-glbs:only -- lanternbound
  npm run assets:inspect-glbs:only -- "lanternbound_line_*.glb"
  npm run assets:inspect-glbs:profile -- amber_geode_monks
`);
}

function globToRegExp(pattern) {
  let s = "";
  for (const c of pattern) {
    if (c === "*") s += ".*";
    else if (c === "?") s += ".";
    else s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${s}$`, "i");
}

/** @param {string} file manifest entry */
/** @param {string} pattern user pattern */
function fileMatchesPattern(file, pattern) {
  const base = path.basename(file);
  if (pattern.includes("*") || pattern.includes("?")) {
    try {
      return globToRegExp(pattern).test(base);
    } catch {
      return false;
    }
  }
  return base.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * @param {string[]} manifestFiles
 * @param {string[]} onlyPatterns
 */
function filterFilesByOnly(manifestFiles, onlyPatterns) {
  if (!onlyPatterns.length) return manifestFiles;
  return manifestFiles.filter((file) => onlyPatterns.some((p) => fileMatchesPattern(file, p)));
}

/**
 * @param {object} manifest
 * @param {string[]} profileArgs
 * @returns {{ files: Set<string>, matchedProfiles: object[] }}
 */
function collectFilesForProfiles(manifest, profileArgs) {
  const files = new Set();
  const profiles = manifest.animationProfiles ?? [];
  const matchedProfiles = [];

  for (const arg of profileArgs) {
    const exact = profiles.filter((p) => p.id === arg);
    const use = exact.length ? exact : profiles.filter((p) => typeof p.id === "string" && p.id.includes(arg));
    for (const p of use) {
      if (!matchedProfiles.includes(p)) matchedProfiles.push(p);
      for (const f of p.files ?? []) {
        if (typeof f === "string") files.add(f);
      }
      for (const v of Object.values(p.roles ?? {})) {
        if (typeof v === "string") files.add(v);
      }
    }
  }

  return { files, matchedProfiles };
}

function parseArgs(argv) {
  /** @type {string[]} */
  const only = [];
  /** @type {string[]} */
  const profiles = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--only") {
      const p = argv[++i];
      if (!p) {
        console.error("--only needs a pattern");
        process.exit(1);
      }
      only.push(p);
    } else if (a === "--profile") {
      const p = argv[++i];
      if (!p) {
        console.error("--profile needs an animationProfiles id");
        process.exit(1);
      }
      profiles.push(p);
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(1);
    }
    i += 1;
  }
  return { only, profiles };
}

function movingTrackCount(clip) {
  let moving = 0;
  for (const track of clip.tracks) {
    if (!/\.(position|quaternion|rotation)$/i.test(track.name)) continue;
    if (track.times.length < 2) continue;
    const size = typeof track.getValueSize === "function" ? track.getValueSize() : 1;
    let changed = false;
    for (let j = size; j < track.values.length && !changed; j++) {
      if (Math.abs(track.values[j] - track.values[j % size]) > 1e-5) changed = true;
    }
    if (changed) moving++;
  }
  return moving;
}

async function inspect(file) {
  const buf = await bufferForThreeGlbLoader(fs.readFileSync(path.join(unitsDir, file)));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(ab, "", resolve, reject));
  let skinned = 0;
  let bones = 0;
  gltf.scene.traverse((o) => {
    if (o.isSkinnedMesh) skinned++;
    if (o.isBone) bones++;
  });
  return {
    file,
    skinned,
    bones,
    clips: (gltf.animations ?? []).map((clip) => ({
      name: clip.name,
      duration: Number(clip.duration.toFixed(3)),
      tracks: clip.tracks.length,
      movingTracks: movingTrackCount(clip),
      scaleTracks: clip.tracks.filter((t) => t.name.endsWith(".scale")).length,
    })),
  };
}

const argv = process.argv.slice(2);
const { only: onlyPatterns, profiles: profileArgs } = parseArgs(argv);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const allFiles = manifest.files ?? [];

let filesToScan = allFiles;

if (profileArgs.length) {
  const { files: profileFiles, matchedProfiles } = collectFilesForProfiles(manifest, profileArgs);
  if (!matchedProfiles.length) {
    console.error(`No animationProfiles matched: ${profileArgs.join(", ")}`);
    process.exit(1);
  }
  if (matchedProfiles.length > 1) {
    console.log(
      `[inspect-unit-glbs] Multiple profiles matched (${matchedProfiles.map((p) => p.id).join(", ")}); unioning their files.`,
    );
  }
  filesToScan = [...profileFiles].filter((f) => allFiles.includes(f));
  const missing = [...profileFiles].filter((f) => !allFiles.includes(f));
  if (missing.length) {
    console.log(`[inspect-unit-glbs] warn: profile references not in manifest.files: ${missing.join(", ")}`);
  }
} else if (onlyPatterns.length) {
  filesToScan = filterFilesByOnly(allFiles, onlyPatterns);
  if (!filesToScan.length) {
    console.error(`No manifest files matched --only: ${onlyPatterns.join(", ")}`);
    process.exit(1);
  }
}

const profileSection =
  profileArgs.length || onlyPatterns.length
    ? (manifest.animationProfiles ?? []).filter((p) => {
        const set = new Set(filesToScan);
        const pf = new Set([...(p.files ?? []), ...Object.values(p.roles ?? {}).filter((x) => typeof x === "string")]);
        for (const f of pf) {
          if (set.has(f)) return true;
        }
        return false;
      })
    : manifest.animationProfiles ?? [];

console.log(
  `Manifest: ${allFiles.length} GLB(s), ${(manifest.animationProfiles ?? []).length} animated profile(s)` +
    (filesToScan.length !== allFiles.length ? ` → inspecting ${filesToScan.length} file(s)` : ""),
);

for (const profile of profileSection) {
  console.log(`\n[profile] ${profile.id}${profile.sizeClass ? ` -> ${profile.sizeClass}` : ""}`);
  for (const [role, file] of Object.entries(profile.roles ?? {})) console.log(`  ${role}: ${file}`);
}

console.log("\n[file diagnostics]");
for (const file of filesToScan) {
  try {
    const d = await inspect(file);
    const clips = d.clips.map((c) => `${c.name} ${c.duration}s moving=${c.movingTracks}`).join("; ") || "no clips";
    console.log(`${d.file}: skinned=${d.skinned} bones=${d.bones} ${clips}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`${file}: inspect-error=${message}`);
  }
}
