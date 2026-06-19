/**
 * Seeded RNG + math helpers, ported verbatim from the buildin-s "Massing"
 * procedural building generator (building-generator.html). Kept dependency-free
 * so the generator can run headlessly (no GL context) in tests.
 */

export type Rng = () => number;

/** Deterministic mulberry32 PRNG — same seed always yields the same stream. */
export function mulberry32(a: number): Rng {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TAU = Math.PI * 2;

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[(rng() * arr.length) | 0]!;
export const rrange = (rng: Rng, a: number, b: number): number => a + (b - a) * rng();
export const rint = (rng: Rng, a: number, b: number): number => Math.floor(a + (b - a + 1) * rng());
