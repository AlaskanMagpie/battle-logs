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

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
console.log(`Manifest: ${manifest.files.length} GLB(s), ${(manifest.animationProfiles ?? []).length} animated profile(s)`);
for (const profile of manifest.animationProfiles ?? []) {
  console.log(`\n[profile] ${profile.id}${profile.sizeClass ? ` -> ${profile.sizeClass}` : ""}`);
  for (const [role, file] of Object.entries(profile.roles ?? {})) console.log(`  ${role}: ${file}`);
}

console.log("\n[file diagnostics]");
for (const file of manifest.files) {
  try {
    const d = await inspect(file);
    const clips = d.clips.map((c) => `${c.name} ${c.duration}s moving=${c.movingTracks}`).join("; ") || "no clips";
    console.log(`${d.file}: skinned=${d.skinned} bones=${d.bones} ${clips}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`${file}: inspect-error=${message}`);
  }
}
