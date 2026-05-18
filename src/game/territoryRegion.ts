import {
  TERRITORY_LINK_MAX_GAP,
  TERRITORY_LINK_RADIUS_PAD,
  TERRITORY_RADIUS,
} from "./constants";
import { chordDist2SqWorld, isSphereWorld, sphereRadiusOf, unitFromTangentAtPole, unitToVec2 } from "./surface";
import type { MapData, Vec2 } from "./types";

export interface TerritoryLink {
  readonly a: Vec2;
  readonly b: Vec2;
  /** Center separation in the same metric as `chordDist2SqWorld` (world units). */
  readonly d: number;
  readonly rCap: number;
}

function dist2Planar(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Squared distance from `p` to segment `ab` in XZ (planar). */
export function pointSegmentDistSqPlanar(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const ab2 = abx * abx + abz * abz;
  if (ab2 < 1e-12) return dist2Planar(p, a);
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  let t = (apx * abx + apz * abz) / ab2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + abx * t;
  const qz = a.z + abz * t;
  const dx = p.x - qx;
  const dz = p.z - qz;
  return dx * dx + dz * dz;
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len3(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const l = len3(v);
  if (l < 1e-12) return [0, 1, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

function slerpUnit(u0: [number, number, number], u1: [number, number, number], t: number): [number, number, number] {
  let omega = Math.acos(Math.max(-1, Math.min(1, dot3(u0, u1))));
  if (omega < 1e-5) return normalize3([u0[0] * (1 - t) + u1[0] * t, u0[1] * (1 - t) + u1[1] * t, u0[2] * (1 - t) + u1[2] * t]);
  const sinO = Math.sin(omega);
  const s0 = Math.sin((1 - t) * omega) / sinO;
  const s1 = Math.sin(t * omega) / sinO;
  return normalize3([u0[0] * s0 + u1[0] * s1, u0[1] * s0 + u1[1] * s1, u0[2] * s0 + u1[2] * s1]);
}

function geodesicSampleXZ(map: MapData, a: Vec2, b: Vec2, t: number): Vec2 {
  const Rsp = sphereRadiusOf(map);
  const u0 = unitFromTangentAtPole(a.x, a.z, Rsp);
  const u1 = unitFromTangentAtPole(b.x, b.z, Rsp);
  const w = slerpUnit(u0, u1, t);
  return unitToVec2(map, w[0], w[1], w[2]);
}

/** Minimum squared chord distance from `pos` to a polyline sampling the great circle from `a` to `b`. */
function minChordDist2SqToGeodesic(map: MapData, pos: Vec2, a: Vec2, b: Vec2, steps: number): number {
  let best = Infinity;
  const n = Math.max(2, steps);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const q = geodesicSampleXZ(map, a, b, t);
    const d2 = chordDist2SqWorld(map, pos, q);
    if (d2 < best) best = d2;
  }
  return best;
}

function geodesicSampleSteps(map: MapData, a: Vec2, b: Vec2): number {
  const chord = Math.sqrt(Math.max(0, chordDist2SqWorld(map, a, b)));
  return Math.max(3, Math.min(16, 2 + Math.ceil(chord / 7)));
}

function centerSeparationSq(map: MapData | undefined | null, a: Vec2, b: Vec2): number {
  return Math.max(0, chordDist2SqWorld(map, a, b));
}

/**
 * Pairs of sources that receive a linking corridor (disks do not already overlap).
 */
export function territoryLinksForSources(
  map: MapData | undefined | null,
  sources: readonly Vec2[],
  radius = TERRITORY_RADIUS,
  linkMaxGap = TERRITORY_LINK_MAX_GAP,
): TerritoryLink[] {
  const out: TerritoryLink[] = [];
  const maxD = 2 * radius + linkMaxGap;
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i]!;
      const b = sources[j]!;
      const d = Math.sqrt(centerSeparationSq(map, a, b));
      if (d <= 2 * radius) continue;
      if (d > maxD) continue;
      const rCap = (d - 2 * radius) / 2 + TERRITORY_LINK_RADIUS_PAD;
      out.push({ a, b, d, rCap });
    }
  }
  return out;
}

function inAnyLinkCorridor(map: MapData | undefined | null, pos: Vec2, links: readonly TerritoryLink[]): boolean {
  if (links.length === 0) return false;
  const sphere = map != null && isSphereWorld(map);
  for (const L of links) {
    const r2 = L.rCap * L.rCap;
    if (sphere && map) {
      const steps = geodesicSampleSteps(map, L.a, L.b);
      if (minChordDist2SqToGeodesic(map, pos, L.a, L.b, steps) <= r2) return true;
    } else if (pointSegmentDistSqPlanar(pos, L.a, L.b) <= r2) return true;
  }
  return false;
}

/**
 * Territory = union of radius disks around each source (same metric as `gameDist2`) plus
 * corridors between sources separated by `(2R, 2R + linkMaxGap]`.
 */
export function inConnectedTerritory(
  map: MapData | undefined | null,
  pos: Vec2,
  sources: readonly Vec2[],
  radius = TERRITORY_RADIUS,
  linkMaxGap = TERRITORY_LINK_MAX_GAP,
): boolean {
  if (sources.length === 0) return false;
  const r2 = radius * radius;
  for (const p of sources) {
    if (chordDist2SqWorld(map, pos, p) <= r2) return true;
  }
  const links = territoryLinksForSources(map, sources, radius, linkMaxGap);
  return inAnyLinkCorridor(map, pos, links);
}

/** Distance-from-boundary estimate for floor tint (larger = deeper inside disks or link corridors). */
export function territoryInteriorDepth(
  map: MapData | undefined | null,
  pos: Vec2,
  sources: readonly Vec2[],
  links: readonly TerritoryLink[],
  radius = TERRITORY_RADIUS,
): number {
  let depth = 0;
  for (const p of sources) {
    const d = Math.sqrt(Math.max(0, chordDist2SqWorld(map, pos, p)));
    if (d < radius) depth = Math.max(depth, radius - d);
  }
  for (const L of links) {
    const sphere = map != null && isSphereWorld(map);
    const sd = sphere && map
      ? Math.sqrt(
          minChordDist2SqToGeodesic(map, pos, L.a, L.b, geodesicSampleSteps(map, L.a, L.b)),
        )
      : Math.sqrt(pointSegmentDistSqPlanar(pos, L.a, L.b));
    if (sd < L.rCap) depth = Math.max(depth, L.rCap - sd);
  }
  return depth;
}
