import {
  DOCTRINE_SLOT_COUNT,
  ENEMY_AI_PASSIVE_FLUX_PER_SEC,
  SALVAGE_FLUX_CAP_PER_SEC,
  SALVAGE_FLUX_PER_POOL_PER_SEC,
  TAP_FLUX_PER_SEC,
  TICK_HZ,
} from "../../constants";
import { enemyEconomyScalar } from "../../difficulty";
import type { GameState } from "../../state";
import type { TeamId } from "../../types";
import { tapYieldMultForOwner } from "./homeDistance";

export function economy(s: GameState): void {
  if (s.phase === "playing") {
    s.enemyFlux += (ENEMY_AI_PASSIVE_FLUX_PER_SEC * enemyEconomyScalar(s)) / TICK_HZ;
  }
  const perTap = TAP_FLUX_PER_SEC / TICK_HZ;
  for (const t of s.taps) {
    if (!t.active) continue;
    if ((t.anchorHp ?? 0) <= 0) continue;
    if (t.yieldRemaining <= 0) continue;
    const owner: TeamId = t.ownerTeam ?? "player";
    const yMul = tapYieldMultForOwner(s, owner, t);
    const take = Math.min(t.yieldRemaining, perTap * yMul);
    if (owner === "enemy") s.enemyFlux += take * enemyEconomyScalar(s);
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
