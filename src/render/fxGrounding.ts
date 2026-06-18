/**
 * Places procedural FX on analytic plane/sphere feet and optionally snaps to terrain meshes
 * (same ray path as units via FxHost.sampleSurface).
 */
import * as THREE from "three";
import type { MapData, Vec2 } from "../game/types";
import {
  greatCircleTangentToward,
  isSphereWorld,
  surfaceNormalFromTan,
  worldFootXYZ,
} from "../game/surface";

const REF_UP = new THREE.Vector3(0, 1, 0);

/** Minimal host slice for resolver (avoids circular import with fx.ts). */
export type FxFootHost = {
  map: MapData | null;
  mobileLod: boolean;
  sampleSurface?: (
    tan: Vec2,
    analyticalYLift: number,
    outPos: THREE.Vector3,
    outNorm: THREE.Vector3,
  ) => boolean;
};

export function analyticFoot(out: THREE.Vector3, map: MapData | null, tan: Vec2, yBias: number): void {
  if (!map) {
    out.set(tan.x, yBias, tan.z);
    return;
  }
  const p = worldFootXYZ(map, tan, yBias);
  out.set(p.x, p.y, p.z);
}

export function analyticNormal(out: THREE.Vector3, map: MapData | null, tan: Vec2): void {
  if (!map) {
    out.set(0, 1, 0);
    return;
  }
  const n = surfaceNormalFromTan(map, tan);
  out.set(n[0], n[1], n[2]);
}

/** Unit tangent-forward from `fromTan` toward `toTan` (great-circle on sphere, XZ on plane). */
export function tangentForwardWorld(out: THREE.Vector3, map: MapData | null, fromTan: Vec2, toTan: Vec2): void {
  if (!map || !isSphereWorld(map)) {
    const dx = toTan.x - fromTan.x;
    const dz = toTan.z - fromTan.z;
    const len = Math.hypot(dx, dz) || 1;
    out.set(dx / len, 0, dz / len);
    return;
  }
  const t = greatCircleTangentToward(map, fromTan, toTan);
  out.set(t[0], t[1], t[2]);
}

/** Remove component along `unitNormal`, then normalize; fallback axis if degenerate. */
export function projectOntoTangentPlane(
  out: THREE.Vector3,
  v: THREE.Vector3,
  unitNormal: THREE.Vector3,
  scratch: THREE.Vector3,
): void {
  const d = v.dot(unitNormal);
  scratch.copy(unitNormal).multiplyScalar(d);
  out.copy(v).sub(scratch);
  const len = out.length();
  if (len < 1e-8) {
    const ax = Math.abs(unitNormal.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    out.crossVectors(unitNormal, ax);
    if (out.lengthSq() < 1e-10) out.crossVectors(unitNormal, new THREE.Vector3(0, 0, 1));
    out.normalize();
  } else {
    out.multiplyScalar(1 / len);
  }
}

const _basisTmp = new THREE.Vector3();

/** Orthonormal tangent basis at anchor: right = N×F, up = N, forward = F (cone local +Z). */
export function buildConeBasis(
  foot: THREE.Vector3,
  forwardRaw: THREE.Vector3,
  unitNormal: THREE.Vector3,
  outMat: THREE.Matrix4,
  scratchF: THREE.Vector3,
  scratchR: THREE.Vector3,
): void {
  projectOntoTangentPlane(scratchF, forwardRaw, unitNormal, _basisTmp);
  scratchR.crossVectors(unitNormal, scratchF).normalize();
  outMat.makeBasis(scratchR, unitNormal, scratchF);
  outMat.setPosition(foot);
}

/** Horizontal decal whose default normal is +Y maps to `unitNormal` (must be non-zero). */
export function quatAlignYToNormal(out: THREE.Quaternion, unitNormal: THREE.Vector3): void {
  _basisTmp.copy(unitNormal);
  if (_basisTmp.lengthSq() < 1e-12) {
    out.identity();
    return;
  }
  _basisTmp.normalize();
  if (Math.abs(_basisTmp.dot(REF_UP)) > 0.99999) {
    out.identity();
    return;
  }
  out.setFromUnitVectors(REF_UP, _basisTmp);
}

/**
 * Resolve foot position + outward normal. Terrain snap when allowed and host provides sampler.
 */
export function resolveFxFoot(
  host: FxFootHost,
  tan: Vec2,
  yBias: number,
  preferTerrainSnap: boolean,
  outPos: THREE.Vector3,
  outNorm: THREE.Vector3,
): void {
  const allowSnap =
    preferTerrainSnap && host.sampleSurface && !host.mobileLod && host.sampleSurface(tan, yBias, outPos, outNorm);
  if (allowSnap) return;
  analyticFoot(outPos, host.map, tan, yBias);
  analyticNormal(outNorm, host.map, tan);
}
