import { getCatalogEntry } from "../../catalog";
import { TICK_HZ } from "../../constants";
import {
  dominantSignal,
  meetsEnemyStructureRequirements,
  meetsSignalRequirements,
  pushFx,
  rand,
  randU32,
  type CastFxKind,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../../state";
import { isStructureEntry } from "../../types";
import { unitStatsForCatalog } from "./helpers";

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

function pushSpawnedUnit(s: GameState, st: StructureRuntime, team: "player" | "enemy"): void {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return;
  const stStats = unitStatsForCatalog(def.producedSizeClass);
  const u: UnitRuntime = {
    id: s.nextId.unit++,
    team,
    structureId: st.id,
    x: st.x + (rand(s) - 0.5) * SPAWN_JITTER,
    z: st.z + (rand(s) - 0.5) * SPAWN_JITTER,
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

export function spawnPlayerUnit(s: GameState, st: StructureRuntime): void {
  pushSpawnedUnit(s, st, "player");
}

export function spawnEnemyUnit(s: GameState, st: StructureRuntime): void {
  pushSpawnedUnit(s, st, "enemy");
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
    if (!meetsSignalRequirements(s, def)) continue;

    st.productionTicksRemaining -= 1;
    if (st.productionTicksRemaining > 0) continue;

    spawnPlayerUnit(s, st);
    s.lastMessage = `${def.name} produced a ${def.producedSizeClass}.`;
    st.productionTicksRemaining = Math.round(def.productionSeconds * TICK_HZ);
  }

  for (const st of s.structures) {
    if (st.team !== "enemy") continue;
    if (!st.complete) continue;
    if (st.productionSilenceUntilTick > s.tick) continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def)) continue;
    if (!meetsEnemyStructureRequirements(s, def)) continue;

    st.productionTicksRemaining -= 1;
    if (st.productionTicksRemaining > 0) continue;

    spawnEnemyUnit(s, st);
    st.productionTicksRemaining = Math.round(def.productionSeconds * TICK_HZ);
  }
}
