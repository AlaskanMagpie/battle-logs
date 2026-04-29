import { UNIT_MESH_HEAVY, UNIT_MESH_LINE, UNIT_MESH_SWARM, UNIT_MESH_TITAN } from "../../constants";
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

/**
 * Characteristic unit height (world units), shared by gameplay spacing and renderer GLB
 * normalization. Canonical feet: Swarm 15′, Line 25′, Heavy 35′, Titan 50′ (`constants.ts`).
 */
export function unitMeshLinearSize(size: UnitSizeClass): number {
  switch (size) {
    case "Swarm":
      return UNIT_MESH_SWARM;
    case "Line":
      return UNIT_MESH_LINE;
    case "Heavy":
      return UNIT_MESH_HEAVY;
    case "Titan":
      return UNIT_MESH_TITAN;
  }
}

export function unitVisualScaleReport(): Record<UnitSizeClass, number> {
  return {
    Swarm: unitMeshLinearSize("Swarm"),
    Line: unitMeshLinearSize("Line"),
    Heavy: unitMeshLinearSize("Heavy"),
    Titan: unitMeshLinearSize("Titan"),
  };
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
      return { maxHp: 34, speedPerSec: 10.5, range: 10, dmgPerTick: 0.1, pop: 1 };
    case "Line":
      return { maxHp: 72, speedPerSec: 7.2, range: 12, dmgPerTick: 0.19, pop: 2 };
    case "Heavy":
      return { maxHp: 170, speedPerSec: 4.8, range: 15, dmgPerTick: 0.42, pop: 4 };
    case "Titan":
      return { maxHp: 420, speedPerSec: 3.2, range: 19, dmgPerTick: 0.92, pop: 8 };
  }
}

export function productionBatchSizeForClass(size: UnitSizeClass): number {
  switch (size) {
    case "Swarm":
      return 4;
    case "Line":
      return 3;
    case "Heavy":
      return 2;
    case "Titan":
      return 1;
  }
}
