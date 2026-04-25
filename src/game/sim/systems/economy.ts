import {
  DOCTRINE_SLOT_COUNT,
  ENEMY_AI_PASSIVE_FLUX_PER_SEC,
  SALVAGE_FLUX_CAP_PER_SEC,
  SALVAGE_FLUX_PER_POOL_PER_SEC,
  TAP_FLUX_PER_SEC,
  TICK_HZ,
} from "../../constants";
import type { GameState } from "../../state";
import type { TeamId } from "../../types";
import { tapYieldMultForOwner } from "./homeDistance";

export function economy(s: GameState): void {
  if (s.phase === "playing") {
    const d = s.map.difficulty;
    const stress = d ? Math.max(d.enemyHpMult, d.enemyDmgMult) : 1;
    const fluxMul = 0.78 + 0.28 * Math.min(Math.max(stress, 0.85), 1.75);
    s.enemyFlux += (ENEMY_AI_PASSIVE_FLUX_PER_SEC * fluxMul) / TICK_HZ;
  }
  const perTap = TAP_FLUX_PER_SEC / TICK_HZ;
  for (const t of s.taps) {
    if (!t.active) continue;
    if ((t.anchorHp ?? 0) <= 0) continue;
    if (t.yieldRemaining <= 0) continue;
    const owner: TeamId = t.ownerTeam ?? "player";
    const yMul = tapYieldMultForOwner(s, owner, t);
    const take = Math.min(t.yieldRemaining, perTap * yMul);
    if (owner === "enemy") s.enemyFlux += take;
    else s.flux += take;
    t.yieldRemaining -= take;
  }
}

export function salvageTrickle(s: GameState): void {
  if (s.salvage <= 0) return;
  const capPerTick = SALVAGE_FLUX_CAP_PER_SEC / TICK_HZ;
  const ratePerTick = (s.salvage * SALVAGE_FLUX_PER_POOL_PER_SEC) / TICK_HZ;
  const take = Math.min(s.salvage, capPerTick, ratePerTick);
  s.flux += take;
  s.salvage -= take;
}

export function tickDoctrineCooldowns(s: GameState): void {
  for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
    const v = s.doctrineCooldownTicks[i] ?? 0;
    if (v > 0) s.doctrineCooldownTicks[i] = v - 1;
  }
}
