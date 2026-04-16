import { getCatalogEntry } from "../../catalog";
import { GLOBAL_POP_CAP, TICK_HZ } from "../../constants";
import {
  dominantSignal,
  localPopForStructure,
  meetsSignalRequirements,
  rand,
  randU32,
  totalPlayerPop,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../../state";
import { isStructureEntry } from "../../types";
import { unitStatsForCatalog } from "./helpers";

export function spawnPlayerUnit(s: GameState, st: StructureRuntime): void {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return;
  const stStats = unitStatsForCatalog(def.producedSizeClass);
  const u: UnitRuntime = {
    id: s.nextId.unit++,
    team: "player",
    structureId: st.id,
    x: st.x + (rand(s) - 0.5) * 2,
    z: st.z + (rand(s) - 0.5) * 2,
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
    signal: dominantSignal(def),
  };
  s.units.push(u);
  s.stats.unitsProduced += 1;
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
    if (local + defPop > localCap) {
      st.productionTicksRemaining = Math.round(0.5 * TICK_HZ);
      continue;
    }
    if (global + defPop > GLOBAL_POP_CAP) {
      st.productionTicksRemaining = Math.round(0.5 * TICK_HZ);
      continue;
    }

    spawnPlayerUnit(s, st);
    st.productionTicksRemaining = Math.round(def.productionSeconds * TICK_HZ);
  }
}
