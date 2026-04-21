import { getCatalogEntry } from "../../catalog";
import { GLOBAL_POP_CAP, TICK_HZ } from "../../constants";
import {
  dominantSignal,
  localPopForEnemyStructure,
  localPopForStructure,
  meetsEnemyStructureRequirements,
  meetsSignalRequirements,
  rand,
  randU32,
  totalEnemyPop,
  totalPlayerPop,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../../state";
import { isStructureEntry } from "../../types";
import { unitStatsForCatalog } from "./helpers";

/** Slightly wider ring than ±1 so units clear the tower footprint / GLB hull. */
const SPAWN_JITTER = 3.5;

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
  };
  s.units.push(u);
  if (team === "player") s.stats.unitsProduced += 1;
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

    const localCap = def.localPopCap;
    const local = localPopForStructure(s, st.id);
    const global = totalPlayerPop(s);
    const defPop = unitStatsForCatalog(def.producedSizeClass).pop;
    const maxFitLocal = Math.floor((localCap - local) / defPop);
    const maxFitGlobal = Math.floor((GLOBAL_POP_CAP - global) / defPop);
    const n = Math.min(maxFitLocal, maxFitGlobal);
    if (n < 1) {
      if (st.productionTicksRemaining <= 0) {
        if (maxFitLocal < 1) s.lastMessage = `${def.name}: local pop cap reached (waiting…).`;
        else s.lastMessage = `Global pop cap reached (${GLOBAL_POP_CAP}). Free a slot to resume production.`;
      }
      st.productionTicksRemaining = Math.round(0.5 * TICK_HZ);
      continue;
    }

    for (let i = 0; i < n; i++) spawnPlayerUnit(s, st);
    s.lastMessage =
      n === 1
        ? `${def.name} produced a ${def.producedSizeClass}.`
        : `${def.name} produced ${n}× ${def.producedSizeClass}.`;
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

    const localCap = def.localPopCap;
    const local = localPopForEnemyStructure(s, st.id);
    const global = totalEnemyPop(s);
    const defPop = unitStatsForCatalog(def.producedSizeClass).pop;
    const maxFitLocal = Math.floor((localCap - local) / defPop);
    const maxFitGlobal = Math.floor((GLOBAL_POP_CAP - global) / defPop);
    const n = Math.min(maxFitLocal, maxFitGlobal);
    if (n < 1) {
      st.productionTicksRemaining = Math.round(0.5 * TICK_HZ);
      continue;
    }

    for (let i = 0; i < n; i++) spawnEnemyUnit(s, st);
    st.productionTicksRemaining = Math.round(def.productionSeconds * TICK_HZ);
  }
}
