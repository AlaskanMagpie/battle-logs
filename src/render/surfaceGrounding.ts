/**
 * Snap logical map coordinates (plane XZ or sphere tangent XZ) onto the **rendered** ground mesh:
 * imported terrain GLBs when present, otherwise the procedural `ground` mesh (plane or sphere).
 *
 * Uses a short ray cast along −hintUp from above the analytical foot so hills, convex shells,
 * and uneven authored meshes win over the smooth analytic shell.
 *
 * **Debug:** open a match with `?groundingDebug=1` — `GameRenderer` fills `window.__battleLogsGrounding`.
 */
import * as THREE from "three";
import type { MapData, Vec2 } from "../game/types";
import { isSphereWorld, surfaceNormalFromTan, worldFootXYZ } from "../game/surface";

/** Start this far along hint-up from the analytical foot (world units). */
export const SURFACE_GROUND_CAST_ABOVE = 160;
/** Max ray length along −hintUp (world units). */
export const SURFACE_GROUND_CAST_MAX = 720;
/** Burrow along −normal after a hit (units/heroes; stacks with structure bury in scene.ts). */
export const SURFACE_GROUND_FOOT_BIAS = 0.72;
/** Reject hits whose normals tilt away from the analytic “up” (undercuts / interior faces). */
export const SURFACE_GROUND_MIN_UP_DOT = 0.12;

function analyticalFootWorld(map: MapData, tan: Vec2, yLift: number, out: THREE.Vector3): THREE.Vector3 {
  const p = worldFootXYZ(map, tan, yLift);
  return out.set(p.x, p.y, p.z);
}

function analyticalHintUp(map: MapData, tan: Vec2, out: THREE.Vector3): THREE.Vector3 {
  if (!isSphereWorld(map)) return out.set(0, 1, 0);
  const n = surfaceNormalFromTan(map, tan);
  return out.set(n[0], n[1], n[2]).normalize();
}

function worldNormalFromIntersection(hit: THREE.Intersection, target: THREE.Vector3): THREE.Vector3 | null {
  if (hit.normal) return target.copy(hit.normal).normalize();
  const mesh = hit.object as THREE.Mesh;
  if (!mesh.isMesh || !hit.face) return null;
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  return target.copy(hit.face.normal).applyMatrix3(nm).normalize();
}

/**
 * Returns true if a shell hit was found. On success, `outPosition` is biased slightly into the surface
 * along −`outNormal`; `outNormal` points outward (same hemisphere as `hintUp`).
 */
export function sampleRenderableSurfaceFoot(
  map: MapData,
  tan: Vec2,
  analyticalYLift: number,
  raycaster: THREE.Raycaster,
  targets: THREE.Object3D[],
  tmpAnalytical: THREE.Vector3,
  tmpHintUp: THREE.Vector3,
  tmpOrigin: THREE.Vector3,
  tmpDir: THREE.Vector3,
  tmpNormScratch: THREE.Vector3,
  outPosition: THREE.Vector3,
  outNormal: THREE.Vector3,
): boolean {
  if (targets.length === 0) return false;

  analyticalFootWorld(map, tan, analyticalYLift, tmpAnalytical);
  analyticalHintUp(map, tan, tmpHintUp);

  tmpOrigin.copy(tmpAnalytical).addScaledVector(tmpHintUp, SURFACE_GROUND_CAST_ABOVE);
  tmpDir.copy(tmpHintUp).multiplyScalar(-1).normalize();

  raycaster.set(tmpOrigin, tmpDir);
  raycaster.far = SURFACE_GROUND_CAST_MAX;
  raycaster.near = 0.02;

  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length === 0) return false;

  let best: THREE.Intersection | null = null;
  let bestDot = -Infinity;
  for (const h of hits) {
    const n = worldNormalFromIntersection(h, tmpNormScratch);
    if (!n) continue;
    const align = n.dot(tmpHintUp);
    if (align < SURFACE_GROUND_MIN_UP_DOT) continue;
    if (align > bestDot) {
      bestDot = align;
      best = h;
    }
  }
  const hit = best ?? hits[0]!;
  const n = worldNormalFromIntersection(hit, tmpNormScratch);
  if (!n) return false;

  if (n.dot(tmpHintUp) < 0) n.multiplyScalar(-1);

  outNormal.copy(n);
  outPosition.copy(hit.point).addScaledVector(outNormal, -SURFACE_GROUND_FOOT_BIAS);
  return true;
}
