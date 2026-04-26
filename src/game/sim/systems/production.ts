import { getCatalogEntry } from "../../catalog";
import { GLOBAL_POP_CAP, TICK_HZ } from "../../constants";
import {
  dominantSignal,
  effectiveGlobalPopCap,
  localPopForEnemyStructure,
  localPopForStructure,
  pushFx,
  rand,
  randU32,
  totalEnemyPop,
  totalPlayerPop,
  type CastFxKind,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../../state";
import { isStructureEntry } from "../../types";
import { productionBatchSizeForClass, unitStatsForCatalog } from "./helpers";

/** Slightly wider ring than ±1 so units clear the tower footprint / GLB hull. */
const SPAWN_JITTER = 3.5;

function spawnFxKindForUnit(sizeClass: UnitRuntime["sizeClass"]): CastFxKind {
  switch (sizeClass) {
    case "Swarm":
      return "spark_burst";
    case "Heavy":
    case "Titan":
      return "ground_crack";
    case "Line":
    default:
      return "reclaim_pulse";
  }
}

export function availableProductionSlots(s: GameState, st: StructureRuntime): number {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return 0;
  const stats = unitStatsForCatalog(def.producedSizeClass);
  const batch = productionBatchSizeForClass(def.producedSizeClass);
  const localCap = Math.max(0, def.localPopCap + st.localPopCapBonus);
  const localPop =
    st.team === "player" ? localPopForStructure(s, st.id) : localPopForEnemyStructure(s, st.id);
  const globalCap = st.team === "player" ? effectiveGlobalPopCap(s) : GLOBAL_POP_CAP;
  const globalPop = st.team === "player" ? totalPlayerPop(s) : totalEnemyPop(s);
  const localRoom = Math.floor(Math.max(0, localCap - localPop) / stats.pop);
  const globalRoom = Math.floor(Math.max(0, globalCap - globalPop) / stats.pop);
  return Math.max(0, Math.min(batch, localRoom, globalRoom));
}

function pushSpawnedUnit(
  s: GameState,
  st: StructureRuntime,
  team: "player" | "enemy",
  spawnIndex: number,
  batchCount: number,
): void {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return;
  const stStats = unitStatsForCatalog(def.producedSizeClass);
  const angle = (spawnIndex / Math.max(1, batchCount)) * Math.PI * 2 + rand(s) * 0.22;
  const radius = SPAWN_JITTER * (0.62 + spawnIndex * 0.08 + rand(s) * 0.25);
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
    dmgPerTick: stStats.dmgPerTick,
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
  pushFx(s, { kind: spawnFxKindForUnit(def.producedSizeClass), x: u.x, z: u.z });
}

export function spawnPlayerUnit(s: GameState, st: StructureRuntime): number {
  const n = availableProductionSlots(s, st);
  for (let i = 0; i < n; i++) pushSpawnedUnit(s, st, "player", i, n);
  return n;
}

export function spawnEnemyUnit(s: GameState, st: StructureRuntime): number {
  const n = availableProductionSlots(s, st);
  for (let i = 0; i < n; i++) pushSpawnedUnit(s, st, "enemy", i, n);
  if (n > 0) s.stats.enemyUnitsSpawned += n;
  return n;
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
      st.productionTicksRemaining = Math.round(def.productionSeconds * TICK_HZ);
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
    st.productionTicksRemaining = spawned > 0 ? Math.round(def.productionSeconds * TICK_HZ) : 1;
  }
}
