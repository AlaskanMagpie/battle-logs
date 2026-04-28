import { STRUCTURE_MESH_VISUAL_SCALE } from "./constants";
import { getCatalogEntry } from "./catalog";
import type { MapObstacleFootprint } from "./mapObstacles";
import type { StructureCatalogEntry } from "./types";
import { isStructureEntry } from "./types";
import type { GameState, StructureRuntime } from "./state";
import { unitMeshLinearSize } from "./sim/systems/helpers";

const SWARM_WADE_HEIGHT = unitMeshLinearSize("Swarm") * 0.5;
const TALL_CORE_RADIUS_FRAC = 0.28;
const TALL_CORE_MIN_RADIUS = 5.1;
const TALL_CORE_MAX_RADIUS = 7.25;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Gameplay-side mirror of the renderer's `structureDims()`.
 * The collision only uses the tall central mass, leaving low GLB skirts/roots wadeable.
 */
function structureVisualDims(entry: StructureCatalogEntry): { w: number; h: number; d: number } {
  const H = unitMeshLinearSize("Titan");
  const S = STRUCTURE_MESH_VISUAL_SCALE;
  const signals = entry.signalTypes;
  const isBastion = signals.filter((s) => s === "Bastion").length >= 2;
  const isVanguard = signals.includes("Vanguard");
  const isReclaim = signals.includes("Reclaim");
  let w: number;
  let d: number;

  if (entry.producedSizeClass === "Titan") {
    w = 6.2;
    d = 6.2;
  } else if (entry.producedSizeClass === "Heavy" && isBastion) {
    w = 6.4;
    d = 6.4;
  } else if (entry.producedSizeClass === "Heavy") {
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

function structureBuildScale(st: StructureRuntime): number {
  if (st.complete) return 1;
  return 0.35 + 0.65 * (1 - st.buildTicksRemaining / Math.max(1, st.buildTotalTicks));
}

export function structureObstacleFootprints(s: Pick<GameState, "structures">): MapObstacleFootprint[] {
  const out: MapObstacleFootprint[] = [];
  for (const st of s.structures) {
    if (st.hp <= 0) continue;
    const entry = getCatalogEntry(st.catalogId);
    if (!entry || !isStructureEntry(entry)) continue;
    const dims = structureVisualDims(entry);
    const buildScale = structureBuildScale(st);
    if (dims.h * buildScale <= SWARM_WADE_HEIGHT) continue;
    out.push({
      kind: "disc",
      cx: st.x,
      cz: st.z,
      r: clamp(Math.max(dims.w, dims.d) * TALL_CORE_RADIUS_FRAC * buildScale, TALL_CORE_MIN_RADIUS, TALL_CORE_MAX_RADIUS),
    });
  }
  return out;
}
