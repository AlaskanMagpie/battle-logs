import { findKeep, type GameState } from "../../state";

/**
 * Defeat conditions (any of):
 *   - The Wizard Keep has been destroyed (no live keep structure exists).
 *   - The Wizard himself has dropped to 0 HP.
 */
export function loseCheck(s: GameState): void {
  if (s.phase !== "playing") return;
  const keep = findKeep(s);
  const wizardDead = s.hero.hp <= 0;
  if (!keep) {
    s.phase = "lose";
    s.lastMessage = "Defeat — the Wizard Keep has fallen.";
    return;
  }
  if (wizardDead) {
    s.phase = "lose";
    s.lastMessage = "Defeat — the Wizard has perished.";
  }
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
