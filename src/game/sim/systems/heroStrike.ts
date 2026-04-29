import {
  HERO_ARCANE_SWEEP_CLUSTER_RADIUS,
  HERO_ARCANE_SWEEP_DAMAGE_PER_UNIT,
  HERO_ARCANE_SWEEP_EVERY_STRIKES,
  HERO_ARCANE_SWEEP_HALF_WIDTH,
  HERO_ARCANE_SWEEP_LENGTH,
  HERO_ARCANE_SWEEP_MIN_CLUSTER,
  HERO_ATTACK_COOLDOWN_TICKS,
  HERO_ATTACK_DAMAGE,
  HERO_ATTACK_RANGE,
  HERO_ATTACK_SWARM_MULT,
  HERO_STRIKE_NEAR_ENEMY_TAP_RADIUS,
  HERO_STRIKE_STRUCTURE_ON_ENEMY_NODE_MULT,
  SPELL_KNOCKBACK_SPEED,
} from "../../constants";
import { logGame } from "../../gameLog";
import {
  emitHeroStrikeFx,
  pushFx,
  recordDamageDealtBy,
  shatterTapAnchor,
  type GameState,
  type HeroStrikeFxVariant,
  type StructureRuntime,
} from "../../state";
import type { Vec2 } from "../../types";
import { applyAttackImpulse } from "./combat";
import { applyHeroFacingTowardWorld } from "./heroFacing";
import { dist2 } from "./helpers";

export type PlayerHeroStrikeTag =
  | "unit"
  | "enemyWizard"
  | "fortress"
  | "structure"
  | "tap";

export type PlayerHeroStrikeResult =
  | { ok: false }
  | { ok: true; tag: PlayerHeroStrikeTag };

function enemyStructureNearEnemyOwnedTap(s: GameState, st: StructureRuntime): boolean {
  if (st.team !== "enemy") return false;
  const r2 = HERO_STRIKE_NEAR_ENEMY_TAP_RADIUS * HERO_STRIKE_NEAR_ENEMY_TAP_RADIUS;
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "enemy") continue;
    if ((t.anchorHp ?? 0) <= 0) continue;
    if (dist2(st, t) <= r2) return true;
  }
  return false;
}

function emitPlayerHeroStrikeFx(
  s: GameState,
  target: Vec2,
  from: Vec2,
  strikeVariant: HeroStrikeFxVariant,
): void {
  s.hero.strikeSequence += 1;
  emitHeroStrikeFx(s, target, from, strikeVariant, s.hero.strikeSequence);
}

/** Corridor test (same geometry as doctrine line / Cut Back) — duplicated to avoid importing `intents`. */
function heroPointInCorridor(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  halfW: number,
): boolean {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz;
  const t = ab2 < 1e-8 ? 0 : Math.max(0, Math.min(1, (apx * abx + apz * abz) / ab2));
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const ddx = px - cx;
  const ddz = pz - cz;
  return ddx * ddx + ddz * ddz <= halfW * halfW;
}

function heroAimFromHero(hx: number, hz: number, aimX: number, aimZ: number): { ux: number; uz: number } {
  let dx = aimX - hx;
  let dz = aimZ - hz;
  const d = Math.hypot(dx, dz);
  if (d < 0.25) {
    return { ux: 1, uz: 0 };
  }
  return { ux: dx / d, uz: dz / d };
}

function heroCorridorKnockNormal(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { nx: number; nz: number } {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz;
  const t = ab2 < 1e-8 ? 0 : Math.max(0, Math.min(1, (apx * abx + apz * abz) / ab2));
  const cx = ax + abx * t;
  const cz = az + abz * t;
  let nx = px - cx;
  let nz = pz - cz;
  const nlen = Math.hypot(nx, nz) || 1;
  nx /= nlen;
  nz /= nlen;
  return { nx, nz };
}

function collectEnemyClusterNear(
  s: GameState,
  anchor: { x: number; z: number },
  radius: number,
): (typeof s.units)[0][] {
  const r2 = radius * radius;
  const out: (typeof s.units)[0][] = [];
  for (const u of s.units) {
    if (u.team !== "enemy" || u.hp <= 0) continue;
    if (dist2(u, anchor) <= r2) out.push(u);
  }
  return out;
}

/** Arcane corridor from the Wizard through the cluster centroid (Cut-Back–style). */
function runHeroArcaneLineSweep(
  s: GameState,
  from: Vec2,
  cluster: (typeof s.units)[0][],
): void {
  const h = s.hero;
  let cx = 0;
  let cz = 0;
  for (const u of cluster) {
    cx += u.x;
    cz += u.z;
  }
  cx /= cluster.length;
  cz /= cluster.length;
  const hx = from.x;
  const hz = from.z;
  const { ux, uz } = heroAimFromHero(hx, hz, cx, cz);
  const L = HERO_ARCANE_SWEEP_LENGTH;
  const ex = hx + ux * L;
  const ez = hz + uz * L;
  const hw = HERO_ARCANE_SWEEP_HALF_WIDTH;

  for (const u of s.units) {
    if (u.team !== "enemy" || u.hp <= 0) continue;
    if (!heroPointInCorridor(u.x, u.z, hx, hz, ex, ez, hw)) continue;
    const swarmMult = u.sizeClass === "Swarm" ? HERO_ATTACK_SWARM_MULT : 1;
    const dealt = HERO_ARCANE_SWEEP_DAMAGE_PER_UNIT * swarmMult;
    u.hp -= dealt;
    recordDamageDealtBy(s, "player", dealt);
    const { nx, nz } = heroCorridorKnockNormal(u.x, u.z, hx, hz, ex, ez);
    applyAttackImpulse(u, { x: u.x - nx, z: u.z - nz }, SPELL_KNOCKBACK_SPEED * 0.85);
  }

  for (const er of s.enemyRelays) {
    if (er.hp <= 0) continue;
    if (!heroPointInCorridor(er.x, er.z, hx, hz, ex, ez, hw)) continue;
    const dealt = HERO_ARCANE_SWEEP_DAMAGE_PER_UNIT * 0.65;
    er.hp -= dealt;
    recordDamageDealtBy(s, "player", dealt);
  }

  for (const st of s.structures) {
    if (st.team !== "enemy" || st.hp <= 0) continue;
    if (!heroPointInCorridor(st.x, st.z, hx, hz, ex, ez, hw)) continue;
    const nearTapMult = enemyStructureNearEnemyOwnedTap(s, st) ? HERO_STRIKE_STRUCTURE_ON_ENEMY_NODE_MULT : 1;
    const dealt = HERO_ARCANE_SWEEP_DAMAGE_PER_UNIT * 0.45 * nearTapMult;
    st.hp -= dealt;
    recordDamageDealtBy(s, "player", dealt);
  }

  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "enemy") continue;
    if ((t.anchorHp ?? 0) <= 0) continue;
    if (!heroPointInCorridor(t.x, t.z, hx, hz, ex, ez, hw)) continue;
    const dealt = HERO_ARCANE_SWEEP_DAMAGE_PER_UNIT * 0.42;
    t.anchorHp = Math.max(0, (t.anchorHp ?? 0) - dealt);
    recordDamageDealtBy(s, "player", dealt);
    if ((t.anchorHp ?? 0) <= 0) shatterTapAnchor(s, t);
  }

  applyHeroFacingTowardWorld(s, ex, ez);
  h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
  emitPlayerHeroStrikeFx(s, { x: ex, z: ez }, from, "player_arcane_sweep");
  pushFx(s, {
    kind: "line_cleave",
    x: ex,
    z: ez,
    fromX: hx,
    fromZ: hz,
    impactRadius: hw * 2,
  });
  pushFx(s, {
    kind: "elemental_spell",
    x: ex,
    z: ez,
    fromX: hx,
    fromZ: hz,
    element: "arcane",
    secondaryElement: "air",
    shape: "line",
    reach: L,
    width: hw * 2,
    impactRadius: hw * 2,
    visualSeed: s.tick + cluster.length * 19,
  });
  logGame("attack", `Wizard arcane sweep — ${cluster.length} clustered foes, line ${Math.round(L)}u`, s.tick);
}

/**
 * Player wizard strike resolution (auto-fire each tick when off cooldown). Caller must ensure
 * `s.hero.attackCooldownTicksRemaining === 0` before calling.
 */
export function tryPlayerHeroStrike(s: GameState): PlayerHeroStrikeResult {
  if (s.phase !== "playing") return { ok: false };

  const h = s.hero;
  const r2 = HERO_ATTACK_RANGE * HERO_ATTACK_RANGE;
  const from: Vec2 = { x: h.x, z: h.z };

  let bestU: (typeof s.units)[0] | null = null;
  let bestUd = r2;
  for (const u of s.units) {
    if (u.team !== "enemy" || u.hp <= 0) continue;
    const d = dist2(h, u);
    if (d <= bestUd) {
      bestUd = d;
      bestU = u;
    }
  }

  const nextStrikeSeq = s.hero.strikeSequence + 1;
  const sweepWindow =
    nextStrikeSeq % HERO_ARCANE_SWEEP_EVERY_STRIKES === 0 && nextStrikeSeq >= HERO_ARCANE_SWEEP_EVERY_STRIKES;
  if (sweepWindow && bestU) {
    const cluster = collectEnemyClusterNear(s, bestU, HERO_ARCANE_SWEEP_CLUSTER_RADIUS);
    if (cluster.length >= HERO_ARCANE_SWEEP_MIN_CLUSTER) {
      runHeroArcaneLineSweep(s, from, cluster);
      return { ok: true, tag: "unit" };
    }
  }

  if (bestU) {
    applyHeroFacingTowardWorld(s, bestU.x, bestU.z);
    const swarmMult = bestU.sizeClass === "Swarm" ? HERO_ATTACK_SWARM_MULT : 1;
    const dealt = HERO_ATTACK_DAMAGE * swarmMult;
    bestU.hp -= dealt;
    recordDamageDealtBy(s, "player", dealt);
    applyAttackImpulse(bestU, from, 2.4 * swarmMult);
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitPlayerHeroStrikeFx(s, { x: bestU.x, z: bestU.z }, from, "player_vs_unit");
    logGame(
      "attack",
      `Wizard strike → unit #${bestU.id} (−${Math.round(dealt)} HP)`,
      s.tick,
    );
    return { ok: true, tag: "unit" };
  }

  const eh = s.enemyHero;
  if (eh.hp > 0 && dist2(h, eh) <= r2) {
    applyHeroFacingTowardWorld(s, eh.x, eh.z);
    eh.hp -= HERO_ATTACK_DAMAGE;
    recordDamageDealtBy(s, "player", HERO_ATTACK_DAMAGE);
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitPlayerHeroStrikeFx(s, { x: eh.x, z: eh.z }, from, "player_vs_rival");
    logGame("attack", `Wizard strike → rival Wizard (−${HERO_ATTACK_DAMAGE} HP)`, s.tick);
    return { ok: true, tag: "enemyWizard" };
  }

  let bestEr: (typeof s.enemyRelays)[0] | null = null;
  let bestErd = r2;
  for (const er of s.enemyRelays) {
    if (er.hp <= 0) continue;
    const d = dist2(h, er);
    if (d <= bestErd) {
      bestErd = d;
      bestEr = er;
    }
  }
  if (bestEr) {
    applyHeroFacingTowardWorld(s, bestEr.x, bestEr.z);
    const dealt = HERO_ATTACK_DAMAGE * 0.65;
    bestEr.hp -= dealt;
    recordDamageDealtBy(s, "player", dealt);
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitPlayerHeroStrikeFx(s, { x: bestEr.x, z: bestEr.z }, from, "player_vs_fortress");
    logGame("attack", `Wizard strike → Dark Fortress (−${Math.round(dealt)} HP)`, s.tick);
    return { ok: true, tag: "fortress" };
  }

  let bestSt: StructureRuntime | null = null;
  let bestStd = r2;
  for (const st of s.structures) {
    if (st.team !== "enemy" || st.hp <= 0) continue;
    const d = dist2(h, st);
    if (d <= bestStd) {
      bestStd = d;
      bestSt = st;
    }
  }
  if (bestSt) {
    applyHeroFacingTowardWorld(s, bestSt.x, bestSt.z);
    const nearTapMult = enemyStructureNearEnemyOwnedTap(s, bestSt)
      ? HERO_STRIKE_STRUCTURE_ON_ENEMY_NODE_MULT
      : 1;
    const dealt = HERO_ATTACK_DAMAGE * 0.45 * nearTapMult;
    bestSt.hp -= dealt;
    recordDamageDealtBy(s, "player", dealt);
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitPlayerHeroStrikeFx(s, { x: bestSt.x, z: bestSt.z }, from, "player_vs_structure");
    logGame("attack", `Wizard strike → enemy structure #${bestSt.id}`, s.tick);
    return { ok: true, tag: "structure" };
  }

  let bestTap: (typeof s.taps)[0] | null = null;
  let bestTapD = r2;
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "enemy") continue;
    if ((t.anchorHp ?? 0) <= 0) continue;
    const d = dist2(h, t);
    if (d <= bestTapD) {
      bestTapD = d;
      bestTap = t;
    }
  }
  if (bestTap) {
    applyHeroFacingTowardWorld(s, bestTap.x, bestTap.z);
    const dealt = HERO_ATTACK_DAMAGE * 0.42;
    bestTap.anchorHp = Math.max(0, (bestTap.anchorHp ?? 0) - dealt);
    recordDamageDealtBy(s, "player", dealt);
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitPlayerHeroStrikeFx(s, { x: bestTap.x, z: bestTap.z }, from, "player_vs_anchor");
    logGame("attack", `Wizard strike → enemy Mana anchor (${bestTap.defId})`, s.tick);
    if ((bestTap.anchorHp ?? 0) <= 0) shatterTapAnchor(s, bestTap);
    return { ok: true, tag: "tap" };
  }

  return { ok: false };
}
