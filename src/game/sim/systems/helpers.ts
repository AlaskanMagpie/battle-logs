import type { UnitSizeClass, Vec2 } from "../../types";

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Heavier classes crush lighter ones (PRD table). */
export const TRAMPLE: Record<UnitSizeClass, Partial<Record<UnitSizeClass, number>>> = {
  Heavy: { Swarm: 2 },
  Titan: { Swarm: 2, Line: 1.5 },
  Swarm: {},
  Line: {},
};

export function unitStatsForCatalog(size: UnitSizeClass): {
  maxHp: number;
  speedPerSec: number;
  range: number;
  dmgPerTick: number;
  pop: number;
} {
  switch (size) {
    case "Swarm":
      return { maxHp: 28, speedPerSec: 9, range: 7, dmgPerTick: 0.55, pop: 4 };
    case "Line":
      return { maxHp: 55, speedPerSec: 6, range: 2.2, dmgPerTick: 0.45, pop: 2 };
    case "Heavy":
      return { maxHp: 140, speedPerSec: 4, range: 2.8, dmgPerTick: 0.95, pop: 4 };
    case "Titan":
      return { maxHp: 420, speedPerSec: 3, range: 5, dmgPerTick: 1.8, pop: 8 };
  }
}
