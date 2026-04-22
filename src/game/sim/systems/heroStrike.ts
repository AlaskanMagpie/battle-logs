import {
  HERO_ATTACK_COOLDOWN_TICKS,
  HERO_ATTACK_DAMAGE,
  HERO_ATTACK_RANGE,
} from "../../constants";
import { logGame } from "../../gameLog";
import { emitHeroStrikeFx, shatterTapAnchor, type GameState, type StructureRuntime } from "../../state";
import type { Vec2 } from "../../types";
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
    bestU.hp -= HERO_ATTACK_DAMAGE;
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: bestU.x, z: bestU.z }, from);
    logGame("attack", `Wizard strike → unit #${bestU.id} (−${HERO_ATTACK_DAMAGE} HP)`, s.tick);
    return { ok: true, tag: "unit" };
  }

  const eh = s.enemyHero;
  if (eh.hp > 0 && dist2(h, eh) <= r2) {
    eh.hp -= HERO_ATTACK_DAMAGE;
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: eh.x, z: eh.z }, from);
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
    bestEr.hp -= HERO_ATTACK_DAMAGE * 0.65;
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: bestEr.x, z: bestEr.z }, from);
    logGame("attack", `Wizard strike → Dark Fortress (−${Math.round(HERO_ATTACK_DAMAGE * 0.65)} HP)`, s.tick);
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
    bestSt.hp -= HERO_ATTACK_DAMAGE * 0.45;
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: bestSt.x, z: bestSt.z }, from);
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
    bestTap.anchorHp = Math.max(0, (bestTap.anchorHp ?? 0) - HERO_ATTACK_DAMAGE * 0.42);
    h.attackCooldownTicksRemaining = HERO_ATTACK_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: bestTap.x, z: bestTap.z }, from);
    logGame("attack", `Wizard strike → enemy Mana anchor (${bestTap.defId})`, s.tick);
    if ((bestTap.anchorHp ?? 0) <= 0) shatterTapAnchor(s, bestTap);
    return { ok: true, tag: "tap" };
  }

  return { ok: false };
}
