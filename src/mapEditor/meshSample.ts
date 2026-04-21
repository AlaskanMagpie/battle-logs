import * as THREE from "three";

/** Collect all meshes under `root` (world matrices updated). */
export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  root.updateMatrixWorld(true);
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) out.push(m);
  });
  return out;
}

/**
 * Sample points on terrain by casting vertical rays from random XZ into downward Y.
 * Works for arbitrary GLB topology; rejects samples closer than `minSep` in XZ to prior picks.
 */
export function sampleTerrainSurface(
  terrainMeshes: THREE.Object3D[],
  halfExtents: number,
  count: number,
  rng: () => number,
  minSep: number,
): THREE.Vector3[] {
  if (terrainMeshes.length === 0 || count <= 0) return [];
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3(0, -1, 0);
  const out: THREE.Vector3[] = [];
  const min2 = minSep * minSep;
  const span = halfExtents * 0.94;
  const maxAttempts = 8000;

  for (let n = 0; n < count; n++) {
    let placed = false;
    for (let a = 0; a < maxAttempts && !placed; a++) {
      const x = (rng() * 2 - 1) * span;
      const z = (rng() * 2 - 1) * span;
      origin.set(x, 520, z);
      ray.set(origin, dir);
      const hits = ray.intersectObjects(terrainMeshes, true);
      const p = hits[0]?.point;
      if (!p) continue;
      let ok = true;
      for (const q of out) {
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        if (dx * dx + dz * dz < min2) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(p.clone());
      placed = true;
    }
  }
  return out;
}
