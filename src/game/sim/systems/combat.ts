import {
  ANTI_CLASS_DAMAGE_MULT,
  CAMP_CORE_ATTACK_RADIUS,
  CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK,
  FORTIFY_INCOMING_DAMAGE_MULT,
  FORWARD_BUILD_INCOMING_DAMAGE_MULT,
  TAP_ANCHOR_STRIKE_RADIUS,
} from "../../constants";
import { shatterTapAnchor, type GameState, type StructureRuntime, type UnitRuntime } from "../../state";
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

const COMBAT_MARK_MAX = 14;

export function combat(s: GameState): void {
  s.lastSiegeHit = null;
  s.combatHitMarks.length = 0;
  const markAttackers = new Set<number>();

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
    if (s.combatHitMarks.length < COMBAT_MARK_MAX && !markAttackers.has(u.id)) {
      markAttackers.add(u.id);
      s.combatHitMarks.push({
        ax: u.x,
        az: u.z,
        tx: best.x,
        tz: best.z,
        range: u.range,
        wide: !!(u.aoeRadius && u.aoeRadius > 0),
      });
    }
    if (u.aoeRadius && u.aoeRadius > 0) {
      const r2 = u.aoeRadius * u.aoeRadius;
      for (const splash of s.units) {
        if (splash === best || splash.team !== foeTeam || splash.hp <= 0) continue;
        if (dist2(best, splash) <= r2) {
          splash.hp -= physicalDamage(u, splash) * 0.6;
        }
      }
    }
  }

  // Enemy → player structures (Keep is just another player structure).
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
      if (best.damageReductionUntilTick > s.tick) incoming *= FORTIFY_INCOMING_DAMAGE_MULT;
      best.hp -= incoming;
    }
  }

  // Enemy units ↦ Wizard hero (melee-range chip damage).
  for (const u of s.units) {
    if (u.team !== "enemy" || u.hp <= 0) continue;
    if (s.hero.hp <= 0) break;
    const dx = u.x - s.hero.x;
    const dz = u.z - s.hero.z;
    if (dx * dx + dz * dz <= 2.2 * 2.2) {
      s.hero.hp = Math.max(0, s.hero.hp - u.dmgPerTick * 0.4);
    }
  }

  // Player units ↦ rival Wizard (same range check as unit-vs-unit).
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (s.enemyHero.hp <= 0) break;
    if (dist2(u, s.enemyHero) <= u.range * u.range) {
      s.enemyHero.hp = Math.max(0, s.enemyHero.hp - u.dmgPerTick);
    }
  }

  // Player units vs enemy buildings (+X% if the producing structure flagged producedDamageVsStructuresMult).
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    const buildingDmgMult = u.damageVsStructuresMult ?? 1;
    const isSiege = buildingDmgMult > 1;
    for (const er of s.enemyRelays) {
      if (er.hp <= 0) continue;
      if (dist2(u, er) <= u.range * u.range) {
        er.hp -= u.dmgPerTick * 0.5 * buildingDmgMult;
        if (isSiege) s.lastSiegeHit = { x: er.x, z: er.z, tick: s.tick };
      }
    }
    for (const st of s.structures) {
      if (st.team !== "enemy") continue;
      if (dist2(u, st) <= u.range * u.range) {
        st.hp -= u.dmgPerTick * 0.5 * buildingDmgMult;
        if (isSiege) s.lastSiegeHit = { x: st.x, z: st.z, tick: s.tick };
      }
    }
  }

  // Units vs hostile Mana anchors (claim pillars on taps).
  const ar2 = TAP_ANCHOR_STRIKE_RADIUS * TAP_ANCHOR_STRIKE_RADIUS;
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    const foeTeam = u.team === "player" ? "enemy" : "player";
    for (const t of s.taps) {
      if (!t.active || t.ownerTeam !== foeTeam) continue;
      if ((t.anchorHp ?? 0) <= 0) continue;
      if (dist2(u, t) > ar2) continue;
      const mult = u.damageVsStructuresMult ?? 1;
      t.anchorHp = Math.max(0, (t.anchorHp ?? 0) - u.dmgPerTick * 0.42 * mult);
      if ((t.anchorHp ?? 0) <= 0) shatterTapAnchor(s, t);
    }
  }

  // Player units within a camp's core-attack radius chip its core while the camp is awake.
  for (const camp of s.map.enemyCamps) {
    const cur = s.enemyCampCoreHp[camp.id];
    if (cur === undefined || cur <= 0) continue;
    if (!s.enemyCampAwake[camp.id]) continue;
    const r2 = CAMP_CORE_ATTACK_RADIUS * CAMP_CORE_ATTACK_RADIUS;
    let dmg = 0;
    for (const u of s.units) {
      if (u.team !== "player" || u.hp <= 0) continue;
      if (dist2(u, camp.origin) <= r2) dmg += CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK;
    }
    if (dmg > 0) s.enemyCampCoreHp[camp.id] = Math.max(0, cur - dmg);
  }
}
