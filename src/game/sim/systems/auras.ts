import { getCatalogEntry } from "../../catalog";
import { TICK_HZ } from "../../constants";
import { recordDamageDealtBy, type GameState, type UnitRuntime } from "../../state";
import { isStructureEntry } from "../../types";
import { applyAttackImpulse } from "./combat";
import { dist2 } from "./helpers";

export function auras(s: GameState): void {
  const perTick = 1 / TICK_HZ;
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def) || !def.aura) continue;
    const aura = def.aura;
    const r2 = aura.radius * aura.radius;

    if (aura.kind === "heal_structures") {
      const healPerTick = aura.value * perTick;
      for (const other of s.structures) {
        if (other.team !== "player" || other.hp <= 0) continue;
        if (dist2(st, other) > r2) continue;
        other.hp = Math.min(other.maxHp, other.hp + healPerTick);
      }
    } else if (aura.kind === "turret") {
      let best: UnitRuntime | null = null;
      let bestD = r2;
      for (const u of s.units) {
        if (u.team !== "enemy" || u.hp <= 0) continue;
        const d = dist2(st, u);
        if (d <= bestD) {
          bestD = d;
          best = u;
        }
      }
      if (best) {
        best.hp -= aura.value;
        recordDamageDealtBy(s, "player", aura.value);
        applyAttackImpulse(best, st, aura.value * 0.95);
      }
    }
    // salvage_bonus & safe_deploy_radius are read at death / placement time respectively.
  }
}
