import { MATCH_DURATION_TICKS } from "../../constants";
import { findKeep, type GameState } from "../../state";

/**
 * Defeat conditions (any of):
 *   - The Wizard Keep has been destroyed (no live keep structure exists).
 */
export function loseCheck(s: GameState): void {
  if (s.phase !== "playing") return;
  const keep = findKeep(s);
  if (!keep) {
    s.phase = "lose";
    s.lastMessage = "Defeat — the Wizard Keep has fallen.";
  }
}

/** When match duration elapses, highest damage dealt wins (tie → stalemate counts as defeat). */
export function resolveMatchTimeLimit(s: GameState): void {
  if (s.phase !== "playing") return;
  const p = s.stats.damageDealtPlayer;
  const e = s.stats.damageDealtEnemy;
  if (p > e) {
    s.phase = "win";
    s.lastMessage = `Time — victory by damage (${Math.round(p)} vs ${Math.round(e)}).`;
  } else if (e > p) {
    s.phase = "lose";
    s.lastMessage = `Time — defeat by damage (${Math.round(p)} vs ${Math.round(e)}).`;
  } else {
    s.phase = "lose";
    s.lastMessage = `Time — stalemate (${Math.round(p)} damage each).`;
  }
}

/** Call when `s.tick >= MATCH_DURATION_TICKS` to end the match by score. */
export function timeLimitCheck(s: GameState): void {
  if (s.phase !== "playing" || s.tick < MATCH_DURATION_TICKS) return;
  resolveMatchTimeLimit(s);
}

export function winCheck(s: GameState): void {
  if (s.phase !== "playing") return;
  if (s.enemyHero.hp <= 0) {
    s.phase = "win";
    s.lastMessage = "Victory — the rival Wizard has fallen.";
    return;
  }
  const relaysDead =
    s.enemyRelays.length > 0 ? s.enemyRelays.every((r) => r.hp <= 0) : false;
  /** Without this gate, zero spawned enemies (e.g. empty `enemyCamps` after map merge) reads as "all dead" and wins instantly. */
  const enemiesDead =
    s.stats.enemyUnitsSpawned > 0 && !s.units.some((u) => u.team === "enemy" && u.hp > 0);
  const hasCoreObjective = s.map.enemyCamps.some(
    (c) => typeof c.coreMaxHp === "number" && c.coreMaxHp > 0,
  );
  const coresDestroyed =
    hasCoreObjective &&
    s.map.enemyCamps.every((c) => {
      if (!(typeof c.coreMaxHp === "number" && c.coreMaxHp > 0)) return true;
      return (s.enemyCampCoreHp[c.id] ?? 0) <= 0;
    });
  if (relaysDead || enemiesDead || coresDestroyed) {
    s.phase = "win";
    s.lastMessage = coresDestroyed
      ? "Victory — camp core destroyed."
      : relaysDead
        ? "Victory — Dark Fortresses shattered."
        : "Victory — hostile force routed.";
  }
}
