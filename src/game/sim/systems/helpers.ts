import { UNIT_MESH_SCALE_STEP, UNIT_MESH_SWARM } from "../../constants";
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

/** Characteristic width/footprint for procedural unit placeholders (1.5× per tier from Swarm). */
export function unitMeshLinearSize(size: UnitSizeClass): number {
  const t = size === "Swarm" ? 0 : size === "Line" ? 1 : size === "Heavy" ? 2 : 3;
  return UNIT_MESH_SWARM * UNIT_MESH_SCALE_STEP ** t;
}

/** Minimum center spacing in XZ so units (especially swarms) do not sit on one spot. */
export function unitSeparationRadiusXZ(size: UnitSizeClass, flying?: boolean): number {
  const r = 0.39 * unitMeshLinearSize(size);
  return flying ? r * 0.78 : r;
}

export function unitStatsForCatalog(size: UnitSizeClass): {
  maxHp: number;
  speedPerSec: number;
  range: number;
  dmgPerTick: number;
  pop: number;
} {
  switch (size) {
    case "Swarm":
      return { maxHp: 28, speedPerSec: 9, range: 7, dmgPerTick: 0.275, pop: 4 };
    case "Line":
      return { maxHp: 55, speedPerSec: 6, range: 2.2, dmgPerTick: 0.225, pop: 2 };
    case "Heavy":
      return { maxHp: 140, speedPerSec: 4, range: 2.8, dmgPerTick: 0.475, pop: 4 };
    case "Titan":
      return { maxHp: 420, speedPerSec: 3, range: 5, dmgPerTick: 0.9, pop: 8 };
  }
}
