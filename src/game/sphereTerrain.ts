/**
 * Procedural hills / valleys on spherical worlds (radial displacement along the shell normal).
 * Shared by gameplay footing in `surface.ts` and the displaced mesh in `render/spherePlanetGeometry.ts`.
 */
import type { MapData } from "./types";

function sphereRForTerrain(map: MapData): number {
  const r = map.world.sphereRadius;
  if (r != null && Number.isFinite(r) && r > 1) return r;
  return Math.max(120, map.world.halfExtents * 2);
}

/** Smooth sphere maps ignore this. */
export function sphereTerrainEnabled(map: MapData): boolean {
  return map.worldGeometry === "sphere" && map.world.sphereTerrain?.enabled !== false;
}

function hash01(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

function vnoise3(ix: number, iy: number, iz: number, seed: number): number {
  const n = ix * 73 + iy * 127 + iz * 251 + seed * 9973;
  return hash01(n) * 2 - 1;
}

function smoothNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const xf = x - x0;
  const yf = y - y0;
  const zf = z - z0;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  let acc = 0;
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dz = 0; dz <= 1; dz++) {
        const vx = vnoise3(x0 + dx, y0 + dy, z0 + dz, seed);
        const wx = dx ? u : 1 - u;
        const wy = dy ? v : 1 - v;
        const wz = dz ? w : 1 - w;
        acc += vx * wx * wy * wz;
      }
    }
  }
  return acc;
}

function effectiveTerrainParams(map: MapData): {
  R: number;
  amplitude: number;
  seed: number;
  octaves: number;
  macroScale: number;
} {
  const R = sphereRForTerrain(map);
  const t = map.world.sphereTerrain;
  const amplitude = t?.amplitude ?? Math.min(72, R * 0.085);
  const seed = Math.floor(t?.seed ?? 41) % 100000;
  const octaves = Math.max(1, Math.min(6, Math.floor(t?.octaves ?? 4)));
  const macroScale = t?.macroScale ?? 1.35;
  return { R, amplitude, seed, octaves, macroScale };
}

/** Height (radial offset) at a unit direction on the shell. Zero when terrain is disabled or not a sphere. */
export function sphereTerrainHeightAtUnit(map: MapData, ux: number, uy: number, uz: number): number {
  if (!sphereTerrainEnabled(map)) return 0;
  const { R, amplitude, seed, octaves, macroScale } = effectiveTerrainParams(map);
  const baseFreq = (2.15 * macroScale) / R;
  let sum = 0;
  let w = 1;
  let wSum = 0;
  for (let o = 0; o < octaves; o++) {
    const k = (1 << o) * baseFreq;
    sum +=
      w *
      smoothNoise3(
        ux * k + seed * 0.401,
        uy * k - seed * 0.293,
        uz * k + seed * 0.777,
        seed * 1009 + o * 503,
      );
    wSum += w;
    w *= 0.52;
  }
  return (amplitude * sum) / (wSum > 1e-8 ? wSum : 1);
}

/** Cache key for renderer geometry rebuilds. */
export function sphereTerrainGeometryKey(map: MapData): string {
  if (map.worldGeometry !== "sphere") return "";
  const R = sphereRForTerrain(map);
  if (!(R > 1)) return "";
  if (map.world.sphereTerrain?.enabled === false) return `flat|${R}`;
  const { amplitude, seed, octaves, macroScale } = effectiveTerrainParams(map);
  return `d|${R}|${amplitude}|${seed}|${octaves}|${macroScale}`;
}
