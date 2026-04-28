import {
  ANTI_CLASS_DAMAGE_MULT,
  CAMP_CORE_ATTACK_RADIUS,
  CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK,
  FORTIFY_INCOMING_DAMAGE_MULT,
  FORWARD_BUILD_INCOMING_DAMAGE_MULT,
  ENEMY_UNIT_STRUCTURE_DAMAGE_MULT,
  PLAYER_UNIT_STRUCTURE_DAMAGE_MULT,
  SPELL_AOE_KNOCKBACK,
  TAP_ANCHOR_STRIKE_RADIUS,
  COMBAT_SPATIAL_CELL,
  UNIT_ATTACK_COOLDOWN_TICKS,
  UNIT_ATTACK_DAMAGE_MULT,
  UNIT_AOE_SPLASH_DAMAGE_MULT,
  UNIT_LIFESTEAL_DAMAGE_FRAC,
  UNIT_TAP_ANCHOR_DAMAGE_MULT,
} from "../../constants";
import { enemyAttackSpeedScalar } from "../../difficulty";
import {
  classifyAttackRangeBand,
  liveSquadCount,
  recordDamageDealtBy,
  shatterTapAnchor,
  tacticsFieldIncomingDamageMult,
  tacticsFieldOutgoingDamageMult,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../../state";
import type { UnitSizeClass, Vec2 } from "../../types";
import { dist2, TRAMPLE } from "./helpers";
import { buildCombatUnitBuckets, nearestFoeInBuckets, unitsNearXZ } from "../unitSpatial";

const IMPULSE_MASS: Record<UnitSizeClass, number> = {
  Swarm: 0.85,
  Line: 1,
  Heavy: 1.7,
  Titan: 2.8,
};

const ATTACK_IMPULSE_BY_CLASS: Record<UnitSizeClass, number> = {
  Swarm: 0.34,
  Line: 0.48,
  Heavy: 0.72,
  Titan: 1.05,
};

const ATTACK_IMPULSE_CAP = 8.5;

function baseAttackCooldownTicks(u: UnitRuntime): number {
  return UNIT_ATTACK_COOLDOWN_TICKS[u.sizeClass] ?? UNIT_ATTACK_COOLDOWN_TICKS.Line;
}

function attackCooldownTicks(s: GameState, u: UnitRuntime): number {
  const base = baseAttackCooldownTicks(u);
  if (u.team !== "enemy") return base;
  return Math.max(1, Math.round(base / enemyAttackSpeedScalar(s)));
}

function tickAttackCooldowns(units: UnitRuntime[]): void {
  for (const u of units) {
    if ((u.attackCooldownTicksRemaining ?? 0) > 0) {
      u.attackCooldownTicksRemaining = Math.max(0, (u.attackCooldownTicksRemaining ?? 0) - 1);
    }
  }
}

function attackReady(u: UnitRuntime): boolean {
  return (u.attackCooldownTicksRemaining ?? 0) <= 0;
}

function commitAttack(s: GameState, u: UnitRuntime): void {
  u.attackCooldownTicksRemaining = attackCooldownTicks(s, u);
  u.lastAttackTick = s.tick;
}

function attackDamageFromPerTick(u: UnitRuntime, perTick: number): number {
  const classMult = UNIT_ATTACK_DAMAGE_MULT[u.sizeClass] ?? UNIT_ATTACK_DAMAGE_MULT.Line;
  return perTick * baseAttackCooldownTicks(u) * classMult * liveSquadCount(u);
}

export function applyAttackImpulse(
  target: UnitRuntime,
  from: Vec2,
  strength: number,
  targetMassClass: UnitSizeClass = target.sizeClass,
): void {
  if (target.hp <= 0 || strength <= 0) return;
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const mass = IMPULSE_MASS[targetMassClass] ?? 1;
  const k = strength / mass;
  let vx = target.vxImpulse + (dx / len) * k;
  let vz = target.vzImpulse + (dz / len) * k;
  const mag = Math.hypot(vx, vz);
  if (mag > ATTACK_IMPULSE_CAP) {
    const c = ATTACK_IMPULSE_CAP / mag;
    vx *= c;
    vz *= c;
  }
  target.vxImpulse = vx;
  target.vzImpulse = vz;
}

function physicalDamage(attacker: UnitRuntime, defender: UnitRuntime): number {
  let d = attackDamageFromPerTick(attacker, attacker.dmgPerTick);
  const antiClasses = attacker.antiClasses?.length ? attacker.antiClasses : attacker.antiClass ? [attacker.antiClass] : [];
  if (antiClasses.includes(defender.sizeClass)) d *= ANTI_CLASS_DAMAGE_MULT;
  const trample = TRAMPLE[attacker.sizeClass]?.[defender.sizeClass];
  if (trample) d *= trample;
  return d;
}

function applyUnitDamage(s: GameState, attacker: UnitRuntime, defender: UnitRuntime): number {
  let d = physicalDamage(attacker, defender);
  d *= tacticsFieldOutgoingDamageMult(s, attacker.team, attacker.x, attacker.z);
  d *= tacticsFieldIncomingDamageMult(s, defender.team, defender.x, defender.z);
  defender.hp -= d;
  recordDamageDealtBy(s, attacker.team, d);
  if (attacker.trait === "lifesteal") {
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + d * UNIT_LIFESTEAL_DAMAGE_FRAC);
  }
  return d;
}

const cell = COMBAT_SPATIAL_CELL;

function combatMarkBudget(unitCount: number): number {
  if (unitCount >= 1500) return 1;
  if (unitCount >= 900) return 2;
  if (unitCount >= 450) return 4;
  if (unitCount >= 220) return 7;
  return 12;
}

function pushAttackMark(
  s: GameState,
  attacker: UnitRuntime,
  target: Vec2,
  markMax: number,
  markAttackers: Set<number>,
): void {
  if (s.combatHitMarks.length >= markMax || markAttackers.has(attacker.id)) return;
  markAttackers.add(attacker.id);
  s.combatHitMarks.push({
    attackerId: attacker.id,
    producedUnitId: attacker.producedUnitId,
    ax: attacker.x,
    az: attacker.z,
    tx: target.x,
    tz: target.z,
    range: attacker.range,
    wide: !!(attacker.aoeRadius && attacker.aoeRadius > 0),
    team: attacker.team,
    sizeClass: attacker.sizeClass,
    signal: attacker.signal,
    visualSeed: attacker.visualSeed ^ (s.tick * 2654435761),
    trait: attacker.trait,
    rangeBand: classifyAttackRangeBand(attacker.range),
  });
}

export function combat(s: GameState): void {
  s.lastSiegeHit = null;
  s.combatHitMarks.length = 0;
  tickAttackCooldowns(s.units);
  const markAttackers = new Set<number>();
  const buckets = buildCombatUnitBuckets(s, cell);
  const markMax = combatMarkBudget(s.units.length);

  // Unit vs unit (w/ AoE breath for units with aoeRadius).
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    if (!attackReady(u)) continue;
    const foeTeam = u.team === "player" ? "enemy" : "player";
    const best = nearestFoeInBuckets(u, foeTeam, u.range * u.range, buckets, cell);
    if (!best) continue;
    applyUnitDamage(s, u, best);
    applyAttackImpulse(best, u, ATTACK_IMPULSE_BY_CLASS[u.sizeClass]);
    if (u.aoeRadius && u.aoeRadius > 0) {
      const r2 = u.aoeRadius * u.aoeRadius;
      const near = unitsNearXZ(buckets, best.x, best.z, best, cell, u.aoeRadius);
      for (const splash of near) {
        if (splash.team !== foeTeam || splash.hp <= 0) continue;
        if (dist2(best, splash) > r2) continue;
        const spBase = physicalDamage(u, splash) * UNIT_AOE_SPLASH_DAMAGE_MULT;
        const sp =
          spBase *
          tacticsFieldOutgoingDamageMult(s, u.team, u.x, u.z) *
          tacticsFieldIncomingDamageMult(s, splash.team, splash.x, splash.z);
        splash.hp -= sp;
        recordDamageDealtBy(s, u.team, sp);
        applyAttackImpulse(splash, best, SPELL_AOE_KNOCKBACK);
      }
    }
    commitAttack(s, u);
    pushAttackMark(s, u, best, markMax, markAttackers);
  }

  // Enemy → player structures (Keep is just another player structure).
  for (const u of s.units) {
    if (u.team !== "enemy" || u.hp <= 0) continue;
    if (!attackReady(u)) continue;
    const ur2 = u.range * u.range;
    let best: StructureRuntime | null = null;
    let bestD = ur2;
    for (const st of s.structures) {
      if (st.team !== "player") continue;
      const d = dist2(u, st);
      if (d <= bestD) {
        bestD = d;
        best = st;
      }
    }
    if (best) {
      let incoming = attackDamageFromPerTick(u, u.dmgPerTick) * ENEMY_UNIT_STRUCTURE_DAMAGE_MULT;
      incoming *= tacticsFieldOutgoingDamageMult(s, "enemy", u.x, u.z);
      if (!best.complete && best.placementForward) incoming *= FORWARD_BUILD_INCOMING_DAMAGE_MULT;
      if (best.damageReductionUntilTick > s.tick) incoming *= FORTIFY_INCOMING_DAMAGE_MULT;
      if (best.team === "player") incoming *= tacticsFieldIncomingDamageMult(s, "player", best.x, best.z);
      best.hp -= incoming;
      recordDamageDealtBy(s, "enemy", incoming);
      commitAttack(s, u);
      pushAttackMark(s, u, best, markMax, markAttackers);
    }
  }

  // Enemy units ↦ Wizard hero (automatic melee at unit weapon range).
  for (const u of s.units) {
    if (u.team !== "enemy" || u.hp <= 0) continue;
    if (!attackReady(u)) continue;
    if (s.hero.hp <= 0) break;
    if (dist2(u, s.hero) <= u.range * u.range) {
      const raw =
        attackDamageFromPerTick(u, u.dmgPerTick) *
        0.4 *
        tacticsFieldOutgoingDamageMult(s, "enemy", u.x, u.z) *
        tacticsFieldIncomingDamageMult(s, "player", s.hero.x, s.hero.z);
      s.hero.hp = Math.max(0, s.hero.hp - raw);
      recordDamageDealtBy(s, "enemy", raw);
      commitAttack(s, u);
      pushAttackMark(s, u, s.hero, markMax, markAttackers);
    }
  }

  // Player units ↦ rival Wizard (same range check as unit-vs-unit).
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (!attackReady(u)) continue;
    if (s.enemyHero.hp <= 0) break;
    if (dist2(u, s.enemyHero) <= u.range * u.range) {
      const raw =
        attackDamageFromPerTick(u, u.dmgPerTick) *
        tacticsFieldOutgoingDamageMult(s, "player", u.x, u.z) *
        tacticsFieldIncomingDamageMult(s, "enemy", s.enemyHero.x, s.enemyHero.z);
      s.enemyHero.hp = Math.max(0, s.enemyHero.hp - raw);
      recordDamageDealtBy(s, "player", raw);
      commitAttack(s, u);
      pushAttackMark(s, u, s.enemyHero, markMax, markAttackers);
    }
  }

  // Player units vs enemy buildings (+X% if the producing structure flagged producedDamageVsStructuresMult).
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (!attackReady(u)) continue;
    const buildingDmgMult = u.damageVsStructuresMult ?? 1;
    const isSiege = buildingDmgMult > 1;
    let attacked = false;
    for (const er of s.enemyRelays) {
      if (er.hp <= 0) continue;
      if (dist2(u, er) <= u.range * u.range) {
        const raw =
          attackDamageFromPerTick(u, u.dmgPerTick) *
          PLAYER_UNIT_STRUCTURE_DAMAGE_MULT *
          buildingDmgMult *
          tacticsFieldOutgoingDamageMult(s, "player", u.x, u.z) *
          tacticsFieldIncomingDamageMult(s, "enemy", er.x, er.z);
        er.hp -= raw;
        recordDamageDealtBy(s, "player", raw);
        if (isSiege) s.lastSiegeHit = { x: er.x, z: er.z, tick: s.tick };
        commitAttack(s, u);
        pushAttackMark(s, u, er, markMax, markAttackers);
        attacked = true;
        break;
      }
    }
    if (attacked) continue;
    for (const st of s.structures) {
      if (st.team !== "enemy") continue;
      if (dist2(u, st) <= u.range * u.range) {
        const raw =
          attackDamageFromPerTick(u, u.dmgPerTick) *
          PLAYER_UNIT_STRUCTURE_DAMAGE_MULT *
          buildingDmgMult *
          tacticsFieldOutgoingDamageMult(s, "player", u.x, u.z) *
          tacticsFieldIncomingDamageMult(s, "enemy", st.x, st.z);
        st.hp -= raw;
        recordDamageDealtBy(s, "player", raw);
        if (isSiege) s.lastSiegeHit = { x: st.x, z: st.z, tick: s.tick };
        commitAttack(s, u);
        pushAttackMark(s, u, st, markMax, markAttackers);
        break;
      }
    }
  }

  // Units vs hostile Mana anchors (claim pillars on taps).
  const ar2 = TAP_ANCHOR_STRIKE_RADIUS * TAP_ANCHOR_STRIKE_RADIUS;
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    if (!attackReady(u)) continue;
    const foeTeam = u.team === "player" ? "enemy" : "player";
    for (const t of s.taps) {
      if (!t.active || t.ownerTeam !== foeTeam) continue;
      if ((t.anchorHp ?? 0) <= 0) continue;
      if (dist2(u, t) > ar2) continue;
      const mult = u.damageVsStructuresMult ?? 1;
      const anchorDmg = attackDamageFromPerTick(u, u.dmgPerTick) * UNIT_TAP_ANCHOR_DAMAGE_MULT * mult;
      t.anchorHp = Math.max(0, (t.anchorHp ?? 0) - anchorDmg);
      recordDamageDealtBy(s, u.team, anchorDmg);
      commitAttack(s, u);
      pushAttackMark(s, u, t, markMax, markAttackers);
      if ((t.anchorHp ?? 0) <= 0) shatterTapAnchor(s, t);
      break;
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
      if (!attackReady(u)) continue;
      if (dist2(u, camp.origin) <= r2) {
        dmg += attackDamageFromPerTick(u, CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK);
        commitAttack(s, u);
        pushAttackMark(s, u, camp.origin, markMax, markAttackers);
      }
    }
    if (dmg > 0) {
      s.enemyCampCoreHp[camp.id] = Math.max(0, cur - dmg);
      recordDamageDealtBy(s, "player", dmg);
    }
  }
}
