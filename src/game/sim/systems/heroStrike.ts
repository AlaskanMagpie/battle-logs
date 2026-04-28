import {
  HERO_ATTACK_COOLDOWN_TICKS,
  HERO_ATTACK_DAMAGE,
  HERO_ATTACK_RANGE,
  HERO_ATTACK_SWARM_MULT,
  HERO_STRIKE_NEAR_ENEMY_TAP_RADIUS,
  HERO_STRIKE_STRUCTURE_ON_ENEMY_NODE_MULT,
} from "../../constants";
import { logGame } from "../../gameLog";
import {
  emitHeroStrikeFx,
  recordDamageDealtBy,
  shatterTapAnchor,
  type GameState,
  type HeroStrikeFxVariant,
  type StructureRuntime,
} from "../../state";
import type { Vec2 } from "../../types";
import { applyAttackImpulse } from "./combat";
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
  if (bestU) {
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
