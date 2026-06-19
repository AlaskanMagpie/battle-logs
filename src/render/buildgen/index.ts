/**
 * Public entry for the procedural building generator ported from buildin-s.
 *
 * `buildProceduralBuilding(params)` returns a Three.js Group (base at y=0)
 * built deterministically from `params.seed`. Construction needs no GL context.
 */
import type * as THREE from "three";
import { mulberry32 } from "./rng";
import { buildBuilding, type BuildParams } from "./building";

export function buildProceduralBuilding(params: BuildParams): THREE.Group {
  return buildBuilding(params, mulberry32(params.seed));
}

export type { BuildParams } from "./building";
export type { FootKey } from "./footprints";
export { STYLES, STYLE_KEYS, CURATED_STYLE_KEYS, type StyleKey } from "./styles";
export { buildCityBlock, buildSkylineBackdrop } from "./city";
export { resolveStructureBuild, type ResolvedBuild } from "./structureMapping";
