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
  const enemiesDead = !s.units.some((u) => u.team === "enemy" && u.hp > 0);
  if (relaysDead || enemiesDead) {
    s.phase = "win";
    s.lastMessage = relaysDead
      ? "Victory — enemy Relays eliminated."
      : "Victory — hostile force routed.";
  }
}
