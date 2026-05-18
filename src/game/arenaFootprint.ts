/**
 * Playable XZ footprints on plane maps (and optional circular cap on spheres).
 * `world.halfExtents` remains the outer sim safety bound.
 */
import type { MapArenaFootprint, MapArenaFootprintKind, MapData, Vec2 } from "./types";

function half(map: MapData): number {
  return map.world.halfExtents;
}

function isSphereMap(map: MapData): boolean {
  const r = map.world.sphereRadius;
  return map.worldGeometry === "sphere" && r != null && Number.isFinite(r) && r > 1;
}

function fp(map: MapData): MapArenaFootprint | undefined {
  return map.world.arenaFootprint;
}

export function arenaFootprintKind(map: MapData): MapArenaFootprintKind {
  return fp(map)?.kind ?? "rectangle";
}

/** Semi-axes for ellipse / diamond / capsule math (world units). */
export function planeArenaSemiAxes(map: MapData): { ax: number; bz: number } {
  const H = half(map);
  const f = fp(map);
  const ax = H * (f?.semiAxisXMult ?? 1);
  const bz = H * (f?.semiAxisZMult ?? 1);
  return { ax: Math.max(8, ax), bz: Math.max(8, bz) };
}

function circleRadius(map: MapData): number {
  const H = half(map);
  const m = fp(map)?.radiusMult ?? 1;
  return Math.max(12, H * m);
}

function capsuleParams(map: MapData, _axis: "x" | "z"): { L: number; R: number } {
  const H = half(map);
  const f = fp(map);
  const L = H * Math.max(0.12, f?.capsuleLengthMult ?? 0.62);
  const R = H * Math.max(0.06, f?.capsuleRadiusMult ?? 0.24);
  return { L, R };
}

function twinLobeParams(map: MapData): { c: number; r: number } {
  const H = half(map);
  const f = fp(map);
  const c = H * (f?.lobeCenterMult ?? 0.36);
  const r = H * (f?.lobeRadiusMult ?? 0.58);
  return { c: Math.max(4, c), r: Math.max(10, r) };
}

/** Max tangent-plane radius from pole for spherical maps (respects circular footprint when set). */
export function sphereTangentCapRadius(map: MapData): number {
  if (!isSphereMap(map)) return half(map);
  return arenaFootprintKind(map) === "circle" ? circleRadius(map) : half(map);
}

/** Tangent-plane radial clamp (same cap as spherical {@link clampWorldArena}). */
function clampSphereTangentCap(map: MapData, p: Vec2): Vec2 {
  const cap = sphereTangentCapRadius(map);
  const len = Math.hypot(p.x, p.z);
  if (len <= cap || len < 1e-12) return { x: p.x, z: p.z };
  const s = cap / len;
  return { x: p.x * s, z: p.z * s };
}

function distPointToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz || 1;
  let t = (apx * abx + apz * abz) / ab2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + abx * t;
  const qz = az + abz * t;
  return Math.hypot(px - qx, pz - qz);
}

function closestOnSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): Vec2 {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz || 1;
  let t = (apx * abx + apz * abz) / ab2;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + abx * t, z: az + abz * t };
}

/** True if `p` lies inside the arena footprint (tangent plane). */
export function insidePlaneArena(map: MapData, p: Vec2): boolean {
  const x = p.x;
  const z = p.z;
  if (isSphereMap(map)) {
    const cap = sphereTangentCapRadius(map);
    return x * x + z * z <= cap * cap + 1e-9;
  }
  const H = half(map);
  const kind = arenaFootprintKind(map);
  if (kind === "rectangle") {
    return Math.abs(x) <= H && Math.abs(z) <= H;
  }
  if (kind === "circle") {
    const R = circleRadius(map);
    return x * x + z * z <= R * R;
  }
  if (kind === "ellipse") {
    const { ax, bz } = planeArenaSemiAxes(map);
    return (x / ax) * (x / ax) + (z / bz) * (z / bz) <= 1 + 1e-9;
  }
  if (kind === "diamond") {
    const { ax, bz } = planeArenaSemiAxes(map);
    return Math.abs(x) / ax + Math.abs(z) / bz <= 1 + 1e-9;
  }
  if (kind === "capsule_x") {
    const { L, R } = capsuleParams(map, "x");
    return distPointToSegment(x, z, -L, 0, L, 0) <= R + 1e-6;
  }
  if (kind === "capsule_z") {
    const { L, R } = capsuleParams(map, "z");
    return distPointToSegment(x, z, 0, -L, 0, L) <= R + 1e-6;
  }
  if (kind === "twin_lobes") {
    const { c, r } = twinLobeParams(map);
    const d0 = Math.hypot(x + c, z);
    const d1 = Math.hypot(x - c, z);
    return d0 <= r + 1e-6 || d1 <= r + 1e-6;
  }
  return Math.abs(x) <= H && Math.abs(z) <= H;
}

/**
 * Clamp `p` to the boundary of the arena footprint.
 * Callers should still respect the outer `halfExtents` box for safety where needed.
 */
export function clampPlaneArena(map: MapData, p: Vec2): Vec2 {
  if (insidePlaneArena(map, p)) return { x: p.x, z: p.z };
  if (isSphereMap(map)) {
    return clampSphereTangentCap(map, p);
  }
  const x = p.x;
  const z = p.z;
  const H = half(map);
  const kind = arenaFootprintKind(map);

  if (kind === "rectangle") {
    return {
      x: Math.max(-H, Math.min(H, x)),
      z: Math.max(-H, Math.min(H, z)),
    };
  }
  if (kind === "circle") {
    const R = circleRadius(map);
    const len = Math.hypot(x, z) || 1;
    const s = R / len;
    return { x: x * s, z: z * s };
  }
  if (kind === "ellipse") {
    const { ax, bz } = planeArenaSemiAxes(map);
    const k = Math.hypot(x / ax, z / bz) || 1;
    const s = 1 / k;
    return { x: x * s, z: z * s };
  }
  if (kind === "diamond") {
    const { ax, bz } = planeArenaSemiAxes(map);
    const m = Math.abs(x) / ax + Math.abs(z) / bz || 1;
    const s = 1 / m;
    return { x: x * s, z: z * s };
  }
  if (kind === "capsule_x") {
    const { L, R } = capsuleParams(map, "x");
    const q = closestOnSegment(x, z, -L, 0, L, 0);
    const dx = x - q.x;
    const dz = z - q.z;
    const d = Math.hypot(dx, dz) || 1;
    const s = R / d;
    return { x: q.x + dx * s, z: q.z + dz * s };
  }
  if (kind === "capsule_z") {
    const { L, R } = capsuleParams(map, "z");
    const q = closestOnSegment(x, z, 0, -L, 0, L);
    const dx = x - q.x;
    const dz = z - q.z;
    const d = Math.hypot(dx, dz) || 1;
    const s = R / d;
    return { x: q.x + dx * s, z: q.z + dz * s };
  }
  if (kind === "twin_lobes") {
    const { c, r } = twinLobeParams(map);
    const c0 = { x: -c, z: 0 };
    const c1 = { x: c, z: 0 };
    const d0 = Math.hypot(x - c0.x, z - c0.z);
    const d1 = Math.hypot(x - c1.x, z - c1.z);
    const pick = d0 <= d1 ? c0 : c1;
    const len = Math.hypot(x - pick.x, z - pick.z) || 1;
    const s = r / len;
    return { x: pick.x + (x - pick.x) * s, z: pick.z + (z - pick.z) * s };
  }
  return {
    x: Math.max(-H, Math.min(H, x)),
    z: Math.max(-H, Math.min(H, z)),
  };
}

/**
 * Clamp to the footprint shrunk uniformly by scaling `halfExtents` by `(H-pad)/H`.
 */
export function clampPlaneArenaPadded(map: MapData, p: Vec2, pad: number): Vec2 {
  const H0 = half(map);
  const H1 = Math.max(12, H0 - pad);
  if (pad <= 0 || H1 >= H0 - 1e-6) return clampPlaneArena(map, p);
  const scaled: MapData = { ...map, world: { ...map.world, halfExtents: H1 } };
  return clampPlaneArena(scaled, p);
}

/** Rejection sample inside footprint; falls back to center clamp. */
export function samplePointInArenaFootprint(map: MapData, rnd: () => number, edgePad = 10): Vec2 {
  const H = half(map);
  const innerR = Math.max(12, H - edgePad);
  if (isSphereMap(map)) {
    const cap = sphereTangentCapRadius({ ...map, world: { ...map.world, halfExtents: innerR } });
    for (let i = 0; i < 160; i++) {
      const x = (rnd() * 2 - 1) * H;
      const z = (rnd() * 2 - 1) * H;
      if (x * x + z * z > cap * cap) continue;
      return clampSphereTangentCap(map, { x, z });
    }
    return clampSphereTangentCap(map, { x: 0, z: 0 });
  }
  const innerMap: MapData = { ...map, world: { ...map.world, halfExtents: innerR } };
  for (let i = 0; i < 140; i++) {
    const x = (rnd() * 2 - 1) * H;
    const z = (rnd() * 2 - 1) * H;
    const q = { x, z };
    if (!insidePlaneArena(innerMap, q)) continue;
    return clampPlaneArena(map, q);
  }
  return clampPlaneArena(map, { x: 0, z: 0 });
}
