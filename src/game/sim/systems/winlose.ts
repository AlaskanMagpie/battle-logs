import { MATCH_DURATION_TICKS } from "../../constants";
import { findKeep, recordMatchDamageTimelinePoint, type GameState } from "../../state";

/**
 * Defeat conditions (any of):
 *   - The Wizard Keep has been destroyed (no live keep structure exists).
 */
export function loseCheck(s: GameState): void {
  if (s.phase !== "playing") return;
  const keep = findKeep(s);
  if (!keep) {
    s.phase = "lose";
    s.matchEndDetail = "You lost: your Wizard Keep (base) was destroyed.";
    s.lastMessage = s.matchEndDetail;
  }
}

/** When match duration elapses, highest damage dealt wins; equal damage is a draw. */
export function resolveMatchTimeLimit(s: GameState): void {
  if (s.phase !== "playing") return;
  const p = s.stats.damageDealtPlayer;
  const e = s.stats.damageDealtEnemy;
  if (p > e) {
    s.phase = "win";
    s.matchEndDetail = `You won on the clock: you dealt more total damage than the enemy (${Math.round(p)} vs ${Math.round(
      e,
    )}).`;
    s.lastMessage = s.matchEndDetail;
  } else if (e > p) {
    s.phase = "lose";
    s.matchEndDetail = `You lost on the clock: the enemy dealt more total damage (${Math.round(p)} vs ${Math.round(e)}).`;
    s.lastMessage = s.matchEndDetail;
  } else {
    s.phase = "draw";
    s.matchEndDetail = `Match draw: equal total damage (${Math.round(p)} each) after the time limit.`;
    s.lastMessage = s.matchEndDetail;
  }
}

/** Call when `s.tick >= MATCH_DURATION_TICKS` to end the match by score. */
export function timeLimitCheck(s: GameState): void {
  if (s.phase !== "playing" || s.tick < MATCH_DURATION_TICKS) return;
  resolveMatchTimeLimit(s);
  recordMatchDamageTimelinePoint(s);
}

/** Enemy HQ: all Dark Fortress relays dead when present; otherwise all authored camp cores destroyed. */
function enemyHeadquartersDestroyed(s: GameState): boolean {
  if (s.enemyRelays.length > 0) {
    return s.enemyRelays.every((r) => r.hp <= 0);
  }
  const hasCoreObjective = s.map.enemyCamps.some(
    (c) => typeof c.coreMaxHp === "number" && c.coreMaxHp > 0,
  );
  if (!hasCoreObjective) return false;
  return s.map.enemyCamps.every((c) => {
    if (!(typeof c.coreMaxHp === "number" && c.coreMaxHp > 0)) return true;
    return (s.enemyCampCoreHp[c.id] ?? 0) <= 0;
  });
}

export function winCheck(s: GameState): void {
  if (s.phase !== "playing") return;
  if (!enemyHeadquartersDestroyed(s)) return;
  const viaRelays = s.enemyRelays.length > 0;
  s.phase = "win";
  s.matchEndDetail = viaRelays
    ? "You won: the enemy headquarters (every Dark Fortress relay) was destroyed."
    : "You won: every enemy camp core was destroyed.";
  s.lastMessage = s.matchEndDetail;
}
