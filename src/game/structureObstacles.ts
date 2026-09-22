import { STRUCTURE_MESH_VISUAL_SCALE } from "./constants";
import { getCatalogEntry } from "./catalog";
import type { MapObstacleFootprint } from "./mapObstacles";
import type { StructureCatalogEntry } from "./types";
import { isStructureEntry } from "./types";
import type { GameState, StructureRuntime } from "./state";
import { unitMeshLinearSize } from "./sim/systems/helpers";

/**
 * Gameplay-side mirror of the renderer's `structureDims()`.
 * Shared battle dimensions for procedural fallback, GLB sizing, and simulation placement.
 */
export function structureVisualDims(entry: StructureCatalogEntry | null): { w: number; h: number; d: number } {
  const H = unitMeshLinearSize("Titan");
  const S = STRUCTURE_MESH_VISUAL_SCALE;
  const signals = entry?.signalTypes ?? [];
  const isBastion = signals.filter((s) => s === "Bastion").length >= 2;
  const isVanguard = signals.includes("Vanguard");
  const isReclaim = signals.includes("Reclaim");
  let w: number;
  let d: number;

  if (entry?.producedSizeClass === "Titan") {
    w = 6.2;
    d = 6.2;
  } else if (entry?.producedSizeClass === "Heavy" && isBastion) {
    w = 6.4;
    d = 6.4;
  } else if (entry?.producedSizeClass === "Heavy") {
    w = 5.6;
    d = 5.6;
  } else if (isBastion) {
    w = 6.2;
    d = 6.2;
  } else if (isVanguard && isReclaim) {
    w = 5.1;
    d = 5.1;
  } else if (isVanguard) {
    w = 4.5;
    d = 4.5;
  } else if (isReclaim) {
    w = 5.2;
    d = 5.2;
  } else {
    w = 4.8;
    d = 4.8;
  }

  return { w: w * S, h: H * S, d: d * S };
}

/** Radius enclosing the square procedural footprint and its 0.7-width plinth.
 * Tower GLBs are normalized to the same maximum horizontal span, so this also
 * encloses their XZ bounds for every authored model even if its source is tall.
 */
export function structureVisualRadius(entry: StructureCatalogEntry): number {
  const { w, d } = structureVisualDims(entry);
  return Math.max(Math.hypot(w, d) * 0.5, Math.max(w, d) * 0.7) + 0.35;
}

export function structureObstacleFootprints(s: Pick<GameState, "structures">): MapObstacleFootprint[] {
  const out: MapObstacleFootprint[] = [];
  for (const st of s.structures) {
    const r = structureObstacleRadius(st);
    if (r <= 0) continue;
    out.push({
      kind: "disc",
      cx: st.x,
      cz: st.z,
      r,
    });
  }
  return out;
}

/** Reserve the finished footprint from the first build tick; units cannot occupy its future mesh. */
export function structureObstacleRadius(st: StructureRuntime): number {
  if (st.hp <= 0) return 0;
  const entry = getCatalogEntry(st.catalogId);
  if (!entry || !isStructureEntry(entry)) return 0;
  return structureVisualRadius(entry);
}
