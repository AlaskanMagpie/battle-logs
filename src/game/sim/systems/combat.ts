import {
  ANTI_CLASS_DAMAGE_MULT,
  FORWARD_BUILD_INCOMING_DAMAGE_MULT,
} from "../../constants";
import type { GameState, StructureRuntime, UnitRuntime } from "../../state";
import { dist2, TRAMPLE } from "./helpers";

function physicalDamage(attacker: UnitRuntime, defender: UnitRuntime): number {
  let d = attacker.dmgPerTick;
  if (attacker.antiClass && defender.sizeClass === attacker.antiClass) d *= ANTI_CLASS_DAMAGE_MULT;
  const trample = TRAMPLE[attacker.sizeClass]?.[defender.sizeClass];
  if (trample) d *= trample;
  return d;
}

function applyUnitDamage(attacker: UnitRuntime, defender: UnitRuntime): number {
  const d = physicalDamage(attacker, defender);
  defender.hp -= d;
  if (attacker.trait === "lifesteal") {
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + d * 0.35);
  }
  return d;
}

export function combat(s: GameState): void {
  // Unit vs unit (w/ AoE breath for units with aoeRadius).
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    const foeTeam = u.team === "player" ? "enemy" : "player";
    let best: UnitRuntime | null = null;
    let bestD = u.range * u.range;
    for (const o of s.units) {
      if (o.team !== foeTeam || o.hp <= 0) continue;
      const d = dist2(u, o);
      if (d <= bestD) {
        bestD = d;
        best = o;
      }
    }
    if (!best) continue;
    applyUnitDamage(u, best);
    if (u.aoeRadius && u.aoeRadius > 0) {
      const r2 = u.aoeRadius * u.aoeRadius;
      for (const splash of s.units) {
        if (splash === best || splash.team !== foeTeam || splash.hp <= 0) continue;
        if (dist2(best, splash) <= r2) splash.hp -= physicalDamage(u, splash) * 0.6;
      }
    }
  }

  // Enemy → player structures / relays.
  for (const u of s.units) {
    if (u.team !== "enemy" || u.hp <= 0) continue;
    let best: StructureRuntime | null = null;
    let bestD = 2.5 * 2.5;
    for (const st of s.structures) {
      if (st.team !== "player") continue;
      const d = dist2(u, st);
      if (d <= bestD) {
        bestD = d;
        best = st;
      }
    }
    if (best) {
      let incoming = u.dmgPerTick * 0.35;
      if (!best.complete && best.placementForward) incoming *= FORWARD_BUILD_INCOMING_DAMAGE_MULT;
      if (best.damageReductionUntilTick > s.tick) incoming *= 0.5;
      best.hp -= incoming;
    }

    let bestRelay: (typeof s.playerRelays)[0] | null = null;
    let bestRd = 2.2 * 2.2;
    for (const pr of s.playerRelays) {
      if (!pr.built || pr.destroyed) continue;
      const d = dist2(u, pr);
      if (d <= bestRd) {
        bestRd = d;
        bestRelay = pr;
      }
    }
    if (bestRelay) bestRelay.hp -= u.dmgPerTick * 0.45;
  }

  // Player units vs enemy buildings (+50% if anti_building).
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    const buildingDmgMult = u.trait === "anti_building" ? 1.5 : 1;
    for (const er of s.enemyRelays) {
      if (er.hp <= 0) continue;
      if (dist2(u, er) <= u.range * u.range) {
        er.hp -= u.dmgPerTick * 0.5 * buildingDmgMult;
      }
    }
    for (const st of s.structures) {
      if (st.team !== "enemy") continue;
      if (dist2(u, st) <= u.range * u.range) {
        st.hp -= u.dmgPerTick * 0.5 * buildingDmgMult;
      }
    }
  }
}
