import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getCatalogEntry } from "../game/catalog";
import { isCommandEntry, type TeamId, type UnitSizeClass } from "../game/types";

let manifest: string[] | undefined;
let manifestPromise: Promise<string[]> | null = null;
const loader = new GLTFLoader();
/** Cached *template* roots (never added to scene). */
const cache = new Map<string, THREE.Object3D>();
/** In-flight loads: many units can request the same manifest URL before the first parse finishes. */
const templateLoadPromises = new Map<string, Promise<THREE.Object3D>>();

/** Cached GLTF root for a manifest URL (used by towers/units and card thumbnails). */
export async function loadGltfTemplateRoot(url: string): Promise<THREE.Object3D> {
  const done = cache.get(url);
  if (done) return done;

  let p = templateLoadPromises.get(url);
  if (!p) {
    p = loader
      .loadAsync(url)
      .then((gltf) => {
        const root = gltf.scene;
        cache.set(url, root);
        templateLoadPromises.delete(url);
        return root;
      })
      .catch((err) => {
        templateLoadPromises.delete(url);
        throw err;
      });
    templateLoadPromises.set(url, p);
  }
  return p;
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
        const res = await fetch("/assets/units/manifest.json");
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
  if (!files.length) return null;
  const idx = CLASS_INDEX[kind] ?? 0;
  return files[idx % files.length] ?? files[0] ?? null;
}

/** Team albedo push so GLBs keep an immediate blue-vs-red read. */
function applyGlbTeamTint(root: THREE.Object3D, team: TeamId): void {
  const mul = team === "enemy" ? new THREE.Color(1.16, 0.62, 0.62) : new THREE.Color(0.68, 0.88, 1.18);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const raw of mats) {
      const mat = raw as THREE.MeshStandardMaterial;
      if (mat.isMeshStandardMaterial && mat.color) mat.color.multiply(mul);
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
    const template = await loadGltfTemplateRoot(url);
    const inst = template.clone(true);
    setShadowRecursive(inst, true, true);

    const box = new THREE.Box3().setFromObject(inst);
    const size = new THREE.Vector3();
    box.getSize(size);
    const max = Math.max(size.x, size.y, size.z, 1e-3);
    inst.scale.setScalar(targetMaxExtent / max);

    const b2 = new THREE.Box3().setFromObject(inst);
    inst.position.x = -(b2.min.x + b2.max.x) / 2;
    inst.position.z = -(b2.min.z + b2.max.z) / 2;
    inst.position.y = -b2.min.y;

    inst.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.userData["skipBuildOpacity"] = true;
    });

    placeholder.visible = false;
    parent.add(inst);
    parent.userData["glbRoot"] = inst;

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
  const file = pickFile(seed, files);
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
  await attachGlbByFile(file, placeholder, targetMaxExtent, teamTint ? { teamTint } : undefined);
}

/** Default per-class target extent (world units). Kept in scale with procedural silhouettes. */
export async function requestGlbForUnit(
  kind: UnitSizeClass,
  placeholder: THREE.Mesh,
  team: TeamId = "player",
): Promise<void> {
  const extent = kind === "Swarm" ? 1.4 : kind === "Line" ? 1.9 : kind === "Heavy" ? 2.6 : 3.4;
  await attachGlbForClass(kind, placeholder, extent, team);
}

export async function requestGlbForHero(placeholder: THREE.Mesh): Promise<void> {
  await attachGlbForClass("hero", placeholder, 3.0, "player");
}

/** Line unit default max extent in `requestGlbForUnit` — towers scale relative to this. */
const UNIT_EXTENT_LINE = 1.9;

/** Player towers: GLB is normalized so max axis ≈ this (≥ 4× Line unit silhouette). */
export const TOWER_GLB_TARGET_EXTENT = UNIT_EXTENT_LINE * 4;

/**
 * First 10 structure catalog ids map 1:1 to `manifest.json` `files[0..9]` once the
 * log-tower GLBs are present under `public/assets/units/`. Any other structure id
 * picks a file by stable hash modulo length.
 */
const TOWER_GLB_MANIFEST_ORDER = [
  "outpost",
  "watchtower",
  "root_bunker",
  "menders_hut",
  "siege_works",
  "bastion_keep",
  "salvage_yard",
  "war_camp",
  "dragon_roost",
  "ironhold_citadel",
] as const;

function towerManifestIndex(catalogId: string): number {
  const i = (TOWER_GLB_MANIFEST_ORDER as readonly string[]).indexOf(catalogId);
  if (i >= 0) return i;
  return hashStringToSeed(catalogId) % TOWER_GLB_MANIFEST_ORDER.length;
}

function pickTowerFile(catalogId: string, files: string[]): string | null {
  if (!files.length) return null;
  return files[towerManifestIndex(catalogId) % files.length] ?? null;
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
