import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

let manifest: string[] | null = null;
const loader = new GLTFLoader();
/** Cached *template* roots (never added to scene). */
const cache = new Map<string, THREE.Object3D>();

export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function loadManifest(): Promise<string[]> {
  if (manifest) return manifest;
  try {
    const res = await fetch("/assets/units/manifest.json");
    if (!res.ok) return [];
    const j = (await res.json()) as { files?: string[] };
    manifest = j.files ?? [];
  } catch {
    manifest = [];
  }
  return manifest;
}

function pickFile(seed: number, files: string[]): string | null {
  if (!files.length) return null;
  return files[seed % files.length] ?? null;
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

/**
 * Loads a Meshy GLB from `/assets/units/` (manifest), scales to `targetMaxExtent`,
 * grounds + centers on XZ, hides the placeholder cube, and parents the model under the same group.
 */
export async function attachGlbFromManifest(
  seed: number,
  placeholder: THREE.Mesh,
  targetMaxExtent: number,
): Promise<void> {
  const files = await loadManifest();
  const file = pickFile(seed, files);
  if (!file) return;
  const url = `/assets/units/${file}`;
  const parent = placeholder.parent as THREE.Group | null;
  if (!parent) return;
  if (parent.userData["glbRoot"] || parent.userData["glbPending"]) return;
  parent.userData["glbPending"] = true;

  try {
    let template = cache.get(url);
    if (!template) {
      const gltf = await loader.loadAsync(url);
      template = gltf.scene;
      cache.set(url, template);
    }
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

    placeholder.visible = false;
    parent.add(inst);
    parent.userData["glbRoot"] = inst;
  } catch {
    placeholder.visible = true;
  } finally {
    delete parent.userData["glbPending"];
  }
}

/** Default unit scale target for GLB swap (world units). */
export async function requestGlbForSeed(seed: number, placeholder: THREE.Mesh): Promise<void> {
  await attachGlbFromManifest(seed, placeholder, 2.35);
}
