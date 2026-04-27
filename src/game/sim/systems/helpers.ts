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

/**
 * Characteristic unit footprint/max extent (world units), shared by gameplay spacing and renderer
 * GLB normalization. Do not add class-specific scale multipliers in render code unless this ladder
 * changes too: Titan should stay building-scale, then Heavy/Line/Swarm step down by 1.5×.
 */
export function unitMeshLinearSize(size: UnitSizeClass): number {
  const t = size === "Swarm" ? 0 : size === "Line" ? 1 : size === "Heavy" ? 2 : 3;
  return UNIT_MESH_SWARM * UNIT_MESH_SCALE_STEP ** t;
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
      return { maxHp: 28, speedPerSec: 9, range: 18, dmgPerTick: 0.12, pop: 1 };
    case "Line":
      return { maxHp: 60, speedPerSec: 6, range: 12, dmgPerTick: 0.22, pop: 2 };
    case "Heavy":
      return { maxHp: 160, speedPerSec: 4, range: 15, dmgPerTick: 0.55, pop: 4 };
    case "Titan":
      return { maxHp: 520, speedPerSec: 3, range: 20, dmgPerTick: 1.15, pop: 8 };
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
