import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { KEEP_ID, STRUCTURE_MESH_VISUAL_SCALE } from "../game/constants";
import { getCatalogEntry } from "../game/catalog";
import { unitMeshLinearSize } from "../game/sim/systems/helpers";
import { isCommandEntry, type TeamId, type UnitSizeClass } from "../game/types";

type UnitAnimationRole = "model" | "run" | "idle" | "attack" | "death";
type UnitAnimationProfile = {
  id: string;
  sizeClass?: UnitSizeClass | "hero";
  roles?: Partial<Record<UnitAnimationRole, string>>;
  files?: string[];
};
type UnitGlbManifest = {
  files: string[];
  animationProfiles?: UnitAnimationProfile[];
};

let manifest: UnitGlbManifest | undefined;
let manifestPromise: Promise<UnitGlbManifest> | null = null;
const loader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("/draco/gltf/");
loader.setDRACOLoader(dracoLoader);
type GltfTemplate = { root: THREE.Object3D; animations: THREE.AnimationClip[]; triangleCount: number };
/** Cached *template* GLTF data (never added to scene). */
const cache = new Map<string, GltfTemplate>();
/** In-flight loads: many units can request the same manifest URL before the first parse finishes. */
const templateLoadPromises = new Map<string, Promise<GltfTemplate>>();
const warnedAnimationRoles = new Set<string>();

const AZURE_SPEAR_SWARM_PREFIX = "azure_spear_swarm_";
const AZURE_SPEAR_SWARM_RUN_FILE = "azure_spear_swarm_run_fast.glb";
const AZURE_SPEAR_SWARM_ATTACK_FILE = "azure_spear_swarm_attack_spin.glb";
const AZURE_SPEAR_SWARM_IDLE_FILE = "azure_spear_swarm_idle.glb";
const AZURE_SPEAR_SWARM_IDLE_FALLBACK_FILE = "azure_spear_swarm_walking.glb";
const AZURE_SPEAR_SWARM_DEATH_FILE = "azure_spear_swarm_dying.glb";
const LANTERNBOUND_LINE_PREFIX = "lanternbound_line_";
const LANTERNBOUND_LINE_RUN_FILE = "lanternbound_line_running.glb";
const LANTERNBOUND_LINE_ATTACK_FILE = "lanternbound_line_attack_triple_combo.glb";
const LANTERNBOUND_LINE_IDLE_FILE = "lanternbound_line_combat_stance.glb";
const LANTERNBOUND_LINE_DEATH_FILE = "lanternbound_line_dying.glb";

function isAzureSpearSwarmFile(file: string): boolean {
  return file.startsWith(AZURE_SPEAR_SWARM_PREFIX);
}

function isPreviewUnitFile(file: string): boolean {
  return (
    isAzureSpearSwarmFile(file) ||
    file === "acrobat_compressed.glb" ||
    file === "bastion_keep_compressed.glb" ||
    file === "driftwood_oasis_compressed.glb" ||
    file === "verdant_citadel_titan_base.glb" ||
    file.startsWith(LANTERNBOUND_LINE_PREFIX)
  );
}

function animatedProfileFiles(m: UnitGlbManifest): Set<string> {
  const out = new Set<string>();
  for (const p of m.animationProfiles ?? []) {
    for (const f of p.files ?? []) out.add(f);
    for (const f of Object.values(p.roles ?? {})) {
      if (f) out.add(f);
    }
  }
  return out;
}

function productionArtFiles(m: UnitGlbManifest): string[] {
  const animatedFiles = animatedProfileFiles(m);
  return m.files.filter((f) => !animatedFiles.has(f) && !isPreviewUnitFile(f) && !f.endsWith("_building.glb"));
}

function animationProfileForClass(kind: UnitSizeClass | "hero", m: UnitGlbManifest): UnitAnimationProfile | null {
  const profiles = m.animationProfiles ?? [];
  const exact = profiles.find((p) => p.sizeClass === kind && p.roles?.model);
  if (exact) return exact;
  return null;
}

function animationProfileById(id: string, m: UnitGlbManifest): UnitAnimationProfile | null {
  return (m.animationProfiles ?? []).find((p) => p.id === id) ?? null;
}

/** Prefer `animationProfiles` entry matched by `producedUnitId`, else size-class profile. */
function animationProfileForUnit(
  kind: UnitSizeClass | "hero",
  producedUnitId: string | undefined,
  m: UnitGlbManifest,
): UnitAnimationProfile | null {
  if (producedUnitId) {
    const byId = animationProfileById(producedUnitId, m);
    if (byId?.roles && (byId.roles.model || byId.roles.run)) return byId;
  }
  return animationProfileForClass(kind, m);
}

function roleFileForUnit(
  kind: UnitSizeClass | "hero",
  producedUnitId: string | undefined,
  role: UnitAnimationRole,
  m: UnitGlbManifest,
): string | null {
  const profile = animationProfileForUnit(kind, producedUnitId, m);
  return profile?.roles?.[role] ?? null;
}

function attackFileForUnit(kind: UnitSizeClass | "hero", producedUnitId: string | undefined, m: UnitGlbManifest): string | null {
  const profileFile = roleFileForUnit(kind, producedUnitId, "attack", m);
  if (profileFile) return profileFile;
  const files = m.files;
  if (kind === "Swarm") return files.includes(AZURE_SPEAR_SWARM_ATTACK_FILE) ? AZURE_SPEAR_SWARM_ATTACK_FILE : null;
  if (kind === "Line") return files.includes(LANTERNBOUND_LINE_ATTACK_FILE) ? LANTERNBOUND_LINE_ATTACK_FILE : null;
  return null;
}

function idleFileForUnit(kind: UnitSizeClass | "hero", producedUnitId: string | undefined, m: UnitGlbManifest): string | null {
  const profileFile = roleFileForUnit(kind, producedUnitId, "idle", m);
  if (profileFile) return profileFile;
  const files = m.files;
  if (kind === "Swarm") {
    if (files.includes(AZURE_SPEAR_SWARM_IDLE_FILE)) return AZURE_SPEAR_SWARM_IDLE_FILE;
    return files.includes(AZURE_SPEAR_SWARM_IDLE_FALLBACK_FILE) ? AZURE_SPEAR_SWARM_IDLE_FALLBACK_FILE : null;
  }
  if (kind === "Line") return files.includes(LANTERNBOUND_LINE_IDLE_FILE) ? LANTERNBOUND_LINE_IDLE_FILE : null;
  return null;
}

function deathFileForUnit(kind: UnitSizeClass | "hero", producedUnitId: string | undefined, m: UnitGlbManifest): string | null {
  const profileFile = roleFileForUnit(kind, producedUnitId, "death", m);
  if (profileFile) return profileFile;
  const files = m.files;
  if (kind === "Swarm") return files.includes(AZURE_SPEAR_SWARM_DEATH_FILE) ? AZURE_SPEAR_SWARM_DEATH_FILE : null;
  if (kind === "Line") return files.includes(LANTERNBOUND_LINE_DEATH_FILE) ? LANTERNBOUND_LINE_DEATH_FILE : null;
  return null;
}

function pickFileForUnit(kind: UnitSizeClass | "hero", producedUnitId: string | undefined, m: UnitGlbManifest): string | null {
  const run = roleFileForUnit(kind, producedUnitId, "run", m);
  if (run) return run;
  const model = roleFileForUnit(kind, producedUnitId, "model", m);
  if (model) return model;

  const files = m.files;
  if (kind === "Swarm") return files.includes(AZURE_SPEAR_SWARM_RUN_FILE) ? AZURE_SPEAR_SWARM_RUN_FILE : null;
  if (kind === "Line") return files.includes(LANTERNBOUND_LINE_RUN_FILE) ? LANTERNBOUND_LINE_RUN_FILE : null;

  const classFiles = productionArtFiles(m);
  if (!classFiles.length) return null;
  const idx = CLASS_INDEX[kind] ?? 0;
  return classFiles[idx % classFiles.length] ?? classFiles[0] ?? null;
}

function attackPlaybackSeconds(kind: UnitSizeClass | "hero", producedUnitId?: string): number | undefined {
  if (producedUnitId === "amber_geode_monks") return 2.12;
  // Never compress attack clips to sim cooldowns. Short Meshy attacks need extra
  // visual recovery so anticipation/release/follow-through can read on screen.
  switch (kind) {
    case "Swarm":
      return 3.1;
    case "Line":
      return 4.35;
    case "Heavy":
      return 3.05;
    case "Titan":
      return 3.35;
    case "hero":
      return 1.48;
  }
}

function loopPlaybackSeconds(role: "run" | "idle", clip: THREE.AnimationClip, file: string): number {
  const hay = `${file} ${clip.name}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (role === "run") {
    // Meshy run exports are often 0.5-0.7s loops, which reads frantic at this scale.
    // Stretch short loops into a calm jog cadence while keeping already-slower clips authored.
    const target = /\b(fast|sprint|runfast)\b/.test(hay) ? 0.95 : 1.08;
    let playback = Math.max(clip.duration, target);
    // Verdant Titan locomotion GLB is authored as Monster_Walk; stretch slightly for a heavier field read.
    if (file.includes("verdant_gatekeeper_titan_run")) playback *= 1.1;
    if (file.includes("verdant_gatekeeper_reference")) playback = Math.max(playback, 1.45);
    if (file.includes("starbound_arcanist_hero")) {
      playback = Math.max(playback, 1.1);
    }
    // Amber golem squad: slightly slower loop read vs frantic short Meshy run cycles.
    if (file.includes("amber_geode_monks_run")) playback *= 1.14;
    return playback;
  }
  const target = /\b(walk|walking)\b/.test(hay) ? 1.22 : 1.15;
  let playback = Math.max(clip.duration, target);
  if (file.includes("verdant_gatekeeper_reference")) playback = Math.max(playback, 1.55);
  // Idle slot uses walk clip — stretch so stance transitions don't feel twitchy.
  if (file.includes("amber_geode_monks_walk")) playback = Math.max(playback, 1.38);
  return playback;
}

function setLoopPlayback(action: THREE.AnimationAction, clip: THREE.AnimationClip, role: "run" | "idle", file: string): void {
  const playback = loopPlaybackSeconds(role, clip, file);
  action.timeScale = clip.duration / Math.max(0.05, playback);
}

/** Last path segment for `BoneName.position` / nested bone tracks. */
function boneLeafFromPositionTrack(trackName: string): string {
  const path = trackName.replace(/\.position$/i, "");
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1) : path;
}

/**
 * Run/walk clips often bake root translation on **Hips.position** (forward/side drift in place).
 * We already drive world XY from the sim; keeping those keys fights the unit root and reads as
 * horizontal jitter (especially Line / Meshy exports).
 * Preserve Y so vertical bounce from the authored cycle remains.
 */
function stripHipsHorizontalTranslation(clip: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = clip.tracks.map((track) => {
    if (!track.name.endsWith(".position")) return track;
    if (!/hips$/i.test(boneLeafFromPositionTrack(track.name))) return track;
    if (!(track instanceof THREE.VectorKeyframeTrack)) return track;
    const values = Float32Array.from(track.values);
    for (let i = 0; i < values.length; i += 3) {
      values[i] = 0;
      values[i + 2] = 0;
    }
    return new THREE.VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(values));
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function safeClip(clip: THREE.AnimationClip, stripHipsRootXZ = false): THREE.AnimationClip {
  // Meshy exports often include scale keys that fight our class-based GLB normalization.
  const tracks = clip.tracks.filter((track) => !track.name.endsWith(".scale"));
  let out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  if (stripHipsRootXZ) out = stripHipsHorizontalTranslation(out);
  return out;
}

function movingTrackCount(clip: THREE.AnimationClip): number {
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

function animClipLeafLower(name: string): string {
  const t = name.trim();
  const parts = t.split(/[|/\\]/u);
  return (parts[parts.length - 1] ?? t).trim().toLowerCase();
}

function starboundHeroForbiddenLocoName(name: string): boolean {
  const h = name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return /\b(kick|lunge|sweep|spin|jump|360|weapon|combo|mage|spell|cast|soell|dab|taunt|dance|flip)\b/.test(h);
}

/**
 * Hard-pick authored locomotion for the Starbound wizard GLB (same file as kicks/spells).
 * Uses leaf names so `Armature|Running` still resolves; rejects flourish clips if mis-tagged.
 */
function starboundHeroLocomotionClip(
  animations: THREE.AnimationClip[],
  role: "run" | "idle",
): THREE.AnimationClip | null {
  const okTracks = (c: THREE.AnimationClip) => movingTrackCount(c) > 0;
  if (role === "run") {
    const byLeaf = animations.filter((c) => animClipLeafLower(c.name) === "running" && okTracks(c));
    const running = byLeaf.find((c) => !starboundHeroForbiddenLocoName(c.name)) ?? byLeaf[0];
    if (running) return running;
    const walking = animations.find(
      (c) => animClipLeafLower(c.name) === "walking" && okTracks(c) && !starboundHeroForbiddenLocoName(c.name),
    );
    return walking ?? null;
  }
  const idles = animations.filter((c) => {
    if (!okTracks(c)) return false;
    if (animClipLeafLower(c.name) !== "idle") return false;
    if (/\bswim\b/i.test(c.name)) return false;
    if (starboundHeroForbiddenLocoName(c.name)) return false;
    return true;
  });
  return idles[0] ?? null;
}

function clipRoleScore(role: Exclude<UnitAnimationRole, "model">, file: string, clip: THREE.AnimationClip): number {
  if (movingTrackCount(clip) <= 0) return 0;
  const hay = `${file} ${clip.name}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const starbound = file.includes("starbound_arcanist_hero");
  let score = 0;
  if (role === "run") {
    if (/\b(run|running|sprint|runfast|fast|jog)\b/.test(hay)) score += 100;
    if (/\b(walk|walking)\b/.test(hay)) score += 30;
    if (starbound) {
      if (/\b(kick|spell|mage|cast|dance|flip|jump|spin|taunt|wave|celebrate|yoga|stretch)\b/.test(hay)) score -= 260;
      if (/\b(attack|slash|strike|combo|fireball|magic)\b/.test(hay)) score -= 200;
      if (/\b(idle|stance|guard)\b/.test(hay)) score -= 120;
    }
  } else if (role === "idle") {
    if (/\b(combat[_\s-]?stance|stance|idle|ready|guard)\b/.test(hay)) score += 100;
    if (/\b(walk|walking)\b/.test(hay)) score += 25;
    if (clip.duration < 0.08) score -= 60;
    if (starbound) {
      if (/\b(run|running|sprint|jog)\b/.test(hay)) score -= 140;
      if (/\b(kick|spell|mage|cast|dance|flip|jump|attack|slash)\b/.test(hay)) score -= 180;
    }
  } else if (role === "attack") {
    if (/\b(attack|attacking|slash|strike|melee|combo|spin|bow|charge|fight)\b/.test(hay)) score += 100;
    if (file.includes("starbound_arcanist_hero")) {
      // Prefer readable melee on the default action; short cast bursts are strike-roulette only.
      if (/\b(mage|spell|soell|cast)\b/.test(hay)) score -= 220;
      if (/\b(weapon|kick|sweep|lunge)\b/.test(hay)) score += 120;
    }
  } else if (role === "death") {
    if (/\b(dead|death|die|dying|fall|falling)\b/.test(hay)) score += 100;
  }
  if (score <= 0) return 0;
  if (clip.tracks.some((t) => /\.(position|quaternion|rotation)$/i.test(t.name))) score += 5;
  return score;
}

function clipForRole(
  animations: THREE.AnimationClip[],
  role: Exclude<UnitAnimationRole, "model">,
  file: string,
): THREE.AnimationClip | null {
  if (!animations.length) return null;
  /** Starbound wizard pack: pin real run + standing idle (never kicks / swim idle / cast micro-clips). */
  if (isStarboundHeroFile(file)) {
    if (role === "run" || role === "idle") {
      const picked = starboundHeroLocomotionClip(animations, role);
      if (picked) return picked;
    }
    if (role === "attack") {
      const weapon = animations.find(
        (c) => /weapon_combo/i.test(c.name) && !/_1$/i.test(c.name.trim()) && movingTrackCount(c) > 0,
      );
      if (weapon) return weapon;
      const weapon1 = animations.find((c) => /weapon_combo_1/i.test(c.name) && movingTrackCount(c) > 0);
      if (weapon1) return weapon1;
    }
  }
  let best = animations[0]!;
  let bestScore = clipRoleScore(role, file, best);
  for (const clip of animations.slice(1)) {
    const score = clipRoleScore(role, file, clip);
    if (score > bestScore) {
      best = clip;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

const STARBOUND_HERO_MARKER = "starbound_arcanist_hero";

function isStarboundHeroFile(file: string): boolean {
  return file.toLowerCase().includes(STARBOUND_HERO_MARKER);
}

/** Spell / kick / dance flourishes for strike roulette — excludes plain locomotion clips by name. */
function isHeroStrikeRouletteClip(clip: THREE.AnimationClip): boolean {
  if (movingTrackCount(clip) < 2) return false;
  const hay = clip.name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(death|die|dying|fall|falling)\b/.test(hay)) return false;
  const leaf = animClipLeafLower(clip.name);
  if (leaf === "idle" || leaf === "running" || leaf === "walking") return false;
  if (/\bswim\b/.test(hay)) return false;
  if (/\bidle\b/.test(hay) && !/\b(kick|weapon|combo|attack|cast|spin|jump|lunge|sweep)\b/.test(hay)) return false;
  const loco = /\b(walk|walking|run|running|sprint|jog)\b/.test(hay);
  const flourish =
    /\b(spell|cast|mage|magic|kick|flip|jump|attack|slash|strike|combo|dance|spin|fire|wave|summon|portal)\b/.test(hay);
  if (loco && !flourish) return false;
  return true;
}

function registerStarboundHeroStrikePool(
  parent: THREE.Object3D,
  mixer: THREE.AnimationMixer,
  animations: THREE.AnimationClip[],
  file: string,
  excludedClipNames: Set<string>,
  attackPlaybackFloor: number,
): void {
  if (!isStarboundHeroFile(file) || !animations.length) return;
  const strikeActions: THREE.AnimationAction[] = [];
  const strikeDurations: number[] = [];
  for (const raw of animations) {
    if (excludedClipNames.has(raw.name)) continue;
    if (!isHeroStrikeRouletteClip(raw)) continue;
    const clip = safeClip(raw);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    action.enabled = false;
    action.setEffectiveWeight(0);
    const playback = Math.max(clip.duration, attackPlaybackFloor, 1.32);
    action.timeScale = clip.duration / Math.max(0.05, playback);
    strikeActions.push(action);
    strikeDurations.push(playback);
  }
  if (!strikeActions.length) return;
  parent.userData["glbHeroStrikeActions"] = strikeActions;
  parent.userData["glbHeroStrikeDurations"] = strikeDurations;
}

function rigSummary(root: THREE.Object3D): { skinnedMeshes: number; bones: number } {
  let skinnedMeshes = 0;
  let bones = 0;
  root.traverse((o) => {
    const skinned = o as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinnedMeshes++;
    if ((o as THREE.Bone).isBone) bones++;
  });
  return { skinnedMeshes, bones };
}

function triangleCount(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const geom = m.geometry;
    const pos = geom.getAttribute("position");
    if (!pos) return;
    tris += geom.index ? geom.index.count / 3 : pos.count / 3;
  });
  return Math.max(0, Math.round(tris));
}

/** AABB size → scalar used to fit `targetMaxExtent`. */
export type GlbExtentBasis = "max" | "height";

/**
 * `max`: largest axis (legacy, good for squat structures).
 * `height`: standing-height contract — max(Y, 0.5·max(X,Z)) so wide titans still hit their foot ladder.
 */
export function glbBoxExtentRef(size: THREE.Vector3, basis: GlbExtentBasis): number {
  if (basis === "max") return Math.max(size.x, size.y, size.z, 1e-3);
  const maxXZ = Math.max(size.x, size.z);
  return Math.max(size.y, maxXZ * 0.5, 1e-3);
}

function visibleMeshBounds(root: THREE.Object3D, relativeTo?: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  relativeTo?.updateMatrixWorld(true);
  const inv = relativeTo ? new THREE.Matrix4().copy(relativeTo.matrixWorld).invert() : null;
  const out = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const skinned = m as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.computeBoundingBox();
    else m.geometry.computeBoundingBox();
    const bb = skinned.isSkinnedMesh ? skinned.boundingBox : m.geometry.boundingBox;
    if (!bb) return;
    tmp.copy(bb).applyMatrix4(m.matrixWorld);
    if (inv) tmp.applyMatrix4(inv);
    out.union(tmp);
  });
  return out;
}

function normalizeGlbInstance(inst: THREE.Object3D, targetMaxExtent: number, basis: GlbExtentBasis): void {
  inst.updateMatrixWorld(true);
  const parent = inst.parent ?? undefined;
  const box = visibleMeshBounds(inst, parent);
  if (box.isEmpty()) return;
  const size = new THREE.Vector3();
  box.getSize(size);
  const ref = glbBoxExtentRef(size, basis);
  inst.scale.multiplyScalar(targetMaxExtent / ref);
  inst.updateMatrixWorld(true);
  const b2 = visibleMeshBounds(inst, parent);
  inst.position.x -= (b2.min.x + b2.max.x) / 2;
  inst.position.z -= (b2.min.z + b2.max.z) / 2;
  inst.position.y -= b2.min.y;
}

async function loadGltfTemplate(url: string): Promise<GltfTemplate> {
  const done = cache.get(url);
  if (done) return done;

  let p = templateLoadPromises.get(url);
  if (!p) {
    p = loader
      .loadAsync(url)
      .then((gltf: GLTF) => {
        const template = { root: gltf.scene, animations: gltf.animations ?? [], triangleCount: triangleCount(gltf.scene) };
        cache.set(url, template);
        templateLoadPromises.delete(url);
        return template;
      })
      .catch((err) => {
        templateLoadPromises.delete(url);
        throw err;
      });
    templateLoadPromises.set(url, p);
  }
  return p;
}

/** Cached GLTF root for a manifest URL (used by towers/units and card thumbnails). */
export async function loadGltfTemplateRoot(url: string): Promise<THREE.Object3D> {
  return (await loadGltfTemplate(url)).root;
}

/** Stable class → manifest index mapping so each unit class always looks the same.
 *  Swarm=0, Line=1, Heavy=2, Titan=3, hero=4. Falls back modulo manifest length. */
const CLASS_INDEX: Record<UnitSizeClass | "hero", number> = {
  Swarm: 0,
  Line: 1,
  Heavy: 2,
  Titan: 3,
  hero: 4,
};

export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function loadManifest(): Promise<UnitGlbManifest> {
  if (manifest !== undefined) return manifest;
  if (!manifestPromise) {
    manifestPromise = (async (): Promise<UnitGlbManifest> => {
      try {
        const res = await fetch("/assets/units/manifest.json", { cache: "no-store" });
        if (!res.ok) return { files: [] };
        const j = (await res.json()) as UnitGlbManifest;
        return {
          files: j.files ?? [],
          animationProfiles: j.animationProfiles ?? [],
        };
      } catch {
        return { files: [] };
      }
    })()
      .then((files) => {
        manifest = files;
        return files;
      })
      .finally(() => {
        manifestPromise = null;
      });
  }
  return manifestPromise;
}

function pickFile(seed: number, files: string[]): string | null {
  if (!files.length) return null;
  return files[seed % files.length] ?? null;
}

/**
 * Strong blue-vs-red team read on unit GLBs (works at long zoom where albedo alone mushes together).
 * Touches any mesh material with a `color` (Standard/Physical/Phong/Lambert/Toon/Basic/Matcap),
 * not only MeshStandardMaterial — many exports use Basic or Toon and were skipping tint entirely.
 */
function applyTeamTintToMaterial(mat: THREE.Material, team: TeamId): void {
  if (mat instanceof THREE.ShaderMaterial) return;
  const m = mat as THREE.MeshBasicMaterial & {
    emissive?: THREE.Color;
    emissiveIntensity?: number;
  };
  if (!m.color?.isColor) return;

  const mul =
    team === "enemy"
      ? new THREE.Color(1.48, 0.35, 0.52)
      : new THREE.Color(0.45, 0.92, 1.48);
  const anchor = team === "enemy" ? new THREE.Color(0xff2438) : new THREE.Color(0x1f8fff);
  const lerpAmt = team === "enemy" ? 0.52 : 0.44;

  m.color.multiply(mul);
  m.color.lerp(anchor, lerpAmt);

  if (m.emissive?.isColor) {
    const emTarget = team === "enemy" ? new THREE.Color(0x4a0a18) : new THREE.Color(0x082a52);
    m.emissive.lerp(emTarget, team === "enemy" ? 0.42 : 0.34);
    if (typeof m.emissiveIntensity === "number") {
      m.emissiveIntensity = Math.max(m.emissiveIntensity, team === "enemy" ? 0.16 : 0.14);
    }
  }
}

function applyGlbTeamTint(root: THREE.Object3D, team: TeamId): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const raw of mats) {
      if (!raw) continue;
      applyTeamTintToMaterial(raw, team);
    }
  });
}

function cloneInstanceMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    m.material = Array.isArray(m.material) ? m.material.map((mat) => mat.clone()) : m.material.clone();
  });
}

function setShadowRecursive(root: THREE.Object3D, cast: boolean, receive: boolean): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = cast;
      m.receiveShadow = receive;
    }
  });
}

function setOpacityRecursive(root: THREE.Object3D, opacity: number): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (!mat || typeof (mat as THREE.Material).opacity !== "number") continue;
      const mm = mat as THREE.Material & { opacity: number; transparent: boolean };
      mm.transparent = opacity < 1;
      mm.opacity = opacity;
    }
  });
}

export function setGlbOpacity(group: THREE.Group, opacity: number): void {
  const glb = group.userData["glbRoot"] as THREE.Object3D | undefined;
  if (glb) setOpacityRecursive(glb, opacity);
}

type AttachGlbOpts = {
  /** If set, hide this object (from `parent.userData[key]`) after a successful load. */
  hideSilhouetteUserDataKey?: string;
  /** Shallow multiply on StandardMaterial albedo for team read at a glance. */
  teamTint?: TeamId;
  /** Optional secondary clip GLB whose first animation plays as the unit's attack action. */
  attackFile?: string | null;
  /** Optional secondary clip GLB whose first animation plays while idle/standing. */
  idleFile?: string | null;
  /** Optional secondary clip GLB whose first animation plays while dying before disposal. */
  deathFile?: string | null;
  /** Compress/expand long source attacks to the sim's actual attack event cadence. */
  attackPlaybackSeconds?: number;
  /** Unit/art role label used for one-time dev warnings when expected clips are absent. */
  animationRoleLabel?: string;
  /** Unit placeholders should never reappear as boxes if GLB art is missing/late. */
  keepPlaceholderHidden?: boolean;
  /** How to read authored bounds for normalization (default: height for animated units, max otherwise). */
  extentBasis?: GlbExtentBasis;
};

async function attachGlbByFile(
  file: string,
  placeholder: THREE.Mesh,
  targetMaxExtent: number,
  opts?: AttachGlbOpts,
): Promise<void> {
  const url = `/assets/units/${file}`;
  const parent = placeholder.parent as THREE.Group | null;
  if (!parent) return;
  if (parent.userData["unitDying"] || parent.userData["glbRoot"] || parent.userData["glbPending"]) return;
  parent.userData["glbPending"] = true;
  if (opts?.keepPlaceholderHidden) placeholder.visible = false;

  try {
    const template = await loadGltfTemplate(url);
    if (parent.userData["unitDying"]) return;
    const rig = rigSummary(template.root);
    if (opts?.animationRoleLabel && (rig.skinnedMeshes === 0 || rig.bones === 0 || template.animations.length === 0)) {
      const warnKey = `${opts.animationRoleLabel}:unrigged:${file}`;
      if (!warnedAnimationRoles.has(warnKey)) {
        warnedAnimationRoles.add(warnKey);
        console.warn(
          `[glb] ${opts.animationRoleLabel} has no usable runtime rig/animation in ${file} ` +
            `(skinned=${rig.skinnedMeshes}, bones=${rig.bones}, clips=${template.animations.length})`,
        );
      }
    }
    const inst = cloneSkeleton(template.root);
    cloneInstanceMaterials(inst);
    setShadowRecursive(inst, true, true);

    inst.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.userData["skipBuildOpacity"] = true;
    });

    placeholder.visible = false;
    parent.add(inst);
    parent.userData["glbRoot"] = inst;
    parent.userData["glbTargetMaxExtent"] = targetMaxExtent;
    const extentBasis: GlbExtentBasis =
      opts?.extentBasis ?? (opts?.animationRoleLabel || opts?.attackFile || opts?.idleFile ? "height" : "max");
    parent.userData["glbExtentBasis"] = extentBasis;
    parent.userData["glbTriangleCount"] = template.triangleCount;
    parent.userData["glbClampChecksRemaining"] = 2;
    const strikeExcludeClipNames = new Set<string>();
    let mixer: THREE.AnimationMixer | null = null;
    if (template.animations.length > 0) {
      const clipRaw = clipForRole(template.animations, "run", file);
      if (clipRaw) {
        strikeExcludeClipNames.add(clipRaw.name);
        mixer = new THREE.AnimationMixer(inst);
        const clip = safeClip(clipRaw, true);
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        setLoopPlayback(action, clip, "run", file);
        action.reset();
        action.enabled = true;
        action.setEffectiveWeight(1);
        action.play();
        parent.userData["glbMixer"] = mixer;
        parent.userData["glbAction"] = action;
        parent.userData["glbRunAction"] = action;
        parent.userData["glbBaseState"] = "run";
      }
    }
    const loadIdle = !!opts?.idleFile;
    if (loadIdle) {
      const idleFile = opts.idleFile!;
      const idleTemplate = idleFile === file ? template : await loadGltfTemplate(`/assets/units/${idleFile}`);
      const clipRaw = clipForRole(idleTemplate.animations, "idle", idleFile);
      if (clipRaw) {
        strikeExcludeClipNames.add(clipRaw.name);
        mixer ??= new THREE.AnimationMixer(inst);
        const clip = safeClip(clipRaw, true);
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        setLoopPlayback(action, clip, "idle", idleFile);
        action.enabled = false;
        action.setEffectiveWeight(0);
        parent.userData["glbMixer"] = mixer;
        parent.userData["glbIdleAction"] = action;
      }
    }
    const attackPlaybackFloor = Math.max(opts?.attackPlaybackSeconds ?? 1.48, 1.48);
    if (opts?.attackFile) {
      const attackTemplate = await loadGltfTemplate(`/assets/units/${opts.attackFile}`);
      const clipRaw = clipForRole(attackTemplate.animations, "attack", opts.attackFile);
      if (clipRaw) {
        strikeExcludeClipNames.add(clipRaw.name);
        mixer ??= new THREE.AnimationMixer(inst);
        const clip = safeClip(clipRaw, opts.attackFile.includes("amber_geode_monks_attack"));
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = false;
        action.enabled = false;
        action.setEffectiveWeight(0);
        const playback = Math.max(clip.duration, attackPlaybackFloor);
        action.timeScale = clip.duration / Math.max(0.05, playback);
        parent.userData["glbMixer"] = mixer;
        parent.userData["glbAttackAction"] = action;
        parent.userData["glbAttackDuration"] = playback;
      }
    }
    if (opts?.deathFile) {
      const deathTemplate = await loadGltfTemplate(`/assets/units/${opts.deathFile}`);
      const clipRaw = clipForRole(deathTemplate.animations, "death", opts.deathFile);
      if (clipRaw) {
        strikeExcludeClipNames.add(clipRaw.name);
        mixer ??= new THREE.AnimationMixer(inst);
        const clip = safeClip(clipRaw, opts.deathFile.includes("amber_geode_monks_death"));
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.enabled = false;
        action.setEffectiveWeight(0);
        parent.userData["glbMixer"] = mixer;
        parent.userData["glbDeathAction"] = action;
        parent.userData["glbDeathDuration"] = Math.min(clip.duration, 1.25);
      }
    }
    if (mixer && isStarboundHeroFile(file) && template.animations.length) {
      registerStarboundHeroStrikePool(parent, mixer, template.animations, file, strikeExcludeClipNames, attackPlaybackFloor);
    }
    if (mixer) mixer.update(0);
    parent.userData["glbAnimationReady"] = !!mixer;
    if (opts?.animationRoleLabel) {
      const missing = [
        parent.userData["glbRunAction"] ? "" : "run",
        loadIdle && !parent.userData["glbIdleAction"] ? "idle" : "",
        opts.attackFile && !parent.userData["glbAttackAction"] ? "attack" : "",
        opts.deathFile && !parent.userData["glbDeathAction"] ? "death" : "",
      ].filter(Boolean);
      const warnKey = `${opts.animationRoleLabel}:${missing.join(",") || "all"}`;
      if ((!mixer || missing.length > 0) && !warnedAnimationRoles.has(warnKey)) {
        warnedAnimationRoles.add(warnKey);
        console.warn(`[glb] ${opts.animationRoleLabel} missing animation roles: ${missing.join(", ") || "all"}`, file);
      }
    }
    normalizeGlbInstance(inst, targetMaxExtent, extentBasis);

    if (opts?.teamTint) applyGlbTeamTint(inst, opts.teamTint);

    const hideKey = opts?.hideSilhouetteUserDataKey;
    if (hideKey) {
      const silo = parent.userData[hideKey] as THREE.Object3D | undefined;
      if (silo) silo.visible = false;
    }
  } catch {
    placeholder.visible = !opts?.keepPlaceholderHidden;
  } finally {
    delete parent.userData["glbPending"];
  }
}

/** Legacy seed-based API (kept for compatibility). */
export async function attachGlbFromManifest(
  seed: number,
  placeholder: THREE.Mesh,
  targetMaxExtent: number,
): Promise<void> {
  const m = await loadManifest();
  const file = pickFile(seed, productionArtFiles(m));
  if (!file) return;
  await attachGlbByFile(file, placeholder, targetMaxExtent);
}

/** Stable, class-to-file GLB swap. Optional `producedUnitId` selects `animationProfiles` by id (spawn identity). */
export async function attachGlbForClass(
  kind: UnitSizeClass | "hero",
  placeholder: THREE.Mesh,
  targetMaxExtent: number,
  teamTint?: TeamId,
  producedUnitId?: string,
): Promise<void> {
  const m = await loadManifest();
  const file = pickFileForUnit(kind, producedUnitId, m);
  if (!file) return;
  const parent = placeholder.parent ?? placeholder;
  parent.userData["sizeClass"] = kind;
  if (teamTint) parent.userData["team"] = teamTint;
  if (producedUnitId) parent.userData["producedUnitId"] = producedUnitId;
  const roleLabel =
    producedUnitId !== undefined && producedUnitId.length > 0 ? `${kind}:${producedUnitId}` : kind;
  await attachGlbByFile(file, placeholder, targetMaxExtent, {
    ...(teamTint ? { teamTint } : {}),
    attackFile: attackFileForUnit(kind, producedUnitId, m),
    idleFile: idleFileForUnit(kind, producedUnitId, m),
    deathFile: deathFileForUnit(kind, producedUnitId, m),
    attackPlaybackSeconds: attackPlaybackSeconds(kind, producedUnitId),
    animationRoleLabel: roleLabel,
    keepPlaceholderHidden: true,
  });
}

/** Unit GLBs normalize to the canonical foot ladder (`unitMeshLinearSize` / `constants.ts`). */
export async function requestGlbForUnit(
  kind: UnitSizeClass,
  placeholder: THREE.Mesh,
  team: TeamId = "player",
  producedUnitId?: string,
): Promise<void> {
  const extent = unitMeshLinearSize(kind);
  await attachGlbForClass(kind, placeholder, extent, team, producedUnitId);
}

export async function requestGlbForHero(placeholder: THREE.Mesh, team: TeamId = "player"): Promise<void> {
  await attachGlbForClass("hero", placeholder, 3.0, team);
}

/** Player towers: canonical max extent (matches `structureDims` battle scale). */
export const TOWER_GLB_TARGET_EXTENT = unitMeshLinearSize("Titan") * STRUCTURE_MESH_VISUAL_SCALE;

/**
 * First 10 structure catalog ids map 1:1 to `manifest.json` `files[0..9]` once the
 * log-tower GLBs are present under `public/assets/units/`. Any other structure id
 * picks a file by stable hash modulo length.
 */
const TOWER_GLB_MANIFEST_ORDER = [
  KEEP_ID,
  "outpost",
  "watchtower",
  "root_bunker",
  "menders_hut",
  "siege_works",
  "bastion_keep",
  "salvage_yard",
  "war_camp",
  "dragon_roost",
] as const;

const TOWER_GLB_OVERRIDES: Partial<Record<string, string>> = {
  /** Permanent HQ + Rootbound Crag — compressed crag shell (Amber Geode Monks home). */
  [KEEP_ID]: "bastion_keep_compressed.glb",
  outpost: "driftwood_oasis_compressed.glb",
  /** Cragrunner Redoubt — cliff acropolis mesh; `acrobat_compressed.glb` is excluded from generic tower hashing (preview filter). */
  watchtower: "acrobat_compressed.glb",
  bastion_keep: "bastion_keep_compressed.glb",
  verdant_citadel: "verdant_citadel_titan_base.glb",
};

function towerManifestIndex(catalogId: string): number {
  const i = (TOWER_GLB_MANIFEST_ORDER as readonly string[]).indexOf(catalogId);
  if (i >= 0) return i;
  return hashStringToSeed(catalogId) % TOWER_GLB_MANIFEST_ORDER.length;
}

function pickTowerFile(catalogId: string, m: UnitGlbManifest): string | null {
  const override = TOWER_GLB_OVERRIDES[catalogId];
  if (override && m.files.includes(override)) return override;
  const towerFiles = productionArtFiles(m);
  if (!towerFiles.length) return null;
  return towerFiles[towerManifestIndex(catalogId) % towerFiles.length] ?? null;
}

/**
 * Asset lab: tower GLB + spawned-unit preview GLB using the same rules as the match (`pickTowerFile` + `pickFileForUnit`).
 * Note: e.g. `watchtower` uses `acrobat_compressed.glb` for the **building**; produced scouts use `azure_spear_swarm` profile files.
 */
export async function getAssetLabTowerAndUnitGlbFiles(catalogId: string): Promise<{
  towerFile: string | null;
  unitFile: string | null;
}> {
  const m = await loadManifest();
  const entry = getCatalogEntry(catalogId);
  if (!entry || isCommandEntry(entry)) return { towerFile: null, unitFile: null };
  const towerFile = pickTowerFile(catalogId, m);
  const unitFile = pickFileForUnit(entry.producedSizeClass, entry.producedUnitId, m);
  return { towerFile, unitFile };
}

/**
 * Extra unit GLBs whose clips the match loads beside the base `pickFileForUnit` file (idle / attack / death).
 * Asset lab merges these into one preview so role dropdowns are not stuck on a single run clip.
 */
export async function getAssetLabUnitExtraAnimationFiles(catalogId: string): Promise<readonly string[]> {
  const m = await loadManifest();
  const entry = getCatalogEntry(catalogId);
  if (!entry || isCommandEntry(entry)) return [];
  const kind = entry.producedSizeClass;
  const pid = entry.producedUnitId;
  const base = pickFileForUnit(kind, pid, m);
  if (!base) return [];
  const parts = [
    idleFileForUnit(kind, pid, m),
    attackFileForUnit(kind, pid, m),
    deathFileForUnit(kind, pid, m),
  ].filter((f): f is string => typeof f === "string" && f.length > 0 && f !== base);
  return [...new Set(parts)];
}

/** Root-relative GLB URL for HUD doctrine thumbnails when no `/assets/cards/*.png` exists (tower mesh only). */
export async function getCatalogPreviewAssetUrl(catalogId: string): Promise<string | null> {
  const m = await loadManifest();
  if (!m.files.length) return null;
  const entry = getCatalogEntry(catalogId);
  if (!entry || isCommandEntry(entry)) return null;
  const file = pickTowerFile(catalogId, m);
  return file ? `/assets/units/${file}` : null;
}

/** Load tower art from the same unit manifest; hides procedural silhouette on success. */
export async function requestGlbForTower(catalogId: string, placeholder: THREE.Mesh): Promise<void> {
  const m = await loadManifest();
  const file = pickTowerFile(catalogId, m);
  if (!file) return;
  await attachGlbByFile(file, placeholder, TOWER_GLB_TARGET_EXTENT, {
    hideSilhouetteUserDataKey: "structureSilhouette",
    keepPlaceholderHidden: true,
  });
}

/** Back-compat: route seeded calls to the class API (callers should prefer requestGlbForUnit). */
export async function requestGlbForSeed(seed: number, placeholder: THREE.Mesh): Promise<void> {
  await attachGlbFromManifest(seed, placeholder, 2.35);
}
