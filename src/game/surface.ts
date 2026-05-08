/**
 * Spherical planet surface using tangent-plane coordinates from the north pole (+Y).
 * Positions match existing Vec2 {x,z}: arc-length offsets in the horizontal plane through the pole.
 */
import type { MapData, Vec2 } from "./types";

const UP: [number, number, number] = [0, 1, 0];

export function isSphereWorld(map: MapData | undefined | null): boolean {
  if (!map?.world) return false;
  const r = map.world.sphereRadius;
  return map.worldGeometry === "sphere" && r != null && Number.isFinite(r) && r > 1;
}

export function sphereRadiusOf(map: MapData): number {
  const r = map.world.sphereRadius;
  if (r != null && Number.isFinite(r) && r > 1) return r;
  return Math.max(120, map.world.halfExtents * 2);
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function len3(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const l = len3(v);
  if (l < 1e-12) return [0, 1, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

function scale3(v: [number, number, number], s: number): [number, number, number] {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function add3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Unit sphere direction from tangent-plane coords at north pole (exp map). */
export function unitFromTangentAtPole(x: number, z: number, R: number): [number, number, number] {
  const len = Math.hypot(x, z);
  if (len < 1e-12) return [0, 1, 0];
  const theta = len / R;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const ux = x / len;
  const uz = z / len;
  return [s * ux, c, s * uz];
}

/** Inverse: tangent-plane coords from unit direction (north-pole chart). */
export function tangentFromUnitAtPole(nx: number, ny: number, nz: number, R: number): Vec2 {
  const h = Math.hypot(nx, nz);
  if (h < 1e-12) return { x: 0, z: 0 };
  const theta = Math.acos(Math.max(-1, Math.min(1, ny)));
  const r = theta * R;
  return { x: (nx / h) * r, z: (nz / h) * r };
}

export function vec2ToUnit(map: MapData, p: Vec2): [number, number, number] {
  return unitFromTangentAtPole(p.x, p.z, sphereRadiusOf(map));
}

export function unitToVec2(map: MapData, nx: number, ny: number, nz: number): Vec2 {
  return tangentFromUnitAtPole(nx, ny, nz, sphereRadiusOf(map));
}

/** Squared chord length in world units between surface positions (monotonic with geodesic distance). */
export function chordDist2SqWorld(map: MapData | undefined | null, a: Vec2, b: Vec2): number {
  if (!map?.world || !isSphereWorld(map)) {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }
  const R = sphereRadiusOf(map);
  const u = unitFromTangentAtPole(a.x, a.z, R);
  const v = unitFromTangentAtPole(b.x, b.z, R);
  const dx = (u[0] - v[0]) * R;
  const dy = (u[1] - v[1]) * R;
  const dz = (u[2] - v[2]) * R;
  return dx * dx + dy * dy + dz * dz;
}

export function clampOrderXZ(map: MapData, p: Vec2): Vec2 {
  if (!isSphereWorld(map)) {
    const h = map.world.halfExtents;
    return { x: Math.max(-h, Math.min(h, p.x)), z: Math.max(-h, Math.min(h, p.z)) };
  }
  return clampWorldArena(map, p);
}

/** Clamp radial distance from pole in tangent plane to halfExtents (matches legacy square bound as circular cap). */
export function clampWorldArena(map: MapData, p: Vec2): Vec2 {
  const half = map.world.halfExtents;
  const len = Math.hypot(p.x, p.z);
  if (len <= half || len < 1e-12) return { x: p.x, z: p.z };
  const s = half / len;
  return { x: p.x * s, z: p.z * s };
}

export function tangentEastNorth(n: [number, number, number]): {
  east: [number, number, number];
  north: [number, number, number];
} {
  let east = cross3(UP, n);
  let el = len3(east);
  if (el < 1e-8) {
    east = [1, 0, 0];
    el = 1;
  } else {
    east = [east[0] / el, east[1] / el, east[2] / el];
  }
  const north = normalize3(cross3(n, east));
  return { east, north };
}

/** Rodrigues: rotate vector `v` around unit axis `k` by angle `theta`. */
function rotateRodrigues(v: [number, number, number], k: [number, number, number], theta: number): [number, number, number] {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const cr = cross3(k, v);
  const kd = dot3(k, v);
  return normalize3(
    add3(add3(scale3(v, cosT), scale3(cr, sinT)), scale3(k, kd * (1 - cosT))),
  );
}

/** Move from `from` toward `to` by at most `stepWorld` meters along the great circle (surface). */
export function stepGreatCircleToward(map: MapData, from: Vec2, to: Vec2, stepWorld: number): Vec2 {
  if (!isSphereWorld(map)) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    if (len <= stepWorld) return { x: to.x, z: to.z };
    const f = stepWorld / len;
    return { x: from.x + dx * f, z: from.z + dz * f };
  }
  const R = sphereRadiusOf(map);
  const u0 = unitFromTangentAtPole(from.x, from.z, R);
  const u1 = unitFromTangentAtPole(to.x, to.z, R);
  let dotp = dot3(u0, u1);
  dotp = Math.max(-1, Math.min(1, dotp));
  const omega = Math.acos(dotp);
  if (!Number.isFinite(omega) || omega < 1e-9) return from;
  const maxStep = stepWorld / R;
  if (omega <= maxStep) return { x: to.x, z: to.z };
  let axis = cross3(u0, u1);
  const al = len3(axis);
  if (al < 1e-14) return from;
  axis = [axis[0] / al, axis[1] / al, axis[2] / al];
  const nu = rotateRodrigues(u0, axis, maxStep);
  return tangentFromUnitAtPole(nu[0], nu[1], nu[2], R);
}

/** WASD / world-XZ velocity (dx,dz) mapped through tangent frame at current position. */
export function stepDirectionXZ(map: MapData, pos: Vec2, dirXZx: number, dirXZz: number, stepWorld: number): Vec2 {
  if (!isSphereWorld(map)) {
    const len = Math.hypot(dirXZx, dirXZz);
    if (len < 1e-12) return pos;
    const nx = dirXZx / len;
    const nz = dirXZz / len;
    return {
      x: pos.x + nx * stepWorld,
      z: pos.z + nz * stepWorld,
    };
  }
  const R = sphereRadiusOf(map);
  const n = unitFromTangentAtPole(pos.x, pos.z, R);
  const { east, north } = tangentEastNorth(n);
  const len = Math.hypot(dirXZx, dirXZz);
  if (len < 1e-12) return pos;
  const mx = dirXZx / len;
  const mz = dirXZz / len;
  const tv = normalize3(add3(scale3(east, mx), scale3(north, mz)));
  const w = stepWorld / R;
  const nu = normalize3(add3(scale3(n, Math.cos(w)), scale3(tv, Math.sin(w))));
  return tangentFromUnitAtPole(nu[0], nu[1], nu[2], R);
}

/** Ring offset for production spawns: small-circle arc `ringR` at `angleRad` around `center`. */
export function ringPointOnSphere(map: MapData, center: Vec2, angleRad: number, ringR: number): Vec2 {
  if (!isSphereWorld(map)) {
    return {
      x: center.x + Math.cos(angleRad) * ringR,
      z: center.z + Math.sin(angleRad) * ringR,
    };
  }
  const R = sphereRadiusOf(map);
  const nc = unitFromTangentAtPole(center.x, center.z, R);
  const { east, north } = tangentEastNorth(nc);
  const w = ringR / R;
  const dir = normalize3(add3(scale3(east, Math.cos(angleRad)), scale3(north, Math.sin(angleRad))));
  const nu = normalize3(add3(scale3(nc, Math.cos(w)), scale3(dir, Math.sin(w))));
  return tangentFromUnitAtPole(nu[0], nu[1], nu[2], R);
}

/** World-space foot position for rendering (Y-up). Plane: `(x, groundY+yLift, z)`. Sphere: `(R+yLift)*unitDir`. */
export function worldFootXYZ(map: MapData, tan: Vec2, yLift = 0): { x: number; y: number; z: number } {
  const gy = map.world.groundY;
  if (!isSphereWorld(map)) {
    return { x: tan.x, y: gy + yLift, z: tan.z };
  }
  const R = sphereRadiusOf(map);
  const u = unitFromTangentAtPole(tan.x, tan.z, R);
  const s = R + yLift;
  return { x: u[0] * s, y: u[1] * s, z: u[2] * s };
}

/** Unit outward normal on sphere (for orienting meshes). */
export function surfaceNormalFromTan(map: MapData, tan: Vec2): [number, number, number] {
  if (!isSphereWorld(map)) return [0, 1, 0];
  const R = sphereRadiusOf(map);
  return unitFromTangentAtPole(tan.x, tan.z, R);
}
