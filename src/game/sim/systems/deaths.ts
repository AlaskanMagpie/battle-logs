import { getCatalogEntry } from "../../catalog";
import { SALVAGE_RETURN_STRUCTURE_FRAC } from "../../constants";
import type { GameState, StructureRuntime } from "../../state";
import type { Vec2 } from "../../types";
import { isStructureEntry } from "../../types";
import { dist2 } from "./helpers";

function structureSalvageFrac(catalogId: string): number {
  const def = getCatalogEntry(catalogId);
  if (!def || !isStructureEntry(def)) return SALVAGE_RETURN_STRUCTURE_FRAC;
  return def.salvageRefundFrac ?? SALVAGE_RETURN_STRUCTURE_FRAC;
}

function salvageYardBonusAt(s: GameState, pos: Vec2): number {
  let bonus = 0;
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def) || !def.aura) continue;
    if (def.aura.kind !== "salvage_bonus") continue;
    if (dist2(st, pos) <= def.aura.radius * def.aura.radius) bonus += def.aura.value;
  }
  return bonus;
}

function salvageFromDeadStructures(s: GameState, dead: StructureRuntime[]): void {
  for (const st of dead) {
    if (st.team !== "player") continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def)) continue;
    const baseFrac = structureSalvageFrac(st.catalogId);
    const bonus = salvageYardBonusAt(s, st);
    const refund = def.fluxCost * Math.min(1, baseFrac + bonus);
    s.salvage += refund;
    s.stats.salvageRecovered += refund;
    s.stats.structuresLost += 1;
  }
}

export function cleanupDead(s: GameState): void {
  const deadUnits = s.units.filter((u) => u.hp <= 0);
  for (const u of deadUnits) {
    if (u.team === "player") s.stats.unitsLost += 1;
    else s.stats.enemyKills += 1;
  }
  s.units = s.units.filter((u) => u.hp > 0);
  if (s.selectedUnitId !== null && !s.units.some((u) => u.id === s.selectedUnitId)) {
    s.selectedUnitId = null;
  }

  const deadStructs = s.structures.filter((st) => st.hp <= 0);
  salvageFromDeadStructures(s, deadStructs);
  for (const st of s.structures) {
    if (st.hp <= 0) st.hp = 0;
  }
  s.structures = s.structures.filter((st) => st.hp > 0);

  for (const er of s.enemyRelays) {
    if (er.hp <= 0) er.hp = 0;
  }
}
