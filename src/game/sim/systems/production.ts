import { getCatalogEntry } from "../../catalog";
import { TICK_HZ } from "../../constants";
import { enemyDamageScalar, enemyProductionSpeedScalar } from "../../difficulty";
import { circleOverlapsMapObstacles } from "../../mapObstacles";
import { structureObstacleFootprints, structureObstacleRadius } from "../../structureObstacles";
import {
  dominantSignal,
  rand,
  randU32,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../../state";
import { isStructureEntry, type StructureCatalogEntry } from "../../types";
import { productionBatchSizeForClass, unitSeparationRadiusXZ, unitStatsForCatalog } from "./helpers";

/** Find a clear release point outside the finished tower, decor and existing squads. */
function unitSpawnPoint(
  s: GameState,
  def: StructureCatalogEntry,
  center: { x: number; z: number },
  structureId: number | null,
  batchIndex: number,
  batchTotal: number,
): { x: number; z: number } | null {
  const unitR = unitSeparationRadiusXZ(def.producedSizeClass, def.unitFlying);
  const structure = structureId === null ? null : s.structures.find((st) => st.id === structureId);
  const rootR = structure ? structureObstacleRadius(structure) : 2;
  const obstacles = structureObstacleFootprints(s);
  const baseAngle = rand(s) * Math.PI * 2 + (batchIndex / Math.max(1, batchTotal)) * Math.PI * 2;
  const half = s.map.world.halfExtents;
  for (let ring = 0; ring < 3; ring++) {
    const distance = rootR + unitR + 0.8 + ring * (unitR * 2 + 1.5);
    for (let slot = 0; slot < 24; slot++) {
      const angle = baseAngle + slot * Math.PI * 2 / 24;
      const pos = { x: center.x + Math.cos(angle) * distance, z: center.z + Math.sin(angle) * distance };
      if (Math.abs(pos.x) + unitR > half || Math.abs(pos.z) + unitR > half) continue;
      if (circleOverlapsMapObstacles(s.map, pos, unitR, obstacles)) continue;
      if (s.units.some((u) => u.hp > 0 && Math.hypot(pos.x - u.x, pos.z - u.z) < unitR + unitSeparationRadiusXZ(u.sizeClass, u.flying))) continue;
      if (s.hero.hp > 0 && Math.hypot(pos.x - s.hero.x, pos.z - s.hero.z) < unitR + 2.85) continue;
      if (s.enemyHero.hp > 0 && Math.hypot(pos.x - s.enemyHero.x, pos.z - s.enemyHero.z) < unitR + 2.85) continue;
      return pos;
    }
  }
  return null;
}

function pushSpawnedUnitFromStructureDef(
  s: GameState,
  def: StructureCatalogEntry,
  center: { x: number; z: number },
  structureId: number | null,
  team: "player" | "enemy",
  batchIndex: number,
  batchTotal: number,
): boolean {
  const stStats = unitStatsForCatalog(def.producedSizeClass);
  const antiClasses =
    def.producedAntiClasses && def.producedAntiClasses.length > 0
      ? [...def.producedAntiClasses]
      : def.producedAntiClass
        ? [def.producedAntiClass]
        : undefined;
  const pos = unitSpawnPoint(s, def, center, structureId, batchIndex, batchTotal);
  if (!pos) return false;
  const u: UnitRuntime = {
    id: s.nextId.unit++,
    team,
    structureId,
    x: pos.x,
    z: pos.z,
    hp: stStats.maxHp,
    maxHp: stStats.maxHp,
    sizeClass: def.producedSizeClass,
    pop: stStats.pop,
    speedPerSec: stStats.speedPerSec,
    range: stStats.range,
    dmgPerTick: team === "enemy" ? stStats.dmgPerTick * enemyDamageScalar(s.map) : stStats.dmgPerTick,
    visualSeed: randU32(s),
    antiClasses,
    antiClass: def.producedAntiClass,
    trait: def.unitTrait,
    aoeRadius: def.unitAoeRadius,
    flying: def.unitFlying,
    damageVsStructuresMult: def.producedDamageVsStructuresMult ?? 1,
    signal: dominantSignal(def),
    producedUnitId: def.producedUnitId,
    producerCatalogId: def.id,
    vxImpulse: 0,
    vzImpulse: 0,
  };
  s.units.push(u);
  if (team === "player") s.stats.unitsProduced += 1;
  return true;
}

export function availableProductionSlots(_s: GameState, st: StructureRuntime): number {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return 0;
  return productionBatchSizeForClass(def.producedSizeClass);
}

function pushSpawnedUnitBody(
  s: GameState,
  st: StructureRuntime,
  team: "player" | "enemy",
  batchIndex: number,
  batchTotal: number,
): boolean {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return false;
  return pushSpawnedUnitFromStructureDef(s, def, { x: st.x, z: st.z }, st.id, team, batchIndex, batchTotal);
}

/**
 * Spawns one full production batch (same size class / count as a completed building) with **no** structure.
 * Used by enemy wizard AI to skip tower meshes until infrastructure visuals are redone.
 */
export function spawnEnemyBatchFromStructureCatalogId(
  s: GameState,
  catalogId: string,
  pos: { x: number; z: number },
): number {
  const def = getCatalogEntry(catalogId);
  if (!def || !isStructureEntry(def)) return 0;
  const n = productionBatchSizeForClass(def.producedSizeClass);
  if (n <= 0) return 0;
  let spawned = 0;
  for (let i = 0; i < n; i++) {
    if (pushSpawnedUnitFromStructureDef(s, def, pos, null, "enemy", i, n)) spawned += 1;
  }
  s.stats.enemyUnitsSpawned += spawned;
  return spawned;
}

function pushSpawnedBatch(s: GameState, st: StructureRuntime, team: "player" | "enemy", count: number): number {
  let spawned = 0;
  for (let i = 0; i < count; i++) if (pushSpawnedUnitBody(s, st, team, i, count)) spawned += 1;
  return spawned;
}

export function spawnPlayerUnit(s: GameState, st: StructureRuntime): number {
  const n = availableProductionSlots(s, st);
  return n > 0 ? pushSpawnedBatch(s, st, "player", n) : 0;
}

export function spawnEnemyUnit(s: GameState, st: StructureRuntime): number {
  const n = availableProductionSlots(s, st);
  const spawned = n > 0 ? pushSpawnedBatch(s, st, "enemy", n) : 0;
  s.stats.enemyUnitsSpawned += spawned;
  return spawned;
}

function productionTicksForStructure(s: GameState, st: StructureRuntime): number {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return 1;
  const baseTicks = def.productionSeconds * TICK_HZ;
  const teamRate = st.team === "enemy" ? enemyProductionSpeedScalar(s) : 1;
  return Math.max(1, Math.round(baseTicks / teamRate));
}

function resetProductionTimer(s: GameState, st: StructureRuntime): void {
  st.productionTicksRemaining = productionTicksForStructure(s, st);
}

export function buildProgress(s: GameState): void {
  for (const st of s.structures) {
    if (st.complete) continue;
    st.buildTicksRemaining -= 1;
    if (st.buildTicksRemaining <= 0) {
      st.complete = true;
      st.buildTicksRemaining = 0;
      const def = getCatalogEntry(st.catalogId);
      if (def && isStructureEntry(def) && typeof def.structureLocalPopCapBonus === "number") {
        st.localPopCapBonus = def.structureLocalPopCapBonus;
      }
      const spawned = st.team === "player" ? spawnPlayerUnit(s, st) : spawnEnemyUnit(s, st);
      resetProductionTimer(s, st);
      if (spawned > 0 && def && isStructureEntry(def)) {
        s.lastMessage = `${def.name} doors burst open — ${spawned} ${def.producedSizeClass}${spawned === 1 ? "" : "s"} charge out.`;
      }
    }
  }
}

export function production(s: GameState): void {
  for (const st of s.structures) {
    if (st.team !== "player") continue;
    if (!st.complete) continue;
    if (st.productionSilenceUntilTick > s.tick) continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def)) continue;
    st.productionTicksRemaining -= 1;
    if (st.productionTicksRemaining > 0) continue;

    const spawned = spawnPlayerUnit(s, st);
    if (spawned > 0) {
      s.lastMessage = `${def.name} produced ${spawned} ${def.producedSizeClass}${spawned === 1 ? "" : "s"}.`;
      st.productionTicksRemaining = productionTicksForStructure(s, st);
    } else {
      st.productionTicksRemaining = 1;
    }
  }

  for (const st of s.structures) {
    if (st.team !== "enemy") continue;
    if (!st.complete) continue;
    if (st.productionSilenceUntilTick > s.tick) continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def)) continue;
    st.productionTicksRemaining -= 1;
    if (st.productionTicksRemaining > 0) continue;

    const spawned = spawnEnemyUnit(s, st);
    st.productionTicksRemaining = spawned > 0 ? productionTicksForStructure(s, st) : 1;
  }
}
