import { getCatalogEntry } from "../../catalog";
import { ENEMY_DAMAGE_MULT, ENEMY_PRODUCTION_RATE_MULT, TICK_HZ } from "../../constants";
import {
  dominantSignal,
  rand,
  randU32,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../../state";
import { isStructureEntry } from "../../types";
import { productionBatchSizeForClass, unitStatsForCatalog } from "./helpers";

/** Slightly wider ring than +/-1 so units clear the tower footprint / GLB hull. */
const SPAWN_JITTER = 3.5;

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
): void {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return;
  const stStats = unitStatsForCatalog(def.producedSizeClass);
  const spread = Math.max(1, batchTotal);
  const baseAngle = rand(s) * Math.PI * 2;
  const angle = baseAngle + (batchIndex / spread) * Math.PI * 2 + (rand(s) - 0.5) * 0.32;
  const radius = SPAWN_JITTER * (0.52 + rand(s) * 0.35);
  const u: UnitRuntime = {
    id: s.nextId.unit++,
    team,
    structureId: st.id,
    x: st.x + Math.cos(angle) * radius,
    z: st.z + Math.sin(angle) * radius,
    hp: stStats.maxHp,
    maxHp: stStats.maxHp,
    sizeClass: def.producedSizeClass,
    pop: stStats.pop,
    speedPerSec: stStats.speedPerSec,
    range: stStats.range,
    dmgPerTick: team === "enemy" ? stStats.dmgPerTick * ENEMY_DAMAGE_MULT : stStats.dmgPerTick,
    visualSeed: randU32(s),
    antiClass: def.producedAntiClass,
    trait: def.unitTrait,
    aoeRadius: def.unitAoeRadius,
    flying: def.unitFlying,
    damageVsStructuresMult: def.producedDamageVsStructuresMult ?? 1,
    signal: dominantSignal(def),
    vxImpulse: 0,
    vzImpulse: 0,
  };
  s.units.push(u);
  if (team === "player") s.stats.unitsProduced += 1;
}

function pushSpawnedBatch(s: GameState, st: StructureRuntime, team: "player" | "enemy", count: number): void {
  for (let i = 0; i < count; i++) pushSpawnedUnitBody(s, st, team, i, count);
}

export function spawnPlayerUnit(s: GameState, st: StructureRuntime): number {
  const n = availableProductionSlots(s, st);
  if (n > 0) pushSpawnedBatch(s, st, "player", n);
  return n;
}

export function spawnEnemyUnit(s: GameState, st: StructureRuntime): number {
  const n = availableProductionSlots(s, st);
  if (n > 0) pushSpawnedBatch(s, st, "enemy", n);
  if (n > 0) s.stats.enemyUnitsSpawned += n;
  return n;
}

function productionTicksForStructure(st: StructureRuntime): number {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return 1;
  const baseTicks = def.productionSeconds * TICK_HZ;
  const teamRate = st.team === "enemy" ? ENEMY_PRODUCTION_RATE_MULT : 1;
  return Math.max(1, Math.round(baseTicks / teamRate));
}

function resetProductionTimer(st: StructureRuntime): void {
  st.productionTicksRemaining = productionTicksForStructure(st);
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
      resetProductionTimer(st);
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
      st.productionTicksRemaining = productionTicksForStructure(st);
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
    st.productionTicksRemaining = spawned > 0 ? productionTicksForStructure(st) : 1;
  }
}
