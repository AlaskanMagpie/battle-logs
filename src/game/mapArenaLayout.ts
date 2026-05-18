/**
 * Arena map prep: injects runtime `decor` from `mapArenaDecorSets` by `mapId`, and helpers for
 * full-map Mana tap scatter (Poisson-style rejection; keeps nodes off blocking decor).
 */
import { insidePlaneArena, samplePointInArenaFootprint, sphereTangentCapRadius } from "./arenaFootprint";
import { arenaDecorForMap, buildTheLineArenaDecor } from "./mapArenaDecorSets";
import { TAP_ARENA_TOTAL, TAP_GENERATION_MIN_SEP } from "./constants";
import { circleOverlapsMapObstacles } from "./mapObstacles";
import { isSphereWorld } from "./surface";
import type { TapRuntime } from "./state";
import type { MapData, Vec2 } from "./types";

export { buildTheLineArenaDecor } from "./mapArenaDecorSets";

/** Runtime decor + layout patches for shipped maps. */
export function prepareMatchMapForRuntime(map: MapData): MapData {
  const decor = arenaDecorForMap(map.mapId, map.world.halfExtents);
  if (!decor) return map;
  return { ...map, decor };
}

function xorShift32(state: { v: number }): number {
  let x = state.v | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.v = x >>> 0;
  return (state.v & 0xffffffff) / 0x100000000;
}

/**
 * Poisson-style rejection scatter across the whole arena (not player/enemy wedges).
 * Keeps nodes off blocking decor, camps, and wizard spawns.
 */
export function scatterArenaTapSlots(map: MapData, rngScratch: { v: number }, count = TAP_ARENA_TOTAL): TapRuntime[] {
  const half = map.world.halfExtents;
  const edgePad = Math.max(22, half * 0.048);
  const minSep = TAP_GENERATION_MIN_SEP * 0.92;
  const minSep2 = minSep * minSep;
  const tapClearR = 14.5;

  const playerStart = map.playerStart ?? { x: 0, z: 0 };
  const enemyStart = map.enemyStart ?? { x: -playerStart.x, z: playerStart.z };
  const hqR = Math.max(58, half * 0.13);
  const hqR2 = hqR * hqR;
  const campR2 = 38 * 38;

  const placed: Vec2[] = [];
  const rnd = () => xorShift32(rngScratch);

  function okPos(x: number, z: number): boolean {
    const inner = half - edgePad;
    if (isSphereWorld(map)) {
      const innerMap: MapData = { ...map, world: { ...map.world, halfExtents: inner } };
      const cap = sphereTangentCapRadius(innerMap);
      if (x * x + z * z > cap * cap) return false;
    } else {
      const innerMap: MapData = { ...map, world: { ...map.world, halfExtents: inner } };
      if (!insidePlaneArena(innerMap, { x, z })) return false;
    }
    const dp = (x - playerStart.x) ** 2 + (z - playerStart.z) ** 2;
    if (dp < hqR2) return false;
    const de = (x - enemyStart.x) ** 2 + (z - enemyStart.z) ** 2;
    if (de < hqR2) return false;
    for (const c of map.enemyCamps) {
      const dx = x - c.origin.x;
      const dz = z - c.origin.z;
      if (dx * dx + dz * dz < campR2) return false;
    }
    for (const p of placed) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < minSep2) return false;
    }
    if (circleOverlapsMapObstacles(map, { x, z }, tapClearR)) return false;
    return true;
  }

  const taps: TapRuntime[] = [];
  let id = 0;
  let attempts = 0;
  const maxAttempts = Math.max(2400, count * 450);
  while (taps.length < count && attempts < maxAttempts) {
    attempts++;
    const pos = samplePointInArenaFootprint(map, rnd, edgePad);
    if (!okPos(pos.x, pos.z)) continue;
    placed.push(pos);
    taps.push({
      defId: `tap_arena_${id++}`,
      x: pos.x,
      z: pos.z,
      active: false,
      yieldRemaining: 0,
      ownerTeam: undefined,
    });
  }
  return taps;
}
