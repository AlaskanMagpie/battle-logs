import { STRUCTURE_MESH_VISUAL_SCALE } from "./constants";
import { getCatalogEntry } from "./catalog";
import type { MapObstacleFootprint } from "./mapObstacles";
import type { StructureCatalogEntry } from "./types";
import { isStructureEntry } from "./types";
import type { GameState, StructureRuntime } from "./state";
import { unitMeshLinearSize } from "./sim/systems/helpers";

const SWARM_WADE_HEIGHT = unitMeshLinearSize("Swarm") * 0.5;
/** Inset from half-footprint so low tower skirts stay notionally wadeable; body blocks cleanly. */
const STRUCTURE_DISC_INSET = 0.88;
const STRUCTURE_DISC_MIN_RADIUS = 4.25;
/** Large scaled meshes need discs past old 7.25 cap — prevents units sitting inside tower visuals. */
const STRUCTURE_DISC_MAX_RADIUS = 15;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Gameplay-side mirror of the renderer's `structureDims()`.
 * Blocking uses a center disc sized to ~half the authored footprint (minus inset) so it tracks
 * scaled tower meshes; old ~28%‑of‑width caps left most of the mesh non-collidable.
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
    const halfFootprint = Math.max(dims.w, dims.d) * 0.5 * buildScale;
    const r = clamp(halfFootprint * STRUCTURE_DISC_INSET, STRUCTURE_DISC_MIN_RADIUS, STRUCTURE_DISC_MAX_RADIUS);
    out.push({
      kind: "disc",
      cx: st.x,
      cz: st.z,
      r,
    });
  }
  return out;
}
