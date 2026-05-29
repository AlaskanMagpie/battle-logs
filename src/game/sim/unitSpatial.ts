import { COMBAT_SPATIAL_CELL } from "../constants";
import type { GameState, StructureRuntime, UnitRuntime } from "../state";
import type { Vec2 } from "../types";
import { dist2 } from "./systems/helpers";

function cellKey(x: number, z: number, cell: number): string {
  return `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
}

/** Bucket alive units by XZ cell for O(n·k) neighbor queries. */
export function buildCombatUnitBuckets(
  s: GameState,
  cell: number = COMBAT_SPATIAL_CELL,
): Map<string, UnitRuntime[]> {
  const buckets = new Map<string, UnitRuntime[]>();
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    const k = cellKey(u.x, u.z, cell);
    const arr = buckets.get(k);
    if (arr) arr.push(u);
    else buckets.set(k, [u]);
  }
  return buckets;
}

/** Nearest opposing unit within squared range `maxD2`, searching a 3×3 cell neighborhood around `from`. */
export function nearestFoeInBuckets(
  from: UnitRuntime,
  foeTeam: "player" | "enemy",
  maxD2: number,
  buckets: Map<string, UnitRuntime[]>,
  cell: number = COMBAT_SPATIAL_CELL,
): UnitRuntime | null {
  let best: UnitRuntime | null = null;
  let bestD = maxD2;
  const gx = Math.floor(from.x / cell);
  const gz = Math.floor(from.z / cell);
  const reachCells = Math.max(1, Math.ceil(Math.sqrt(maxD2) / cell));
  for (let ox = -reachCells; ox <= reachCells; ox++) {
    for (let oz = -reachCells; oz <= reachCells; oz++) {
      const list = buckets.get(`${gx + ox},${gz + oz}`);
      if (!list) continue;
      for (const o of list) {
        if (o === from || o.team !== foeTeam || o.hp <= 0) continue;
        const d = dist2(from, o);
        if (d <= bestD) {
          bestD = d;
          best = o;
        }
      }
    }
  }
  return best;
}

/** All units in 3×3 cells around (cx, cz) (excluding `skip`). */
export function unitsNearXZ(
  buckets: Map<string, UnitRuntime[]>,
  cx: number,
  cz: number,
  skip: UnitRuntime | null,
  cell: number = COMBAT_SPATIAL_CELL,
  radius: number = cell,
): UnitRuntime[] {
  const out: UnitRuntime[] = [];
  const gx = Math.floor(cx / cell);
  const gz = Math.floor(cz / cell);
  const reachCells = Math.max(1, Math.ceil(radius / cell));
  for (let ox = -reachCells; ox <= reachCells; ox++) {
    for (let oz = -reachCells; oz <= reachCells; oz++) {
      const list = buckets.get(`${gx + ox},${gz + oz}`);
      if (!list) continue;
      for (const o of list) {
        if (o === skip || o.hp <= 0) continue;
        out.push(o);
      }
    }
  }
  return out;
}

export type StructureTeamBuckets = {
  player: Map<string, StructureRuntime[]>;
  enemy: Map<string, StructureRuntime[]>;
};

export function buildStructureTeamBuckets(
  s: GameState,
  cell: number = COMBAT_SPATIAL_CELL,
): StructureTeamBuckets {
  const player = new Map<string, StructureRuntime[]>();
  const enemy = new Map<string, StructureRuntime[]>();
  for (const st of s.structures) {
    if (st.hp <= 0) continue;
    const map = st.team === "player" ? player : enemy;
    const k = cellKey(st.x, st.z, cell);
    const arr = map.get(k);
    if (arr) arr.push(st);
    else map.set(k, [st]);
  }
  return { player, enemy };
}

export function nearestStructureInBuckets(
  from: Vec2,
  buckets: Map<string, StructureRuntime[]>,
  maxD2: number,
  cell: number = COMBAT_SPATIAL_CELL,
): StructureRuntime | null {
  let best: StructureRuntime | null = null;
  let bestD = maxD2;
  const gx = Math.floor(from.x / cell);
  const gz = Math.floor(from.z / cell);
  const reachCells = Math.max(1, Math.ceil(Math.sqrt(maxD2) / cell));
  for (let ox = -reachCells; ox <= reachCells; ox++) {
    for (let oz = -reachCells; oz <= reachCells; oz++) {
      const list = buckets.get(`${gx + ox},${gz + oz}`);
      if (!list) continue;
      for (const st of list) {
        const d = dist2(from, st);
        if (d <= bestD) {
          bestD = d;
          best = st;
        }
      }
    }
  }
  return best;
}

export function nearestEnemyUnitInBuckets(
  from: Vec2,
  buckets: Map<string, UnitRuntime[]>,
  maxD2: number,
  cell: number = COMBAT_SPATIAL_CELL,
): UnitRuntime | null {
  const proxy = { x: from.x, z: from.z, team: "player" as const, hp: 1, id: -1 } as UnitRuntime;
  return nearestFoeInBuckets(proxy, "enemy", maxD2, buckets, cell);
}
