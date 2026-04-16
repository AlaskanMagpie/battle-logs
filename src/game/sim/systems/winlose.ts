import { RELAY_LOSS_GRACE_TICKS } from "../../constants";
import { builtPlayerRelayCount, type GameState } from "../../state";

export function loseCheck(s: GameState): void {
  const active = builtPlayerRelayCount(s);
  if (s.playerRelaysEverBuilt > 0 && active === 0) {
    if (s.loseGraceTicksRemaining <= 0) s.loseGraceTicksRemaining = RELAY_LOSS_GRACE_TICKS;
  } else if (active > 0) {
    s.loseGraceTicksRemaining = 0;
  }

  if (s.loseGraceTicksRemaining > 0) {
    s.loseGraceTicksRemaining -= 1;
    if (s.loseGraceTicksRemaining <= 0 && builtPlayerRelayCount(s) === 0) {
      s.phase = "lose";
      s.lastMessage = "Defeat — all Relays lost.";
    }
  }
}

export function winCheck(s: GameState): void {
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
        ? "Victory — enemy Relays eliminated."
        : "Victory — hostile force routed.";
  }
}
