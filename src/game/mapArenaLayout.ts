/**
 * Procedural arena geometry for `mapId === "the_line"`: macro obstacles, blocking terrain variety,
 * and full-map Mana node scatter (not wedge-split by team side).
 */
import { TAP_ARENA_TOTAL, TAP_GENERATION_MIN_SEP } from "./constants";
import { circleOverlapsMapObstacles } from "./mapObstacles";
import type { TapRuntime } from "./state";
import type { MapData, MapDecorDef, Vec2 } from "./types";

const THE_LINE_LAYOUT_SEED = 0x4c1e7ead;

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runtime-only patch for matches that ship layout from code instead of JSON arrays. */
export function prepareMatchMapForRuntime(map: MapData): MapData {
  if (map.mapId !== "the_line") return map;
  return {
    ...map,
    decor: buildTheLineArenaDecor(map.world.halfExtents),
    useAuthorTapSlots: false,
  };
}

/** Macro + scattered terrain for "The Line" — scaled from {@link MapData.world.halfExtents}. */
export function buildTheLineArenaDecor(halfExtents: number): MapDecorDef[] {
  const H = halfExtents;
  const rnd = mulberry32(THE_LINE_LAYOUT_SEED);
  const out: MapDecorDef[] = [];

  const edgeThin = Math.max(7.5, H * 0.018);
  const edgeLong = H * 1.95;
  out.push({
    kind: "box",
    x: 0,
    z: H - edgeThin * 0.5,
    w: edgeLong,
    h: 12,
    d: edgeThin,
    blocksMovement: true,
    color: 0x5c6a72,
    terrainKind: "mesa_slab",
  });
  out.push({
    kind: "box",
    x: 0,
    z: -H + edgeThin * 0.5,
    w: edgeLong,
    h: 12,
    d: edgeThin,
    blocksMovement: true,
    color: 0x5c6a72,
    terrainKind: "mesa_slab",
  });
  out.push({
    kind: "box",
    x: H - edgeThin * 0.5,
    z: 0,
    w: edgeThin,
    h: 12,
    d: edgeLong,
    blocksMovement: true,
    color: 0x5c6a72,
    terrainKind: "mesa_slab",
  });
  out.push({
    kind: "box",
    x: -H + edgeThin * 0.5,
    z: 0,
    w: edgeThin,
    h: 12,
    d: edgeLong,
    blocksMovement: true,
    color: 0x5c6a72,
    terrainKind: "mesa_slab",
  });

  const corner = (x: number, z: number, rot: number) => {
    out.push({
      kind: "box",
      x,
      z,
      w: H * 0.34,
      h: 30,
      d: H * 0.038,
      rotYDeg: rot,
      blocksMovement: true,
      color: 0x6a5a62,
      terrainKind: "mesa_slab",
    });
  };
  corner(-H * 0.376, H * 0.4, 0);
  corner(H * 0.376, H * 0.4, 0);
  corner(-H * 0.376, -H * 0.4, 0);
  corner(H * 0.376, -H * 0.4, 0);

  const gateChunk = (gx: number, gz: number, rotDeg: number, spanZ: number) => {
    out.push({
      kind: "box",
      x: gx,
      z: gz,
      w: H * 0.021,
      h: 32,
      d: spanZ,
      rotYDeg: rotDeg,
      blocksMovement: true,
      color: 0x5d534e,
      terrainKind: "mesa_slab",
    });
  };
  gateChunk(-H * 0.257, 0, 0, H * 0.42);
  gateChunk(H * 0.257, 0, 0, H * 0.42);

  out.push({
    kind: "box",
    x: 0,
    z: H * 0.219,
    w: H * 0.14,
    h: 26,
    d: H * 0.033,
    blocksMovement: true,
    color: 0x4b433e,
    terrainKind: "mesa_slab",
  });
  out.push({
    kind: "box",
    x: 0,
    z: -H * 0.219,
    w: H * 0.14,
    h: 26,
    d: H * 0.033,
    blocksMovement: true,
    color: 0x4b433e,
    terrainKind: "mesa_slab",
  });

  const lake = (x: number, z: number, r: number) => {
    out.push({
      kind: "cylinder",
      x,
      z,
      radius: r,
      h: 0.42,
      blocksMovement: true,
      color: 0x1a4a62,
      terrainKind: "lake",
    });
  };
  lake(-H * 0.42, H * 0.08, H * 0.052);
  lake(H * 0.38, -H * 0.11, H * 0.048);
  lake(H * 0.05, H * 0.28, H * 0.044);
  lake(-H * 0.08, -H * 0.31, H * 0.05);
  lake(H * 0.12, H * 0.05, H * 0.038);

  const hill = (x: number, z: number, r: number, h: number, deg: number) => {
    out.push({
      kind: "cone",
      x,
      z,
      radius: r,
      h,
      rotYDeg: deg,
      blocksMovement: true,
      color: 0x6b5a46,
      terrainKind: "hill",
    });
  };
  hill(-H * 0.18, H * 0.15, 11, 9, 22);
  hill(H * 0.22, -H * 0.22, 13, 10, -18);
  hill(-H * 0.28, -H * 0.08, 10, 8, 40);
  hill(H * 0.08, -H * 0.38, 12, 9.5, -32);

  const rockSpire = (x: number, z: number, r: number, height: number) => {
    out.push({
      kind: "cylinder",
      x,
      z,
      radius: r,
      h: height,
      blocksMovement: true,
      color: 0x4a5562,
      terrainKind: "rock_spire",
    });
  };
  rockSpire(H * 0.31, H * 0.18, 5.2, 7);
  rockSpire(-H * 0.35, -H * 0.2, 5.8, 7.5);
  rockSpire(H * 0.02, -H * 0.12, 4.8, 6);

  const microCenters: Vec2[] = [];
  const microSep2 = 13.5 * 13.5;
  function tryMicro(ax: number, az: number): boolean {
    if (Math.abs(ax) < H * 0.045 && Math.abs(az) < H * 0.075) return false;
    for (const p of microCenters) {
      const dx = p.x - ax;
      const dz = p.z - az;
      if (dx * dx + dz * dz < microSep2) return false;
    }
    microCenters.push({ x: ax, z: az });
    return true;
  }

  for (let i = 0; i < 320; i++) {
    if (microCenters.length >= 34) break;
    const ax = (rnd() * 2 - 1) * (H * 0.88);
    const az = (rnd() * 2 - 1) * (H * 0.88);
    if (!tryMicro(ax, az)) continue;
    const roll = rnd();
    const w = 6 + rnd() * 12;
    const d = 6 + rnd() * 11;
    if (roll < 0.32) {
      out.push({
        kind: "box",
        x: ax,
        z: az,
        w,
        h: 3.2 + rnd() * 3.8,
        d,
        rotYDeg: (rnd() * 2 - 1) * 55,
        blocksMovement: true,
        color: 0x4d433a + Math.floor(rnd() * 0x080808),
        terrainKind: "mesa_slab",
      });
    } else if (roll < 0.58) {
      lake(ax, az, 7 + rnd() * 11);
    } else if (roll < 0.78) {
      hill(ax, az, 5 + rnd() * 7, 5.5 + rnd() * 6, (rnd() * 2 - 1) * 70);
    } else {
      rockSpire(ax, az, 3.5 + rnd() * 3.5, 5 + rnd() * 6);
    }
  }

  return out;
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
    if (Math.abs(x) > half - edgePad || Math.abs(z) > half - edgePad) return false;
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
    const x = (rnd() * 2 - 1) * (half - edgePad);
    const z = (rnd() * 2 - 1) * (half - edgePad);
    if (!okPos(x, z)) continue;
    placed.push({ x, z });
    taps.push({
      defId: `tap_arena_${id++}`,
      x,
      z,
      active: false,
      yieldRemaining: 0,
      ownerTeam: undefined,
    });
  }
  return taps;
}
