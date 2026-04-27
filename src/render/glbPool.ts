import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { KEEP_ID } from "../game/constants";
import { getCatalogEntry } from "../game/catalog";
import { unitMeshLinearSize } from "../game/sim/systems/helpers";
import { isCommandEntry, type TeamId, type UnitSizeClass } from "../game/types";

let manifest: string[] | undefined;
let manifestPromise: Promise<string[]> | null = null;
const loader = new GLTFLoader();
type GltfTemplate = { root: THREE.Object3D; animations: THREE.AnimationClip[] };
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
  return isAzureSpearSwarmFile(file) || file.startsWith(LANTERNBOUND_LINE_PREFIX);
}

function productionArtFiles(files: string[]): string[] {
  return files.filter((f) => !isPreviewUnitFile(f));
}

function attackFileForClass(kind: UnitSizeClass | "hero", files: string[]): string | null {
  if (kind === "Swarm") return files.includes(AZURE_SPEAR_SWARM_ATTACK_FILE) ? AZURE_SPEAR_SWARM_ATTACK_FILE : null;
  if (kind === "Line") return files.includes(LANTERNBOUND_LINE_ATTACK_FILE) ? LANTERNBOUND_LINE_ATTACK_FILE : null;
  return null;
}

function idleFileForClass(kind: UnitSizeClass | "hero", files: string[]): string | null {
  if (kind === "Swarm") {
    if (files.includes(AZURE_SPEAR_SWARM_IDLE_FILE)) return AZURE_SPEAR_SWARM_IDLE_FILE;
    return files.includes(AZURE_SPEAR_SWARM_IDLE_FALLBACK_FILE) ? AZURE_SPEAR_SWARM_IDLE_FALLBACK_FILE : null;
  }
  if (kind === "Line") return files.includes(LANTERNBOUND_LINE_IDLE_FILE) ? LANTERNBOUND_LINE_IDLE_FILE : null;
  return null;
}

function deathFileForClass(kind: UnitSizeClass | "hero", files: string[]): string | null {
  if (kind === "Swarm") return files.includes(AZURE_SPEAR_SWARM_DEATH_FILE) ? AZURE_SPEAR_SWARM_DEATH_FILE : null;
  if (kind === "Line") return files.includes(LANTERNBOUND_LINE_DEATH_FILE) ? LANTERNBOUND_LINE_DEATH_FILE : null;
  return null;
}

function attackPlaybackSeconds(kind: UnitSizeClass | "hero"): number | undefined {
  void kind;
  // Use authored timing. Compressing long attack files to sim cooldowns made rich
  // sequences (e.g. triple-combo) flash by as a single pose.
  return undefined;
}

function safeClip(clip: THREE.AnimationClip): THREE.AnimationClip {
  // Meshy exports often include scale keys that fight our class-based GLB normalization.
  // Keep bone position tracks: these clips use them heavily for hips/limbs, so stripping
  // them makes runs and attacks look like a single held frame instead of a full sequence.
  const tracks = clip.tracks.filter((track) => !track.name.endsWith(".scale"));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
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

function normalizeGlbInstance(inst: THREE.Object3D, targetMaxExtent: number): void {
  inst.updateMatrixWorld(true);
  const parent = inst.parent ?? undefined;
  const box = visibleMeshBounds(inst, parent);
  if (box.isEmpty()) return;
  const size = new THREE.Vector3();
  box.getSize(size);
  const max = Math.max(size.x, size.y, size.z, 1e-3);
  inst.scale.multiplyScalar(targetMaxExtent / max);
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
        const template = { root: gltf.scene, animations: gltf.animations ?? [] };
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

async function loadManifest(): Promise<string[]> {
  if (manifest !== undefined) return manifest;
  if (!manifestPromise) {
    manifestPromise = (async (): Promise<string[]> => {
      try {
        const res = await fetch("/assets/units/manifest.json", { cache: "no-store" });
        if (!res.ok) return [];
        const j = (await res.json()) as { files?: string[] };
        return j.files ?? [];
      } catch {
        return [];
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

function pickFileForClass(kind: UnitSizeClass | "hero", files: string[]): string | null {
  if (kind === "Swarm") {
    return files.includes(AZURE_SPEAR_SWARM_RUN_FILE) ? AZURE_SPEAR_SWARM_RUN_FILE : null;
  }
  if (kind === "Line") {
    return files.includes(LANTERNBOUND_LINE_RUN_FILE) ? LANTERNBOUND_LINE_RUN_FILE : null;
  }
  const classFiles = productionArtFiles(files);
  if (!classFiles.length) return null;
  const idx = CLASS_INDEX[kind] ?? 0;
  return classFiles[idx % classFiles.length] ?? classFiles[0] ?? null;
}

/** Team albedo push so GLBs keep an immediate blue-vs-red read (multiply + slight anchor lerp). */
function applyGlbTeamTint(root: THREE.Object3D, team: TeamId): void {
  const mul = team === "enemy" ? new THREE.Color(1.08, 0.78, 0.74) : new THREE.Color(0.82, 0.96, 1.08);
  const anchor = team === "enemy" ? new THREE.Color(0xef6a5a) : new THREE.Color(0x6ec9ff);
  const lerp = team === "enemy" ? 0.12 : 0.13;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const raw of mats) {
      const mat = raw as THREE.MeshStandardMaterial;
      if (mat.isMeshStandardMaterial && mat.color) {
        mat.color.multiply(mul);
        mat.color.lerp(anchor, lerp);
      }
    }
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
  if (parent.userData["glbRoot"] || parent.userData["glbPending"]) return;
  parent.userData["glbPending"] = true;

  try {
    const template = await loadGltfTemplate(url);
    const inst = cloneSkeleton(template.root);
    setShadowRecursive(inst, true, true);

    inst.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.userData["skipBuildOpacity"] = true;
    });

    placeholder.visible = false;
    parent.add(inst);
    parent.userData["glbRoot"] = inst;
    parent.userData["glbTargetMaxExtent"] = targetMaxExtent;
    parent.userData["glbClampChecksRemaining"] = 2;
    let mixer: THREE.AnimationMixer | null = null;
    if (template.animations.length > 0) {
      mixer = new THREE.AnimationMixer(inst);
      const clip = safeClip(template.animations[0]!);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.reset();
      action.play();
      parent.userData["glbMixer"] = mixer;
      parent.userData["glbAction"] = action;
      parent.userData["glbRunAction"] = action;
      parent.userData["glbBaseState"] = "run";
    }
    if (opts?.idleFile) {
      const idleTemplate = await loadGltfTemplate(`/assets/units/${opts.idleFile}`);
      const clipRaw = idleTemplate.animations[0];
      if (clipRaw) {
        mixer ??= new THREE.AnimationMixer(inst);
        const action = mixer.clipAction(safeClip(clipRaw));
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.enabled = false;
        action.setEffectiveWeight(0);
        parent.userData["glbMixer"] = mixer;
        parent.userData["glbIdleAction"] = action;
      }
    }
    if (opts?.attackFile) {
      const attackTemplate = await loadGltfTemplate(`/assets/units/${opts.attackFile}`);
      const clipRaw = attackTemplate.animations[0];
      if (clipRaw) {
        mixer ??= new THREE.AnimationMixer(inst);
        const clip = safeClip(clipRaw);
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = false;
        action.enabled = false;
        action.setEffectiveWeight(0);
        const playback = opts.attackPlaybackSeconds ?? clip.duration;
        action.timeScale = clip.duration / Math.max(0.05, playback);
        parent.userData["glbMixer"] = mixer;
        parent.userData["glbAttackAction"] = action;
        parent.userData["glbAttackDuration"] = playback;
      }
    }
    if (opts?.deathFile) {
      const deathTemplate = await loadGltfTemplate(`/assets/units/${opts.deathFile}`);
      const clipRaw = deathTemplate.animations[0];
      if (clipRaw) {
        mixer ??= new THREE.AnimationMixer(inst);
        const clip = safeClip(clipRaw);
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
    if (mixer) mixer.update(0);
    parent.userData["glbAnimationReady"] = !!mixer;
    if (opts?.animationRoleLabel) {
      const missing = [
        parent.userData["glbRunAction"] ? "" : "run",
        opts.idleFile && !parent.userData["glbIdleAction"] ? "idle" : "",
        opts.attackFile && !parent.userData["glbAttackAction"] ? "attack" : "",
        opts.deathFile && !parent.userData["glbDeathAction"] ? "death" : "",
      ].filter(Boolean);
      const warnKey = `${opts.animationRoleLabel}:${missing.join(",") || "all"}`;
      if ((!mixer || missing.length > 0) && !warnedAnimationRoles.has(warnKey)) {
        warnedAnimationRoles.add(warnKey);
        console.warn(`[glb] ${opts.animationRoleLabel} missing animation roles: ${missing.join(", ") || "all"}`, file);
      }
    }
    normalizeGlbInstance(inst, targetMaxExtent);

    if (opts?.teamTint) applyGlbTeamTint(inst, opts.teamTint);

    const hideKey = opts?.hideSilhouetteUserDataKey;
    if (hideKey) {
      const silo = parent.userData[hideKey] as THREE.Object3D | undefined;
      if (silo) silo.visible = false;
    }
  } catch {
    placeholder.visible = true;
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
  const files = await loadManifest();
  const file = pickFile(seed, productionArtFiles(files));
  if (!file) return;
  await attachGlbByFile(file, placeholder, targetMaxExtent);
}

/** Stable, class-to-file GLB swap. */
export async function attachGlbForClass(
  kind: UnitSizeClass | "hero",
  placeholder: THREE.Mesh,
  targetMaxExtent: number,
  teamTint?: TeamId,
): Promise<void> {
  const files = await loadManifest();
  const file = pickFileForClass(kind, files);
  if (!file) return;
  await attachGlbByFile(file, placeholder, targetMaxExtent, {
    ...(teamTint ? { teamTint } : {}),
    attackFile: attackFileForClass(kind, files),
    idleFile: idleFileForClass(kind, files),
    deathFile: deathFileForClass(kind, files),
    attackPlaybackSeconds: attackPlaybackSeconds(kind),
    ...(kind === "Swarm" || kind === "Line" ? { animationRoleLabel: kind } : {}),
  });
}

/** Unit GLBs normalize to the canonical tower-derived ladder exactly (1.5× per tier). */
export async function requestGlbForUnit(
  kind: UnitSizeClass,
  placeholder: THREE.Mesh,
  team: TeamId = "player",
): Promise<void> {
  const extent = unitMeshLinearSize(kind);
  await attachGlbForClass(kind, placeholder, extent, team);
}

export async function requestGlbForHero(placeholder: THREE.Mesh): Promise<void> {
  await attachGlbForClass("hero", placeholder, 3.0, "player");
}

/** Player towers: canonical max extent. Titan units use the same target, lower classes step down. */
export const TOWER_GLB_TARGET_EXTENT = unitMeshLinearSize("Titan");

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

function towerManifestIndex(catalogId: string): number {
  const i = (TOWER_GLB_MANIFEST_ORDER as readonly string[]).indexOf(catalogId);
  if (i >= 0) return i;
  return hashStringToSeed(catalogId) % TOWER_GLB_MANIFEST_ORDER.length;
}

function pickTowerFile(catalogId: string, files: string[]): string | null {
  const towerFiles = productionArtFiles(files);
  if (!towerFiles.length) return null;
  return towerFiles[towerManifestIndex(catalogId) % towerFiles.length] ?? null;
}

/** Root-relative GLB URL for doctrine card thumbnail (structures only — spells use SVG art). */
export async function getCatalogPreviewAssetUrl(catalogId: string): Promise<string | null> {
  const files = await loadManifest();
  if (!files.length) return null;
  const entry = getCatalogEntry(catalogId);
  if (!entry) return null;
  if (isCommandEntry(entry)) return null;
  const file = pickTowerFile(catalogId, files);
  return file ? `/assets/units/${file}` : null;
}

/** Load tower art from the same unit manifest; hides procedural silhouette on success. */
export async function requestGlbForTower(catalogId: string, placeholder: THREE.Mesh): Promise<void> {
  const files = await loadManifest();
  const file = pickTowerFile(catalogId, files);
  if (!file) return;
  await attachGlbByFile(file, placeholder, TOWER_GLB_TARGET_EXTENT, {
    hideSilhouetteUserDataKey: "structureSilhouette",
  });
}

/** Back-compat: route seeded calls to the class API (callers should prefer requestGlbForUnit). */
export async function requestGlbForSeed(seed: number, placeholder: THREE.Mesh): Promise<void> {
  await attachGlbFromManifest(seed, placeholder, 2.35);
}
