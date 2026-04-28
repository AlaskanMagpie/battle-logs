import {
  HERO_CLAIM_CHANNEL_SEC,
  HERO_CLAIM_FLUX_FEE,
  HERO_CLAIM_FLUX_REWARD,
  HOME_CLAIM_CHANNEL_MULT_MAX,
  HOME_CLAIM_DISTANCE_FAR,
  HOME_CLAIM_DISTANCE_NEAR,
  HOME_CLAIM_FLUX_MULT_MAX,
  HOME_TAP_YIELD_MULT_MAX,
} from "../../constants";
import { findKeep, type GameState } from "../../state";
import type { TeamId, Vec2 } from "../../types";
import { dist2 } from "./helpers";

/** Shortest distance from `pos` to player Keep (if alive) or any player relay slot. */
export function minDistToPlayerHome(s: GameState, pos: Vec2): number {
  let best = Infinity;
  const keep = findKeep(s);
  if (keep && keep.hp > 0) {
    const d = Math.sqrt(dist2(keep, pos));
    best = Math.min(best, d);
  }
  for (const r of s.map.playerRelaySlots) {
    best = Math.min(best, Math.sqrt(dist2(r, pos)));
  }
  return Number.isFinite(best) ? best : 0;
}

/** Shortest distance from `pos` to any live enemy relay, else `enemyStart` if defined. */
export function minDistToEnemyHome(s: GameState, pos: Vec2): number {
  let best = Infinity;
  for (const er of s.enemyRelays) {
    if (er.hp <= 0) continue;
    best = Math.min(best, Math.sqrt(dist2(er, pos)));
  }
  if (!Number.isFinite(best) || best === Infinity) {
    const es = s.map.enemyStart;
    if (es) return Math.sqrt(dist2(es, pos));
    return 0;
  }
  return best;
}

function homeDistForTeam(s: GameState, team: TeamId, pos: Vec2): number {
  return team === "player" ? minDistToPlayerHome(s, pos) : minDistToEnemyHome(s, pos);
}

/** 0 = at/near home (no penalty), 1 = at/ beyond far distance (max penalty). */
export function homeStretchT(s: GameState, team: TeamId, pos: Vec2): number {
  const d = homeDistForTeam(s, team, pos);
  if (d <= HOME_CLAIM_DISTANCE_NEAR) return 0;
  if (d >= HOME_CLAIM_DISTANCE_FAR) return 1;
  return (d - HOME_CLAIM_DISTANCE_NEAR) / (HOME_CLAIM_DISTANCE_FAR - HOME_CLAIM_DISTANCE_NEAR);
}

export function claimFluxFeeForTap(s: GameState, team: TeamId, tap: Vec2): number {
  const t = homeStretchT(s, team, tap);
  const mult = 1 + t * (HOME_CLAIM_FLUX_MULT_MAX - 1);
  return Math.ceil(HERO_CLAIM_FLUX_FEE * mult);
}

export function claimFluxRewardForTap(s: GameState, team: TeamId, tap: Vec2): number {
  return Math.round(HERO_CLAIM_FLUX_REWARD * tapYieldMultForOwner(s, team, tap));
}

export function claimChannelSecForTap(s: GameState, team: TeamId, tap: Vec2): number {
  const t = homeStretchT(s, team, tap);
  const mult = 1 + t * (HOME_CLAIM_CHANNEL_MULT_MAX - 1);
  return HERO_CLAIM_CHANNEL_SEC * mult;
}

export function tapYieldMultForOwner(s: GameState, owner: TeamId, tap: Vec2): number {
  const t = homeStretchT(s, owner, tap);
  return 1 + t * (HOME_TAP_YIELD_MULT_MAX - 1);
}
