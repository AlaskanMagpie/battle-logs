import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

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
const loader = new GLTFLoader();

const files = fs
  .readdirSync(unitsDir)
  .filter((f) => f.endsWith(".glb"))
  .sort();

const roleTokens = new Set([
  "360",
  "attack",
  "attacking",
  "backward",
  "backwards",
  "base",
  "baselayer",
  "bow",
  "charge",
  "charged",
  "clip0",
  "combo",
  "combat",
  "death",
  "die",
  "dying",
  "fall",
  "falling",
  "fast",
  "fight",
  "fighting",
  "idle",
  "inplace",
  "jump",
  "melee",
  "power",
  "run",
  "running",
  "slash",
  "spin",
  "sprint",
  "stance",
  "triple",
  "walk",
  "walking",
]);

function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/\.glb$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .split("_")
    .filter(Boolean);
}

function familyId(file) {
  const kept = words(file).filter((w) => !roleTokens.has(w));
  return kept.length ? kept.join("_") : path.basename(file, ".glb").toLowerCase();
}

function inferSizeClass(file, clipNames) {
  const hay = `${file} ${clipNames.join(" ")}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(hero|wizard|mage|leader|champion)\b/.test(hay)) return "hero";
  if (/\b(titan|giant|colossus|boss|dragon|behemoth)\b/.test(hay)) return "Titan";
  if (/\b(heavy|brute|ogre|crusher|tank|siege)\b/.test(hay)) return "Heavy";
  if (/\b(swarm|small|scout|imp|goblin|minion|spearman|spear)\b/.test(hay)) return "Swarm";
  if (/\b(line|soldier|warrior|archer|ranger|knight|nomad)\b/.test(hay)) return "Line";
  return undefined;
}

function movingTrackCount(clip) {
  let moving = 0;
  for (const track of clip.tracks) {
    if (!/\.(position|quaternion|rotation)$/i.test(track.name)) continue;
    if (track.times.length < 2) continue;
    const size = typeof track.getValueSize === "function" ? track.getValueSize() : 1;
    let changed = false;
    for (let i = size; i < track.values.length && !changed; i++) {
      if (Math.abs(track.values[i] - track.values[i % size]) > 1e-5) changed = true;
    }
    if (changed) moving++;
  }
  return moving;
}

async function inspectGlb(file) {
  const full = path.join(unitsDir, file);
  const buf = fs.readFileSync(full);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const gltf = await new Promise((resolve, reject) => loader.parse(ab, "", resolve, reject));
    let skinnedMeshes = 0;
    let bones = 0;
    gltf.scene.traverse((o) => {
      if (o.isSkinnedMesh) skinnedMeshes++;
      if (o.isBone) bones++;
    });
    return {
      file,
      skinnedMeshes,
      bones,
      animations: (gltf.animations ?? []).map((clip) => ({
        name: clip.name,
        duration: Number(clip.duration.toFixed(3)),
        tracks: clip.tracks.length,
        movingTracks: movingTrackCount(clip),
        scaleTracks: clip.tracks.filter((t) => t.name.endsWith(".scale")).length,
      })),
    };
  } catch (err) {
    return { file, error: err instanceof Error ? err.message : String(err), skinnedMeshes: 0, bones: 0, animations: [] };
  }
}

function roleScore(role, file, meta) {
  const hay = `${file} ${meta.animations.map((a) => a.name).join(" ")}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const animated = Math.max(0, ...meta.animations.map((a) => a.movingTracks));
  const duration = Math.max(0, ...meta.animations.map((a) => a.duration));
  let score = 0;
  if (role === "run") {
    if (/\b(run|running|sprint|runfast|fast)\b/.test(hay)) score += 90;
    if (/\b(walk|walking)\b/.test(hay)) score += 35;
    if (/\bfast\b/.test(hay)) score += 12;
    if (duration > 0.15 && duration < 1.5) score += 8;
  } else if (role === "idle") {
    if (/\b(combat[_\s-]?stance|stance|idle|breath|ready|guard)\b/.test(hay)) score += 90;
    if (/\b(walk|walking)\b/.test(hay)) score += 28;
    if (duration < 0.08 || animated <= 0) score -= 55;
  } else if (role === "attack") {
    if (/\b(attack|attacking|slash|strike|melee|combo|spin|bow|charge|fight)\b/.test(hay)) score += 90;
    if (/\b(combo|power|spin|charge)\b/.test(hay)) score += 8;
  } else if (role === "death") {
    if (/\b(death|die|dying|fall|falling)\b/.test(hay)) score += 100;
  }
  if (score <= 0) return 0;
  if (animated > 0) score += Math.min(20, animated);
  return score;
}

function pickRoleFile(role, metas) {
  let best = null;
  for (const meta of metas) {
    const score = roleScore(role, meta.file, meta);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { file: meta.file, score };
  }
  return best?.file;
}

const inspections = await Promise.all(files.map(inspectGlb));
const animated = inspections.filter((m) => m.skinnedMeshes > 0 && m.bones > 0 && m.animations.length > 0);
const byFamily = new Map();
for (const meta of animated) {
  const id = familyId(meta.file);
  const list = byFamily.get(id) ?? [];
  list.push(meta);
  byFamily.set(id, list);
}

const animationProfiles = [];
for (const [id, metas] of byFamily) {
  const roleFiles = {
    run: pickRoleFile("run", metas),
    idle: pickRoleFile("idle", metas),
    attack: pickRoleFile("attack", metas),
    death: pickRoleFile("death", metas),
  };
  const model = roleFiles.run ?? roleFiles.idle ?? roleFiles.attack ?? metas[0]?.file;
  if (!model) continue;
  const clipNames = metas.flatMap((m) => m.animations.map((a) => a.name));
  const sizeClass = inferSizeClass(metas.map((m) => m.file).join(" "), clipNames);
  const roles = Object.fromEntries(Object.entries({ model, ...roleFiles }).filter(([, v]) => Boolean(v)));
  animationProfiles.push({
    id,
    ...(sizeClass ? { sizeClass } : {}),
    roles,
    files: metas.map((m) => m.file).sort(),
  });
}

const out = path.join(unitsDir, "manifest.json");
fs.writeFileSync(
  out,
  `${JSON.stringify(
    {
      schemaVersion: 2,
      files,
      animationProfiles: animationProfiles.sort((a, b) => a.id.localeCompare(b.id)),
      inspections,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`Wrote ${out} (${files.length} GLB, ${animationProfiles.length} animated profile(s))`);
